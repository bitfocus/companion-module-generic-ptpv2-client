import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PtpTime } from './ptpv1.js'

// ---------------------------------------------------------------------------
// dgram mock
// ---------------------------------------------------------------------------

type Handler = (...args: unknown[]) => void

class MockSocket {
	private _handlers: Map<string, Handler[]> = new Map()

	bind = vi.fn((_port: number, _addr?: string) => {
		setImmediate(() => this.emit('listening'))
	})
	addMembership = vi.fn()
	send = vi.fn((_buf: Buffer, _port: number, _addr: string, cb?: (err: Error | null) => void) => {
		cb?.(null)
	})
	close = vi.fn()
	removeAllListeners = vi.fn(() => {
		this._handlers.clear()
	})

	on(event: string, handler: Handler) {
		if (!this._handlers.has(event)) this._handlers.set(event, [])
		this._handlers.get(event)!.push(handler)
		return this
	}

	emit(event: string, ...args: unknown[]) {
		this._handlers.get(event)?.forEach((h) => h(...args))
	}
}

let mockSockets: MockSocket[] = []

vi.mock('dgram', () => ({
	default: {
		createSocket: vi.fn(() => {
			const s = new MockSocket()
			mockSockets.push(s)
			return s
		}),
	},
}))

// ---------------------------------------------------------------------------
// Import after mock is registered
// ---------------------------------------------------------------------------

const {
	PTPv1Client,
	PTP_SUBDOMAIN_DEFAULT,
	PTP_SUBDOMAIN_ALT1,
	PTP_SUBDOMAIN_ALT2,
	PTP_SUBDOMAIN_ALT3,
	PTP_SUBDOMAIN_ALT4,
	DANTE_SUBDOMAIN_DEFAULT,
	DANTE_SUBDOMAIN_PULLUP_441,
	DANTE_SUBDOMAIN_PULLUP_01,
	DANTE_SUBDOMAIN_PULLDOWN_01,
	DANTE_SUBDOMAIN_PULLDOWN_48,
} = await import('./ptpv1.js')

// ---------------------------------------------------------------------------
// PTPv1 packet constants (mirrors the class internals)
// ---------------------------------------------------------------------------

const MSG_SYNC = 0x01
const MSG_FOLLOW_UP = 0x03
const MSG_DELAY_RESP = 0x04

const FLAG_ASSIST = 0x0008 // two-step flag
const CTRL_DELAY_REQ = 0x01

// ---------------------------------------------------------------------------
// Buffer builders
// ---------------------------------------------------------------------------
// PTPv1 header layout:
//  0-15 : subdomain name (null-padded, 16 bytes)
//    16  : messageType
//    17  : sourceCommunicationTechnology
// 18-23  : sourceUuid (6 bytes)
// 24-25  : sourcePortId (uint16 BE)
// 26-27  : sequenceId  (uint16 BE)
//    28  : control
//    29  : reserved
// 30-31  : flags (uint16 BE)
// 32-35  : timestamp seconds  (uint32 BE)
// 36-39  : timestamp nanoseconds (int32 BE — signed)

interface PacketOpts {
	subdomain?: string
	msgType?: number
	uuid?: string // 6-byte hex, e.g. 'aabbccddeeff'
	portId?: number
	sequence?: number
	control?: number
	flags?: number
	tsSeconds?: number // uint32
	tsNanos?: number // int32 (signed)
	length?: number
}

const makePacket = ({
	subdomain = '_DFLT',
	msgType = MSG_SYNC,
	uuid = 'aabbccddeeff',
	portId = 1,
	sequence = 1,
	control = 0x00,
	flags = 0x0000,
	tsSeconds = 0,
	tsNanos = 0,
	length = 44,
}: PacketOpts = {}): Buffer => {
	const buf = Buffer.alloc(Math.max(length, 44), 0)

	// subdomain (bytes 0-15, null padded)
	Buffer.from(subdomain, 'ascii').copy(buf, 0, 0, Math.min(subdomain.length, 15))

	buf.writeUInt8(msgType, 16)
	buf.writeUInt8(0x00, 17) // sourceCommunicationTechnology
	Buffer.from(uuid, 'hex').copy(buf, 18) // sourceUuid (6 bytes)
	buf.writeUInt16BE(portId, 24) // sourcePortId
	buf.writeUInt16BE(sequence, 26) // sequenceId
	buf.writeUInt8(control, 28) // control
	buf.writeUInt16BE(flags, 30) // flags
	buf.writeUInt32BE(tsSeconds >>> 0, 32) // timestamp seconds (uint32)
	buf.writeInt32BE(tsNanos, 36) // timestamp nanoseconds (int32, signed)

	return buf
}

const makeSyncPacket = (opts: PacketOpts = {}) => makePacket({ ...opts, msgType: MSG_SYNC })
const makeFollowUp = (opts: PacketOpts = {}) => makePacket({ ...opts, msgType: MSG_FOLLOW_UP })
const makeDelayResp = (opts: PacketOpts = {}) => makePacket({ ...opts, msgType: MSG_DELAY_RESP })

// Default rinfo
const rinfo = { address: '192.168.1.1', family: 'IPv4', port: 319, size: 44 }

// ---------------------------------------------------------------------------
// Socket helpers
// ---------------------------------------------------------------------------

const eventSocket = () => mockSockets[mockSockets.length - 2]
const generalSocket = () => mockSockets[mockSockets.length - 1]

const makeClient = async (iface = '0.0.0.0', subdomain = '_DFLT', interval = 125) => {
	const client = new PTPv1Client(iface, subdomain, interval)
	await new Promise<void>((r) => setImmediate(r))
	await new Promise<void>((r) => setImmediate(r))
	return client
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
	mockSockets = []
	vi.clearAllMocks()
})

afterEach(() => {
	vi.useRealTimers()
})

// ===========================================================================
// Constructor – iface validation
// ===========================================================================

describe('constructor – iface validation', () => {
	it('accepts a valid unicast IPv4 address', () => {
		expect(() => new PTPv1Client('192.168.1.10')).not.toThrow()
	})

	it('accepts 0.0.0.0 (all interfaces)', () => {
		expect(() => new PTPv1Client('0.0.0.0')).not.toThrow()
	})

	it('accepts loopback', () => {
		expect(() => new PTPv1Client('127.0.0.1')).not.toThrow()
	})

	it('defaults to 0.0.0.0 when no iface is supplied', async () => {
		const client = await makeClient()
		expect(eventSocket().bind).toHaveBeenCalledWith(319, '0.0.0.0')
		expect(generalSocket().bind).toHaveBeenCalledWith(320, '0.0.0.0')
		client.destroy()
	})

	it('throws TypeError for an empty string', () => {
		expect(() => new PTPv1Client('')).toThrow(TypeError)
	})

	it('throws TypeError for a hostname', () => {
		expect(() => new PTPv1Client('eth0')).toThrow(TypeError)
	})

	it('throws TypeError for an IPv6 address', () => {
		expect(() => new PTPv1Client('::1')).toThrow(TypeError)
	})

	it('throws TypeError for a partial address', () => {
		expect(() => new PTPv1Client('10.0.0')).toThrow(TypeError)
	})

	it('throws TypeError for an out-of-range octet', () => {
		expect(() => new PTPv1Client('256.0.0.1')).toThrow(TypeError)
	})

	it('throws TypeError for CIDR notation', () => {
		expect(() => new PTPv1Client('10.0.0.0/8')).toThrow(TypeError)
	})

	it('error message contains the invalid value', () => {
		expect(() => new PTPv1Client('not-an-ip')).toThrow(/not-an-ip/)
	})
})

// ===========================================================================
// Constructor – subdomain validation
// ===========================================================================

describe('constructor – subdomain validation', () => {
	it.each([PTP_SUBDOMAIN_DEFAULT, PTP_SUBDOMAIN_ALT1, PTP_SUBDOMAIN_ALT2, PTP_SUBDOMAIN_ALT3, PTP_SUBDOMAIN_ALT4])(
		'accepts well-known subdomain "%s"',
		(sd) => {
			expect(() => new PTPv1Client('0.0.0.0', sd)).not.toThrow()
		},
	)

	it.each([
		['DANTE_SUBDOMAIN_DEFAULT', DANTE_SUBDOMAIN_DEFAULT],
		['DANTE_SUBDOMAIN_PULLUP_441', DANTE_SUBDOMAIN_PULLUP_441],
		['DANTE_SUBDOMAIN_PULLUP_01', DANTE_SUBDOMAIN_PULLUP_01],
		['DANTE_SUBDOMAIN_PULLDOWN_01', DANTE_SUBDOMAIN_PULLDOWN_01],
		['DANTE_SUBDOMAIN_PULLDOWN_48', DANTE_SUBDOMAIN_PULLDOWN_48],
	])('accepts Dante constant %s ("%s")', (_name, sd) => {
		expect(() => new PTPv1Client('0.0.0.0', sd)).not.toThrow()
	})

	it('accepts a custom ASCII subdomain', () => {
		expect(() => new PTPv1Client('0.0.0.0', 'MYCLOCK')).not.toThrow()
	})

	it('accepts a single-character subdomain', () => {
		expect(() => new PTPv1Client('0.0.0.0', 'X')).not.toThrow()
	})

	it('accepts exactly 15 characters (maximum)', () => {
		expect(() => new PTPv1Client('0.0.0.0', 'ABCDEFGHIJKLMNO')).not.toThrow()
	})

	it('accepts printable ASCII including symbols', () => {
		expect(() => new PTPv1Client('0.0.0.0', 'PTP-CLOCK_01')).not.toThrow()
	})

	it('rejects an empty subdomain', () => {
		expect(() => new PTPv1Client('0.0.0.0', '')).toThrow(TypeError)
	})

	it('rejects a subdomain exceeding 15 characters', () => {
		expect(() => new PTPv1Client('0.0.0.0', 'ABCDEFGHIJKLMNOP')).toThrow(TypeError)
	})

	it('error message mentions max length when subdomain is too long', () => {
		expect(() => new PTPv1Client('0.0.0.0', 'ABCDEFGHIJKLMNOP')).toThrow(/15/)
	})

	it('rejects a subdomain containing a non-printable character (tab)', () => {
		expect(() => new PTPv1Client('0.0.0.0', 'BAD\tSUBDOMAIN')).toThrow(TypeError)
	})

	it('rejects a subdomain containing a newline', () => {
		expect(() => new PTPv1Client('0.0.0.0', 'BAD\nSUBDOMAIN')).toThrow(TypeError)
	})

	it('rejects a subdomain containing a null byte', () => {
		expect(() => new PTPv1Client('0.0.0.0', 'BAD\x00SUB')).toThrow(TypeError)
	})

	it('rejects a subdomain containing non-ASCII characters', () => {
		expect(() => new PTPv1Client('0.0.0.0', 'café')).toThrow(TypeError)
	})

	it('stores and exposes the configured subdomain via ptp_subdomain', async () => {
		const client = await makeClient('0.0.0.0', 'MYCLOCK')
		expect(client.ptp_subdomain).toBe('MYCLOCK')
		client.destroy()
	})

	it('defaults to _DFLT when no subdomain is supplied', async () => {
		const client = await makeClient()
		expect(client.ptp_subdomain).toBe('_DFLT')
		client.destroy()
	})
})

// ===========================================================================
// Constructor – interval validation
// ===========================================================================

describe('constructor – interval parameter', () => {
	it('accepts 125ms (minimum)', () => {
		expect(() => new PTPv1Client('0.0.0.0', '_DFLT', 125)).not.toThrow()
	})

	it('accepts values above minimum', () => {
		expect(() => new PTPv1Client('0.0.0.0', '_DFLT', 5000)).not.toThrow()
	})

	it('ignores values below 125ms and keeps 10000ms default', async () => {
		const client = await makeClient('0.0.0.0', '_DFLT', 50)
		expect(client).toBeTruthy()
		client.destroy()
	})
})

// ===========================================================================
// Socket setup
// ===========================================================================

describe('socket setup', () => {
	it('always joins the single PTPv1 multicast address 224.0.1.129', async () => {
		const client = await makeClient()
		expect(eventSocket().addMembership).toHaveBeenCalledWith('224.0.1.129', '0.0.0.0')
		expect(generalSocket().addMembership).toHaveBeenCalledWith('224.0.1.129', '0.0.0.0')
		client.destroy()
	})

	it('two clients with different subdomains still join the same multicast address', async () => {
		const clientA = await makeClient('0.0.0.0', '_DFLT')
		const clientB = await makeClient('0.0.0.0', '_ALT1')
		const esA = mockSockets[0]
		const esB = mockSockets[2]
		expect(esA.addMembership).toHaveBeenCalledWith('224.0.1.129', '0.0.0.0')
		expect(esB.addMembership).toHaveBeenCalledWith('224.0.1.129', '0.0.0.0')
		clientA.destroy()
		clientB.destroy()
	})

	it('binds event socket to port 319 on the supplied address', async () => {
		const client = await makeClient('10.0.0.1')
		expect(eventSocket().bind).toHaveBeenCalledWith(319, '10.0.0.1')
		client.destroy()
	})

	it('binds general socket to port 320 on the supplied address', async () => {
		const client = await makeClient('10.0.0.1')
		expect(generalSocket().bind).toHaveBeenCalledWith(320, '10.0.0.1')
		client.destroy()
	})
})

// ===========================================================================
// Initial state
// ===========================================================================

describe('initial state', () => {
	it('is_synced is false before any exchange', async () => {
		const client = await makeClient()
		expect(client.is_synced).toBe(false)
		client.destroy()
	})

	it('ptp_master returns empty strings before any message', async () => {
		const client = await makeClient()
		expect(client.ptp_master).toEqual(['', ''])
		client.destroy()
	})

	it('last_sync is 0 before any exchange', async () => {
		const client = await makeClient()
		expect(client.last_sync).toBe(0)
		client.destroy()
	})

	it('ptp_time returns a valid [s, ns] tuple immediately', async () => {
		const client = await makeClient()
		const [s, ns] = client.ptp_time
		expect(s).toBeGreaterThanOrEqual(0)
		expect(ns).toBeGreaterThanOrEqual(0)
		expect(ns).toBeLessThan(1_000_000_000)
		client.destroy()
	})
})

// ===========================================================================
// Event socket – message filtering
// ===========================================================================

describe('event socket – message filtering', () => {
	it('ignores packets shorter than 32 bytes', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('ptp_master_changed', spy)
		eventSocket().emit('message', Buffer.alloc(10), rinfo)
		expect(spy).not.toHaveBeenCalled()
		client.destroy()
	})

	it('ignores non-Sync message types on the event socket', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('ptp_master_changed', spy)
		// Follow_Up arriving on the event socket should be ignored
		eventSocket().emit('message', makeFollowUp(), rinfo)
		expect(spy).not.toHaveBeenCalled()
		client.destroy()
	})

	it('ignores Sync messages from a different subdomain', async () => {
		const client = await makeClient('0.0.0.0', '_DFLT')
		const spy = vi.fn()
		client.on('ptp_master_changed', spy)
		eventSocket().emit('message', makeSyncPacket({ subdomain: '_ALT1' }), rinfo)
		expect(spy).not.toHaveBeenCalled()
		client.destroy()
	})

	it('processes Sync messages that match the configured subdomain', async () => {
		const client = await makeClient('0.0.0.0', '_DFLT')
		const spy = vi.fn()
		client.on('ptp_master_changed', spy)
		eventSocket().emit('message', makeSyncPacket({ subdomain: '_DFLT' }), rinfo)
		expect(spy).toHaveBeenCalledOnce()
		client.destroy()
	})

	it('emits ptp_master_changed with correct master identity on first Sync', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('ptp_master_changed', spy)
		eventSocket().emit('message', makeSyncPacket({ uuid: 'aabbccddeeff', portId: 1, flags: FLAG_ASSIST }), rinfo)
		const [masterId, addr, synced] = spy.mock.calls[0]
		expect(masterId).toBe('aa-bb-cc-dd-ee-ff:1')
		expect(addr).toBe('192.168.1.1')
		expect(synced).toBe(false)
		client.destroy()
	})

	it('does not re-emit ptp_master_changed for the same source', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('ptp_master_changed', spy)
		eventSocket().emit('message', makeSyncPacket({ flags: FLAG_ASSIST, sequence: 1 }), rinfo)
		eventSocket().emit('message', makeSyncPacket({ flags: FLAG_ASSIST, sequence: 2 }), rinfo)
		expect(spy).toHaveBeenCalledOnce()
		client.destroy()
	})

	it('re-emits ptp_master_changed when UUID changes', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('ptp_master_changed', spy)
		eventSocket().emit('message', makeSyncPacket({ flags: FLAG_ASSIST, uuid: 'aabbccddeeff' }), rinfo)
		eventSocket().emit('message', makeSyncPacket({ flags: FLAG_ASSIST, uuid: '112233445566' }), rinfo)
		expect(spy).toHaveBeenCalledTimes(2)
		client.destroy()
	})

	it('re-emits ptp_master_changed when portId changes', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('ptp_master_changed', spy)
		eventSocket().emit('message', makeSyncPacket({ flags: FLAG_ASSIST, portId: 1 }), rinfo)
		eventSocket().emit('message', makeSyncPacket({ flags: FLAG_ASSIST, portId: 2 }), rinfo)
		expect(spy).toHaveBeenCalledTimes(2)
		client.destroy()
	})

	it('still tracks subdomain from packets with a non-matching subdomain', async () => {
		const client = await makeClient('0.0.0.0', '_DFLT')
		const spy = vi.fn()
		client.on('subdomains', spy)
		eventSocket().emit('message', makeSyncPacket({ subdomain: '_ALT2' }), rinfo)
		expect(spy).toHaveBeenCalled()
		client.destroy()
	})
})

// ===========================================================================
// General socket – message filtering
// ===========================================================================

describe('general socket – message filtering', () => {
	it('ignores packets shorter than 32 bytes', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('ptp_time_synced', spy)
		generalSocket().emit('message', Buffer.alloc(10), rinfo)
		expect(spy).not.toHaveBeenCalled()
		client.destroy()
	})

	it('ignores packets shorter than 40 bytes (no timestamp fields)', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('ptp_time_synced', spy)
		generalSocket().emit('message', Buffer.alloc(36), rinfo)
		expect(spy).not.toHaveBeenCalled()
		client.destroy()
	})

	it('ignores Follow_Up from a different subdomain', async () => {
		const client = await makeClient('0.0.0.0', '_DFLT')
		const spy = vi.fn()
		client.on('ptp_time_synced', spy)
		eventSocket().emit('message', makeSyncPacket({ flags: FLAG_ASSIST, sequence: 1 }), rinfo)
		generalSocket().emit('message', makeFollowUp({ subdomain: '_ALT3', sequence: 1 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		generalSocket().emit('message', makeDelayResp({ subdomain: '_ALT3', sequence: 1 }), rinfo)
		expect(spy).not.toHaveBeenCalled()
		client.destroy()
	})

	it('ignores Follow_Up with a mismatched sequence number', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('ptp_time_synced', spy)
		eventSocket().emit('message', makeSyncPacket({ flags: FLAG_ASSIST, sequence: 5 }), rinfo)
		generalSocket().emit('message', makeFollowUp({ sequence: 99 }), rinfo)
		expect(spy).not.toHaveBeenCalled()
		client.destroy()
	})

	it('ignores Delay_Resp with a mismatched sequence number', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('ptp_time_synced', spy)
		eventSocket().emit('message', makeSyncPacket({ flags: FLAG_ASSIST, sequence: 1 }), rinfo)
		generalSocket().emit('message', makeFollowUp({ sequence: 1 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		// send req_seq=1, respond with seq=99
		generalSocket().emit('message', makeDelayResp({ sequence: 99 }), rinfo)
		expect(spy).not.toHaveBeenCalled()
		client.destroy()
	})
})

// ===========================================================================
// Full two-step sync flow (Sync + Follow_Up + Delay_Resp)
// ===========================================================================

describe('two-step sync flow', () => {
	const runTwoStepSync = async (client: InstanceType<typeof PTPv1Client>, seq = 1) => {
		eventSocket().emit('message', makeSyncPacket({ flags: FLAG_ASSIST, sequence: seq }), rinfo)
		generalSocket().emit('message', makeFollowUp({ sequence: seq, tsSeconds: 1700000000, tsNanos: 500_000_000 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		generalSocket().emit('message', makeDelayResp({ sequence: 1, tsSeconds: 1700000000, tsNanos: 600_000_000 }), rinfo)
	}

	it('emits ptp_time_synced after a complete exchange', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('ptp_time_synced', spy)
		await runTwoStepSync(client)
		expect(spy).toHaveBeenCalledOnce()
		client.destroy()
	})

	it('emits sync_changed true after a complete exchange', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('sync_changed', spy)
		await runTwoStepSync(client)
		expect(spy).toHaveBeenCalledWith(true)
		client.destroy()
	})

	it('is_synced becomes true after a complete exchange', async () => {
		const client = await makeClient()
		await runTwoStepSync(client)
		expect(client.is_synced).toBe(true)
		client.destroy()
	})

	it('last_sync is updated after a complete exchange', async () => {
		const client = await makeClient()
		const before = Date.now()
		await runTwoStepSync(client)
		expect(client.last_sync).toBeGreaterThanOrEqual(before)
		client.destroy()
	})

	it('ptp_time_synced payload contains valid [s, ns] and lastSync', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('ptp_time_synced', spy)
		await runTwoStepSync(client)
		const [time, lastSync] = spy.mock.calls[0] as [PtpTime, number]
		expect(time[1]).toBeGreaterThanOrEqual(0)
		expect(time[1]).toBeLessThan(1_000_000_000)
		expect(lastSync).toBeGreaterThan(0)
		client.destroy()
	})
})

// ===========================================================================
// Full one-step sync flow (Sync only, no Follow_Up)
// ===========================================================================

describe('one-step sync flow', () => {
	it('completes sync using only Sync + Delay_Resp', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('sync_changed', spy)

		// No FLAG_ASSIST → timestamp is embedded in the Sync message
		eventSocket().emit(
			'message',
			makeSyncPacket({
				flags: 0x0000,
				sequence: 3,
				tsSeconds: 1700000010,
				tsNanos: 100_000_000,
			}),
			rinfo,
		)
		await new Promise<void>((r) => setImmediate(r))
		generalSocket().emit('message', makeDelayResp({ sequence: 1, tsSeconds: 1700000010, tsNanos: 200_000_000 }), rinfo)

		expect(spy).toHaveBeenCalledWith(true)
		expect(client.is_synced).toBe(true)
		client.destroy()
	})

	it('does not send a delay_req in one-step mode for a packet with <40 bytes', async () => {
		const client = await makeClient()
		// Truncate the packet so it has 32 bytes (valid header) but no timestamp
		const truncated = makeSyncPacket({ flags: 0x0000, sequence: 1 }).subarray(0, 32)
		eventSocket().emit('message', truncated, rinfo)
		await new Promise<void>((r) => setImmediate(r))
		expect(eventSocket().send).not.toHaveBeenCalled()
		client.destroy()
	})
})

// ===========================================================================
// delay_req packet format
// ===========================================================================

describe('delay_req packet format', () => {
	it('sends a delay_req after a two-step Follow_Up', async () => {
		const client = await makeClient()
		eventSocket().emit('message', makeSyncPacket({ flags: FLAG_ASSIST, sequence: 1 }), rinfo)
		generalSocket().emit('message', makeFollowUp({ sequence: 1 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		expect(eventSocket().send).toHaveBeenCalledOnce()
		client.destroy()
	})

	it('sends delay_req to the PTPv1 multicast address 224.0.1.129', async () => {
		const client = await makeClient()
		eventSocket().emit('message', makeSyncPacket({ flags: FLAG_ASSIST, sequence: 1 }), rinfo)
		generalSocket().emit('message', makeFollowUp({ sequence: 1 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		expect(eventSocket().send.mock.calls[0][2]).toBe('224.0.1.129')
		client.destroy()
	})

	it('delay_req contains the correct messageType byte (0x02)', async () => {
		const client = await makeClient()
		eventSocket().emit('message', makeSyncPacket({ flags: FLAG_ASSIST, sequence: 1 }), rinfo)
		generalSocket().emit('message', makeFollowUp({ sequence: 1 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		const sent: Buffer = eventSocket().send.mock.calls[0][0]
		expect(sent.readUInt8(16)).toBe(0x02)
		client.destroy()
	})

	it('delay_req contains the correct control byte (0x01)', async () => {
		const client = await makeClient()
		eventSocket().emit('message', makeSyncPacket({ flags: FLAG_ASSIST, sequence: 1 }), rinfo)
		generalSocket().emit('message', makeFollowUp({ sequence: 1 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		const sent: Buffer = eventSocket().send.mock.calls[0][0]
		expect(sent.readUInt8(28)).toBe(CTRL_DELAY_REQ)
		client.destroy()
	})

	it('delay_req contains the configured subdomain in bytes 0-15', async () => {
		const client = await makeClient('0.0.0.0', '_ALT2')
		eventSocket().emit('message', makeSyncPacket({ subdomain: '_ALT2', flags: FLAG_ASSIST, sequence: 1 }), rinfo)
		generalSocket().emit('message', makeFollowUp({ subdomain: '_ALT2', sequence: 1 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		const sent: Buffer = eventSocket().send.mock.calls[0][0]
		const subdomainBytes = sent.toString('ascii', 0, 16).replace(/\0+$/, '')
		expect(subdomainBytes).toBe('_ALT2')
		client.destroy()
	})

	it('delay_req sequence increments on each send', async () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		const client = await makeClient()

		for (let seq = 1; seq <= 3; seq++) {
			eventSocket().emit('message', makeSyncPacket({ flags: FLAG_ASSIST, sequence: seq }), rinfo)
			generalSocket().emit('message', makeFollowUp({ sequence: seq }), rinfo)
			await new Promise<void>((r) => setImmediate(r))
			const reqSeq = eventSocket().send.mock.calls[seq - 1][0]
			generalSocket().emit('message', makeDelayResp({ sequence: reqSeq.readUInt16BE(26) }), rinfo)
			// Advance Date.now() past minSyncInterval so the next iteration is not blocked by the guard
			vi.advanceTimersByTime(200)
		}

		const seqs = eventSocket().send.mock.calls.map((c) => c[0].readUInt16BE(26))
		expect(seqs).toEqual([1, 2, 3])
		client.destroy()
	})

	it('delay_req is sent exactly once per Follow_Up (not before setImmediate)', async () => {
		const client = await makeClient()
		eventSocket().emit('message', makeSyncPacket({ flags: FLAG_ASSIST, sequence: 1 }), rinfo)
		generalSocket().emit('message', makeFollowUp({ sequence: 1 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		expect(eventSocket().send).toHaveBeenCalledOnce()
		client.destroy()
	})
})

// ===========================================================================
// Signed nanoseconds (int32) handling
// ===========================================================================

describe('signed nanoseconds in PTPv1 timestamps', () => {
	it('accepts a timestamp with positive nanoseconds', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('ptp_time_synced', spy)
		eventSocket().emit('message', makeSyncPacket({ flags: FLAG_ASSIST, sequence: 1 }), rinfo)
		generalSocket().emit('message', makeFollowUp({ sequence: 1, tsSeconds: 1000, tsNanos: 500_000_000 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		generalSocket().emit('message', makeDelayResp({ sequence: 1, tsSeconds: 1000, tsNanos: 600_000_000 }), rinfo)
		expect(spy).toHaveBeenCalled()
		const [_t, _l] = spy.mock.calls[0] as [PtpTime, number]
		const [, ns] = client.ptp_time
		expect(ns).toBeGreaterThanOrEqual(0)
		expect(ns).toBeLessThan(1_000_000_000)
		client.destroy()
	})

	it('handles a negative nanoseconds value (signed int32 correction)', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('ptp_time_synced', spy)
		// tsNanos = -1 is a valid signed int32 in PTPv1 (correction timestamp)
		eventSocket().emit('message', makeSyncPacket({ flags: FLAG_ASSIST, sequence: 1 }), rinfo)
		generalSocket().emit('message', makeFollowUp({ sequence: 1, tsSeconds: 1700000000, tsNanos: -1 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		generalSocket().emit('message', makeDelayResp({ sequence: 1, tsSeconds: 1700000000, tsNanos: 100_000_000 }), rinfo)
		expect(spy).toHaveBeenCalled()
		const [, ns] = client.ptp_time
		expect(ns).toBeGreaterThanOrEqual(0)
		expect(ns).toBeLessThan(1_000_000_000)
		client.destroy()
	})

	it('handles maximum positive nanoseconds (999999999)', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('ptp_time_synced', spy)
		eventSocket().emit('message', makeSyncPacket({ flags: FLAG_ASSIST, sequence: 1 }), rinfo)
		generalSocket().emit('message', makeFollowUp({ sequence: 1, tsSeconds: 1700000000, tsNanos: 999_999_999 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		generalSocket().emit('message', makeDelayResp({ sequence: 1, tsSeconds: 1700000000, tsNanos: 999_999_999 }), rinfo)
		expect(spy).toHaveBeenCalled()
		const [, ns] = client.ptp_time
		expect(ns).toBeGreaterThanOrEqual(0)
		expect(ns).toBeLessThan(1_000_000_000)
		client.destroy()
	})
})

// ===========================================================================
// 32-bit timestamp range
// ===========================================================================

describe('32-bit timestamp seconds range', () => {
	it('handles seconds = 0', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('ptp_time_synced', spy)
		eventSocket().emit('message', makeSyncPacket({ flags: FLAG_ASSIST, sequence: 1 }), rinfo)
		generalSocket().emit('message', makeFollowUp({ sequence: 1, tsSeconds: 0, tsNanos: 0 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		generalSocket().emit('message', makeDelayResp({ sequence: 1, tsSeconds: 0, tsNanos: 0 }), rinfo)
		expect(spy).toHaveBeenCalled()
		client.destroy()
	})

	it('handles maximum uint32 seconds (0xFFFFFFFF ≈ year 2106)', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('ptp_time_synced', spy)
		eventSocket().emit('message', makeSyncPacket({ flags: FLAG_ASSIST, sequence: 1 }), rinfo)
		generalSocket().emit('message', makeFollowUp({ sequence: 1, tsSeconds: 0xffffffff, tsNanos: 0 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		generalSocket().emit('message', makeDelayResp({ sequence: 1, tsSeconds: 0xffffffff, tsNanos: 0 }), rinfo)
		expect(spy).toHaveBeenCalled()
		const [, ns] = client.ptp_time
		expect(ns).toBeGreaterThanOrEqual(0)
		expect(ns).toBeLessThan(1_000_000_000)
		client.destroy()
	})
})

// ===========================================================================
// ptp_time normalisation
// ===========================================================================

describe('ptp_time nanosecond normalisation', () => {
	it('nanoseconds are always in [0, 1_000_000_000) across many sync cycles', async () => {
		for (let i = 0; i < 20; i++) {
			const client = await makeClient('0.0.0.0', '_DFLT', 125)

			eventSocket().emit('message', makeSyncPacket({ flags: FLAG_ASSIST, sequence: i }), rinfo)
			generalSocket().emit(
				'message',
				makeFollowUp({
					sequence: i,
					tsSeconds: 1700000000 + i,
					tsNanos: (i * 137_000_000) % 1_000_000_000,
				}),
				rinfo,
			)
			await new Promise<void>((r) => setImmediate(r))
			generalSocket().emit(
				'message',
				makeDelayResp({
					sequence: 1,
					tsSeconds: 1700000000 + i,
					tsNanos: ((i + 1) * 137_000_000) % 1_000_000_000,
				}),
				rinfo,
			)

			const [, ns] = client.ptp_time
			expect(ns, `iteration ${i}`).toBeGreaterThanOrEqual(0)
			expect(ns, `iteration ${i}`).toBeLessThan(1_000_000_000)

			client.destroy()
			mockSockets = []
			vi.clearAllMocks()
		}
	})
})

// ===========================================================================
// Negative delta (local clock ahead of master)
// ===========================================================================

describe('negative delta handling', () => {
	it('produces valid ptp_time when local clock is ahead of master', async () => {
		const client = await makeClient()

		eventSocket().emit('message', makeSyncPacket({ flags: FLAG_ASSIST, sequence: 1 }), rinfo)
		generalSocket().emit(
			'message',
			// large t1 → negative delta when ts1 < t1
			makeFollowUp({ sequence: 1, tsSeconds: 1700000020, tsNanos: 999_000_000 }),
			rinfo,
		)
		await new Promise<void>((r) => setImmediate(r))
		generalSocket().emit('message', makeDelayResp({ sequence: 1, tsSeconds: 1700000021, tsNanos: 0 }), rinfo)

		const [s, ns] = client.ptp_time
		expect(s).toBeGreaterThanOrEqual(0)
		expect(ns).toBeGreaterThanOrEqual(0)
		expect(ns).toBeLessThan(1_000_000_000)
		client.destroy()
	})
})

// ===========================================================================
// subdomain filtering correctness
// ===========================================================================

describe('subdomain filtering', () => {
	it('processes packets from the configured subdomain and ignores others', async () => {
		const client = await makeClient('0.0.0.0', '_ALT1')
		const masterSpy = vi.fn()
		const syncedSpy = vi.fn()
		client.on('ptp_master_changed', masterSpy)
		client.on('ptp_time_synced', syncedSpy)

		// Wrong subdomain — should be silently ignored
		eventSocket().emit('message', makeSyncPacket({ subdomain: '_DFLT', flags: FLAG_ASSIST }), rinfo)
		// Correct subdomain — should be processed
		eventSocket().emit('message', makeSyncPacket({ subdomain: '_ALT1', flags: FLAG_ASSIST, sequence: 1 }), rinfo)
		generalSocket().emit('message', makeFollowUp({ subdomain: '_ALT1', sequence: 1 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		generalSocket().emit('message', makeDelayResp({ subdomain: '_ALT1', sequence: 1 }), rinfo)

		expect(masterSpy).toHaveBeenCalledOnce()
		expect(syncedSpy).toHaveBeenCalledOnce()
		client.destroy()
	})

	it('subdomain matching is exact — a prefix of the configured name is rejected', async () => {
		const client = await makeClient('0.0.0.0', '_DFLT')
		const spy = vi.fn()
		client.on('ptp_master_changed', spy)
		// '_DFL' is a valid prefix but not the same as '_DFLT'
		eventSocket().emit('message', makeSyncPacket({ subdomain: '_DFL', flags: FLAG_ASSIST }), rinfo)
		expect(spy).not.toHaveBeenCalled()
		client.destroy()
	})

	it('subdomain matching is exact — a suffix with trailing chars is rejected', async () => {
		const client = await makeClient('0.0.0.0', '_DFLT')
		const spy = vi.fn()
		client.on('ptp_master_changed', spy)
		eventSocket().emit('message', makeSyncPacket({ subdomain: '_DFLTX', flags: FLAG_ASSIST }), rinfo)
		expect(spy).not.toHaveBeenCalled()
		client.destroy()
	})
})

// ===========================================================================
// sync_changed deduplication
// ===========================================================================

describe('sync_changed deduplication', () => {
	it('only emits sync_changed true on the first transition', async () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		const client = await makeClient()
		const spy = vi.fn()
		client.on('sync_changed', spy)

		for (let seq = 1; seq <= 3; seq++) {
			eventSocket().emit('message', makeSyncPacket({ flags: FLAG_ASSIST, sequence: seq }), rinfo)
			generalSocket().emit('message', makeFollowUp({ sequence: seq }), rinfo)
			await new Promise<void>((r) => setImmediate(r))
			generalSocket().emit('message', makeDelayResp({ sequence: seq }), rinfo)
			// Advance Date.now() past minSyncInterval so the next iteration is not blocked by the guard
			vi.advanceTimersByTime(200)
		}

		const trueEvents = spy.mock.calls.filter(([v]) => v === true)
		expect(trueEvents).toHaveLength(1)
		client.destroy()
	})
})

// ===========================================================================
// ptp_master getter
// ===========================================================================

describe('ptp_master getter', () => {
	it('reflects the most recently seen master UUID and port', async () => {
		const client = await makeClient()
		eventSocket().emit('message', makeSyncPacket({ uuid: '112233445566', portId: 7, flags: FLAG_ASSIST }), {
			...rinfo,
			address: '10.10.10.10',
		})
		const [id, addr] = client.ptp_master
		expect(id).toBe('11-22-33-44-55-66:7')
		expect(addr).toBe('10.10.10.10')
		client.destroy()
	})

	it('updates when a new master is seen', async () => {
		const client = await makeClient()
		eventSocket().emit('message', makeSyncPacket({ uuid: 'aabbccddeeff', portId: 1, flags: FLAG_ASSIST }), rinfo)
		eventSocket().emit('message', makeSyncPacket({ uuid: '001122334455', portId: 2, flags: FLAG_ASSIST }), {
			...rinfo,
			address: '10.0.0.2',
		})
		const [id, addr] = client.ptp_master
		expect(id).toBe('00-11-22-33-44-55:2')
		expect(addr).toBe('10.0.0.2')
		client.destroy()
	})
})

// ===========================================================================
// Dante subdomain constants
// ===========================================================================

describe('Dante subdomain constants', () => {
	// Verify the exported aliases resolve to the correct underlying strings
	it('DANTE_SUBDOMAIN_DEFAULT maps to _DFLT', () => {
		expect(DANTE_SUBDOMAIN_DEFAULT).toBe('_DFLT')
	})

	it('DANTE_SUBDOMAIN_PULLUP_441 maps to _ALT1', () => {
		expect(DANTE_SUBDOMAIN_PULLUP_441).toBe('_ALT1')
	})

	it('DANTE_SUBDOMAIN_PULLUP_01 maps to _ALT2', () => {
		expect(DANTE_SUBDOMAIN_PULLUP_01).toBe('_ALT2')
	})

	it('DANTE_SUBDOMAIN_PULLDOWN_01 maps to _ALT3', () => {
		expect(DANTE_SUBDOMAIN_PULLDOWN_01).toBe('_ALT3')
	})

	it('DANTE_SUBDOMAIN_PULLDOWN_48 maps to _ALT4', () => {
		expect(DANTE_SUBDOMAIN_PULLDOWN_48).toBe('_ALT4')
	})

	// Verify each Dante subdomain can receive and complete a full sync exchange
	it.each([
		['standard rate (_DFLT)', DANTE_SUBDOMAIN_DEFAULT],
		['44.1kHz pull-up +4.1667% (_ALT1)', DANTE_SUBDOMAIN_PULLUP_441],
		['pull-up +0.1% (_ALT2)', DANTE_SUBDOMAIN_PULLUP_01],
		['pull-down -0.1% (_ALT3)', DANTE_SUBDOMAIN_PULLDOWN_01],
		['48kHz pull-down -4% (_ALT4)', DANTE_SUBDOMAIN_PULLDOWN_48],
	])('completes a full sync on Dante subdomain: %s', async (_label, subdomain) => {
		const client = await makeClient('0.0.0.0', subdomain)
		const syncSpy = vi.fn()
		const timeSpy = vi.fn()
		client.on('sync_changed', syncSpy)
		client.on('ptp_time_synced', timeSpy)

		eventSocket().emit('message', makeSyncPacket({ subdomain, flags: FLAG_ASSIST, sequence: 1 }), rinfo)
		generalSocket().emit(
			'message',
			makeFollowUp({ subdomain, sequence: 1, tsSeconds: 1700000000, tsNanos: 500_000_000 }),
			rinfo,
		)
		await new Promise<void>((r) => setImmediate(r))
		generalSocket().emit(
			'message',
			makeDelayResp({ subdomain, sequence: 1, tsSeconds: 1700000000, tsNanos: 600_000_000 }),
			rinfo,
		)

		expect(syncSpy).toHaveBeenCalledWith(true)
		expect(timeSpy).toHaveBeenCalledOnce()
		expect(client.is_synced).toBe(true)
		const [, ns] = client.ptp_time
		expect(ns).toBeGreaterThanOrEqual(0)
		expect(ns).toBeLessThan(1_000_000_000)

		client.destroy()
		mockSockets = []
		vi.clearAllMocks()
	})

	it('two Dante subdomains remain isolated from each other', async () => {
		// Client A listens on _DFLT, client B on _ALT4.
		// Traffic destined for _ALT4 should not trigger a sync on the _DFLT client.
		const clientA = await makeClient('0.0.0.0', DANTE_SUBDOMAIN_DEFAULT)
		const clientB = await makeClient('0.0.0.0', DANTE_SUBDOMAIN_PULLDOWN_48)

		const esA = mockSockets[0]
		const gsA = mockSockets[1]
		const esB = mockSockets[2]
		const gsB = mockSockets[3]

		const syncSpyA = vi.fn()
		const syncSpyB = vi.fn()
		clientA.on('sync_changed', syncSpyA)
		clientB.on('sync_changed', syncSpyB)

		// Drive a full sync on _ALT4 only
		esB.emit('message', makeSyncPacket({ subdomain: '_ALT4', flags: FLAG_ASSIST, sequence: 1 }), rinfo)
		gsB.emit('message', makeFollowUp({ subdomain: '_ALT4', sequence: 1 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		gsB.emit('message', makeDelayResp({ subdomain: '_ALT4', sequence: 1 }), rinfo)

		// Also inject the same packets into client A's sockets — it should ignore them
		esA.emit('message', makeSyncPacket({ subdomain: '_ALT4', flags: FLAG_ASSIST, sequence: 1 }), rinfo)
		gsA.emit('message', makeFollowUp({ subdomain: '_ALT4', sequence: 1 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		gsA.emit('message', makeDelayResp({ subdomain: '_ALT4', sequence: 1 }), rinfo)

		expect(clientB.is_synced).toBe(true)
		expect(clientA.is_synced).toBe(false) // _DFLT client must not have synced

		clientA.destroy()
		clientB.destroy()
	})
})

// ===========================================================================
// destroy()
// ===========================================================================

describe('destroy()', () => {
	it('emits sync_changed false', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('sync_changed', spy)
		client.destroy()
		expect(spy).toHaveBeenCalledWith(false)
	})

	it('calls close on both sockets', async () => {
		const client = await makeClient()
		const es = eventSocket()
		const gs = generalSocket()
		client.destroy()
		expect(es.close).toHaveBeenCalled()
		expect(gs.close).toHaveBeenCalled()
	})

	it('calls removeAllListeners on both sockets', async () => {
		const client = await makeClient()
		const es = eventSocket()
		const gs = generalSocket()
		client.destroy()
		expect(es.removeAllListeners).toHaveBeenCalled()
		expect(gs.removeAllListeners).toHaveBeenCalled()
	})

	it('emits sync_changed false when destroyed while synced', async () => {
		const client = await makeClient()

		eventSocket().emit('message', makeSyncPacket({ flags: FLAG_ASSIST, sequence: 1 }), rinfo)
		generalSocket().emit('message', makeFollowUp({ sequence: 1 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		generalSocket().emit('message', makeDelayResp({ sequence: 1 }), rinfo)

		expect(client.is_synced).toBe(true)
		const spy = vi.fn()
		client.on('sync_changed', spy)
		client.destroy()
		expect(spy).toHaveBeenCalledWith(false)
		expect(client.is_synced).toBe(false)
	})
})

// ===========================================================================
// Error propagation
// ===========================================================================

describe('error propagation', () => {
	it('re-emits errors from the event socket', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('error', spy)
		const err = new Error('event socket error')
		eventSocket().emit('error', err)
		expect(spy).toHaveBeenCalledWith(err)
		client.destroy()
	})

	it('re-emits errors from the general socket', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('error', spy)
		const err = new Error('general socket error')
		generalSocket().emit('error', err)
		expect(spy).toHaveBeenCalledWith(err)
		client.destroy()
	})

	it('emits an error from send callback if the send fails', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('error', spy)

		// Override send to simulate a failure
		eventSocket().send = vi.fn((_b, _p, _a, cb?: (err: Error | null) => void) => {
			cb?.(new Error('send failed'))
		})

		eventSocket().emit('message', makeSyncPacket({ flags: FLAG_ASSIST, sequence: 1 }), rinfo)
		generalSocket().emit('message', makeFollowUp({ sequence: 1 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))

		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ message: 'send failed' }))
		client.destroy()
	})
})

// ===========================================================================
// listening events
// ===========================================================================

describe('listening events', () => {
	it('emits two listening events (one per socket) after bind', async () => {
		const spy = vi.fn()
		const client = new PTPv1Client()
		client.on('listening', spy)
		await new Promise<void>((r) => setImmediate(r))
		await new Promise<void>((r) => setImmediate(r))
		expect(spy).toHaveBeenCalledTimes(2)
		client.destroy()
	})

	it('listening messages identify which socket is ready', async () => {
		const messages: string[] = []
		const client = new PTPv1Client()
		client.on('listening', (msg: string) => messages.push(msg))
		await new Promise<void>((r) => setImmediate(r))
		await new Promise<void>((r) => setImmediate(r))
		expect(messages.some((m) => m.includes('ptpClientEvent'))).toBe(true)
		expect(messages.some((m) => m.includes('ptpClientGeneral'))).toBe(true)
		client.destroy()
	})
})
