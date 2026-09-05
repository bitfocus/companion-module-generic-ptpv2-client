import dgram from 'dgram'
import { EventEmitter } from 'events'
import { isIPv4 } from 'net'
import { networkInterfaces } from 'os'
import { randomBytes } from 'crypto'

export type PtpTime = [number, number]

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

// Dante (Audinate) subdomain aliases, per Audinate's published PTP address table.
// Dante runs a separate PTPv1 clock domain per pull-up/pull-down rate so that devices at
// different rates cannot disturb one another:
//   _DFLT : AES67 / Default
//   _ALT1 : pull-up/down +4.1667%
//   _ALT2 : pull-up/down +0.1%
//   _ALT3 : pull-up/down -0.1%
//   _ALT4 : pull-up/down -4%
export const DANTE_SUBDOMAIN_DEFAULT = PTP_SUBDOMAIN_DEFAULT
export const DANTE_SUBDOMAIN_PULLUP_441 = PTP_SUBDOMAIN_ALT1
export const DANTE_SUBDOMAIN_PULLUP_01 = PTP_SUBDOMAIN_ALT2
export const DANTE_SUBDOMAIN_PULLDOWN_01 = PTP_SUBDOMAIN_ALT3
export const DANTE_SUBDOMAIN_PULLDOWN_48 = PTP_SUBDOMAIN_ALT4

// PTPv1 (IEEE 1588-2002) defines four multicast addresses, and Dante spreads five subdomains
// across them. _ALT2 and _ALT4 deliberately share 224.0.1.131 — this is not a transcription
// error, it is what Audinate documents and what the wire actually carries. IEEE 1588-2002
// defines only three alternate addresses, so a fifth subdomain has to double up on one of
// them, and the 16-byte subdomain name in the header is what tells the two domains apart.
// That is why every receive path compares the whole name field rather than trusting the
// group a datagram arrived on.
export const PTP_MULTICAST = {
	[PTP_SUBDOMAIN_DEFAULT]: '224.0.1.129',
	[PTP_SUBDOMAIN_ALT1]: '224.0.1.130',
	[PTP_SUBDOMAIN_ALT2]: '224.0.1.131',
	[PTP_SUBDOMAIN_ALT3]: '224.0.1.132',
	[PTP_SUBDOMAIN_ALT4]: '224.0.1.131', // shares a group with _ALT2 by design; see above
} as const satisfies Record<PTP_SUBDOMAINS, string>

/**
 * Every multicast group IEEE 1588-2002 defines. A subdomain name outside the well-known set
 * — a Dante Domain Manager network can be given any name — still has to land on one of
 * these, chosen by a hash Audinate does not publish, so the group has to be supplied
 * alongside the name rather than derived from it.
 */
export const PTP_MULTICAST_GROUPS = ['224.0.1.129', '224.0.1.130', '224.0.1.131', '224.0.1.132'] as const
export type PtpMulticastGroup = (typeof PTP_MULTICAST_GROUPS)[number]

const isPtpMulticastGroup = (addr: string): addr is PtpMulticastGroup =>
	(PTP_MULTICAST_GROUPS as readonly string[]).includes(addr)

/**
 * The group a well-known subdomain uses, or undefined for a name outside the set.
 * Subdomain names are arbitrary text, so the lookup has to be an own-property check: a plain
 * index would answer a name like 'toString' or 'constructor' with an inherited member.
 */
export const multicastForSubdomain = (subdomain: string): string | undefined =>
	Object.hasOwn(PTP_MULTICAST, subdomain) ? (PTP_MULTICAST as Record<string, string>)[subdomain] : undefined

const PTP_EVENT_PORT = 319
const PTP_GENERAL_PORT = 320

// PTPv1 message types (byte 20 of header)
const MSG_SYNC = 0x01
const MSG_DELAY_REQ = 0x02
const MSG_FOLLOW_UP = 0x03
const MSG_DELAY_RESP = 0x04

// PTPv1 control field values (byte 32 of header)
export const CTRL_SYNC = 0x00
export const CTRL_DELAY_REQ = 0x01
export const CTRL_FOLLOW_UP = 0x02
export const CTRL_DELAY_RSP = 0x03

// PTPv1 flags (uint16 BE at byte 34):
// Bit 3 is PTP_ASSIST — set by a two-step master to indicate a Follow_Up will follow.
const FLAG_ASSIST = 0x0008

// ---------------------------------------------------------------------------
// PTPv1 header layout, IEEE 1588-2002 §6.2.2 — 40 bytes
// ---------------------------------------------------------------------------
// Bytes  0–1  : versionPTP      (uint16 BE, value = 1)
// Bytes  2–3  : versionNetwork  (uint16 BE)
// Bytes  4–19 : subdomain name  (16 bytes, null-terminated, null-padded)
// Byte   20   : messageType
// Byte   21   : sourceCommunicationTechnology
// Bytes 22–27 : sourceUuid      (6 bytes — an EUI-48, i.e. the port's MAC)
// Bytes 28–29 : sourcePortId    (uint16 BE)
// Bytes 30–31 : sequenceId      (uint16 BE)
// Byte   32   : control
// Byte   33   : reserved
// Bytes 34–35 : flags           (uint16 BE)
// Bytes 36–39 : reserved
//
// That trailing reserved word is the whole reason the header is 40 bytes and not 36, and
// every message body therefore begins 4 bytes later than a 36-byte header would suggest.
// The bodies are not laid out alike either — a Follow_Up carries an associatedSequenceId
// ahead of its timestamp, so its timestamp sits 4 bytes further still.
//
// Sync / Delay_Req body:
//   40–43 : originTimestamp.seconds        (uint32 BE)
//   44–47 : originTimestamp.nanoseconds    (int32 BE — signed per spec)
//   83    : syncInterval                   (int8, log2 of seconds)
//
// Follow_Up body:
//   42–43 : associatedSequenceId           (uint16 BE — the Sync this belongs to)
//   44–47 : preciseOriginTimestamp.seconds
//   48–51 : preciseOriginTimestamp.nanoseconds
//
// Delay_Resp body:
//   40–43 : delayReceiptTimestamp.seconds
//   44–47 : delayReceiptTimestamp.nanoseconds
//   50–55 : requestingSourceUuid           (6 bytes)
//   56–57 : requestingSourcePortId         (uint16 BE)
//   58–59 : requestingSourceSequenceId     (uint16 BE)
// ---------------------------------------------------------------------------

const HEADER_LENGTH = 40
const SUBDOMAIN_OFFSET = 4
const SUBDOMAIN_LENGTH = 16
const SUBDOMAIN_END = SUBDOMAIN_OFFSET + SUBDOMAIN_LENGTH
const MESSAGE_TYPE_OFFSET = 20
const SOURCE_UUID_OFFSET = 22
const SOURCE_UUID_LENGTH = 6
const SOURCE_PORT_ID_OFFSET = 28
const SEQUENCE_OFFSET = 30
const CONTROL_OFFSET = 32
const FLAGS_OFFSET = 34

// Sync and Delay_Req share a body layout
const ORIGIN_TIMESTAMP_OFFSET = 40
const SDR_LENGTH = 48
const SYNC_INTERVAL_OFFSET = 83
const SYNC_WITH_INTERVAL_LENGTH = SYNC_INTERVAL_OFFSET + 1

// Follow_Up
const FU_ASSOCIATED_SEQUENCE_OFFSET = 42
const FU_TIMESTAMP_OFFSET = 44
const FU_LENGTH = 52

// Delay_Resp
const DR_TIMESTAMP_OFFSET = 40
const DR_REQUESTING_UUID_OFFSET = 50
const DR_REQUESTING_PORT_ID_OFFSET = 56
const DR_REQUESTING_SEQUENCE_OFFSET = 58
const DR_LENGTH = 60

const NS_PER_S = 1_000_000_000n

// IEEE 1588-2002 §D.2: the default sync interval is 2 seconds, expressed as log2. A receipt
// timeout is a multiple of what the master actually advertises, not of our own poll rate.
const DEFAULT_LOG_SYNC_INTERVAL = 1
const SYNC_RECEIPT_TIMEOUT = 3
const MIN_SYNC_INTERVAL_MS = 1000 / 128
const MAX_SYNC_INTERVAL_MS = 16_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a nanosecond count to the public `[seconds, nanoseconds]` shape.
 * Uses floored division so that nanoseconds stay in [0, 1e9) for negative inputs too.
 */
const toPtpTime = (nanoseconds: bigint): PtpTime => {
	let s = nanoseconds / NS_PER_S
	let ns = nanoseconds % NS_PER_S
	if (ns < 0n) {
		s -= 1n
		ns += NS_PER_S
	}
	return [Number(s), Number(ns)]
}

/**
 * Read a PTPv1 TimeRepresentation — unsigned 32-bit seconds plus *signed* 32-bit
 * nanoseconds — as a single nanosecond count.
 *
 * The whole pipeline works in BigInt because these values reach ~1.8e18 ns once scaled,
 * some two hundred times past what a double can represent exactly. Doing this arithmetic
 * in floating point silently rounds away everything finer than a few hundred nanoseconds,
 * which is the entire quantity being measured.
 */
const readPtpTimestamp = (buffer: Buffer, at: number): bigint =>
	BigInt(buffer.readUInt32BE(at)) * NS_PER_S + BigInt(buffer.readInt32BE(at + 4))

/** The interval a syncInterval field denotes, in ms, clamped so a bad value cannot hang us */
const syncIntervalMs = (logInterval: number): number =>
	Math.min(Math.max(Math.pow(2, logInterval) * 1000, MIN_SYNC_INTERVAL_MS), MAX_SYNC_INTERVAL_MS)

/**
 * A PTPv1 sourceUuid is a 6-byte EUI-48 — the port's MAC, used as-is rather than expanded
 * into the EUI-64 that PTPv2 uses for its clockIdentity.
 */
const uuidFromMac = (mac: string): Buffer | undefined => {
	const bytes = mac.split(':').map((part) => parseInt(part, 16))
	if (bytes.length !== SOURCE_UUID_LENGTH || bytes.some((byte) => Number.isNaN(byte))) return undefined
	// Some virtual interfaces report an all-zero MAC, which is not a usable identity
	if (bytes.every((byte) => byte === 0)) return undefined
	return Buffer.from(bytes)
}

/** Our own sourceUuid, taken from the interface we are bound to. */
const uuidForAddress = (addr: string): Buffer => {
	for (const nics of Object.values(networkInterfaces())) {
		for (const nic of nics ?? []) {
			if (nic.family !== 'IPv4') continue
			// '0.0.0.0' means "any interface", so take the first usable non-internal MAC
			if (addr !== '0.0.0.0' && nic.address !== addr) continue
			if (addr === '0.0.0.0' && nic.internal) continue
			const uuid = uuidFromMac(nic.mac)
			if (uuid) return uuid
		}
	}
	return randomBytes(SOURCE_UUID_LENGTH)
}

/**
 * Encode a subdomain string into a null-padded 16-byte Buffer.
 * Non-ASCII characters are rejected since subdomain names are ASCII by spec.
 */
const encodeSubdomain = (name: string): Buffer => {
	const buf = Buffer.alloc(SUBDOMAIN_LENGTH, 0)
	Buffer.from(name, 'ascii').copy(buf, 0, 0, SUBDOMAIN_MAX_LEN) // leave the last byte as the terminator
	return buf
}

/**
 * Decode the null-terminated subdomain name from bytes 4–19 of a PTPv1 packet.
 * Reads up to the first null byte, which is how null-terminated strings work per spec.
 */
const decodeSubdomain = (buffer: Buffer): string => {
	const nullIdx = buffer.indexOf(0, SUBDOMAIN_OFFSET)
	const end = nullIdx === -1 ? SUBDOMAIN_END : Math.min(nullIdx, SUBDOMAIN_END)
	return buffer.toString('ascii', SUBDOMAIN_OFFSET, end)
}

/**
 * Format a PTPv1 source identity as "uuid0-uuid1-...-uuid5:portId"
 */
const formatSourceId = (buffer: Buffer): string => {
	const uuidBytes =
		buffer.toString('hex', SOURCE_UUID_OFFSET, SOURCE_UUID_OFFSET + SOURCE_UUID_LENGTH).match(/.{1,2}/g) ?? []
	const portId = buffer.readUInt16BE(SOURCE_PORT_ID_OFFSET)
	return uuidBytes.join('-') + ':' + portId
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface PTPv1ClientEvents {
	close: [msg: string]
	error: [err: Error]
	listening: [msg: string]
	ptp_master_changed: [ptp_master: string, address: string, sync: boolean]
	ptp_time_synced: [time: PtpTime, lastSync: number]
	sync_changed: [sync: boolean]
	domains: [domains: SetIterator<string>]
}

// ---------------------------------------------------------------------------
// PTPv1Client
// ---------------------------------------------------------------------------

/**
 * PTPv1 (IEEE 1588-2002) client.
 *
 * Key differences from PTPv2:
 *  - All subdomain filtering is performed by matching the 16-byte subdomain name field in
 *    the packet header (bytes 4–19, following the 4-byte version preamble).
 *  - Message types are different: Sync=0x01, Delay_Req=0x02,
 *    Follow_Up=0x03, Delay_Resp=0x04.
 *  - The two-step flag is PTP_ASSIST (bit 3 of the flags word at byte 34), not 0x0200.
 *  - Timestamps are 32-bit seconds + signed 32-bit nanoseconds (not 48-bit).
 *  - Source identity is a 6-byte UUID + 2-byte port ID (not a clock identity).
 *  - Domain is expressed as a subdomain name string, not a number.
 *
 * @author Phillip Ivan Pietruschka <ivanpietruschka@gmail.com>
 * @since February, 2026
 */
export class PTPv1Client extends EventEmitter<PTPv1ClientEvents> {
	// settings
	private addr: string = '0.0.0.0'
	private subdomain: string = PTP_SUBDOMAIN_DEFAULT
	private subdomainBuf: Buffer = encodeSubdomain(PTP_SUBDOMAIN_DEFAULT)
	private multicast: string = PTP_MULTICAST[PTP_SUBDOMAIN_DEFAULT]
	private sync: boolean = false
	private syncTimeout: NodeJS.Timeout | undefined = undefined
	private ptpMaster: string = ''
	private ptpMasterAddress: string = ''
	private minSyncInterval: number = 10000
	private subdomainsFound: Set<string> = new Set<string>()
	private destroyed: boolean = false
	// What the master advertises, which is what the receipt timeout is a multiple of
	private logSyncInterval: number = DEFAULT_LOG_SYNC_INTERVAL

	// Our own identity: the 6-byte sourceUuid and portId we stamp on every Delay_Req, and
	// which the master echoes back so we can tell our own Delay_Resp from another slave's
	private readonly sourceUuid: Buffer
	private readonly sourcePortId: number = 1

	// sockets
	private ptpClientEvent = dgram.createSocket({ type: 'udp4', reuseAddr: true })
	private ptpClientGeneral = dgram.createSocket({ type: 'udp4', reuseAddr: true })

	// timing vars — all nanoseconds. t1/ts2 come from the master, ts1/t2 are local.
	private t1: bigint = 0n // master send timestamp (from Sync or Follow_Up)
	private ts1: bigint = 0n // local receive timestamp of Sync
	private t2: bigint = 0n // local send timestamp of Delay_Req
	private ts2: bigint = 0n // master receive timestamp of Delay_Req (from Delay_Resp)
	private offset: bigint = 0n // local clock − ptp time
	private sync_seq: number = 0
	private req_seq: number = 0
	private lastSync: number = 0
	// Keyed on the last attempt, not the last success: keying it on success means that while
	// a master is not answering, every incoming Sync fires another Delay_Req
	private lastRequest: number = 0

	/**
	 * Initialise the client.
	 *
	 * @param iface      IPv4 address of the interface to bind to
	 *                   (defaults to '0.0.0.0' for all interfaces)
	 * @param subdomain  PTPv1 subdomain name to listen to (defaults to '_DFLT'). Any printable
	 *                   ASCII name of up to 15 characters is accepted, since a Dante Domain
	 *                   Manager network may use one outside the well-known set.
	 * @param interval   Minimum sync interval in ms (minimum 125ms, default 10000ms)
	 * @param multicast  The group to join. Required for a subdomain outside the well-known
	 *                   set, whose address cannot be derived from its name; ignored otherwise.
	 */
	constructor(
		iface: string = '0.0.0.0',
		subdomain: string = PTP_SUBDOMAIN_DEFAULT,
		interval: number = 10000,
		multicast?: string,
	) {
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

		// A well-known name carries its own address; anything else must be told which group it
		// lives on, because the name-to-address hash for custom subdomains is not published.
		const group = multicast ?? multicastForSubdomain(subdomain)
		if (group === undefined) {
			throw new TypeError(
				`Subdomain "${subdomain}" is not one of ${Object.keys(PTP_MULTICAST).join(', ')}, ` +
					`so its multicast group cannot be derived and must be supplied.`,
			)
		}
		if (!isPtpMulticastGroup(group)) {
			throw new TypeError(
				`Invalid multicast group "${group}": IEEE 1588-2002 defines only ${PTP_MULTICAST_GROUPS.join(', ')}.`,
			)
		}

		this.addr = iface
		this.subdomain = subdomain
		this.subdomainBuf = encodeSubdomain(subdomain)
		this.multicast = group
		if (interval >= 125) this.minSyncInterval = Math.round(interval)
		this.sourceUuid = uuidForAddress(this.addr)

		this.ptpClientEvent.on('listening', () => {
			this.joinMulticast(this.ptpClientEvent)
			this.emit('listening', 'ptpClientEvent socket listening')
		})
		this.ptpClientGeneral.on('listening', () => {
			this.joinMulticast(this.ptpClientGeneral)
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
			const recv_ts = this.correctedTime() //safe timestamp for ts1

			if (buffer.length < HEADER_LENGTH) return

			const msgType = buffer.readUInt8(MESSAGE_TYPE_OFFSET)
			const sequence = buffer.readUInt16BE(SEQUENCE_OFFSET)
			const flags = buffer.readUInt16BE(FLAGS_OFFSET)

			// Track all subdomains seen on the wire regardless of our own filter
			const pktSubdomain = decodeSubdomain(buffer)
			if (pktSubdomain) this.addSubdomain(pktSubdomain)

			// Only process Sync messages for our configured subdomain
			if (msgType !== MSG_SYNC) return
			if (!buffer.subarray(SUBDOMAIN_OFFSET, SUBDOMAIN_END).equals(this.subdomainBuf)) return

			const source = formatSourceId(buffer)

			// Detect master change
			if (source !== this.ptpMaster) {
				this.ptpMaster = source
				this.ptpMasterAddress = rinfo.address
				this.sync_change(false)
				this.emit('ptp_master_changed', this.ptpMaster, rinfo.address, this.sync)
			}

			this.sync_seq = sequence

			// The master advertises its own Sync rate; the receipt timeout follows it. A short
			// Sync that stops before the field simply leaves the previous value in place.
			if (buffer.length >= SYNC_WITH_INTERVAL_LENGTH) {
				this.logSyncInterval = buffer.readInt8(SYNC_INTERVAL_OFFSET)
			}
			this.startSyncTimeout()

			if ((flags & FLAG_ASSIST) === FLAG_ASSIST) {
				// Two-step clock: the Follow_Up will carry the precise t1
				this.ts1 = recv_ts
			} else if (this.dueForExchange()) {
				// One-step clock: the timestamp is in the Sync itself
				if (buffer.length < SDR_LENGTH) return
				this.ts1 = recv_ts
				this.t1 = readPtpTimestamp(buffer, ORIGIN_TIMESTAMP_OFFSET)
				this.sendDelayReq()
			}
		})

		// -----------------------------------------------------------------------
		// General socket (port 320): receives Follow_Up and Delay_Resp messages
		// -----------------------------------------------------------------------
		this.ptpClientGeneral.on('message', (buffer, _rinfo): void => {
			if (buffer.length < HEADER_LENGTH) return

			const msgType = buffer.readUInt8(MESSAGE_TYPE_OFFSET)

			// Track subdomains regardless of filter
			const pktSubdomain = decodeSubdomain(buffer)
			if (pktSubdomain) this.addSubdomain(pktSubdomain)

			// Only process messages for our configured subdomain
			if (!buffer.subarray(SUBDOMAIN_OFFSET, SUBDOMAIN_END).equals(this.subdomainBuf)) return

			if (msgType === MSG_FOLLOW_UP) {
				if (buffer.length < FU_LENGTH) return
				// A Follow_Up carries its own sequenceId in the header and the sequenceId of
				// the Sync it belongs to in associatedSequenceId. Only the latter identifies
				// the exchange; a master that numbers its Follow_Ups separately would never
				// match on the header field.
				if (buffer.readUInt16BE(FU_ASSOCIATED_SEQUENCE_OFFSET) !== this.sync_seq) return
				if (!this.dueForExchange()) return

				this.t1 = readPtpTimestamp(buffer, FU_TIMESTAMP_OFFSET)
				this.sendDelayReq()
				return
			}

			if (msgType === MSG_DELAY_RESP) {
				if (buffer.length < DR_LENGTH) return
				if (!this.isOurDelayResp(buffer)) return

				// The master's receive timestamp for our Delay_Req
				this.ts2 = readPtpTimestamp(buffer, DR_TIMESTAMP_OFFSET)

				// offset = ((t2 − t1) − (t4 − t3)) / 2, in this class's naming
				// ((ts1 − t1) − (ts2 − t2)) / 2. ts1 and t2 are already offset-corrected, so
				// this is the residual error and accumulates onto the running offset.
				const correction = (this.ts1 - this.t1 - (this.ts2 - this.t2)) / 2n
				this.offset += correction

				this.lastSync = Date.now()
				this.emit('ptp_time_synced', this.ptp_time, this.lastSync)
				this.startSyncTimeout()
				this.sync_change(true)
			}
		})

		// Must bind to INADDR_ANY: a socket bound to a specific unicast address will not
		// receive datagrams addressed to the multicast group. The interface is selected by
		// addMembership() below, not by the bind address.
		// Bind errors (EADDRINUSE, EACCES on these privileged ports) arrive on the 'error'
		// event, never as a throw, so there is nothing useful to catch here.
		this.ptpClientEvent.bind(PTP_EVENT_PORT)
		this.ptpClientGeneral.bind(PTP_GENERAL_PORT)
	}

	// ---------------------------------------------------------------------------
	// Public API
	// ---------------------------------------------------------------------------

	/**
	 * Close both sockets and mark the client as unsynced.
	 */
	public destroy(): void {
		if (this.destroyed) return
		this.destroyed = true
		if (this.syncTimeout) clearTimeout(this.syncTimeout)
		this.syncTimeout = undefined
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
		return toPtpTime(this.correctedTime())
	}

	/**
	 * PTP time as a single BigInt in nanoseconds.
	 */
	public get ptp_time_n(): bigint {
		return this.correctedTime()
	}

	/** The master's advertised Sync interval, in seconds */
	public get sync_interval(): number {
		return syncIntervalMs(this.logSyncInterval) / 1000
	}

	/** Sync receipt timeout in ms — syncReceiptTimeout × the advertised sync interval */
	public get sync_receipt_timeout(): number {
		return Math.round(syncIntervalMs(this.logSyncInterval) * SYNC_RECEIPT_TIMEOUT)
	}

	/**
	 * Our own sourceUuid, as hex. This is the identity stamped on every Delay_Req and echoed
	 * back by the master in its Delay_Resp, which is how our own response is told apart from
	 * that of every other slave on the subdomain.
	 */
	public get source_uuid(): string {
		return this.sourceUuid.toString('hex')
	}

	/** The port id we identify ourselves with. A single-port client is always 1. */
	public get source_port_id(): number {
		return this.sourcePortId
	}

	/** The multicast group this client actually joined. */
	public get ptp_multicast(): string {
		return this.multicast
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
	 *   Bytes  0–1  : versionPTP = 1       (uint16 BE)
	 *   Bytes  2–3  : versionNetwork = 1   (uint16 BE)
	 *   Bytes  4–19 : subdomain name       (16 bytes, null-padded)
	 *   Byte   20   : messageType = 0x02
	 *   Byte   21   : sourceCommunicationTechnology = 0 (unknown)
	 *   Bytes 22–27 : sourceUuid           (zeroed — we are a slave with no UUID)
	 *   Bytes 28–29 : sourcePortId         (zeroed)
	 *   Bytes 30–31 : sequenceId           (uint16 BE)
	 *   Byte   32   : control = 0x01
	 *   Byte   33   : reserved
	 *   Bytes 34–35 : flags                (zeroed)
	 *   Bytes 36–39 : originTimestamp.seconds     (zeroed)
	 *   Bytes 40–43 : originTimestamp.nanoseconds (zeroed)
	 */
	private ptp_delay_req(): Buffer {
		const buffer = Buffer.alloc(SDR_LENGTH, 0)
		this.req_seq = (this.req_seq + 1) % 0x10000

		buffer.writeUInt16BE(1, 0) // versionPTP
		buffer.writeUInt16BE(1, 2) // versionNetwork
		this.subdomainBuf.copy(buffer, SUBDOMAIN_OFFSET)
		buffer.writeUInt8(MSG_DELAY_REQ, MESSAGE_TYPE_OFFSET)
		buffer.writeUInt8(0x01, MESSAGE_TYPE_OFFSET + 1) // sourceCommunicationTechnology: IEEE 802.3
		// Without a sourceUuid the master echoes back all zeroes, leaving every client on the
		// network indistinguishable in the Delay_Resp
		this.sourceUuid.copy(buffer, SOURCE_UUID_OFFSET)
		buffer.writeUInt16BE(this.sourcePortId, SOURCE_PORT_ID_OFFSET)
		buffer.writeUInt16BE(this.req_seq, SEQUENCE_OFFSET)
		buffer.writeUInt8(CTRL_DELAY_REQ, CONTROL_OFFSET)
		// originTimestamp at 40–47 is transmitted as zero; the real send time is taken locally

		return buffer
	}

	/**
	 * Is this Delay_Resp answering our request, rather than another slave's?
	 *
	 * A PTPv1 Delay_Resp identifies its requester by uuid, port and sequence — its own header
	 * sequenceId belongs to the master, not to the exchange, so matching on that would accept
	 * any slave's response that happened to collide.
	 */
	private isOurDelayResp(buffer: Buffer): boolean {
		if (buffer.readUInt16BE(DR_REQUESTING_SEQUENCE_OFFSET) !== this.req_seq) return false
		if (buffer.readUInt16BE(DR_REQUESTING_PORT_ID_OFFSET) !== this.sourcePortId) return false
		return (
			buffer.compare(
				this.sourceUuid,
				0,
				SOURCE_UUID_LENGTH,
				DR_REQUESTING_UUID_OFFSET,
				DR_REQUESTING_UUID_OFFSET + SOURCE_UUID_LENGTH,
			) === 0
		)
	}

	/** Local time in the PTP timebase, in nanoseconds. */
	private correctedTime(): bigint {
		return process.hrtime.bigint() - this.offset
	}

	/**
	 * Whether enough time has passed to start another delay request exchange.
	 * Keyed on the last *attempt* rather than the last success — keying it on success meant
	 * that while a master was not answering, every incoming Sync fired another Delay_Req.
	 */
	private dueForExchange(): boolean {
		return Date.now() - this.lastRequest > this.minSyncInterval
	}

	private sendDelayReq(): void {
		this.lastRequest = Date.now()
		setImmediate(() => {
			if (this.destroyed) return
			this.ptpClientEvent.send(this.ptp_delay_req(), PTP_EVENT_PORT, this.multicast, (err) => {
				if (err) {
					this.emit('error', err)
				} else {
					// only capture t2 after the packet has actually been sent
					this.t2 = this.correctedTime()
				}
			})
		})
	}

	/**
	 * Join the multicast group for the configured subdomain.
	 * addMembership throws synchronously if the interface has gone away, which would
	 * otherwise escape from the 'listening' handler and take the process down.
	 */
	private joinMulticast(socket: dgram.Socket): void {
		try {
			socket.addMembership(this.multicast, this.addr)
		} catch (e) {
			this.emit('error', e instanceof Error ? e : new Error(String(e)))
		}
	}

	/**
	 * Sync receipt timeout: syncReceiptTimeout × the interval the master advertises, not a
	 * multiple of our own poll rate. Armed on every Sync, so it measures the master's message
	 * flow rather than the success of our own delay request exchange.
	 */
	private startSyncTimeout(): void {
		if (this.syncTimeout) clearTimeout(this.syncTimeout)
		this.syncTimeout = setTimeout(() => {
			this.syncTimeout = undefined
			this.sync_change(false)
		}, this.sync_receipt_timeout)
	}

	private addSubdomain(name: string): void {
		if (this.subdomainsFound.has(name)) return
		this.subdomainsFound.add(name)
		this.emit('domains', this.subdomainsFound.values())
	}

	private sync_change(sync: boolean): void {
		if (this.sync === sync) return
		this.sync = sync
		this.emit('sync_changed', this.sync)
	}
}
