// Typescript PTPv2 Client based on Phil Hartung's node-ptpv2 client

import dgram from 'dgram'
import { EventEmitter } from 'stream'

//PTPv2
const ptpMulticastAddrs = ['224.0.1.129', '224.0.1.130', '224.0.1.131', '224.0.1.132']

//functions

const getCorrectedTime = (offset: [number, number]): [number, number] => {
	const time = process.hrtime()
	const timeS = time[0] - offset[0]
	const timeNS = time[1] - offset[1]

	return [timeS, timeNS]
}

export interface PTPv2ClientEvents {
	ptp_master_changed: [ptp_master: string, sync: boolean]
	sync_changed: [sync: boolean]
	ptp_time_synced: [time: [number, number], lastSync: number]
}

export class PTPv2Client extends EventEmitter<PTPv2ClientEvents> {
	//ptp settings
	private addr: string = '127.0.0.1'
	private ptp_domain: number = 0
	private sync: boolean = false
	private ptpMaster: string = ''
	private minSyncInterval: number = 10000

	//PTPv2
	private ptpClientEvent = dgram.createSocket({ type: 'udp4', reuseAddr: true })
	private ptpClientGeneral = dgram.createSocket({ type: 'udp4', reuseAddr: true })

	//vars
	private t1: [number, number] = [0, 0]
	private ts1: [number, number] = [0, 0]
	private t2: [number, number] = [0, 0]
	private ts2: [number, number] = [0, 0]
	private offset: [number, number] = [0, 0]
	private sync_seq: number = 0
	private req_seq: number = 0
	private lastSync: number = 0

	init(iface: string, domain: number): void {
		this.addr = iface || '127.0.0.1'
		if (domain <= 3 && domain >= 0) this.ptp_domain = domain
		this.ptpClientEvent.bind(319)
		this.ptpClientGeneral.bind(320)
		this.ptpClientEvent.on('listening', () => {
			this.ptpClientEvent.addMembership(ptpMulticastAddrs[this.ptp_domain], this.addr)
		})
		this.ptpClientGeneral.on('listening', () => {
			this.ptpClientGeneral.addMembership(ptpMulticastAddrs[this.ptp_domain], this.addr)
		})

		this.ptpClientEvent.on('message', (buffer, _remote): void => {
			const recv_ts = getCorrectedTime(this.offset) //safe timestamp for ts1

			//check buffer length
			if (buffer.length < 31) return

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

			if (version != 2 || domain != this.ptp_domain)
				//check for version 2 and domain 0
				return

			if (type != 0)
				//only process sync messages
				return

			//do we have a new ptp master?
			if (source != this.ptpMaster) {
				this.ptpMaster = source
				this.sync = false
				this.emit('ptp_master_changed', this.ptpMaster, this.sync)
			}

			//save sequence number
			this.sync_seq = sequence

			//check if master is two step or not
			if ((flags & 0x0200) == 0x0200) {
				//two step, wait for follow_up msg for accurate t1
				this.ts1 = recv_ts
			} else if (Date.now() - this.lastSync > this.minSyncInterval) {
				//got accurate t1 (no follow_up msg)
				this.ts1 = recv_ts

				//read t1 timestamp
				const tsS = (buffer.readUInt16BE(34) << 4) + buffer.readUInt32BE(36)
				const tsNS = buffer.readUInt32BE(40)
				this.t1 = [tsS, tsNS]

				//send delay_req
				this.ptpClientEvent.send(this.ptp_delay_req(), 319, ptpMulticastAddrs[this.ptp_domain], () => {
					this.t2 = getCorrectedTime(this.offset)
				})

				this.t2 = getCorrectedTime(this.offset)
			}
		})

		this.ptpClientGeneral.on('message', (buffer, _remote): void => {
			//safe timestamp for ts2
			//const recv_ts = getCorrectedTime(this.offset)

			//check buffer length
			if (buffer.length < 31) return

			//read values from buffer
			const type = buffer.readUInt8(0) & 0x0f
			const version = buffer.readUInt8(1)
			//const length = buffer.readUInt16BE(2)
			const domain = buffer.readUInt8(4)
			//const flags = buffer.readUInt16BE(6)
			//const source = buffer.toString('hex', 20, 28).match(/.{1,2}/g).join('-') + ':0'
			const sequence = buffer.readUInt16BE(30)

			//check for version 2 and domain
			if (version != 2 || domain != this.ptp_domain) return

			if (type == 0x08 && this.sync_seq == sequence && Date.now() - this.lastSync > this.minSyncInterval) {
				//follow up msg with current seq
				//read t1 timestamp
				const tsS = (buffer.readUInt16BE(34) << 4) + buffer.readUInt32BE(36)
				const tsNS = buffer.readUInt32BE(40)
				this.t1 = [tsS, tsNS]

				//send delay_req
				this.ptpClientEvent.send(this.ptp_delay_req(), 319, ptpMulticastAddrs[this.ptp_domain], () => {
					this.t2 = getCorrectedTime(this.offset)
				})

				this.t2 = getCorrectedTime(this.offset)
			} else if (type == 0x09 && this.req_seq == sequence) {
				//delay_rsp msg
				//read ts2 timestamp
				const tsS = (buffer.readUInt16BE(34) << 4) + buffer.readUInt32BE(36)
				const tsNS = buffer.readUInt32BE(40)
				this.ts2 = [tsS, tsNS]

				//calc offset
				const delta =
					0.5 * (this.ts1[0] - this.t1[0] - this.ts2[0] + this.t2[0]) * 1000000000 +
					0.5 * (this.ts1[1] - this.t1[1] - this.ts2[1] + this.t2[1])

				const deltaSplit = [0, 0]
				deltaSplit[1] = delta % 1000000000
				deltaSplit[0] = Math.round((delta - deltaSplit[1]) / 1000000000)

				this.offset[0] += deltaSplit[0]
				this.offset[1] += deltaSplit[1]
				this.lastSync = Date.now()
				this.emit('ptp_time_synced', this.ptp_time, this.lastSync)

				//check if the clock was synced before
				if (!this.sync) {
					this.sync = true
					this.emit('sync_changed', this.sync)
				}
			}
		})
	}

	public destroy(): void {
		this.ptpClientEvent.removeAllListeners()
		this.ptpClientEvent.close()
		this.ptpClientGeneral.removeAllListeners()
		this.ptpClientGeneral.close()
		this.sync = false
		this.emit('sync_changed', this.sync)
	}

	public get ptp_time(): [number, number] {
		const time = process.hrtime()
		const timeS = time[0] - this.offset[0]
		const timeNS = time[1] - this.offset[1]

		return [timeS, timeNS]
	}

	//creates ptp delay_req buffer
	private ptp_delay_req(): Buffer<ArrayBuffer> {
		const length = 52
		const buffer = Buffer.alloc(length)
		this.req_seq = (this.req_seq + 1) % 0x10000

		buffer.writeUInt8(1, 0)
		buffer.writeUInt8(2, 1)
		buffer.writeUInt16BE(length, 2)
		buffer.writeUInt16BE(this.req_seq, 30)

		return buffer
	}

	public get is_synced(): boolean {
		return this.sync
	}

	public get ptp_master(): string {
		return this.ptp_master
	}

	public get last_sync(): number {
		return this.lastSync
	}

	//event msg client
}
