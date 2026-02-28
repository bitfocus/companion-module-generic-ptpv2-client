import dgram from 'dgram'
import { EventEmitter } from 'events'
import { isIPv4 } from 'net'

export type PtpTime = [number, number]

// PTPv2 multicast addressing per IEEE 1588-2008 §9.1:
// Domains 0–3 each have a dedicated multicast address.
// Domains 4–127 are valid but have no dedicated address; they all share
// 224.0.1.129 and are differentiated solely by the domain byte in the packet header.
// Domains 128–255 are reserved by the standard.
export const PTP_PRIMARY_MULTICAST = '224.0.1.129'
export const ptpDedicatedMulticastAddrs = ['224.0.1.129', '224.0.1.130', '224.0.1.131', '224.0.1.132']

const ptpMulticastAddr = (domain: number): string =>
	domain <= 3 ? ptpDedicatedMulticastAddrs[domain] : PTP_PRIMARY_MULTICAST

//functions

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
	const timeS = time[0] - offset[0]
	const timeNS = time[1] - offset[1]
	return normalizePtpTime(timeS, timeNS)
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

	//PTPv2
	private ptpClientEvent = dgram.createSocket({ type: 'udp4', reuseAddr: true })
	private ptpClientGeneral = dgram.createSocket({ type: 'udp4', reuseAddr: true })

	//vars
	private t1: PtpTime = [0, 0]
	private ts1: PtpTime = [0, 0]
	private t2: PtpTime = [0, 0]
	private ts2: PtpTime = [0, 0]
	private offset: PtpTime = [0, 0]
	private sync_seq: number = 0
	private req_seq: number = 0
	private lastSync: number = 0

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

		this.ptpClientEvent.on('listening', () => {
			this.ptpClientEvent.addMembership(ptpMulticastAddr(this.ptp_domain), this.addr)
			this.emit('listening', `ptpClientEvent socket listening`)
		})
		this.ptpClientGeneral.on('listening', () => {
			this.ptpClientGeneral.addMembership(ptpMulticastAddr(this.ptp_domain), this.addr)
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
			const recv_ts = getCorrectedTime(this.offset) //safe timestamp for ts1

			//check buffer length
			if (buffer.length < 32) return

			//read values from buffer
			const type = buffer.readUInt8(0) & 0x0f
			const version = buffer.readUInt8(1)
			//const length = buffer.readUInt16BE(2)
			const domain = buffer.readUInt8(4)
			const flags = buffer.readUInt16BE(6)
			let source = buffer.toString('hex', 20, 28)
			if (source == null) return
			const sourceB = source.match(/.{1,2}/g)
			if (sourceB == null) return
			source = sourceB.join('-') + ':0'
			//const sourceAlt = buffer.toString('hex', 20, 28).match(/.{1,2}/g).join(':')
			const sequence = buffer.readUInt16BE(30)
			this.addDomain(domain)
			if (version != 2 || domain != this.ptp_domain)
				//check for version 2 and domain 0
				return

			if (type != 0)
				//only process sync messages
				return

			//do we have a new ptp master?
			if (source != this.ptpMaster) {
				this.ptpMaster = source
				this.ptpMasterAddress = rinfo.address
				this.sync = false
				this.emit('ptp_master_changed', this.ptpMaster, rinfo.address, this.sync)
			}

			//save sequence number
			this.sync_seq = sequence

			//check if master is two step or not
			if ((flags & 0x0200) == 0x0200) {
				//two step, wait for follow_up msg for accurate t1
				this.ts1 = recv_ts
			} else if (Date.now() - this.lastSync > this.minSyncInterval) {
				if (buffer.length < 44) return
				//got accurate t1 (no follow_up msg)
				this.ts1 = recv_ts

				// FIX: use * 2^32 instead of << 4 to correctly combine the 48-bit seconds field
				const tsS = buffer.readUInt16BE(34) * 4294967296 + buffer.readUInt32BE(36)
				const tsNS = buffer.readUInt32BE(40)
				this.t1 = [tsS, tsNS]

				//send delay_req
				setImmediate(() => {
					this.ptpClientEvent.send(this.ptp_delay_req(), 319, ptpMulticastAddr(this.ptp_domain), (err, _bytes) => {
						if (err) {
							console.log(err)
							this.emit('error', err)
						} else {
							// FIX: only capture t2 after the packet has actually been sent
							this.t2 = getCorrectedTime(this.offset)
						}
					})
				})
				// FIX: removed redundant pre-send t2 assignment that was always overwritten
			}
		})

		this.ptpClientGeneral.on('message', (buffer, _rinfo): void => {
			//check buffer length
			if (buffer.length < 32) return

			//read values from buffer
			const type = buffer.readUInt8(0) & 0x0f
			const version = buffer.readUInt8(1)
			//const length = buffer.readUInt16BE(2)
			const domain = buffer.readUInt8(4)
			//const flags = buffer.readUInt16BE(6)
			//const source = buffer.toString('hex', 20, 28).match(/.{1,2}/g).join('-') + ':0'
			const sequence = buffer.readUInt16BE(30)
			this.addDomain(domain)
			//check for version 2 and domain
			if (version != 2 || domain != this.ptp_domain || buffer.length < 44) return
			if (type == 0x08 && this.sync_seq == sequence && Date.now() - this.lastSync > this.minSyncInterval) {
				//follow up msg with current seq
				// FIX: use * 2^32 instead of << 4 to correctly combine the 48-bit seconds field
				const tsS = buffer.readUInt16BE(34) * 4294967296 + buffer.readUInt32BE(36)
				const tsNS = buffer.readUInt32BE(40)
				this.t1 = [tsS, tsNS]

				//send delay_req
				setImmediate(() => {
					this.ptpClientEvent.send(this.ptp_delay_req(), 319, ptpMulticastAddr(this.ptp_domain), (err, _bytes) => {
						if (err) {
							console.log(err)
							this.emit('error', err)
						} else {
							// FIX: only capture t2 after the packet has actually been sent
							this.t2 = getCorrectedTime(this.offset)
						}
					})
				})
				// FIX: removed redundant pre-send t2 assignment that was always overwritten
			} else if (type == 0x09 && this.req_seq == sequence) {
				//delay_rsp msg
				// FIX: use * 2^32 instead of << 4 to correctly combine the 48-bit seconds field
				const tsS = buffer.readUInt16BE(34) * 4294967296 + buffer.readUInt32BE(36)
				const tsNS = buffer.readUInt32BE(40)
				this.ts2 = [tsS, tsNS]

				//calc offset
				const delta =
					0.5 * (this.ts1[0] - this.t1[0] - this.ts2[0] + this.t2[0]) * 1000000000 +
					0.5 * (this.ts1[1] - this.t1[1] - this.ts2[1] + this.t2[1])

				// FIX: use Math.trunc (not %) to correctly split negative deltas,
				// then normalise the accumulated offset to keep ns within [0, 1e9)
				const deltaS = Math.trunc(delta / 1_000_000_000)
				const deltaNS = delta - deltaS * 1_000_000_000

				this.offset = normalizePtpTime(this.offset[0] + deltaS, this.offset[1] + deltaNS)

				this.lastSync = Date.now()
				this.emit('ptp_time_synced', this.ptp_time, this.lastSync)
				this.startSyncTimeout()
				//check if the clock was synced before
				this.sync_change(true)
			}
		})
		try {
			this.ptpClientEvent.bind(319, this.addr)
			this.ptpClientGeneral.bind(320, this.addr)
		} catch (e) {
			console.log(e)
			const err: Error = {
				message: `Could not bind to ports 319, 320.`,
				name: 'Already in use',
			}
			this.emit('error', err)
		}
	}

	/**
	 * Close the sockets
	 *
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

	/**
	 * Create ptp delay_req buffer
	 *
	 */

	private ptp_delay_req(): Buffer<ArrayBuffer> {
		const length = 52
		const buffer = Buffer.alloc(length)
		this.req_seq = (this.req_seq + 1) % 0x10000

		buffer.writeUInt8(1, 0)
		buffer.writeUInt8(2, 1)
		buffer.writeUInt16BE(length, 2)
		// FIX: set the domain byte so masters on non-zero domains respond correctly
		buffer.writeUInt8(this.ptp_domain, 4)
		buffer.writeUInt16BE(this.req_seq, 30)

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
		const time = process.hrtime()
		// FIX: normalise to handle nanosecond underflow
		return normalizePtpTime(time[0] - this.offset[0], time[1] - this.offset[1])
	}

	/**
	 * PTP time as a single BigInt in nanoseconds.
	 */
	public get ptp_time_ns(): bigint {
		const [s, ns] = this.ptp_time
		return BigInt(s) * 1_000_000_000n + BigInt(ns)
	}

	/**
	 * Get iterator of domains found
	 *
	 */

	public get domains(): SetIterator<number> {
		return this.domainsFound.values()
	}
}
