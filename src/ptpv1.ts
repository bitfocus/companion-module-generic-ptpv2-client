import dgram from 'dgram'
import { EventEmitter } from 'events'
import { isIPv4 } from 'net'

export type PtpTime = [number, number]

// PTPv1 (IEEE 1588-2002) uses a single multicast address for all subdomains.
// Subdomain differentiation is done entirely via the subdomain name field in
// the packet header, not by separate multicast group membership.
const PTP_MULTICAST = '224.0.1.129'

// PTPv1 message types (byte 16 of header)
const MSG_SYNC = 0x01
const MSG_DELAY_REQ = 0x02
const MSG_FOLLOW_UP = 0x03
const MSG_DELAY_RESP = 0x04

// PTPv1 control field values (byte 28 of header)
export const CTRL_SYNC = 0x00
export const CTRL_DELAY_REQ = 0x01
export const CTRL_FOLLOW_UP = 0x02
export const CTRL_DELAY_RSP = 0x03

// PTPv1 flags (uint16 BE at byte 30):
// Bit 3 is PTP_ASSIST — set by a two-step master to indicate a Follow_Up will follow.
const FLAG_ASSIST = 0x0008

// ---------------------------------------------------------------------------
// PTPv1 header layout (32 bytes)
// ---------------------------------------------------------------------------
//  0–15 : subdomain name (null-padded ASCII, 16 bytes)
//    16  : messageType
//    17  : sourceCommunicationTechnology
// 18–23  : sourceUuid (6 bytes)
// 24–25  : sourcePortId (uint16 BE)
// 26–27  : sequenceId  (uint16 BE)
//    28  : control
//    29  : reserved
// 30–31  : flags (uint16 BE)
//
// For Sync, Follow_Up, and Delay_Resp the body begins at byte 32:
//   32–35 : timestamp seconds      (uint32 BE)
//   36–39 : timestamp nanoseconds  (int32  BE — signed per spec)
// ---------------------------------------------------------------------------

// Maximum valid subdomain name length (excluding the null terminator/padding).
const SUBDOMAIN_MAX_LEN = 15

// Well-known PTPv1 subdomain names (IEEE 1588-2002 Annex B)
export const PTP_SUBDOMAIN_DEFAULT = '_DFLT'
export const PTP_SUBDOMAIN_ALT1 = '_ALT1'
export const PTP_SUBDOMAIN_ALT2 = '_ALT2'
export const PTP_SUBDOMAIN_ALT3 = '_ALT3'
export const PTP_SUBDOMAIN_ALT4 = '_ALT4'

export type PTP_SUBDOMAINS =
	| typeof PTP_SUBDOMAIN_DEFAULT
	| typeof PTP_SUBDOMAIN_ALT1
	| typeof PTP_SUBDOMAIN_ALT2
	| typeof PTP_SUBDOMAIN_ALT3
	| typeof PTP_SUBDOMAIN_ALT4

// Dante (Audinate) subdomain aliases.
// Dante uses PTPv1 with a separate clock domain per sample rate variant so that
// devices running at different pull rates do not interfere with each other:
//   _DFLT : standard rates (48 kHz, 96 kHz, …)
//   _ALT1 : +4.1667% pull-up   (44.1 kHz derived from 48 kHz base)
//   _ALT2 : +0.1%   pull-up
//   _ALT3 : -0.1%   pull-down
//   _ALT4 : -4%     pull-down  (48 kHz derived from 44.1 kHz base)
export const DANTE_SUBDOMAIN_DEFAULT = PTP_SUBDOMAIN_DEFAULT
export const DANTE_SUBDOMAIN_PULLUP_441 = PTP_SUBDOMAIN_ALT1
export const DANTE_SUBDOMAIN_PULLUP_01 = PTP_SUBDOMAIN_ALT2
export const DANTE_SUBDOMAIN_PULLDOWN_01 = PTP_SUBDOMAIN_ALT3
export const DANTE_SUBDOMAIN_PULLDOWN_48 = PTP_SUBDOMAIN_ALT4

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const normalizePtpTime = (s: number, ns: number): PtpTime => {
	if (ns >= 1_000_000_000) {
		s += Math.floor(ns / 1_000_000_000)
		ns = ns % 1_000_000_000
	} else if (ns < 0) {
		const borrow = Math.ceil(-ns / 1_000_000_000)
		s -= borrow
		ns += borrow * 1_000_000_000
	}
	return [s, ns]
}

const getCorrectedTime = (offset: PtpTime): PtpTime => {
	const time = process.hrtime()
	return normalizePtpTime(time[0] - offset[0], time[1] - offset[1])
}

/**
 * Encode a subdomain string into a null-padded 16-byte Buffer.
 * Non-ASCII characters are rejected since subdomain names are ASCII by spec.
 */
const encodeSubdomain = (name: string): Buffer => {
	const buf = Buffer.alloc(16, 0)
	Buffer.from(name, 'ascii').copy(buf, 0, 0, 15) // leave byte 15 as null terminator
	return buf
}

/**
 * Decode the subdomain name from the first 16 bytes of a PTPv1 packet,
 * trimming trailing null bytes.
 */
const decodeSubdomain = (buffer: Buffer): string => buffer.toString('ascii', 0, 16).replace(/\0+$/, '')

/**
 * Format a PTPv1 source identity as "uuid0-uuid1-...-uuid5:portId"
 */
const formatSourceId = (buffer: Buffer): string => {
	const uuidBytes = buffer.toString('hex', 18, 24).match(/.{1,2}/g) ?? []
	const portId = buffer.readUInt16BE(24)
	return uuidBytes.join('-') + ':' + portId
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface PTPv1ClientEvents {
	close: [msg: string]
	error: [err: Error]
	listening: [msg: string]
	subdomains: [subdomains: SetIterator<string>]
	ptp_master_changed: [ptp_master: string, address: string, sync: boolean]
	ptp_time_synced: [time: PtpTime, lastSync: number]
	sync_changed: [sync: boolean]
}

// ---------------------------------------------------------------------------
// PTPv1Client
// ---------------------------------------------------------------------------

/**
 * PTPv1 (IEEE 1588-2002) client.
 *
 * Key differences from PTPv2:
 *  - All subdomains share a single multicast address (224.0.1.129); subdomain
 *    filtering is performed by matching the 16-byte subdomain name field in
 *    the packet header.
 *  - Message types are different: Sync=0x01, Delay_Req=0x02,
 *    Follow_Up=0x03, Delay_Resp=0x04.
 *  - The two-step flag is PTP_ASSIST (bit 3 of the flags word), not 0x0200.
 *  - Timestamps are 32-bit seconds + signed 32-bit nanoseconds (not 48-bit).
 *  - Source identity is a 6-byte UUID + 2-byte port ID (not a clock identity).
 *  - Domain is expressed as a subdomain name string, not a number.
 *
 * @author Phillip Ivan Pietruschka <ivanpietruschka@gmail.com>
 * @since Feburary, 2026
 */
export class PTPv1Client extends EventEmitter<PTPv1ClientEvents> {
	// settings
	private addr: string = '0.0.0.0'
	private subdomain: string = PTP_SUBDOMAIN_DEFAULT
	private subdomainBuf: Buffer = encodeSubdomain(PTP_SUBDOMAIN_DEFAULT)
	private sync: boolean = false
	private syncTimeout: NodeJS.Timeout | undefined = undefined
	private ptpMaster: string = ''
	private ptpMasterAddress: string = ''
	private minSyncInterval: number = 10000
	private subdomainsFound: Set<string> = new Set<string>()

	// sockets
	private ptpClientEvent = dgram.createSocket({ type: 'udp4', reuseAddr: true })
	private ptpClientGeneral = dgram.createSocket({ type: 'udp4', reuseAddr: true })

	// timing vars
	private t1: PtpTime = [0, 0] // master send timestamp (from Sync or Follow_Up)
	private ts1: PtpTime = [0, 0] // local receive timestamp of Sync
	private t2: PtpTime = [0, 0] // local send timestamp of Delay_Req
	private ts2: PtpTime = [0, 0] // master receive timestamp of Delay_Req (from Delay_Resp)
	private offset: PtpTime = [0, 0]
	private sync_seq: number = 0
	private req_seq: number = 0
	private lastSync: number = 0

	/**
	 * Initialise the client.
	 *
	 * @param iface      IPv4 address of the interface to bind to
	 *                   (defaults to '0.0.0.0' for all interfaces)
	 * @param subdomain  PTPv1 subdomain name to listen to, up to 15 ASCII characters
	 *                   (defaults to '_DFLT', the standard default subdomain).
	 *                   Use the exported PTP_SUBDOMAIN_* constants or supply your own.
	 * @param interval   Minimum sync interval in ms (minimum 125ms, default 10000ms)
	 */
	constructor(iface: string = '0.0.0.0', subdomain: string = PTP_SUBDOMAIN_DEFAULT, interval: number = 10000) {
		super()

		if (!isIPv4(iface)) {
			throw new TypeError(
				`Invalid interface address "${iface}": must be a valid IPv4 address ` +
					`(e.g. '192.168.1.10') or '0.0.0.0' for all interfaces.`,
			)
		}

		if (typeof subdomain !== 'string' || subdomain.length === 0) {
			throw new TypeError(
				`Invalid subdomain "${subdomain}": must be a non-empty ASCII string of up to ${SUBDOMAIN_MAX_LEN} characters.`,
			)
		}
		if (subdomain.length > SUBDOMAIN_MAX_LEN) {
			throw new TypeError(
				`Invalid subdomain "${subdomain}": exceeds maximum length of ${SUBDOMAIN_MAX_LEN} characters.`,
			)
		}
		if (!/^[\x20-\x7E]+$/.test(subdomain)) {
			throw new TypeError(`Invalid subdomain "${subdomain}": must contain only printable ASCII characters.`)
		}

		this.addr = iface
		this.subdomain = subdomain
		this.subdomainBuf = encodeSubdomain(subdomain)
		if (interval >= 125) this.minSyncInterval = Math.round(interval)

		this.ptpClientEvent.on('listening', () => {
			this.ptpClientEvent.addMembership(PTP_MULTICAST, this.addr)
			this.emit('listening', 'ptpClientEvent socket listening')
		})
		this.ptpClientGeneral.on('listening', () => {
			this.ptpClientGeneral.addMembership(PTP_MULTICAST, this.addr)
			this.emit('listening', 'ptpClientGeneral socket listening')
		})
		this.ptpClientEvent.on('error', (err) => this.emit('error', err))
		this.ptpClientGeneral.on('error', (err) => this.emit('error', err))
		this.ptpClientEvent.on('close', () => this.emit('close', 'ptpClientEvent socket closed'))
		this.ptpClientGeneral.on('close', () => this.emit('close', 'ptpClientGeneral socket closed'))

		// -----------------------------------------------------------------------
		// Event socket (port 319): receives Sync and Delay_Req messages
		// -----------------------------------------------------------------------
		this.ptpClientEvent.on('message', (buffer, rinfo): void => {
			const recv_ts = getCorrectedTime(this.offset)

			if (buffer.length < 32) return

			const msgType = buffer.readUInt8(16)
			const sequence = buffer.readUInt16BE(26)
			const flags = buffer.readUInt16BE(30)

			// Track all subdomains seen on the wire regardless of our own filter
			const pktSubdomain = decodeSubdomain(buffer)
			this.addSubdomain(pktSubdomain)

			// Only process Sync messages for our configured subdomain
			if (msgType !== MSG_SYNC) return
			if (!buffer.subarray(0, 16).equals(this.subdomainBuf)) return

			const source = formatSourceId(buffer)

			// Detect master change
			if (source !== this.ptpMaster) {
				this.ptpMaster = source
				this.ptpMasterAddress = rinfo.address
				this.sync = false
				this.emit('ptp_master_changed', this.ptpMaster, rinfo.address, this.sync)
			}

			this.sync_seq = sequence

			if ((flags & FLAG_ASSIST) === FLAG_ASSIST) {
				// Two-step clock: Follow_Up will carry the precise t1
				this.ts1 = recv_ts
			} else if (Date.now() - this.lastSync > this.minSyncInterval) {
				// One-step clock: timestamp is embedded in the Sync message
				if (buffer.length < 40) return
				this.ts1 = recv_ts

				// PTPv1 uses 32-bit seconds (not 48-bit like PTPv2)
				const tsS = buffer.readUInt32BE(32)
				// Nanoseconds are signed int32 per IEEE 1588-2002
				const tsNS = buffer.readInt32BE(36)
				this.t1 = normalizePtpTime(tsS, tsNS)

				setImmediate(() => {
					this.ptpClientEvent.send(this.ptp_delay_req(), 319, PTP_MULTICAST, (err) => {
						if (err) {
							this.emit('error', err)
						} else {
							this.t2 = getCorrectedTime(this.offset)
						}
					})
				})
			}
		})

		// -----------------------------------------------------------------------
		// General socket (port 320): receives Follow_Up and Delay_Resp messages
		// -----------------------------------------------------------------------
		this.ptpClientGeneral.on('message', (buffer, _rinfo): void => {
			if (buffer.length < 32) return

			const msgType = buffer.readUInt8(16)
			const sequence = buffer.readUInt16BE(26)

			// Track subdomains regardless of filter
			const pktSubdomain = decodeSubdomain(buffer)
			this.addSubdomain(pktSubdomain)

			// All general messages we care about need the timestamp fields
			if (buffer.length < 40) return

			// Only process messages for our configured subdomain
			if (!buffer.subarray(0, 16).equals(this.subdomainBuf)) return

			if (
				msgType === MSG_FOLLOW_UP &&
				sequence === this.sync_seq &&
				Date.now() - this.lastSync > this.minSyncInterval
			) {
				// Precise master send timestamp from the Follow_Up message
				const tsS = buffer.readUInt32BE(32)
				const tsNS = buffer.readInt32BE(36)
				this.t1 = normalizePtpTime(tsS, tsNS)

				setImmediate(() => {
					this.ptpClientEvent.send(this.ptp_delay_req(), 319, PTP_MULTICAST, (err) => {
						if (err) {
							this.emit('error', err)
						} else {
							this.t2 = getCorrectedTime(this.offset)
						}
					})
				})
			} else if (msgType === MSG_DELAY_RESP && sequence === this.req_seq) {
				// Master's receive timestamp for our Delay_Req
				const tsS = buffer.readUInt32BE(32)
				const tsNS = buffer.readInt32BE(36)
				this.ts2 = normalizePtpTime(tsS, tsNS)

				// Offset calculation: delta = ((ts1 - t1) - (ts2 - t2)) / 2
				// Rearranged: delta = 0.5 * (ts1 - t1 - ts2 + t2)
				const delta =
					0.5 * (this.ts1[0] - this.t1[0] - this.ts2[0] + this.t2[0]) * 1_000_000_000 +
					0.5 * (this.ts1[1] - this.t1[1] - this.ts2[1] + this.t2[1])

				const deltaS = Math.trunc(delta / 1_000_000_000)
				const deltaNS = delta - deltaS * 1_000_000_000

				this.offset = normalizePtpTime(this.offset[0] + deltaS, this.offset[1] + deltaNS)

				this.lastSync = Date.now()
				this.emit('ptp_time_synced', this.ptp_time, this.lastSync)
				this.startSyncTimeout()
				this.sync_change(true)
			}
		})

		try {
			this.ptpClientEvent.bind(319, this.addr)
			this.ptpClientGeneral.bind(320, this.addr)
		} catch (e) {
			console.log(e)
			this.emit('error', {
				message: 'Could not bind to ports 319, 320.',
				name: 'Already in use',
			})
		}
	}

	// ---------------------------------------------------------------------------
	// Public API
	// ---------------------------------------------------------------------------

	/**
	 * Close both sockets and mark the client as unsynced.
	 */
	public destroy(): void {
		if (this.syncTimeout) clearTimeout(this.syncTimeout)
		this.ptpClientEvent.removeAllListeners()
		this.ptpClientEvent.close()
		this.ptpClientGeneral.removeAllListeners()
		this.ptpClientGeneral.close()
		this.sync = false
		this.emit('sync_changed', this.sync)
	}

	/** Whether the client has achieved and maintained a sync lock. */
	public get is_synced(): boolean {
		return this.sync
	}

	/**
	 * The current PTP master's source identity and IP address.
	 * @returns [sourceId (uuid:port), rinfo.address]
	 */
	public get ptp_master(): [string, string] {
		return [this.ptpMaster, this.ptpMasterAddress]
	}

	/** Timestamp (Date.now()) of the most recent completed sync exchange. */
	public get last_sync(): number {
		return this.lastSync
	}

	/**
	 * Current PTP-corrected time.
	 * @returns [seconds, nanoseconds]
	 */
	public get ptp_time(): PtpTime {
		const time = process.hrtime()
		return normalizePtpTime(time[0] - this.offset[0], time[1] - this.offset[1])
	}

	/** The configured subdomain name this client is listening on. */
	public get ptp_subdomain(): string {
		return this.subdomain
	}

	/** An iterator over all subdomain names observed on the wire so far. */
	public get subdomains(): SetIterator<string> {
		return this.subdomainsFound.values()
	}

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	/**
	 * Build a PTPv1 Delay_Req packet.
	 *
	 * Structure:
	 *   Bytes  0–15 : subdomain name
	 *   Byte  16    : messageType = 0x02
	 *   Byte  17    : sourceCommunicationTechnology = 0 (unknown)
	 *   Bytes 18–23 : sourceUuid (zeroed — we are a slave with no UUID)
	 *   Bytes 24–25 : sourcePortId (zeroed)
	 *   Bytes 26–27 : sequenceId
	 *   Byte  28    : control = 0x01
	 *   Byte  29    : reserved
	 *   Bytes 30–31 : flags (zeroed)
	 *   Bytes 32–35 : originTimestamp.seconds (zeroed)
	 *   Bytes 36–39 : originTimestamp.nanoseconds (zeroed)
	 *   ... remainder of body zeroed to 44 bytes total
	 */
	private ptp_delay_req(): Buffer {
		const length = 44
		const buffer = Buffer.alloc(length, 0)
		this.req_seq = (this.req_seq + 1) % 0x10000

		this.subdomainBuf.copy(buffer, 0) // subdomain name
		buffer.writeUInt8(MSG_DELAY_REQ, 16) // messageType
		buffer.writeUInt8(0x00, 17) // sourceCommunicationTechnology (unknown)
		buffer.writeUInt16BE(this.req_seq, 26) // sequenceId
		buffer.writeUInt8(CTRL_DELAY_REQ, 28) // control

		return buffer
	}

	private startSyncTimeout(): void {
		if (this.syncTimeout) clearTimeout(this.syncTimeout)
		this.syncTimeout = setTimeout(() => {
			this.sync_change(false)
		}, this.minSyncInterval * 2)
	}

	private addSubdomain(name: string): void {
		if (this.subdomainsFound.has(name)) return
		this.subdomainsFound.add(name)
		this.emit('subdomains', this.subdomainsFound.values())
	}

	private sync_change(sync: boolean): void {
		if (this.sync === sync) return
		this.sync = sync
		this.emit('sync_changed', this.sync)
	}
}
