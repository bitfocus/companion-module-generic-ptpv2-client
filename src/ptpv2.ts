import dgram from 'dgram'
import { EventEmitter } from 'events'
import { isIPv4 } from 'net'
import { networkInterfaces } from 'os'
import { randomBytes } from 'crypto'

export type PtpTime = [number, number]

// PTPv2 multicast addressing per IEEE 1588-2008 §9.1:
// Domains 0–3 each have a dedicated multicast address.
// Domains 4–127 are valid but have no dedicated address; they all share
// 224.0.1.129 and are differentiated solely by the domain byte in the packet header.
// Domains 128–255 are reserved by the standard.
const PTP_PRIMARY_MULTICAST = '224.0.1.129'
const ptpDedicatedMulticastAddrs = ['224.0.1.129', '224.0.1.130', '224.0.1.131', '224.0.1.132']

const PTP_EVENT_PORT = 319
const PTP_GENERAL_PORT = 320

// Message types (low nibble of byte 0)
const MSG_SYNC = 0x00
const MSG_DELAY_REQ = 0x01
const MSG_FOLLOW_UP = 0x08
const MSG_DELAY_RESP = 0x09

// Offsets into the PTP packet
const SOURCE_PORT_IDENTITY_OFFSET = 20 // 8-byte clockIdentity + 2-byte portNumber
const PORT_IDENTITY_LENGTH = 10
const SEQUENCE_OFFSET = 30
const CONTROL_FIELD_OFFSET = 32
const LOG_MSG_INTERVAL_OFFSET = 33
const TIMESTAMP_OFFSET = 34 // 6-byte seconds + 4-byte nanoseconds
const TIMESTAMP_LENGTH = 10
// Delay_Resp carries the requesting slave's portIdentity after the timestamp
const REQUESTING_PORT_IDENTITY_OFFSET = TIMESTAMP_OFFSET + TIMESTAMP_LENGTH
const DELAY_RESP_LENGTH = REQUESTING_PORT_IDENTITY_OFFSET + PORT_IDENTITY_LENGTH
// A Delay_Req is header + originTimestamp; the timestamp itself is sent as zero
const DELAY_REQ_LENGTH = TIMESTAMP_OFFSET + TIMESTAMP_LENGTH

const NS_PER_S = 1_000_000_000n

const ptpMulticastAddr = (domain: number): string =>
	domain <= 3 ? ptpDedicatedMulticastAddrs[domain] : PTP_PRIMARY_MULTICAST

//functions

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
 * Read a PTP 80-bit timestamp (48-bit seconds + 32-bit nanoseconds) as nanoseconds.
 * The seconds field is wider than a double can hold exactly once scaled to nanoseconds,
 * which is why the whole pipeline works in BigInt.
 */
const readPtpTimestamp = (buffer: Buffer, at: number = TIMESTAMP_OFFSET): bigint => {
	const seconds = (BigInt(buffer.readUInt16BE(at)) << 32n) | BigInt(buffer.readUInt32BE(at + 2))
	return seconds * NS_PER_S + BigInt(buffer.readUInt32BE(at + 6))
}

/**
 * Derive an IEEE 1588 clockIdentity from an interface MAC, per §7.5.2.2.2:
 * the EUI-48 is expanded to an EUI-64 by inserting FF FE in the middle.
 */
const clockIdentityFromMac = (mac: string): Buffer | undefined => {
	const bytes = mac.split(':').map((part) => parseInt(part, 16))
	if (bytes.length !== 6 || bytes.some((byte) => Number.isNaN(byte))) return undefined
	// Some virtual interfaces report an all-zero MAC, which is not a usable identity
	if (bytes.every((byte) => byte === 0)) return undefined
	return Buffer.from([bytes[0], bytes[1], bytes[2], 0xff, 0xfe, bytes[3], bytes[4], bytes[5]])
}

/**
 * The clockIdentity for the interface we are bound to. Falls back to a random identity so
 * that two clients are never mistaken for each other, which is what matters for matching
 * Delay_Resp messages.
 */
const clockIdentityForAddress = (addr: string): Buffer => {
	for (const nics of Object.values(networkInterfaces())) {
		for (const nic of nics ?? []) {
			if (nic.family !== 'IPv4') continue
			// '0.0.0.0' means "any interface", so take the first usable non-internal MAC
			if (addr !== '0.0.0.0' && nic.address !== addr) continue
			if (addr === '0.0.0.0' && nic.internal) continue
			const identity = clockIdentityFromMac(nic.mac)
			if (identity) return identity
		}
	}
	return randomBytes(8)
}

export interface PTPv2ClientEvents {
	close: [msg: string]
	error: [err: Error]
	listening: [msg: string]

	domains: [domains: SetIterator<number>]
	ptp_master_changed: [ptp_master: string, address: string, sync: boolean]
	ptp_time_synced: [time: PtpTime, lastSync: number]
	sync_changed: [sync: boolean]
}

/**
 * Class providing a Typescript PTPv2 Client based on Philipp Hartung's node-ptpv2 client
 *
 * @author Phillip Ivan Pietruschka <ivanpietruschka@gmail.com>
 * @since July, 2025
 */

export class PTPv2Client extends EventEmitter<PTPv2ClientEvents> {
	//ptp settings
	private addr: string = '127.0.0.1'
	private ptp_domain: number = 0
	private sync: boolean = false
	private syncTimeout: NodeJS.Timeout | undefined = undefined
	private ptpMaster: string = ''
	private ptpMasterAddress: string = ''
	private minSyncInterval: number = 10000
	private domainsFound: Set<number> = new Set<number>()
	private destroyed: boolean = false

	// Our portIdentity: 8-byte clockIdentity + 2-byte portNumber. Sent in every Delay_Req and
	// compared against the requestingPortIdentity echoed back in Delay_Resp.
	private readonly portIdentity: Buffer

	//PTPv2
	private ptpClientEvent = dgram.createSocket({ type: 'udp4', reuseAddr: true })
	private ptpClientGeneral = dgram.createSocket({ type: 'udp4', reuseAddr: true })

	//vars — all times are nanoseconds. t1/ts2 come from the master, ts1/t2 are local.
	private t1: bigint = 0n // Sync transmit time at the master
	private ts1: bigint = 0n // Sync receive time here
	private t2: bigint = 0n // Delay_Req transmit time here
	private ts2: bigint = 0n // Delay_Req receive time at the master
	private offset: bigint = 0n // local clock − ptp time
	private sync_seq: number = 0
	private req_seq: number = 0
	private lastSync: number = 0
	private lastRequest: number = 0

	/**
	 * Initialise the client
	 *
	 * @param iface IPv4 address of the interface to bind to (defaults to '0.0.0.0' for all interfaces)
	 * @param domain PTP domain to listen to (0–127; domains 0–3 use dedicated multicast
	 *               addresses, domains 4–127 share 224.0.1.129)
	 * @param interval Minimum PTP sync interval (125ms)
	 */

	constructor(iface: string = '0.0.0.0', domain: number = 0, interval: number = 10000) {
		super()
		if (!isIPv4(iface)) {
			throw new TypeError(
				`Invalid interface address "${iface}": must be a valid IPv4 address (e.g. '192.168.1.10') or '0.0.0.0' for all interfaces.`,
			)
		}
		this.addr = iface
		if (domain >= 0 && domain <= 127) this.ptp_domain = Math.round(domain)
		if (interval >= 125) this.minSyncInterval = Math.round(interval)

		this.portIdentity = Buffer.alloc(PORT_IDENTITY_LENGTH)
		clockIdentityForAddress(this.addr).copy(this.portIdentity, 0)
		this.portIdentity.writeUInt16BE(1, 8) // portNumber; a single-port client is always 1

		this.ptpClientEvent.on('listening', () => {
			this.joinMulticast(this.ptpClientEvent)
			this.emit('listening', `ptpClientEvent socket listening`)
		})
		this.ptpClientGeneral.on('listening', () => {
			this.joinMulticast(this.ptpClientGeneral)
			this.emit('listening', `ptpClientGeneral socket listening`)
		})
		this.ptpClientEvent.on('error', (err) => {
			this.emit('error', err)
		})
		this.ptpClientGeneral.on('error', (err) => {
			this.emit('error', err)
		})

		this.ptpClientEvent.on('close', () => {
			this.emit('close', `ptpClientEvent socket closed`)
		})
		this.ptpClientGeneral.on('close', () => {
			this.emit('close', `ptpClientGeneral socket closed`)
		})

		this.ptpClientEvent.on('message', (buffer, rinfo): void => {
			const recv_ts = this.correctedTime() //safe timestamp for ts1

			//check buffer length
			if (buffer.length < SEQUENCE_OFFSET + 2) return

			//read values from buffer
			const type = buffer.readUInt8(0) & 0x0f
			const version = buffer.readUInt8(1)
			//const length = buffer.readUInt16BE(2)
			const domain = buffer.readUInt8(4)
			const flags = buffer.readUInt16BE(6)
			let source = buffer.toString('hex', 20, 28)
			const sourceB = source.match(/.{1,2}/g)
			if (sourceB == null) return
			source = sourceB.join('-') + ':0'
			const sequence = buffer.readUInt16BE(SEQUENCE_OFFSET)

			// Only record domains from packets that are actually PTPv2, so unrelated traffic
			// on ports 319/320 can't pollute the discovered-domain list
			if (version != 2) return
			this.addDomain(domain)
			if (domain != this.ptp_domain) return

			if (type != MSG_SYNC)
				//only process sync messages
				return

			//do we have a new ptp master?
			if (source != this.ptpMaster) {
				this.ptpMaster = source
				this.ptpMasterAddress = rinfo.address
				// Route through sync_change so listeners see the transition
				this.sync_change(false)
				this.emit('ptp_master_changed', this.ptpMaster, rinfo.address, this.sync)
			}

			//save sequence number
			this.sync_seq = sequence

			//check if master is two step or not
			if ((flags & 0x0200) == 0x0200) {
				//two step, wait for follow_up msg for accurate t1
				this.ts1 = recv_ts
			} else if (this.dueForExchange()) {
				if (buffer.length < TIMESTAMP_OFFSET + TIMESTAMP_LENGTH) return
				//got accurate t1 (no follow_up msg)
				this.ts1 = recv_ts
				this.t1 = readPtpTimestamp(buffer)

				this.sendDelayReq()
			}
		})

		this.ptpClientGeneral.on('message', (buffer, _rinfo): void => {
			//check buffer length
			if (buffer.length < SEQUENCE_OFFSET + 2) return

			//read values from buffer
			const type = buffer.readUInt8(0) & 0x0f
			const version = buffer.readUInt8(1)
			//const length = buffer.readUInt16BE(2)
			const domain = buffer.readUInt8(4)
			const sequence = buffer.readUInt16BE(SEQUENCE_OFFSET)

			if (version != 2) return
			this.addDomain(domain)
			if (domain != this.ptp_domain || buffer.length < TIMESTAMP_OFFSET + TIMESTAMP_LENGTH) return

			if (type == MSG_FOLLOW_UP && this.sync_seq == sequence && this.dueForExchange()) {
				//follow up msg with current seq
				this.t1 = readPtpTimestamp(buffer)

				this.sendDelayReq()
			} else if (type == MSG_DELAY_RESP && this.req_seq == sequence && this.isOurDelayResp(buffer)) {
				//delay_rsp msg
				this.ts2 = readPtpTimestamp(buffer)

				// offset = ((t2 − t1) − (t4 − t3)) / 2, in this class's naming
				// ((ts1 − t1) − (ts2 − t2)) / 2. ts1 and t2 are already offset-corrected, so
				// this is the residual error and accumulates onto the running offset.
				this.offset += (this.ts1 - this.t1 - (this.ts2 - this.t2)) / 2n

				this.lastSync = Date.now()
				this.emit('ptp_time_synced', this.ptp_time, this.lastSync)
				this.startSyncTimeout()
				//check if the clock was synced before
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

	/**
	 * Join the PTP multicast group on the configured interface.
	 * addMembership throws synchronously if the interface has gone away, which would
	 * otherwise escape from the 'listening' handler and take the process down.
	 */
	private joinMulticast(socket: dgram.Socket): void {
		try {
			socket.addMembership(ptpMulticastAddr(this.ptp_domain), this.addr)
		} catch (e) {
			this.emit('error', e instanceof Error ? e : new Error(String(e)))
		}
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

	/** Is this Delay_Resp answering our request, rather than another slave's? */
	private isOurDelayResp(buffer: Buffer): boolean {
		if (buffer.length < DELAY_RESP_LENGTH) return false
		return (
			buffer.compare(this.portIdentity, 0, PORT_IDENTITY_LENGTH, REQUESTING_PORT_IDENTITY_OFFSET, DELAY_RESP_LENGTH) ===
			0
		)
	}

	private sendDelayReq(): void {
		this.lastRequest = Date.now()
		setImmediate(() => {
			if (this.destroyed) return
			this.ptpClientEvent.send(
				this.ptp_delay_req(),
				PTP_EVENT_PORT,
				ptpMulticastAddr(this.ptp_domain),
				(err, _bytes) => {
					if (err) {
						this.emit('error', err)
					} else {
						// only capture t2 after the packet has actually been sent
						this.t2 = this.correctedTime()
					}
				},
			)
		})
	}

	/**
	 * Close the sockets
	 *
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
		this.sync_change(false)
	}

	/**
	 * Create ptp delay_req buffer
	 *
	 */

	private ptp_delay_req(): Buffer<ArrayBuffer> {
		const buffer = Buffer.alloc(DELAY_REQ_LENGTH)
		this.req_seq = (this.req_seq + 1) % 0x10000

		buffer.writeUInt8(MSG_DELAY_REQ, 0)
		buffer.writeUInt8(2, 1)
		buffer.writeUInt16BE(DELAY_REQ_LENGTH, 2)
		// set the domain byte so masters on non-zero domains respond correctly
		buffer.writeUInt8(this.ptp_domain, 4)
		// Without a sourcePortIdentity the master echoes back all zeroes, leaving every client
		// on the network indistinguishable in the Delay_Resp
		this.portIdentity.copy(buffer, SOURCE_PORT_IDENTITY_OFFSET)
		buffer.writeUInt16BE(this.req_seq, SEQUENCE_OFFSET)
		buffer.writeUInt8(0x01, CONTROL_FIELD_OFFSET) // controlField: Delay_Req
		buffer.writeUInt8(0x7f, LOG_MSG_INTERVAL_OFFSET) // logMessageInterval: not periodic

		return buffer
	}

	private startSyncTimeout(): void {
		if (this.syncTimeout) clearTimeout(this.syncTimeout)
		this.syncTimeout = setTimeout(() => {
			this.sync_change(false)
		}, this.minSyncInterval * 2)
	}

	/**
	 * Check if we have seen this domain before and if not emit event with set of found domains
	 *
	 */

	private addDomain(domain: number): void {
		if (domain > 127) return // 128–255 are reserved by the standard
		if (this.domainsFound.has(domain)) return
		this.domainsFound.add(domain)
		this.emit(`domains`, this.domainsFound.values())
	}

	/**
	 * Check sync state and if changed emit event
	 *
	 */

	private sync_change(sync: boolean) {
		if (this.sync == sync) return
		this.sync = sync
		this.emit('sync_changed', this.sync)
	}

	/**
	 * Is the client synced
	 *
	 */

	public get is_synced(): boolean {
		return this.sync
	}

	/**
	 * This client's PTP clockIdentity, as hex
	 *
	 */

	public get clock_identity(): string {
		return this.portIdentity.toString('hex', 0, 8)
	}

	/**
	 * Who is the ptp_master
	 * @returns [ clockIdentiy, rinfo.Address ]
	 *
	 */

	public get ptp_master(): [string, string] {
		const ptp: [string, string] = [this.ptpMaster, this.ptpMasterAddress]
		return ptp
	}

	/**
	 * @returns timestamp of last sync event
	 *
	 */

	public get last_sync(): number {
		return this.lastSync
	}

	/**
	 * PTP Time
	 * @returns [ Time (seconds), Time (nanoseconds) ]
	 *
	 */

	public get ptp_time(): PtpTime {
		return toPtpTime(this.correctedTime())
	}

	/**
	 * PTP Time
	 * @returns bigint
	 *
	 */

	public get ptp_time_n(): bigint {
		return this.correctedTime()
	}

	/**
	 * Get iterator of domains found
	 *
	 */

	public get domains(): SetIterator<number> {
		return this.domainsFound.values()
	}
}
