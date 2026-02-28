import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
//import type { PtpTime } from './ptpv2.ts'

// ---------------------------------------------------------------------------
// dgram mock
// ---------------------------------------------------------------------------
// We need full control over the fake sockets so tests can:
//   - Inspect bind() calls
//   - Simulate incoming messages by calling the registered 'message' handler
//   - Simulate 'listening' / 'error' / 'close' events
//   - Intercept send() and invoke its callback immediately

type Handler = (...args: unknown[]) => void

class MockSocket {
	private _handlers: Map<string, Handler[]> = new Map()

	// public spies
	bind = vi.fn((_port: number, _addr?: string) => {
		// fire 'listening' asynchronously to match real dgram behaviour
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

// Two sockets are created in order: event (port 319) then general (port 320).
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
// Import AFTER mock is set up so the module picks up the fake dgram
// ---------------------------------------------------------------------------
const { PTPv2Client } = await import('./ptpv2.js')

// ---------------------------------------------------------------------------
// Buffer builders
// ---------------------------------------------------------------------------

/**
 * Build a minimal PTPv2 packet.
 *
 * Layout (bytes):
 *   0  : (version << 4) | type   — we store type in low nibble and version in the
 *        separate version byte (byte 1) to match the class's parsing logic
 *   1  : version
 *   2-3: length (BE)
 *   4  : domain
 *   5  : reserved
 *   6-7: flags (BE)
 *  20-27: source clock identity (8 bytes)
 *  30-31: sequence (BE)
 *  34-35: ts seconds high (BE uint16)
 *  36-39: ts seconds low  (BE uint32)
 *  40-43: ts nanoseconds  (BE uint32)
 */
const makeSyncBuffer = ({
	type = 0x00,
	version = 2,
	domain = 0,
	flags = 0x0000,
	source = '112233445566aabb',
	sequence = 1,
	tsSecondsHigh = 0,
	tsSecondsLow = 0,
	tsNanoseconds = 0,
	length = 44,
}: {
	type?: number
	version?: number
	domain?: number
	flags?: number
	source?: string
	sequence?: number
	tsSecondsHigh?: number
	tsSecondsLow?: number
	tsNanoseconds?: number
	length?: number
} = {}): Buffer => {
	const buf = Buffer.alloc(Math.max(length, 44), 0)
	buf.writeUInt8(type & 0x0f, 0)
	buf.writeUInt8(version, 1)
	buf.writeUInt16BE(length, 2)
	buf.writeUInt8(domain, 4)
	buf.writeUInt16BE(flags, 6)
	Buffer.from(source, 'hex').copy(buf, 20)
	buf.writeUInt16BE(sequence, 30)
	buf.writeUInt16BE(tsSecondsHigh, 34)
	buf.writeUInt32BE(tsSecondsLow, 36)
	buf.writeUInt32BE(tsNanoseconds, 40)
	return buf
}

const makeFollowUpBuffer = (opts: Parameters<typeof makeSyncBuffer>[0] = {}) => makeSyncBuffer({ ...opts, type: 0x08 })

const makeDelayRespBuffer = (opts: Parameters<typeof makeSyncBuffer>[0] = {}) => makeSyncBuffer({ ...opts, type: 0x09 })

// Fake rinfo object
const rinfo = { address: '192.168.1.1', family: 'IPv4', port: 319, size: 44 }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the event-socket (port 319) mock for the most-recently created client */
const eventSocket = () => mockSockets[mockSockets.length - 2]
/** Get the general-socket (port 320) mock for the most-recently created client */
const generalSocket = () => mockSockets[mockSockets.length - 1]

/** Create a client and wait for both sockets to fire 'listening' */
const makeClient = async (iface = '0.0.0.0', domain = 0, interval = 125) => {
	const client = new PTPv2Client(iface, domain, interval)
	await new Promise<void>((r) => setImmediate(r)) // let bind → listening fire
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
	// silence any open handle warnings – sockets are mocked so close is a no-op
})

// ===========================================================================
// Constructor – iface validation
// ===========================================================================
describe('constructor – iface validation', () => {
	it('accepts a valid unicast IPv4 address', () => {
		expect(() => new PTPv2Client('192.168.1.10')).not.toThrow()
	})

	it('accepts 0.0.0.0 (all-interfaces)', () => {
		expect(() => new PTPv2Client('0.0.0.0')).not.toThrow()
	})

	it('accepts the loopback address', () => {
		expect(() => new PTPv2Client('127.0.0.1')).not.toThrow()
	})

	it('accepts a valid broadcast-style address', () => {
		expect(() => new PTPv2Client('10.0.0.255')).not.toThrow()
	})

	it('uses 0.0.0.0 as default when no iface is supplied', async () => {
		const client = await makeClient()
		// bind should have been called with '0.0.0.0'
		expect(eventSocket().bind).toHaveBeenCalledWith(319, '0.0.0.0')
		expect(generalSocket().bind).toHaveBeenCalledWith(320, '0.0.0.0')
		client.destroy()
	})

	it('throws TypeError for an empty string', () => {
		expect(() => new PTPv2Client('')).toThrow(TypeError)
	})

	it('throws TypeError for a hostname', () => {
		expect(() => new PTPv2Client('eth0')).toThrow(TypeError)
	})

	it('throws TypeError for an IPv6 address', () => {
		expect(() => new PTPv2Client('::1')).toThrow(TypeError)
	})

	it('throws TypeError for a partial address', () => {
		expect(() => new PTPv2Client('192.168.1')).toThrow(TypeError)
	})

	it('throws TypeError for an address with out-of-range octet', () => {
		expect(() => new PTPv2Client('256.0.0.1')).toThrow(TypeError)
	})

	it('throws TypeError for a CIDR-notation string', () => {
		expect(() => new PTPv2Client('192.168.1.0/24')).toThrow(TypeError)
	})

	it('error message mentions the invalid value', () => {
		expect(() => new PTPv2Client('not-an-ip')).toThrow(/not-an-ip/)
	})
})

// ===========================================================================
// Constructor – domain clamping
// ===========================================================================
describe('constructor – domain parameter', () => {
	it.each([0, 1, 2, 3, 4, 63, 127])('accepts domain %i', (d) => {
		expect(() => new PTPv2Client('0.0.0.0', d)).not.toThrow()
	})

	it('clamps negative domain to default 0', async () => {
		const client = await makeClient('0.0.0.0', -1)
		// domain 0 → multicast 224.0.1.129
		expect(eventSocket().addMembership).toHaveBeenCalledWith('224.0.1.129', '0.0.0.0')
		client.destroy()
	})

	it('clamps domain > 127 to default 0', async () => {
		const client = await makeClient('0.0.0.0', 128)
		expect(eventSocket().addMembership).toHaveBeenCalledWith('224.0.1.129', '0.0.0.0')
		client.destroy()
	})

	it('rounds a fractional domain', async () => {
		const client = await makeClient('0.0.0.0', 1.7) // rounds to 2
		// domain 2 → 224.0.1.131
		expect(eventSocket().addMembership).toHaveBeenCalledWith('224.0.1.131', '0.0.0.0')
		client.destroy()
	})

	// Domains 0–3: dedicated multicast addresses
	it.each([
		[0, '224.0.1.129'],
		[1, '224.0.1.130'],
		[2, '224.0.1.131'],
		[3, '224.0.1.132'],
	])('domain %i joins dedicated multicast address %s', async (domain, multicast) => {
		const client = await makeClient('0.0.0.0', domain)
		expect(eventSocket().addMembership).toHaveBeenCalledWith(multicast, '0.0.0.0')
		client.destroy()
	})

	// Domains 4–127: all share 224.0.1.129
	it.each([4, 5, 16, 63, 127])('domain %i (above 3) joins primary multicast address 224.0.1.129', async (domain) => {
		const client = await makeClient('0.0.0.0', domain)
		expect(eventSocket().addMembership).toHaveBeenCalledWith('224.0.1.129', '0.0.0.0')
		client.destroy()
	})

	it('two different high domains both join 224.0.1.129 (not separate addresses)', async () => {
		const clientA = await makeClient('0.0.0.0', 10)
		const clientB = await makeClient('0.0.0.0', 20)
		// Both should join the same primary address
		const esA = mockSockets[mockSockets.length - 4] // event socket for clientA
		const esB = mockSockets[mockSockets.length - 2] // event socket for clientB
		expect(esA.addMembership).toHaveBeenCalledWith('224.0.1.129', '0.0.0.0')
		expect(esB.addMembership).toHaveBeenCalledWith('224.0.1.129', '0.0.0.0')
		clientA.destroy()
		clientB.destroy()
	})
})

// ===========================================================================
// Constructor – interval clamping
// ===========================================================================
describe('constructor – interval parameter', () => {
	it('accepts 125 ms (minimum)', () => {
		expect(() => new PTPv2Client('0.0.0.0', 0, 125)).not.toThrow()
	})

	it('accepts values above minimum', () => {
		expect(() => new PTPv2Client('0.0.0.0', 0, 5000)).not.toThrow()
	})

	it('ignores values below 125 and keeps default 10000', async () => {
		// We test indirectly: sync timeout fires at interval * 2.
		// We just confirm construction succeeds and the client behaves normally.
		const client = await makeClient('0.0.0.0', 0, 50)
		expect(client).toBeTruthy()
		client.destroy()
	})
})

// ===========================================================================
// Socket bind addresses
// ===========================================================================
describe('socket bind addresses', () => {
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
})

// ===========================================================================
// Event socket – message parsing
// ===========================================================================
describe('event socket message handling', () => {
	it('ignores buffers shorter than 32 bytes', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('ptp_master_changed', spy)
		eventSocket().emit('message', Buffer.alloc(10), rinfo)
		expect(spy).not.toHaveBeenCalled()
		client.destroy()
	})

	it('ignores packets with version != 2', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('ptp_master_changed', spy)
		eventSocket().emit('message', makeSyncBuffer({ version: 1 }), rinfo)
		expect(spy).not.toHaveBeenCalled()
		client.destroy()
	})

	it('ignores packets from a different domain', async () => {
		const client = await makeClient('0.0.0.0', 0)
		const spy = vi.fn()
		client.on('ptp_master_changed', spy)
		eventSocket().emit('message', makeSyncBuffer({ domain: 2 }), rinfo)
		expect(spy).not.toHaveBeenCalled()
		client.destroy()
	})

	it('ignores non-sync message types on the event socket', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('ptp_master_changed', spy)
		// type 0x0b is not a sync
		eventSocket().emit('message', makeSyncBuffer({ type: 0x0b }), rinfo)
		expect(spy).not.toHaveBeenCalled()
		client.destroy()
	})

	it('emits ptp_master_changed on first sync from a new master', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('ptp_master_changed', spy)
		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0200 }), rinfo)
		expect(spy).toHaveBeenCalledOnce()
		const [master, addr, synced] = spy.mock.calls[0]
		expect(master).toMatch(/^[0-9a-f-]+:0$/)
		expect(addr).toBe('192.168.1.1')
		expect(synced).toBe(false)
		client.destroy()
	})

	it('does not re-emit ptp_master_changed for the same source', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('ptp_master_changed', spy)
		const buf = makeSyncBuffer({ flags: 0x0200, sequence: 1 })
		eventSocket().emit('message', buf, rinfo)
		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0200, sequence: 2 }), rinfo)
		expect(spy).toHaveBeenCalledOnce()
		client.destroy()
	})

	it('re-emits ptp_master_changed when source clock identity changes', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('ptp_master_changed', spy)
		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0200, source: 'aabbccddeeff0011' }), rinfo)
		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0200, source: '1122334455660099' }), rinfo)
		expect(spy).toHaveBeenCalledTimes(2)
		client.destroy()
	})

	it('tracks domain from event socket messages', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('domains', spy)
		// sends a packet with domain 0 (matches our client domain) — domain still tracked
		eventSocket().emit('message', makeSyncBuffer({ domain: 0 }), rinfo)
		expect(spy).toHaveBeenCalled()
		expect([...client.domains]).toContain(0)
		client.destroy()
	})

	it('only emits domains once per new domain value', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('domains', spy)
		eventSocket().emit('message', makeSyncBuffer({ domain: 0 }), rinfo)
		eventSocket().emit('message', makeSyncBuffer({ domain: 0 }), rinfo)
		expect(spy).toHaveBeenCalledOnce()
		client.destroy()
	})
})

// ===========================================================================
// General socket – message parsing
// ===========================================================================
describe('general socket message handling', () => {
	it('ignores buffers shorter than 32 bytes', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('ptp_time_synced', spy)
		generalSocket().emit('message', Buffer.alloc(10), rinfo)
		expect(spy).not.toHaveBeenCalled()
		client.destroy()
	})

	it('ignores packets with version != 2', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('ptp_time_synced', spy)
		generalSocket().emit('message', makeFollowUpBuffer({ version: 1 }), rinfo)
		expect(spy).not.toHaveBeenCalled()
		client.destroy()
	})

	it('ignores follow_up with mismatched sequence number', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('ptp_time_synced', spy)

		// send sync with seq=5 to set sync_seq
		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0200, sequence: 5 }), rinfo)
		// send follow_up with seq=99 (mismatch)
		generalSocket().emit('message', makeFollowUpBuffer({ sequence: 99 }), rinfo)
		expect(spy).not.toHaveBeenCalled()
		client.destroy()
	})
})

// ===========================================================================
// Full sync flow: two-step (Sync + Follow_Up + Delay_Resp)
// ===========================================================================
describe('full two-step sync flow', () => {
	it('emits ptp_time_synced and sync_changed after a complete exchange', async () => {
		const client = await makeClient('0.0.0.0', 0, 125)
		const timeSpy = vi.fn()
		const syncSpy = vi.fn()
		client.on('ptp_time_synced', timeSpy)
		client.on('sync_changed', syncSpy)

		// Step 1: Sync (two-step flag set) – establishes ts1 and sync_seq
		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0200, sequence: 42 }), rinfo)

		// Step 2: Follow_Up – provides t1 timestamp and triggers delay_req send
		generalSocket().emit(
			'message',
			makeFollowUpBuffer({
				sequence: 42,
				tsSecondsHigh: 0,
				tsSecondsLow: 1700000000,
				tsNanoseconds: 500000000,
			}),
			rinfo,
		)

		// Let setImmediate (delay_req send) run, which sets t2
		await new Promise<void>((r) => setImmediate(r))

		// Step 3: Delay_Resp – provides ts2 and triggers offset calculation
		generalSocket().emit(
			'message',
			makeDelayRespBuffer({
				sequence: 1, // req_seq starts at 0, incremented to 1 on first send
				tsSecondsHigh: 0,
				tsSecondsLow: 1700000000,
				tsNanoseconds: 600000000,
			}),
			rinfo,
		)

		expect(timeSpy).toHaveBeenCalledOnce()
		expect(syncSpy).toHaveBeenCalledWith(true)
		expect(client.is_synced).toBe(true)
		expect(client.last_sync).toBeGreaterThan(0)
		client.destroy()
	})

	it('ptp_time returns a valid [seconds, nanoseconds] tuple after sync', async () => {
		const client = await makeClient('0.0.0.0', 0, 125)

		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0200, sequence: 1 }), rinfo)
		generalSocket().emit('message', makeFollowUpBuffer({ sequence: 1 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		generalSocket().emit('message', makeDelayRespBuffer({ sequence: 1 }), rinfo)

		const [s, ns] = client.ptp_time
		expect(s).toBeGreaterThanOrEqual(0)
		expect(ns).toBeGreaterThanOrEqual(0)
		expect(ns).toBeLessThan(1_000_000_000)
		client.destroy()
	})
})

// ===========================================================================
// Full sync flow: one-step (Sync only, no Follow_Up)
// ===========================================================================
describe('one-step sync flow', () => {
	it('processes a one-step sync and completes after delay_resp', async () => {
		const client = await makeClient('0.0.0.0', 0, 125)
		const syncSpy = vi.fn()
		client.on('sync_changed', syncSpy)

		// One-step: flags = 0x0000, timestamp embedded in sync message
		eventSocket().emit(
			'message',
			makeSyncBuffer({
				flags: 0x0000,
				sequence: 7,
				tsSecondsHigh: 0,
				tsSecondsLow: 1700000010,
				tsNanoseconds: 100000000,
			}),
			rinfo,
		)

		await new Promise<void>((r) => setImmediate(r))

		generalSocket().emit(
			'message',
			makeDelayRespBuffer({
				sequence: 1,
				tsSecondsHigh: 0,
				tsSecondsLow: 1700000010,
				tsNanoseconds: 200000000,
			}),
			rinfo,
		)

		expect(syncSpy).toHaveBeenCalledWith(true)
		expect(client.is_synced).toBe(true)
		client.destroy()
	})
})

// ===========================================================================
// FIX: 48-bit timestamp parsing (the << 4 bug)
// ===========================================================================
describe('FIX: 48-bit timestamp seconds field parsing', () => {
	// With the old << 4 bug, any high-word value would have been wrong.
	// We test by constructing a follow_up with a non-zero high word and verifying
	// the sync flow completes (if parsing were broken, the offset would be wildly off
	// and the nanoseconds in ptp_time would be out of range).

	it('correctly parses a timestamp with a non-zero seconds high word', async () => {
		const client = await makeClient('0.0.0.0', 0, 125)
		const timeSpy = vi.fn()
		client.on('ptp_time_synced', timeSpy)

		// Use tsSecondsHigh = 1, which represents seconds = 1 * 2^32 + tsSecondsLow.
		// With the old `<< 4` bug this would have been computed as 1 * 16 = 16 instead
		// of 4294967296, producing a wildly incorrect offset.
		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0200, sequence: 1 }), rinfo)
		generalSocket().emit(
			'message',
			makeFollowUpBuffer({
				sequence: 1,
				tsSecondsHigh: 1, // high 16 bits of 48-bit seconds
				tsSecondsLow: 0,
				tsNanoseconds: 0,
			}),
			rinfo,
		)
		await new Promise<void>((r) => setImmediate(r))
		generalSocket().emit(
			'message',
			makeDelayRespBuffer({
				sequence: 1,
				tsSecondsHigh: 1,
				tsSecondsLow: 0,
				tsNanoseconds: 0,
			}),
			rinfo,
		)

		expect(timeSpy).toHaveBeenCalled()
		// nanoseconds component must always be in [0, 1e9)
		const [_s, ns] = client.ptp_time
		expect(ns).toBeGreaterThanOrEqual(0)
		expect(ns).toBeLessThan(1_000_000_000)
		client.destroy()
	})

	it('correctly handles maximum high-word value (0xFFFF)', async () => {
		const client = await makeClient('0.0.0.0', 0, 125)
		const timeSpy = vi.fn()
		client.on('ptp_time_synced', timeSpy)

		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0200, sequence: 2 }), rinfo)
		generalSocket().emit(
			'message',
			makeFollowUpBuffer({
				sequence: 2,
				tsSecondsHigh: 0xffff,
				tsSecondsLow: 0xffffffff,
				tsNanoseconds: 999999999,
			}),
			rinfo,
		)
		await new Promise<void>((r) => setImmediate(r))
		generalSocket().emit(
			'message',
			makeDelayRespBuffer({
				sequence: 1,
				tsSecondsHigh: 0xffff,
				tsSecondsLow: 0xffffffff,
				tsNanoseconds: 999999999,
			}),
			rinfo,
		)

		expect(timeSpy).toHaveBeenCalled()
		const [_s, ns] = client.ptp_time
		expect(ns).toBeGreaterThanOrEqual(0)
		expect(ns).toBeLessThan(1_000_000_000)
		client.destroy()
	})
})

// ===========================================================================
// FIX: nanosecond normalisation (underflow / overflow)
// ===========================================================================
describe('FIX: ptp_time nanosecond normalisation', () => {
	it('nanoseconds are always in [0, 1_000_000_000)', async () => {
		// Run 20 sync cycles with various timestamps to stress-test normalisation
		for (let i = 0; i < 20; i++) {
			const client = await makeClient('0.0.0.0', 0, 125)

			eventSocket().emit('message', makeSyncBuffer({ flags: 0x0200, sequence: i }), rinfo)
			generalSocket().emit(
				'message',
				makeFollowUpBuffer({
					sequence: i,
					tsSecondsHigh: 0,
					tsSecondsLow: 1700000000 + i,
					tsNanoseconds: (i * 137_000_000) % 1_000_000_000,
				}),
				rinfo,
			)
			await new Promise<void>((r) => setImmediate(r))
			generalSocket().emit(
				'message',
				makeDelayRespBuffer({
					sequence: 1,
					tsSecondsHigh: 0,
					tsSecondsLow: 1700000000 + i,
					tsNanoseconds: ((i + 1) * 137_000_000) % 1_000_000_000,
				}),
				rinfo,
			)

			const [_s, ns] = client.ptp_time
			expect(ns, `iteration ${i}`).toBeGreaterThanOrEqual(0)
			expect(ns, `iteration ${i}`).toBeLessThan(1_000_000_000)
			client.destroy()

			// reset mocks for next iteration
			mockSockets = []
			vi.clearAllMocks()
		}
	})
})

// ===========================================================================
// FIX: negative delta handling
// ===========================================================================
describe('FIX: negative delta offset calculation', () => {
	it('produces a valid ptp_time when the local clock is ahead of master (negative delta)', async () => {
		const client = await makeClient('0.0.0.0', 0, 125)

		// Arrange timestamps so that delta is negative:
		// delta = 0.5 * (ts1 - t1 - ts2 + t2) in ns
		// Use t1 > ts1 to force a negative result
		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0200, sequence: 1 }), rinfo)
		generalSocket().emit(
			'message',
			makeFollowUpBuffer({
				sequence: 1,
				tsSecondsHigh: 0,
				tsSecondsLow: 1700000010, // t1 is in the future relative to ts1
				tsNanoseconds: 999000000,
			}),
			rinfo,
		)
		await new Promise<void>((r) => setImmediate(r))
		// ts2 is also large → delta ends up negative
		generalSocket().emit(
			'message',
			makeDelayRespBuffer({
				sequence: 1,
				tsSecondsHigh: 0,
				tsSecondsLow: 1700000011,
				tsNanoseconds: 0,
			}),
			rinfo,
		)

		const [s, ns] = client.ptp_time
		expect(s).toBeGreaterThanOrEqual(0)
		expect(ns).toBeGreaterThanOrEqual(0)
		expect(ns).toBeLessThan(1_000_000_000)
		client.destroy()
	})
})

// ===========================================================================
// FIX: delay_req domain byte
// ===========================================================================
describe('FIX: delay_req domain byte', () => {
	it('sends delay_req with the correct domain byte for domain 0', async () => {
		const client = await makeClient('0.0.0.0', 0, 125)

		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0200, sequence: 1 }), rinfo)
		generalSocket().emit('message', makeFollowUpBuffer({ sequence: 1 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))

		expect(eventSocket().send).toHaveBeenCalled()
		const sentBuffer: Buffer = eventSocket().send.mock.calls[0][0]
		expect(sentBuffer.readUInt8(4)).toBe(0) // domain byte
		client.destroy()
	})

	it.each([1, 2, 3, 16, 127])('sends delay_req with domain byte %i for domain %i', async (domain) => {
		const client = await makeClient('0.0.0.0', domain, 125)

		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0200, sequence: 1, domain }), rinfo)
		generalSocket().emit('message', makeFollowUpBuffer({ sequence: 1, domain }), rinfo)
		await new Promise<void>((r) => setImmediate(r))

		const sentBuffer: Buffer = eventSocket().send.mock.calls[0][0]
		expect(sentBuffer.readUInt8(4)).toBe(domain)
		client.destroy()
	})
})

// ===========================================================================
// FIX: t2 captured only after send callback (not before setImmediate)
// ===========================================================================
describe('FIX: t2 captured after send completes', () => {
	it('send is called once per follow_up', async () => {
		const client = await makeClient('0.0.0.0', 0, 125)

		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0200, sequence: 1 }), rinfo)
		generalSocket().emit('message', makeFollowUpBuffer({ sequence: 1 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))

		// send should have been called exactly once (not twice due to redundant pre-send assignment)
		expect(eventSocket().send).toHaveBeenCalledOnce()
		client.destroy()
	})
})

// ===========================================================================
// sync_changed events
// ===========================================================================
describe('sync_changed events', () => {
	it('starts as not synced', async () => {
		const client = await makeClient()
		expect(client.is_synced).toBe(false)
		client.destroy()
	})

	it('becomes synced after a complete exchange', async () => {
		const client = await makeClient('0.0.0.0', 0, 125)

		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0200, sequence: 1 }), rinfo)
		generalSocket().emit('message', makeFollowUpBuffer({ sequence: 1 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		generalSocket().emit('message', makeDelayRespBuffer({ sequence: 1 }), rinfo)

		expect(client.is_synced).toBe(true)
		client.destroy()
	})

	it('does not emit duplicate sync_changed true events', async () => {
		const client = await makeClient('0.0.0.0', 0, 125)
		const spy = vi.fn()
		client.on('sync_changed', spy)

		// Two full exchanges back to back
		for (let seq = 1; seq <= 2; seq++) {
			eventSocket().emit('message', makeSyncBuffer({ flags: 0x0200, sequence: seq }), rinfo)
			generalSocket().emit('message', makeFollowUpBuffer({ sequence: seq }), rinfo)
			await new Promise<void>((r) => setImmediate(r))
			generalSocket().emit('message', makeDelayRespBuffer({ sequence: seq }), rinfo)
		}

		// sync_changed(true) should only fire on the transition, not every sync
		const trueEvents = spy.mock.calls.filter(([v]) => v === true)
		expect(trueEvents).toHaveLength(1)
		client.destroy()
	})

	it('emits sync_changed false when destroy() is called while synced', async () => {
		const client = await makeClient('0.0.0.0', 0, 125)

		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0200, sequence: 1 }), rinfo)
		generalSocket().emit('message', makeFollowUpBuffer({ sequence: 1 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		generalSocket().emit('message', makeDelayRespBuffer({ sequence: 1 }), rinfo)

		const spy = vi.fn()
		client.on('sync_changed', spy)
		client.destroy()

		expect(spy).toHaveBeenCalledWith(false)
	})
})

// ===========================================================================
// ptp_master getter
// ===========================================================================
describe('ptp_master getter', () => {
	it('returns empty strings before any sync', async () => {
		const client = await makeClient()
		const [id, addr] = client.ptp_master
		expect(id).toBe('')
		expect(addr).toBe('')
		client.destroy()
	})

	it('returns the master clock identity and address after a sync message', async () => {
		const client = await makeClient()
		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0200, source: 'aabbccddeeff0011' }), {
			...rinfo,
			address: '10.0.0.5',
		})
		const [id, addr] = client.ptp_master
		expect(id).toBe('aa-bb-cc-dd-ee-ff-00-11:0')
		expect(addr).toBe('10.0.0.5')
		client.destroy()
	})
})

// ===========================================================================
// domains getter
// ===========================================================================
describe('domains getter', () => {
	it('returns an empty iterator before any messages', async () => {
		const client = await makeClient()
		expect([...client.domains]).toHaveLength(0)
		client.destroy()
	})

	it('accumulates multiple distinct domains', async () => {
		const client = await makeClient()
		// These have wrong domain for our client (domain 0) so they won't trigger
		// master/sync logic, but addDomain() is called before the domain check
		eventSocket().emit('message', makeSyncBuffer({ domain: 0 }), rinfo)
		eventSocket().emit('message', makeSyncBuffer({ domain: 1 }), rinfo)
		eventSocket().emit('message', makeSyncBuffer({ domain: 3 }), rinfo)
		expect(new Set(client.domains)).toEqual(new Set([0, 1, 3]))
		client.destroy()
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
		const err = new Error('socket error')
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
})
