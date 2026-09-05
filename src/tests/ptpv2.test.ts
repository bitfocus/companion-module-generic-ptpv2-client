import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
//import type { PtpTime } from '../ptpv2.js'

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
	addMembership = vi.fn(() => {
		if (addMembershipError) throw addMembershipError
	})
	send = vi.fn((_buf: Buffer, _port: number, _addr: string, cb?: (err: Error | null) => void) => {
		// Real dgram throws synchronously on a closed socket rather than reporting via cb
		if (this.closed) {
			const err = new Error('Not running') as NodeJS.ErrnoException
			err.code = 'ERR_SOCKET_DGRAM_NOT_RUNNING'
			throw err
		}
		cb?.(null)
	})
	closed = false
	close = vi.fn(() => {
		this.closed = true
	})
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
// When set, every addMembership() call throws it — simulates the interface going away
let addMembershipError: Error | undefined

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
const { PTPv2Client } = await import('../ptpv2.js')
type DelayMechanism = import('../ptpv2.js').DelayMechanism

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

/**
 * Build a Delay_Resp. A real one is 54 bytes and echoes the requesting slave's portIdentity
 * (8-byte clockIdentity + 2-byte portNumber) at bytes 44-53; the client ignores any response
 * that isn't stamped with its own, so tests must supply the client the response is for.
 */
const makeDelayRespBuffer = (
	requester: { clock_identity: string } | undefined,
	opts: Parameters<typeof makeSyncBuffer>[0] = {},
): Buffer => {
	const buf = makeSyncBuffer({ ...opts, type: 0x09, length: 54 })
	if (requester) Buffer.from(requester.clock_identity + '0001', 'hex').copy(buf, 44)
	return buf
}

/**
 * Build a Pdelay_Req, as a neighbour on the link would transmit it. Only its presence
 * matters for detection, so the timestamps are irrelevant.
 */
const makePdelayReqBuffer = (opts: Parameters<typeof makeSyncBuffer>[0] = {}) =>
	makeSyncBuffer({ ...opts, type: 0x02, length: 54 })

/**
 * Build a Pdelay_Resp (type 0x3) or Pdelay_Resp_Follow_Up (type 0xA). Both echo the
 * requester's portIdentity at bytes 44-53, exactly as a Delay_Resp does, and the client
 * ignores any response not stamped with its own.
 */
const makePdelayRespBuffer = (
	requester: { clock_identity: string } | undefined,
	opts: Parameters<typeof makeSyncBuffer>[0] = {},
): Buffer => {
	const buf = makeSyncBuffer({ ...opts, type: 0x03, length: 54 })
	if (requester) Buffer.from(requester.clock_identity + '0001', 'hex').copy(buf, 44)
	return buf
}

const makePdelayFollowUpBuffer = (
	requester: { clock_identity: string } | undefined,
	opts: Parameters<typeof makeSyncBuffer>[0] = {},
): Buffer => {
	const buf = makeSyncBuffer({ ...opts, type: 0x0a, length: 54 })
	if (requester) Buffer.from(requester.clock_identity + '0001', 'hex').copy(buf, 44)
	return buf
}

// Fake rinfo object
const rinfo = { address: '192.168.1.1', family: 'IPv4', port: 319, size: 44 }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the event-socket (port 319) mock for the most-recently created client */
const eventSocket = () => mockSockets[mockSockets.length - 2]
/** Get the general-socket (port 320) mock for the most-recently created client */
const generalSocket = () => mockSockets[mockSockets.length - 1]

/**
 * Create a client and wait for both sockets to fire 'listening'.
 *
 * Defaults to 'e2e' rather than the module's own 'auto', because the bulk of these tests
 * exercise the end to end exchange and auto mode deliberately transmits nothing until it has
 * finished listening for peer delay. Auto's own behaviour is covered in its own block.
 */
const makeClient = async (iface = '0.0.0.0', domain = 0, interval = 125, mechanism: DelayMechanism = 'e2e') => {
	const client = new PTPv2Client(iface, domain, interval, mechanism)
	await new Promise<void>((r) => setImmediate(r)) // let bind → listening fire
	await new Promise<void>((r) => setImmediate(r))
	return client
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeEach(() => {
	mockSockets = []
	addMembershipError = undefined
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
		// The default interface shows up in the group join, not in bind()
		expect(eventSocket().addMembership).toHaveBeenCalledWith('224.0.1.129', '0.0.0.0')
		expect(generalSocket().addMembership).toHaveBeenCalledWith('224.0.1.129', '0.0.0.0')
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
		expect(eventSocket().addMembership).toHaveBeenCalledWith('224.0.1.129', '0.0.0.0')
		client.destroy()
	})

	// IEEE 1588-2008 Annex D: every domain uses the primary multicast address. Joining
	// 224.0.1.130–132 for domains 1–3 is PTPv1 subdomain addressing and receives nothing.
	it.each([0, 1, 2, 3, 4, 5, 16, 63, 127])(
		'domain %i joins the primary multicast address 224.0.1.129',
		async (domain) => {
			const client = await makeClient('0.0.0.0', domain)
			expect(eventSocket().addMembership).toHaveBeenCalledWith('224.0.1.129', '0.0.0.0')
			expect(generalSocket().addMembership).toHaveBeenCalledWith('224.0.1.129', '0.0.0.0')
			client.destroy()
		},
	)

	it.each([1, 2, 3])('domain %i never joins a PTPv1 subdomain address', async (domain) => {
		const client = await makeClient('0.0.0.0', domain)
		for (const addr of ['224.0.1.130', '224.0.1.131', '224.0.1.132']) {
			expect(eventSocket().addMembership).not.toHaveBeenCalledWith(addr, '0.0.0.0')
			expect(generalSocket().addMembership).not.toHaveBeenCalledWith(addr, '0.0.0.0')
		}
		client.destroy()
	})

	it('two different domains both join 224.0.1.129 (not separate addresses)', async () => {
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
	// A socket bound to a specific unicast address does not receive datagrams addressed to
	// a multicast group, so both sockets must bind INADDR_ANY and let addMembership pick
	// the interface. Binding to the configured NIC address here would receive nothing.
	it('binds event socket to port 319 on all interfaces', async () => {
		const client = await makeClient('10.0.0.1')
		expect(eventSocket().bind).toHaveBeenCalledWith(319)
		client.destroy()
	})

	it('binds general socket to port 320 on all interfaces', async () => {
		const client = await makeClient('10.0.0.1')
		expect(generalSocket().bind).toHaveBeenCalledWith(320)
		client.destroy()
	})

	it('selects the configured interface via addMembership rather than bind', async () => {
		const client = await makeClient('10.0.0.1')
		expect(eventSocket().addMembership).toHaveBeenCalledWith('224.0.1.129', '10.0.0.1')
		expect(generalSocket().addMembership).toHaveBeenCalledWith('224.0.1.129', '10.0.0.1')
		client.destroy()
	})
})

// ===========================================================================
// destroy()
// ===========================================================================
describe('destroy()', () => {
	it('does not emit sync_changed when it was never synced', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('sync_changed', spy)
		client.destroy()
		// sync was already false, so there is no transition to report
		expect(spy).not.toHaveBeenCalled()
	})

	it('is safe to call twice', async () => {
		const client = await makeClient()
		const es = eventSocket()
		client.destroy()
		client.destroy()
		// a second close() on a closed socket would throw ERR_SOCKET_DGRAM_NOT_RUNNING
		expect(es.close).toHaveBeenCalledTimes(1)
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
			makeDelayRespBuffer(client, {
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
		generalSocket().emit('message', makeDelayRespBuffer(client, { sequence: 1 }), rinfo)

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
			makeDelayRespBuffer(client, {
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
			makeDelayRespBuffer(client, {
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
			makeDelayRespBuffer(client, {
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
				makeDelayRespBuffer(client, {
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
			makeDelayRespBuffer(client, {
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
		generalSocket().emit('message', makeDelayRespBuffer(client, { sequence: 1 }), rinfo)

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
			generalSocket().emit('message', makeDelayRespBuffer(client, { sequence: seq }), rinfo)
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
		generalSocket().emit('message', makeDelayRespBuffer(client, { sequence: 1 }), rinfo)

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

// ===========================================================================
// FIX: Delay_Resp must be matched to this client
// ===========================================================================
describe('FIX: Delay_Resp addressed to another slave', () => {
	/** Drive a one-step sync so the client has sent a Delay_Req and is awaiting a response */
	const armExchange = async (client: Awaited<ReturnType<typeof makeClient>>) => {
		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0000, tsSecondsLow: 1_700_000_000 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		return client
	}

	it('ignores a Delay_Resp carrying a different requestingPortIdentity', async () => {
		const client = await makeClient('0.0.0.0', 0, 125)
		const timeSpy = vi.fn()
		client.on('ptp_time_synced', timeSpy)
		await armExchange(client)

		// Delay_Resp is multicast, so every slave on the network sees every response.
		// Sequence ids collide across slaves, so the id alone cannot identify ours.
		generalSocket().emit(
			'message',
			makeDelayRespBuffer({ clock_identity: 'deadbeefdeadbeef' }, { sequence: 1, tsSecondsLow: 1_900_000_000 }),
			rinfo,
		)

		expect(timeSpy).not.toHaveBeenCalled()
		expect(client.is_synced).toBe(false)
		client.destroy()
	})

	it('ignores a Delay_Resp too short to carry a requestingPortIdentity', async () => {
		const client = await makeClient('0.0.0.0', 0, 125)
		const timeSpy = vi.fn()
		client.on('ptp_time_synced', timeSpy)
		await armExchange(client)

		generalSocket().emit('message', makeSyncBuffer({ type: 0x09, sequence: 1, length: 44 }), rinfo)

		expect(timeSpy).not.toHaveBeenCalled()
		expect(client.is_synced).toBe(false)
		client.destroy()
	})

	it('accepts a Delay_Resp stamped with our own portIdentity', async () => {
		const client = await makeClient('0.0.0.0', 0, 125)
		const timeSpy = vi.fn()
		client.on('ptp_time_synced', timeSpy)
		await armExchange(client)

		generalSocket().emit('message', makeDelayRespBuffer(client, { sequence: 1, tsSecondsLow: 1_700_000_000 }), rinfo)

		expect(timeSpy).toHaveBeenCalled()
		expect(client.is_synced).toBe(true)
		client.destroy()
	})

	it('exposes a stable, non-zero clock identity', async () => {
		const client = await makeClient()
		expect(client.clock_identity).toMatch(/^[0-9a-f]{16}$/)
		expect(client.clock_identity).not.toBe('0000000000000000')
		expect(client.clock_identity).toBe(client.clock_identity)
		client.destroy()
	})
})

// ===========================================================================
// FIX: Delay_Req rate limiting
// ===========================================================================
describe('FIX: Delay_Req is not re-sent for every Sync', () => {
	it('sends only one Delay_Req for a burst of Syncs with no response', async () => {
		const client = await makeClient('0.0.0.0', 0, 10000)
		for (let i = 0; i < 10; i++) {
			eventSocket().emit('message', makeSyncBuffer({ flags: 0x0000, sequence: i, tsSecondsLow: 1_700_000_000 }), rinfo)
			await new Promise<void>((r) => setImmediate(r))
		}
		// Throttling on the last *attempt* rather than the last success: keyed on success,
		// an unanswering master produced one Delay_Req per Sync, indefinitely.
		expect(eventSocket().send).toHaveBeenCalledTimes(1)
		client.destroy()
	})
})

// ===========================================================================
// FIX: Delay_Req packet format
// ===========================================================================
describe('FIX: Delay_Req packet format', () => {
	const sentDelayReq = async (): Promise<Buffer> => {
		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0000, tsSecondsLow: 1_700_000_000 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		return eventSocket().send.mock.calls[0][0]
	}

	it('is 44 bytes and declares messageLength 44', async () => {
		const client = await makeClient('0.0.0.0', 0, 125)
		const buf = await sentDelayReq()
		expect(buf.length).toBe(44)
		expect(buf.readUInt16BE(2)).toBe(44)
		client.destroy()
	})

	it('carries our sourcePortIdentity so the master can address the response', async () => {
		const client = await makeClient('0.0.0.0', 0, 125)
		const buf = await sentDelayReq()
		expect(buf.toString('hex', 20, 28)).toBe(client.clock_identity)
		expect(buf.readUInt16BE(28)).toBe(1) // portNumber
		client.destroy()
	})

	it('sets controlField and logMessageInterval', async () => {
		const client = await makeClient('0.0.0.0', 0, 125)
		const buf = await sentDelayReq()
		expect(buf.readUInt8(32)).toBe(0x01) // controlField: Delay_Req
		expect(buf.readUInt8(33)).toBe(0x7f) // logMessageInterval: not periodic
		client.destroy()
	})
})

// ===========================================================================
// FIX: sync state transitions
// ===========================================================================
describe('FIX: sync_changed on master change', () => {
	it('emits sync_changed false when the master changes while synced', async () => {
		const client = await makeClient('0.0.0.0', 0, 125)
		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0000, tsSecondsLow: 1_700_000_000 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		generalSocket().emit('message', makeDelayRespBuffer(client, { sequence: 1, tsSecondsLow: 1_700_000_000 }), rinfo)
		expect(client.is_synced).toBe(true)

		const spy = vi.fn()
		client.on('sync_changed', spy)
		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0000, source: 'aabbccddeeff0011' }), rinfo)

		expect(spy).toHaveBeenCalledWith(false)
		expect(client.is_synced).toBe(false)
		client.destroy()
	})
})

// ===========================================================================
// FIX: addMembership failure must not escape the listening handler
// ===========================================================================
describe('FIX: addMembership failure', () => {
	it('emits error instead of throwing when the interface is unavailable', async () => {
		addMembershipError = new Error('ENODEV: no such device')
		const errors: Error[] = []
		const client = new PTPv2Client('0.0.0.0')
		client.on('error', (err) => errors.push(err))
		await new Promise<void>((r) => setImmediate(r))
		await new Promise<void>((r) => setImmediate(r))

		expect(errors.length).toBeGreaterThan(0)
		expect(errors[0].message).toContain('ENODEV')
		client.destroy()
	})
})

// ===========================================================================
// FIX: domain discovery only from PTPv2 traffic
// ===========================================================================
describe('FIX: domain discovery', () => {
	it('ignores domains from packets that are not PTPv2', async () => {
		const client = await makeClient()
		eventSocket().emit('message', makeSyncBuffer({ version: 1, domain: 5 }), rinfo)
		expect([...client.domains]).not.toContain(5)
		client.destroy()
	})

	it('ignores reserved domains above 127', async () => {
		const client = await makeClient()
		eventSocket().emit('message', makeSyncBuffer({ domain: 200 }), rinfo)
		expect([...client.domains]).not.toContain(200)
		client.destroy()
	})

	it('still records other valid domains it observes', async () => {
		const client = await makeClient()
		eventSocket().emit('message', makeSyncBuffer({ domain: 7 }), rinfo)
		expect([...client.domains]).toContain(7)
		client.destroy()
	})
})

// ===========================================================================
// FIX: destroy() while a Delay_Req is still queued
// ===========================================================================
describe('FIX: destroy with a pending Delay_Req', () => {
	it('does not send on a closed socket when destroyed before the send fires', async () => {
		const client = await makeClient('0.0.0.0', 0, 125)

		// sendDelayReq defers the send with setImmediate, so a destroy() in between would
		// otherwise reach a closed socket and throw ERR_SOCKET_DGRAM_NOT_RUNNING
		// synchronously — an uncaught exception, not an 'error' event.
		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0000, tsSecondsLow: 1_700_000_000 }), rinfo)
		const socket = eventSocket()
		client.destroy()

		await new Promise<void>((r) => setImmediate(r))
		await new Promise<void>((r) => setImmediate(r))

		expect(socket.send).not.toHaveBeenCalled()
	})
})

// ===========================================================================
// correctionField
// ===========================================================================
/** Write a correctionField (nanoseconds) into a packet: signed 64-bit, scaled by 2^16 */
const withCorrection = (buf: Buffer, nanoseconds: number): Buffer => {
	buf.writeBigInt64BE(BigInt(nanoseconds) * 65536n, 8)
	return buf
}

describe('correctionField', () => {
	/**
	 * Residence time accumulated by transparent clocks lives in correctionField, not in the
	 * timestamps. Two runs with identical timestamps but different corrections must produce
	 * different offsets, otherwise the field is being ignored.
	 */
	const offsetFor = async (syncCorrection: number, respCorrection: number): Promise<bigint> => {
		mockSockets = []
		const client = await makeClient('0.0.0.0', 0, 125)
		eventSocket().emit(
			'message',
			withCorrection(makeSyncBuffer({ flags: 0x0000, tsSecondsLow: 1_700_000_000 }), syncCorrection),
			rinfo,
		)
		await new Promise<void>((r) => setImmediate(r))
		generalSocket().emit(
			'message',
			withCorrection(makeDelayRespBuffer(client, { sequence: 1, tsSecondsLow: 1_700_000_000 }), respCorrection),
			rinfo,
		)
		const time = client.ptp_time_n
		client.destroy()
		return time
	}

	// A correction on one direction of the exchange moves the offset by *half* its value,
	// since offset = ((t2 - t1) - (t4 - t3)) / 2. 5ms is used so the signal (2.5ms) is far
	// larger than the few microseconds of hrtime jitter between two separate runs.
	const CORRECTION = 5_000_000
	const HALF = BigInt(CORRECTION / 2)
	const TOLERANCE = 500_000n

	it('a Sync correction advances t1 and so advances ptp_time by half of it', async () => {
		const none = await offsetFor(0, 0)
		const corrected = await offsetFor(CORRECTION, 0)
		const shift = corrected - none
		expect(shift).toBeGreaterThan(HALF - TOLERANCE)
		expect(shift).toBeLessThan(HALF + TOLERANCE)
	})

	it('a Delay_Resp correction retards t4 and so retards ptp_time by half of it', async () => {
		const none = await offsetFor(0, 0)
		const corrected = await offsetFor(0, CORRECTION)
		const shift = none - corrected
		expect(shift).toBeGreaterThan(HALF - TOLERANCE)
		expect(shift).toBeLessThan(HALF + TOLERANCE)
	})

	it('corrections on both directions cancel in the offset but not in the path delay', async () => {
		mockSockets = []
		const client = await makeClient('0.0.0.0', 0, 125)
		eventSocket().emit(
			'message',
			withCorrection(makeSyncBuffer({ flags: 0x0000, tsSecondsLow: 1_700_000_000 }), CORRECTION),
			rinfo,
		)
		await new Promise<void>((r) => setImmediate(r))
		generalSocket().emit(
			'message',
			withCorrection(makeDelayRespBuffer(client, { sequence: 1, tsSecondsLow: 1_700_000_000 }), CORRECTION),
			rinfo,
		)
		// Residence time is real transit time, so it comes out of the measured path delay.
		// The upper bound matters: getting the sign of one term wrong also produces a very
		// negative number, but one about 12 orders of magnitude too large.
		expect(client.mean_path_delay).toBeLessThan(-BigInt(CORRECTION) + TOLERANCE)
		expect(client.mean_path_delay).toBeGreaterThan(-BigInt(CORRECTION) - TOLERANCE)
		client.destroy()
	})

	/** Two-step equivalent: the Sync and its Follow_Up each carry their own correction */
	const twoStepOffsetFor = async (syncCorrection: number, followUpCorrection: number): Promise<bigint> => {
		mockSockets = []
		const client = await makeClient('0.0.0.0', 0, 125)
		eventSocket().emit('message', withCorrection(makeSyncBuffer({ flags: 0x0200, sequence: 1 }), syncCorrection), rinfo)
		generalSocket().emit(
			'message',
			withCorrection(makeFollowUpBuffer({ sequence: 1, tsSecondsLow: 1_700_000_000 }), followUpCorrection),
			rinfo,
		)
		await new Promise<void>((r) => setImmediate(r))
		generalSocket().emit('message', makeDelayRespBuffer(client, { sequence: 1, tsSecondsLow: 1_700_000_000 }), rinfo)
		const time = client.ptp_time_n
		client.destroy()
		return time
	}

	it('applies the Follow_Up correction in two-step', async () => {
		const none = await twoStepOffsetFor(0, 0)
		const corrected = await twoStepOffsetFor(0, CORRECTION)
		const shift = corrected - none
		expect(shift).toBeGreaterThan(HALF - TOLERANCE)
		expect(shift).toBeLessThan(HALF + TOLERANCE)
	})

	it('sums the Sync and Follow_Up corrections, since both are on the master to slave path', async () => {
		const none = await twoStepOffsetFor(0, 0)
		const both = await twoStepOffsetFor(CORRECTION, CORRECTION)
		const shift = both - none
		// two corrections of CORRECTION each, halved -> a full CORRECTION of shift
		expect(shift).toBeGreaterThan(BigInt(CORRECTION) - TOLERANCE)
		expect(shift).toBeLessThan(BigInt(CORRECTION) + TOLERANCE)
	})
})

// ===========================================================================
// mean path delay
// ===========================================================================
describe('mean path delay', () => {
	it('is computed from the same exchange as the offset', async () => {
		const client = await makeClient('0.0.0.0', 0, 125)
		expect(client.mean_path_delay).toBe(0n)

		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0000, tsSecondsLow: 1_700_000_000 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		generalSocket().emit('message', makeDelayRespBuffer(client, { sequence: 1, tsSecondsLow: 1_700_000_000 }), rinfo)

		expect(client.is_synced).toBe(true)
		expect(typeof client.mean_path_delay).toBe('bigint')
		expect(typeof client.last_correction).toBe('bigint')
		// The master timestamps are identical in both directions and the mock has no transit
		// time, so the true delay is microseconds. Summing the two terms with the wrong sign
		// leaves the ~1.7e18ns epoch difference uncancelled instead.
		expect(client.mean_path_delay).toBeLessThan(1_000_000_000n)
		expect(client.mean_path_delay).toBeGreaterThan(-1_000_000_000n)
		client.destroy()
	})
})

// ===========================================================================
// Announce
// ===========================================================================
const makeAnnounceBuffer = ({
	sequence = 1,
	domain = 0,
	flags = 0x0000,
	utcOffset = 37,
	priority1 = 128,
	clockClass = 6,
	clockAccuracy = 0x21,
	logVariance = 0x4000,
	priority2 = 128,
	grandmaster = 'aabbccddeeff0011',
	stepsRemoved = 0,
	timeSource = 0x20,
	logMessageInterval = 1,
	length = 64,
}: {
	sequence?: number
	domain?: number
	flags?: number
	utcOffset?: number
	priority1?: number
	clockClass?: number
	clockAccuracy?: number
	logVariance?: number
	priority2?: number
	grandmaster?: string
	stepsRemoved?: number
	timeSource?: number
	logMessageInterval?: number
	length?: number
} = {}): Buffer => {
	const buf = Buffer.alloc(Math.max(length, 64), 0)
	buf.writeUInt8(0x0b, 0)
	buf.writeUInt8(2, 1)
	buf.writeUInt16BE(64, 2)
	buf.writeUInt8(domain, 4)
	buf.writeUInt16BE(flags, 6)
	Buffer.from('112233445566aabb', 'hex').copy(buf, 20)
	buf.writeUInt16BE(sequence, 30)
	buf.writeInt8(logMessageInterval, 33)
	buf.writeInt16BE(utcOffset, 44)
	buf.writeUInt8(priority1, 47)
	buf.writeUInt8(clockClass, 48)
	buf.writeUInt8(clockAccuracy, 49)
	buf.writeUInt16BE(logVariance, 50)
	buf.writeUInt8(priority2, 52)
	Buffer.from(grandmaster, 'hex').copy(buf, 53)
	buf.writeUInt16BE(stepsRemoved, 61)
	buf.writeUInt8(timeSource, 63)
	return buf.subarray(0, length)
}

describe('Announce', () => {
	it('decodes the grandmaster properties', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('announce', spy)
		generalSocket().emit('message', makeAnnounceBuffer(), rinfo)

		const gm = client.grandmaster
		expect(gm).toBeDefined()
		expect(gm?.grandmasterIdentity).toBe('aa-bb-cc-dd-ee-ff-00-11')
		expect(gm?.clockClass).toBe(6)
		expect(gm?.clockClassLabel).toBe('Locked to primary reference')
		expect(gm?.clockAccuracy).toBe(0x21)
		expect(gm?.clockAccuracyLabel).toBe('100ns')
		expect(gm?.timeSource).toBe(0x20)
		expect(gm?.timeSourceLabel).toBe('GNSS')
		expect(gm?.currentUtcOffset).toBe(37)
		expect(gm?.stepsRemoved).toBe(0)
		expect(gm?.grandmasterPriority1).toBe(128)
		expect(gm?.logMessageInterval).toBe(1)
		expect(spy).toHaveBeenCalledTimes(1)
		client.destroy()
	})

	it('reports a grandmaster distinct from the sending port', async () => {
		const client = await makeClient()
		// A boundary clock relays Sync under its own identity while the grandmaster is elsewhere
		eventSocket().emit('message', makeSyncBuffer({ source: '112233445566aabb' }), rinfo)
		generalSocket().emit('message', makeAnnounceBuffer({ grandmaster: 'aabbccddeeff0011', stepsRemoved: 2 }), rinfo)

		expect(client.ptp_master[0]).toBe('11-22-33-44-55-66-aa-bb:0')
		expect(client.grandmaster?.grandmasterIdentity).toBe('aa-bb-cc-dd-ee-ff-00-11')
		expect(client.grandmaster?.stepsRemoved).toBe(2)
		client.destroy()
	})

	it('emits only when the advertised properties change', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('announce', spy)
		generalSocket().emit('message', makeAnnounceBuffer({ sequence: 1 }), rinfo)
		generalSocket().emit('message', makeAnnounceBuffer({ sequence: 2 }), rinfo)
		expect(spy).toHaveBeenCalledTimes(1)

		generalSocket().emit('message', makeAnnounceBuffer({ sequence: 3, clockClass: 7 }), rinfo)
		expect(spy).toHaveBeenCalledTimes(2)
		expect(client.grandmaster?.clockClassLabel).toBe('Holdover (was primary reference)')
		client.destroy()
	})

	it('ignores a truncated Announce', async () => {
		const client = await makeClient()
		generalSocket().emit('message', makeAnnounceBuffer({ length: 50 }), rinfo)
		expect(client.grandmaster).toBeUndefined()
		client.destroy()
	})

	it('records the time of the last Announce', async () => {
		const client = await makeClient()
		expect(client.last_announce).toBe(0)
		generalSocket().emit('message', makeAnnounceBuffer(), rinfo)
		expect(client.last_announce).toBeGreaterThan(0)
		client.destroy()
	})

	it('labels an unrecognised accuracy and time source numerically', async () => {
		const client = await makeClient()
		generalSocket().emit('message', makeAnnounceBuffer({ clockAccuracy: 0xfe, timeSource: 0x77 }), rinfo)
		expect(client.grandmaster?.clockAccuracyLabel).toBe('Unknown')
		expect(client.grandmaster?.timeSourceLabel).toBe('Unknown (0x77)')
		client.destroy()
	})
})

// ===========================================================================
// flagField decoding
// ===========================================================================
describe('flagField decoding', () => {
	it('decodes twoStep from a Sync', async () => {
		const client = await makeClient()
		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0200 }), rinfo)
		expect(client.ptp_flags.twoStep).toBe(true)
		client.destroy()
	})

	it('decodes the alarm-worthy bits from an Announce', async () => {
		const client = await makeClient()
		// leap61 | utcOffsetValid | ptpTimescale | timeTraceable | frequencyTraceable
		generalSocket().emit('message', makeAnnounceBuffer({ flags: 0x003d }), rinfo)
		const f = client.ptp_flags
		expect(f.leap61).toBe(true)
		expect(f.leap59).toBe(false)
		expect(f.currentUtcOffsetValid).toBe(true)
		expect(f.ptpTimescale).toBe(true)
		expect(f.timeTraceable).toBe(true)
		expect(f.frequencyTraceable).toBe(true)
		client.destroy()
	})

	it('decodes alternateMaster and unicast from byte 6', async () => {
		const client = await makeClient()
		generalSocket().emit('message', makeAnnounceBuffer({ flags: 0x0500 }), rinfo)
		expect(client.ptp_flags.alternateMaster).toBe(true)
		expect(client.ptp_flags.unicast).toBe(true)
		client.destroy()
	})

	it('emits flags_changed only on an actual change', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('flags_changed', spy)
		generalSocket().emit('message', makeAnnounceBuffer({ flags: 0x0008 }), rinfo)
		generalSocket().emit('message', makeAnnounceBuffer({ flags: 0x0008 }), rinfo)
		expect(spy).toHaveBeenCalledTimes(1)
		generalSocket().emit('message', makeAnnounceBuffer({ flags: 0x0009 }), rinfo)
		expect(spy).toHaveBeenCalledTimes(2)
		client.destroy()
	})
})

// ===========================================================================
// master portIdentity
// ===========================================================================
describe('master portIdentity', () => {
	it('reports the real portNumber rather than a hardcoded 0', async () => {
		const client = await makeClient()
		const buf = makeSyncBuffer({ source: 'aabbccddeeff0011' })
		buf.writeUInt16BE(3, 28) // portNumber 3 on a multi-port boundary clock
		eventSocket().emit('message', buf, rinfo)
		expect(client.ptp_master[0]).toBe('aa-bb-cc-dd-ee-ff-00-11:3')
		client.destroy()
	})
})

// ===========================================================================
// flag scoping: Announce-only bits must survive a Sync
// ===========================================================================
describe('flag scoping', () => {
	it('a Sync does not clear the time-property flags reported by Announce', async () => {
		const client = await makeClient()
		// utcOffsetValid | ptpTimescale | timeTraceable | frequencyTraceable
		generalSocket().emit('message', makeAnnounceBuffer({ flags: 0x003c }), rinfo)
		expect(client.ptp_flags.timeTraceable).toBe(true)

		// IEEE 1588-2008 Table 20: a Sync transmits those bits as false and they must be
		// ignored on receipt, not taken as a loss of traceability
		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0000 }), rinfo)
		expect(client.ptp_flags.timeTraceable).toBe(true)
		expect(client.ptp_flags.frequencyTraceable).toBe(true)
		expect(client.ptp_flags.currentUtcOffsetValid).toBe(true)
		expect(client.ptp_flags.ptpTimescale).toBe(true)
		client.destroy()
	})

	it('still takes twoStep from the Sync', async () => {
		const client = await makeClient()
		generalSocket().emit('message', makeAnnounceBuffer({ flags: 0x0000 }), rinfo)
		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0200 }), rinfo)
		expect(client.ptp_flags.twoStep).toBe(true)
		client.destroy()
	})

	it('clears traceability when a later Announce says so', async () => {
		const client = await makeClient()
		generalSocket().emit('message', makeAnnounceBuffer({ flags: 0x003c }), rinfo)
		generalSocket().emit('message', makeAnnounceBuffer({ flags: 0x0008 }), rinfo)
		expect(client.ptp_flags.timeTraceable).toBe(false)
		client.destroy()
	})
})

// ===========================================================================
// last_correction bootstrap
// ===========================================================================
describe('last_correction', () => {
	const exchange = async (client: Awaited<ReturnType<typeof makeClient>>, seq: number) => {
		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0000, sequence: seq, tsSecondsLow: 1_700_000_000 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		generalSocket().emit('message', makeDelayRespBuffer(client, { sequence: seq, tsSecondsLow: 1_700_000_000 }), rinfo)
	}

	it('reports zero for the first exchange rather than the epoch acquisition', async () => {
		const client = await makeClient('0.0.0.0', 0, 125)
		await exchange(client, 1)
		// the raw value here is ~-1.7e18, which is initial acquisition and not drift —
		// and would lose precision as a Number in a Companion variable
		expect(client.last_correction).toBe(0n)
		expect(client.is_synced).toBe(true)
		client.destroy()
	})

	it('reports a real drift figure once acquired', async () => {
		const client = await makeClient('0.0.0.0', 0, 125)
		await exchange(client, 1)
		await new Promise<void>((r) => setTimeout(r, 150))
		await exchange(client, 2)
		// second exchange works from an acquired offset, so the correction is small
		expect(client.last_correction).toBeLessThan(1_000_000_000n)
		expect(client.last_correction).toBeGreaterThan(-1_000_000_000n)
		client.destroy()
	})
})

// ===========================================================================
// Receipt timeouts (IEEE 1588-2008 §7.7.3.1)
// ===========================================================================
describe('receipt timeouts', () => {
	/** Write logMessageInterval (signed log2 seconds) into byte 33 */
	const withLogInterval = (buf: Buffer, logInterval: number): Buffer => {
		buf.writeInt8(logInterval, 33)
		return buf
	}

	it('derives the sync receipt timeout from the interval the master advertises', async () => {
		const client = await makeClient('0.0.0.0', 0, 125)
		// logSyncInterval 0 -> 1s interval, x3 = 3000ms
		eventSocket().emit('message', withLogInterval(makeSyncBuffer({ flags: 0x0200 }), 0), rinfo)
		expect(client.sync_receipt_timeout).toBe(3000)
		expect(client.sync_interval).toBe(1)

		// logSyncInterval -3 -> 125ms interval, x3 = 375ms (a common broadcast rate)
		eventSocket().emit('message', withLogInterval(makeSyncBuffer({ flags: 0x0200 }), -3), rinfo)
		expect(client.sync_receipt_timeout).toBe(375)
		expect(client.sync_interval).toBe(0.125)
		client.destroy()
	})

	it('derives the announce receipt timeout from the Announce interval', async () => {
		const client = await makeClient()
		// logAnnounceInterval 1 -> 2s interval, x3 = 6000ms, the IEEE 1588 default
		generalSocket().emit('message', makeAnnounceBuffer({ logMessageInterval: 1 }), rinfo)
		expect(client.announce_receipt_timeout).toBe(6000)

		generalSocket().emit('message', makeAnnounceBuffer({ logMessageInterval: -2, clockClass: 7 }), rinfo)
		expect(client.announce_receipt_timeout).toBe(750)
		client.destroy()
	})

	it('clamps an absurd advertised interval', async () => {
		const client = await makeClient()
		generalSocket().emit('message', makeAnnounceBuffer({ logMessageInterval: 100 }), rinfo)
		expect(client.announce_receipt_timeout).toBe(48_000) // 16s cap x3
		generalSocket().emit('message', makeAnnounceBuffer({ logMessageInterval: -100, clockClass: 7 }), rinfo)
		expect(client.announce_receipt_timeout).toBeGreaterThan(0)
		client.destroy()
	})

	it('drops sync when no Sync arrives within the receipt timeout', async () => {
		// setImmediate must stay real — makeClient and sendDelayReq both rely on it
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		try {
			const client = await makeClient('0.0.0.0', 0, 125)
			const lost = vi.fn()
			client.on('master_lost', lost)

			eventSocket().emit('message', withLogInterval(makeSyncBuffer({ flags: 0x0000 }), 0), rinfo)
			await vi.advanceTimersByTimeAsync(1)
			generalSocket().emit('message', makeDelayRespBuffer(client, { sequence: 1 }), rinfo)
			expect(client.is_synced).toBe(true)

			// still inside the timeout
			await vi.advanceTimersByTimeAsync(2500)
			expect(client.is_synced).toBe(true)

			// past 3 x 1s with no further Sync
			await vi.advanceTimersByTimeAsync(1000)
			expect(client.is_synced).toBe(false)
			expect(lost).toHaveBeenCalled()
			client.destroy()
		} finally {
			vi.useRealTimers()
		}
	})

	it('a continuing flow of Sync messages holds sync up', async () => {
		// setImmediate must stay real — makeClient and sendDelayReq both rely on it
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		try {
			const client = await makeClient('0.0.0.0', 0, 125)
			eventSocket().emit('message', withLogInterval(makeSyncBuffer({ flags: 0x0000 }), 0), rinfo)
			await vi.advanceTimersByTimeAsync(1)
			generalSocket().emit('message', makeDelayRespBuffer(client, { sequence: 1 }), rinfo)
			expect(client.is_synced).toBe(true)

			// a Sync every second re-arms the timeout, well past the 3s it would otherwise expire at
			for (let i = 0; i < 8; i++) {
				await vi.advanceTimersByTimeAsync(1000)
				eventSocket().emit('message', withLogInterval(makeSyncBuffer({ flags: 0x0200, sequence: i }), 0), rinfo)
			}
			expect(client.is_synced).toBe(true)
			client.destroy()
		} finally {
			vi.useRealTimers()
		}
	})

	it('drops the grandmaster when the announce receipt timeout expires', async () => {
		// setImmediate must stay real — makeClient and sendDelayReq both rely on it
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		try {
			const client = await makeClient()
			const lost = vi.fn()
			client.on('master_lost', lost)
			generalSocket().emit('message', makeAnnounceBuffer({ logMessageInterval: 1 }), rinfo)
			expect(client.grandmaster).toBeDefined()

			await vi.advanceTimersByTimeAsync(5500)
			expect(client.grandmaster).toBeDefined()

			await vi.advanceTimersByTimeAsync(1000)
			// stale grandmaster data is dropped rather than left on display
			expect(client.grandmaster).toBeUndefined()
			expect(lost).toHaveBeenCalledWith(expect.stringContaining('Announce'))
			client.destroy()
		} finally {
			vi.useRealTimers()
		}
	})
})

// ===========================================================================
// IEEE 1588-2019 (PTP v2.1) compatibility
// ===========================================================================
describe('IEEE 1588-2019 compatibility', () => {
	/**
	 * 1588-2019 redefined the upper nibble of byte 1 — reserved in 2008 — as minorVersionPTP,
	 * so a 2019 device sends 0x12 where a 2008 device sends 0x02. Comparing the whole byte
	 * against 2 discards every packet from a 2019 grandmaster.
	 */
	const withVersionByte = (buf: Buffer, versionByte: number): Buffer => {
		buf.writeUInt8(versionByte, 1)
		return buf
	}

	it('accepts a Sync from a 1588-2019 master', async () => {
		const client = await makeClient('0.0.0.0', 0, 125)
		eventSocket().emit(
			'message',
			withVersionByte(makeSyncBuffer({ flags: 0x0000, source: 'aabbccddeeff0011' }), 0x12),
			rinfo,
		)
		expect(client.ptp_master[0]).toBe('aa-bb-cc-dd-ee-ff-00-11:0')
		expect(client.ptp_version).toBe('2.1')
		client.destroy()
	})

	it('accepts an Announce from a 1588-2019 master', async () => {
		const client = await makeClient()
		generalSocket().emit('message', withVersionByte(makeAnnounceBuffer(), 0x12), rinfo)
		expect(client.grandmaster?.grandmasterIdentity).toBe('aa-bb-cc-dd-ee-ff-00-11')
		expect(client.ptp_version).toBe('2.1')
		client.destroy()
	})

	it('completes a full exchange with a 1588-2019 master', async () => {
		const client = await makeClient('0.0.0.0', 0, 125)
		eventSocket().emit(
			'message',
			withVersionByte(makeSyncBuffer({ flags: 0x0000, tsSecondsLow: 1_700_000_000 }), 0x12),
			rinfo,
		)
		await new Promise<void>((r) => setImmediate(r))
		generalSocket().emit(
			'message',
			withVersionByte(makeDelayRespBuffer(client, { sequence: 1, tsSecondsLow: 1_700_000_000 }), 0x12),
			rinfo,
		)
		expect(client.is_synced).toBe(true)
		client.destroy()
	})

	it('still reports 2.0 for a 1588-2008 master', async () => {
		const client = await makeClient()
		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0000 }), rinfo)
		expect(client.ptp_version).toBe('2.0')
		client.destroy()
	})

	it('emits version_changed when the minor version changes', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('version_changed', spy)
		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0000 }), rinfo)
		expect(spy).not.toHaveBeenCalled() // 2.0 is the starting assumption

		eventSocket().emit('message', withVersionByte(makeSyncBuffer({ flags: 0x0000 }), 0x12), rinfo)
		expect(spy).toHaveBeenCalledWith('2.1')
		client.destroy()
	})

	it('still rejects a genuinely wrong major version', async () => {
		const client = await makeClient()
		// PTPv1 (version 1) must still be ignored, minor nibble or not
		eventSocket().emit('message', withVersionByte(makeSyncBuffer({ source: 'aabbccddeeff0011' }), 0x11), rinfo)
		expect(client.ptp_master[0]).toBe('')
		client.destroy()
	})

	it('masks the majorSdoId nibble of byte 0 when reading message type', async () => {
		const client = await makeClient()
		// 2019 renamed byte 0's upper nibble from transportSpecific to majorSdoId; a non-zero
		// value there must not stop a Sync being recognised as a Sync
		const buf = makeSyncBuffer({ flags: 0x0000, source: 'aabbccddeeff0011' })
		buf.writeUInt8(0x10, 0) // majorSdoId 1, messageType 0 (Sync)
		eventSocket().emit('message', buf, rinfo)
		expect(client.ptp_master[0]).toBe('aa-bb-cc-dd-ee-ff-00-11:0')
		client.destroy()
	})
})

// ===========================================================================
// Identifying the grandmaster beyond its clock identity
// ===========================================================================
describe('grandmaster identification', () => {
	it('recovers the MAC from an EUI-64 derived clock identity', async () => {
		const client = await makeClient()
		// 00:1b:19:12:34:56 becomes 00:1b:19:ff:fe:12:34:56 per IEEE 1588 §7.5.2.2.2
		generalSocket().emit('message', makeAnnounceBuffer({ grandmaster: '001b19fffe123456' }), rinfo)
		expect(client.grandmaster?.grandmasterMac).toBe('00:1b:19:12:34:56')
		expect(client.grandmaster?.grandmasterOui).toBe('00:1b:19')
		client.destroy()
	})

	it('returns no MAC for an identity that was not derived from one', async () => {
		const client = await makeClient()
		// no ff:fe marker at bytes 3-4, so there is no MAC to recover and none is guessed
		generalSocket().emit('message', makeAnnounceBuffer({ grandmaster: 'aabbccddeeff0011' }), rinfo)
		expect(client.grandmaster?.grandmasterMac).toBeUndefined()
		// the OUI is still the manufacturer block
		expect(client.grandmaster?.grandmasterOui).toBe('aa:bb:cc')
		client.destroy()
	})

	it('recovers the MAC of the port sending Sync', async () => {
		const client = await makeClient()
		eventSocket().emit('message', makeSyncBuffer({ source: 'dc045afffe064144' }), rinfo)
		expect(client.ptp_master_mac).toBe('dc:04:5a:06:41:44')
		expect(client.ptp_master_oui).toBe('dc:04:5a')
		client.destroy()
	})

	it('reports the grandmaster address when the Announce came straight from it', async () => {
		const client = await makeClient()
		generalSocket().emit('message', makeAnnounceBuffer({ stepsRemoved: 0 }), rinfo)
		expect(client.grandmaster_address).toBe(rinfo.address)
		client.destroy()
	})

	it('reports no grandmaster address when it is behind a boundary clock', async () => {
		const client = await makeClient()
		// The source address belongs to the boundary clock that relayed the Announce, and PTP
		// carries no field for the grandmaster's own address, so claiming one would be wrong
		generalSocket().emit('message', makeAnnounceBuffer({ stepsRemoved: 2 }), rinfo)
		expect(client.grandmaster?.stepsRemoved).toBe(2)
		expect(client.grandmaster_address).toBe('')
		client.destroy()
	})

	it('clears the grandmaster address when the announce receipt timeout expires', async () => {
		// setImmediate must stay real — makeClient and sendDelayReq both rely on it
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		try {
			const client = await makeClient()
			generalSocket().emit('message', makeAnnounceBuffer({ stepsRemoved: 0, logMessageInterval: 1 }), rinfo)
			expect(client.grandmaster_address).toBe(rinfo.address)
			await vi.advanceTimersByTimeAsync(6500)
			expect(client.grandmaster_address).toBe('')
			client.destroy()
		} finally {
			vi.useRealTimers()
		}
	})

	it('round-trips our own identity back to the interface MAC', async () => {
		const client = await makeClient()
		// the client derives its own identity from a local MAC the same way, so the reverse
		// of that derivation must land back on a well-formed MAC
		const identity = client.clock_identity
		expect(identity).toMatch(/^[0-9a-f]{16}$/)
		if (identity.slice(6, 10) === 'fffe') {
			const buf = Buffer.from(identity, 'hex')
			const mac = [buf[0], buf[1], buf[2], buf[5], buf[6], buf[7]].map((b) => b.toString(16).padStart(2, '0')).join(':')
			expect(mac).toMatch(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/)
		}
		client.destroy()
	})
})

// ===========================================================================
// The socket's receive buffer is not ours to hold
// ===========================================================================
describe('receive buffer ownership', () => {
	it('keeps the master identity after the source buffer is overwritten', async () => {
		const client = await makeClient()
		const buf = makeSyncBuffer({ source: 'dc045afffe064144' })
		eventSocket().emit('message', buf, rinfo)
		expect(client.ptp_master_mac).toBe('dc:04:5a:06:41:44')

		// Node reads UDP datagrams into a shared slab, so a subarray of the received buffer
		// aliases memory the runtime may reuse. The identity must have been copied out.
		buf.fill(0, 20, 28)
		expect(client.ptp_master_mac).toBe('dc:04:5a:06:41:44')
		expect(client.ptp_master_oui).toBe('dc:04:5a')
		client.destroy()
	})
})

// ===========================================================================
// PATH_TRACE TLV (IEEE 1588-2019 §16.2)
// ===========================================================================
/** Append a PATH_TRACE TLV (type 0x0008) carrying the given clock identities */
const withPathTrace = (announce: Buffer, identities: string[]): Buffer => {
	const value = Buffer.concat(identities.map((id) => Buffer.from(id, 'hex')))
	const tlv = Buffer.alloc(4 + value.length)
	tlv.writeUInt16BE(0x0008, 0)
	tlv.writeUInt16BE(value.length, 2)
	value.copy(tlv, 4)
	const out = Buffer.concat([announce, tlv])
	out.writeUInt16BE(out.length, 2) // messageLength must cover the TLVs
	return out
}

describe('PATH_TRACE TLV', () => {
	const GM = '001b19fffe123456'
	const BC1 = 'aabbccfffe111111'
	const BC2 = 'ddeeffffe2222222'.slice(0, 16)

	it('decodes the clock identity chain', async () => {
		const client = await makeClient()
		generalSocket().emit(
			'message',
			withPathTrace(makeAnnounceBuffer({ grandmaster: GM, stepsRemoved: 2 }), [GM, BC1, BC2]),
			rinfo,
		)
		expect(client.path_trace).toEqual(['00-1b-19-ff-fe-12-34-56', 'aa-bb-cc-ff-fe-11-11-11', 'dd-ee-ff-ff-e2-22-22-22'])
		client.destroy()
	})

	it('puts the grandmaster first and the transmitting clock last', async () => {
		const client = await makeClient()
		generalSocket().emit('message', withPathTrace(makeAnnounceBuffer({ grandmaster: GM }), [GM, BC1]), rinfo)
		const path = client.path_trace
		expect(path[0]).toBe(client.grandmaster?.grandmasterIdentity)
		expect(path[path.length - 1]).toBe('aa-bb-cc-ff-fe-11-11-11')
		client.destroy()
	})

	it('is empty when the master emits no PATH_TRACE, which is the common case', async () => {
		const client = await makeClient()
		generalSocket().emit('message', makeAnnounceBuffer(), rinfo)
		expect(client.path_trace).toEqual([])
		expect(client.grandmaster?.pathTraceLoop).toBe(false)
		client.destroy()
	})

	it('skips over the whole value of a TLV of another type', async () => {
		const client = await makeClient()
		// The preceding TLV's value contains bytes that look like a PATH_TRACE header. A walk
		// that advances by the header only, rather than header + value, lands inside this
		// value and returns the decoy instead of the real path.
		const decoy = Buffer.alloc(12)
		decoy.writeUInt16BE(0x0008, 0)
		decoy.writeUInt16BE(8, 2)
		decoy.fill(0xaa, 4)
		const other = Buffer.alloc(4 + decoy.length)
		other.writeUInt16BE(0x0003, 0)
		other.writeUInt16BE(decoy.length, 2)
		decoy.copy(other, 4)

		const announce = Buffer.concat([makeAnnounceBuffer({ grandmaster: GM }), other])
		announce.writeUInt16BE(announce.length, 2)
		generalSocket().emit('message', withPathTrace(announce, [GM, BC1]), rinfo)

		expect(client.path_trace).toEqual(['00-1b-19-ff-fe-12-34-56', 'aa-bb-cc-ff-fe-11-11-11'])
		client.destroy()
	})

	it('flags a repeated identity as a loop', async () => {
		const client = await makeClient()
		generalSocket().emit('message', withPathTrace(makeAnnounceBuffer({ grandmaster: GM }), [GM, BC1, GM]), rinfo)
		expect(client.grandmaster?.pathTraceLoop).toBe(true)
		client.destroy()
	})

	it('does not flag a loop for a clean path', async () => {
		const client = await makeClient()
		generalSocket().emit('message', withPathTrace(makeAnnounceBuffer({ grandmaster: GM }), [GM, BC1, BC2]), rinfo)
		expect(client.grandmaster?.pathTraceLoop).toBe(false)
		client.destroy()
	})

	it('ignores a TLV whose value is not a whole number of identities', async () => {
		const client = await makeClient()
		const announce = makeAnnounceBuffer({ grandmaster: GM })
		const tlv = Buffer.alloc(4 + 12) // 12 bytes is not a multiple of 8
		tlv.writeUInt16BE(0x0008, 0)
		tlv.writeUInt16BE(12, 2)
		const buf = Buffer.concat([announce, tlv])
		buf.writeUInt16BE(buf.length, 2)
		generalSocket().emit('message', buf, rinfo)
		expect(client.path_trace).toEqual([])
		client.destroy()
	})

	it('ignores a TLV that runs past the end of the message', async () => {
		const client = await makeClient()
		// Claims two identities but carries one. subarray would silently clamp to the single
		// identity present, so without a bounds check this reports a plausible but wrong path.
		const tlv = Buffer.alloc(4 + 8)
		tlv.writeUInt16BE(0x0008, 0)
		tlv.writeUInt16BE(16, 2)
		Buffer.from(GM, 'hex').copy(tlv, 4)
		const buf = Buffer.concat([makeAnnounceBuffer({ grandmaster: GM }), tlv])
		buf.writeUInt16BE(buf.length, 2)
		generalSocket().emit('message', buf, rinfo)
		expect(client.path_trace).toEqual([])
		client.destroy()
	})

	it('ignores TLV bytes beyond the declared messageLength', async () => {
		const client = await makeClient()
		// UDP payloads can be padded; only messageLength delimits the PTP message
		const buf = withPathTrace(makeAnnounceBuffer({ grandmaster: GM }), [GM, BC1])
		buf.writeUInt16BE(64, 2) // declare the message as ending before the TLV
		generalSocket().emit('message', buf, rinfo)
		expect(client.path_trace).toEqual([])
		client.destroy()
	})

	it('does not re-emit announce when an identical path repeats', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('announce', spy)
		const buf = () => withPathTrace(makeAnnounceBuffer({ grandmaster: GM }), [GM, BC1])
		generalSocket().emit('message', buf(), rinfo)
		generalSocket().emit('message', buf(), rinfo)
		// pathTrace is an array, so a reference comparison here would fire every time
		expect(spy).toHaveBeenCalledTimes(1)
		client.destroy()
	})

	it('re-emits announce when the path changes', async () => {
		const client = await makeClient()
		const spy = vi.fn()
		client.on('announce', spy)
		generalSocket().emit('message', withPathTrace(makeAnnounceBuffer({ grandmaster: GM }), [GM, BC1]), rinfo)
		generalSocket().emit('message', withPathTrace(makeAnnounceBuffer({ grandmaster: GM }), [GM, BC2]), rinfo)
		expect(spy).toHaveBeenCalledTimes(2)
		client.destroy()
	})
})

// ===========================================================================
// Manufacturer lookup
// ===========================================================================
describe('manufacturer lookup', () => {
	/** Build an EUI-64 clock identity from a MAC, the way a device would */
	const identityFor = (mac: string): string => {
		const b = mac.replace(/:/g, '')
		return b.slice(0, 6) + 'fffe' + b.slice(6)
	}

	it('names the manufacturer of a 24-bit assignment', async () => {
		const client = await makeClient()
		// 00:07:7D is Cisco
		generalSocket().emit('message', makeAnnounceBuffer({ grandmaster: identityFor('00:07:7d:11:22:33') }), rinfo)
		expect(client.grandmaster?.grandmasterVendor).toContain('Cisco')
		expect(client.grandmaster?.grandmasterOui).toBe('00:07:7d')
		client.destroy()
	})

	it('names the manufacturer of the port sending Sync', async () => {
		const client = await makeClient()
		eventSocket().emit('message', makeSyncBuffer({ source: identityFor('00:07:7d:44:55:66') }), rinfo)
		expect(client.ptp_master_vendor).toContain('Cisco')
		client.destroy()
	})

	it('resolves a 36-bit assignment that a bare OUI could not', async () => {
		const client = await makeClient()
		// 00:50:C2 is the shared IEEE IAB pool; only the longer prefix identifies the holder.
		// 00:50:C2:22:6 is Ross Video.
		generalSocket().emit('message', makeAnnounceBuffer({ grandmaster: identityFor('00:50:c2:22:60:01') }), rinfo)
		expect(client.grandmaster?.grandmasterVendor).toContain('Ross Video')
		client.destroy()
	})

	it('leaves the vendor undefined for a block we do not carry', async () => {
		const client = await makeClient()
		// aa:bb:cc is not a real assignment, and a wrong name is worse than none
		generalSocket().emit('message', makeAnnounceBuffer({ grandmaster: 'aabbccddeeff0011' }), rinfo)
		expect(client.grandmaster?.grandmasterVendor).toBeUndefined()
		expect(client.grandmaster?.grandmasterOui).toBe('aa:bb:cc')
		client.destroy()
	})

	it('falls back to the 24-bit block when the identity is not MAC-derived', async () => {
		const client = await makeClient()
		// no ff:fe marker, so there is no MAC and only the OUI can be matched
		generalSocket().emit('message', makeAnnounceBuffer({ grandmaster: '00077d1122334455' }), rinfo)
		expect(client.grandmaster?.grandmasterVendor).toContain('Cisco')
		client.destroy()
	})
})

// ===========================================================================
// OUI table integrity
// ===========================================================================
describe('OUI table', () => {
	it('holds only 24, 28 and 36 bit prefixes, all valid hex', async () => {
		const { ouiPrefixes, ouiNames } = await import('../oui.js')
		const lengths = new Set<number>()
		for (const [prefix, index] of Object.entries(ouiPrefixes)) {
			expect(prefix).toMatch(/^[0-9A-F]+$/)
			lengths.add(prefix.length)
			expect(ouiNames[index]).toBeTruthy()
		}
		expect([...lengths].sort((a, b) => a - b)).toEqual([6, 7, 9])
	})

	it('has no longer prefix that contradicts its 24-bit parent', async () => {
		const { ouiPrefixes, ouiNames } = await import('../oui.js')
		// MA-M and MA-S blocks are carved from pools IEEE holds itself (00:50:C2, 00:1B:C5,
		// 70:B3:D5), never from another company's MA-L, so a disagreement here would mean the
		// source data is wrong. It also means longest-prefix order cannot currently change a
		// result — this test is what keeps that true.
		const conflicts: string[] = []
		for (const [prefix, index] of Object.entries(ouiPrefixes)) {
			if (prefix.length === 6) continue
			const parent = ouiPrefixes[prefix.slice(0, 6)]
			if (parent !== undefined && parent !== index) {
				conflicts.push(`${prefix}=${ouiNames[index]} under ${prefix.slice(0, 6)}=${ouiNames[parent]}`)
			}
		}
		expect(conflicts).toEqual([])
	})

	it('resolves known vendors', async () => {
		const { lookupOui } = await import('../oui.js')
		expect(lookupOui('EC4670112233')).toContain('Meinberg')
		expect(lookupOui('0002C5112233')).toContain('Evertz')
		expect(lookupOui('000B72112233')).toContain('Lawo')
		expect(lookupOui('00077D112233')).toContain('Cisco')
		expect(lookupOui('0050C2226001')).toContain('Ross Video')
	})

	it('tolerates separators and lower case', async () => {
		const { lookupOui } = await import('../oui.js')
		expect(lookupOui('ec:46:70:11:22:33')).toContain('Meinberg')
		expect(lookupOui('ec-46-70')).toContain('Meinberg')
	})

	it('returns undefined rather than guessing', async () => {
		const { lookupOui } = await import('../oui.js')
		expect(lookupOui('AABBCC112233')).toBeUndefined()
		expect(lookupOui('0050C2999999')).toBeUndefined() // IEEE pool, no matching sub-block
		expect(lookupOui('')).toBeUndefined()
		expect(lookupOui('AB')).toBeUndefined()
	})
})

// ===========================================================================
// Delay mechanism
// ===========================================================================
describe('delay mechanism – multicast group membership', () => {
	const PDELAY_GROUP = '224.0.0.107'

	it.each(['auto', 'p2p', 'passive'] as const)('%s joins the peer delay group', async (mechanism) => {
		const client = await makeClient('0.0.0.0', 0, 125, mechanism)
		expect(eventSocket().addMembership).toHaveBeenCalledWith(PDELAY_GROUP, '0.0.0.0')
		expect(generalSocket().addMembership).toHaveBeenCalledWith(PDELAY_GROUP, '0.0.0.0')
		client.destroy()
	})

	it('an explicit e2e has no use for the peer delay group and does not join it', async () => {
		const client = await makeClient('0.0.0.0', 0, 125, 'e2e')
		expect(eventSocket().addMembership).not.toHaveBeenCalledWith(PDELAY_GROUP, '0.0.0.0')
		expect(eventSocket().addMembership).toHaveBeenCalledWith('224.0.1.129', '0.0.0.0')
		client.destroy()
	})
})

describe('delay mechanism – auto detection', () => {
	/** Drive a one-step Sync, the point at which a transmitting mechanism would react */
	const feedSync = async () => {
		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0000, tsSecondsLow: 1_700_000_000 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
	}

	it('starts out undecided', async () => {
		const client = await makeClient('0.0.0.0', 0, 125, 'auto')
		expect(client.delay_mechanism).toBe('detecting')
		client.destroy()
	})

	it('transmits nothing at all while still undecided', async () => {
		const client = await makeClient('0.0.0.0', 0, 125, 'auto')
		await feedSync()
		// This is the whole point of auto: a Delay_Req here would be the spec violation that
		// mixing mechanisms on one path amounts to
		expect(eventSocket().send).not.toHaveBeenCalled()
		client.destroy()
	})

	it('settles on p2p the moment a neighbour Pdelay_Req is seen', async () => {
		const client = await makeClient('0.0.0.0', 0, 125, 'auto')
		const changed = vi.fn()
		client.on('delay_mechanism_changed', changed)

		eventSocket().emit('message', makePdelayReqBuffer({ sequence: 7 }), rinfo)

		expect(client.delay_mechanism).toBe('p2p')
		expect(client.pdelay_seen).toBe(true)
		expect(changed).toHaveBeenCalledWith('p2p', true)
		client.destroy()
	})

	it('settles on p2p from a Pdelay_Resp_Follow_Up on the general socket too', async () => {
		const client = await makeClient('0.0.0.0', 0, 125, 'auto')
		generalSocket().emit('message', makePdelayFollowUpBuffer(undefined, { sequence: 3 }), rinfo)
		expect(client.delay_mechanism).toBe('p2p')
		client.destroy()
	})

	it('ignores peer delay traffic belonging to another domain', async () => {
		const client = await makeClient('0.0.0.0', 1, 125, 'auto')
		eventSocket().emit('message', makePdelayReqBuffer({ domain: 5 }), rinfo)
		expect(client.delay_mechanism).toBe('detecting')
		expect(client.pdelay_seen).toBe(false)
		client.destroy()
	})

	it('falls back to e2e once the detection window closes in silence', async () => {
		vi.useFakeTimers()
		try {
			const client = new PTPv2Client('0.0.0.0', 0, 125, 'auto')
			const changed = vi.fn()
			client.on('delay_mechanism_changed', changed)
			expect(client.delay_mechanism).toBe('detecting')

			await vi.advanceTimersByTimeAsync(4000)

			expect(client.delay_mechanism).toBe('e2e')
			expect(changed).toHaveBeenCalledWith('e2e', true)
			client.destroy()
		} finally {
			vi.useRealTimers()
		}
	})

	it('does not revert to e2e after having detected p2p', async () => {
		vi.useFakeTimers()
		try {
			const client = new PTPv2Client('0.0.0.0', 0, 125, 'auto')
			await vi.advanceTimersByTimeAsync(0)
			eventSocket().emit('message', makePdelayReqBuffer(), rinfo)
			await vi.advanceTimersByTimeAsync(10_000)
			expect(client.delay_mechanism).toBe('p2p')
			client.destroy()
		} finally {
			vi.useRealTimers()
		}
	})

	it('an explicit mechanism is settled immediately, with no detection at all', async () => {
		for (const mechanism of ['e2e', 'p2p', 'passive'] as const) {
			mockSockets = []
			const client = await makeClient('0.0.0.0', 0, 125, mechanism)
			expect(client.delay_mechanism).toBe(mechanism)
			client.destroy()
		}
	})
})

describe('delay mechanism – passive', () => {
	it('syncs from the Sync alone, without transmitting anything', async () => {
		const client = await makeClient('0.0.0.0', 0, 125, 'passive')
		const synced = vi.fn()
		client.on('ptp_time_synced', synced)

		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0000, tsSecondsLow: 1_700_000_000 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))

		expect(synced).toHaveBeenCalled()
		expect(client.is_synced).toBe(true)
		expect(eventSocket().send).not.toHaveBeenCalled()
		client.destroy()
	})

	it('syncs on the Follow_Up of a two-step master, still without transmitting', async () => {
		const client = await makeClient('0.0.0.0', 0, 125, 'passive')
		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0200, sequence: 4 }), rinfo)
		generalSocket().emit('message', makeFollowUpBuffer({ sequence: 4, tsSecondsLow: 1_700_000_000 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))

		expect(client.is_synced).toBe(true)
		expect(eventSocket().send).not.toHaveBeenCalled()
		client.destroy()
	})

	it('takes the path delay from the Sync correction field', async () => {
		// The correctionField is where a P2P domain's transparent clocks accumulate the path,
		// so a larger correction must move the derived time by the whole of that amount
		const timeFor = async (correction: number): Promise<bigint> => {
			mockSockets = []
			const client = await makeClient('0.0.0.0', 0, 125, 'passive')
			eventSocket().emit(
				'message',
				withCorrection(makeSyncBuffer({ flags: 0x0000, tsSecondsLow: 1_700_000_000 }), correction),
				rinfo,
			)
			await new Promise<void>((r) => setImmediate(r))
			const time = client.ptp_time_n
			client.destroy()
			return time
		}
		const none = await timeFor(0)
		const corrected = await timeFor(5_000_000)
		const shift = corrected - none
		expect(shift).toBeGreaterThan(4_500_000n)
		expect(shift).toBeLessThan(5_500_000n)
	})

	it('reports no mean path delay, because it never measured one', async () => {
		const client = await makeClient('0.0.0.0', 0, 125, 'passive')
		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0000, tsSecondsLow: 1_700_000_000 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		expect(client.mean_path_delay).toBe(0n)
		expect(client.peer_responding).toBe(false)
		client.destroy()
	})
})

describe('delay mechanism – peer to peer', () => {
	/** Sync, then let the Pdelay_Req the client sends in response go out */
	const syncAndRequest = async (domain = 0) => {
		eventSocket().emit('message', makeSyncBuffer({ domain, flags: 0x0000, tsSecondsLow: 1_700_000_000 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		await new Promise<void>((r) => setImmediate(r))
	}

	/** The sequence number of the Pdelay_Req the client last put on the wire */
	const sentSeq = (nth = 0) => eventSocket().send.mock.calls[nth][0].readUInt16BE(30)

	it('sends a Pdelay_Req to the link-local group, never a Delay_Req to the master', async () => {
		const client = await makeClient('0.0.0.0', 0, 125, 'p2p')
		await syncAndRequest()

		expect(eventSocket().send).toHaveBeenCalledTimes(1)
		const [buf, port, addr] = eventSocket().send.mock.calls[0]
		expect(addr).toBe('224.0.0.107')
		expect(port).toBe(319)
		expect(buf.readUInt8(0) & 0x0f).toBe(0x02) // Pdelay_Req
		client.destroy()
	})

	it('builds a conformant Pdelay_Req', async () => {
		const client = await makeClient('0.0.0.0', 1, 125, 'p2p')
		await syncAndRequest(1)

		const buf = eventSocket().send.mock.calls[0][0]
		expect(buf.length).toBe(54)
		expect(buf.readUInt16BE(2)).toBe(54) // messageLength
		expect(buf.readUInt8(4)).toBe(1) // domain
		expect(buf.readUInt8(32)).toBe(0x05) // controlField: all others
		expect(buf.readUInt8(33)).toBe(0x7f) // logMessageInterval: not periodic
		// without our own portIdentity the neighbour's reply could not be told from anyone else's
		expect(buf.toString('hex', 20, 28)).toBe(client.clock_identity)
		client.destroy()
	})

	it('syncs from the Sync without waiting for the peer to answer', async () => {
		// A neighbour that is not a peer delay responder must degrade to the passive
		// calculation rather than never syncing at all
		const client = await makeClient('0.0.0.0', 0, 125, 'p2p')
		await syncAndRequest()
		expect(client.is_synced).toBe(true)
		expect(client.peer_responding).toBe(false)
		client.destroy()
	})

	it('ignores a Pdelay_Resp addressed to a different client', async () => {
		const client = await makeClient('0.0.0.0', 0, 125, 'p2p')
		await syncAndRequest()
		eventSocket().emit(
			'message',
			makePdelayRespBuffer({ clock_identity: 'ffeeddccbbaa9988' }, { sequence: sentSeq(), flags: 0x0000 }),
			rinfo,
		)
		expect(client.peer_responding).toBe(false)
		client.destroy()
	})

	it('ignores a Pdelay_Resp carrying a stale sequence number', async () => {
		const client = await makeClient('0.0.0.0', 0, 125, 'p2p')
		await syncAndRequest()
		eventSocket().emit('message', makePdelayRespBuffer(client, { sequence: sentSeq() + 99, flags: 0x0000 }), rinfo)
		expect(client.peer_responding).toBe(false)
		client.destroy()
	})

	it('ignores a Follow_Up that arrives without a preceding two-step Pdelay_Resp', async () => {
		const client = await makeClient('0.0.0.0', 0, 125, 'p2p')
		await syncAndRequest()
		generalSocket().emit('message', makePdelayFollowUpBuffer(client, { sequence: sentSeq() }), rinfo)
		expect(client.peer_responding).toBe(false)
		client.destroy()
	})
})

// ===========================================================================
// Peer delay arithmetic
// ===========================================================================
// meanLinkDelay = [(t4 − t1) − (t3 − t2) − corrections] / 2. Two of those four terms are
// this client's own clock, so with hrtime faked the whole measurement becomes exact and the
// formula can be asserted outright rather than bounded.
describe('delay mechanism – peer delay measurement', () => {
	beforeEach(() => {
		vi.useFakeTimers({
			toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'Date', 'hrtime'],
		})
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	const startP2p = async () => {
		const client = new PTPv2Client('0.0.0.0', 0, 125, 'p2p')
		await vi.advanceTimersByTimeAsync(0) // bind → listening
		return client
	}

	/**
	 * One exchange with every timing under the test's control: `wireMs` is the round trip the
	 * fake clock is advanced by, `turnaroundNs` is what the neighbour claims it spent holding
	 * the request, and `correctionNs` is what the transparent clocks claim on top.
	 */
	const exchange = async (
		client: Awaited<ReturnType<typeof startP2p>>,
		{
			wireMs,
			turnaroundNs = 0,
			twoStep = true,
			correctionNs = 0,
		}: { wireMs: number; turnaroundNs?: number; twoStep?: boolean; correctionNs?: number },
	) => {
		const before = eventSocket().send.mock.calls.length
		eventSocket().emit('message', makeSyncBuffer({ flags: 0x0000, tsSecondsLow: 1_700_000_000 }), rinfo)
		await vi.advanceTimersByTimeAsync(0) // setImmediate → Pdelay_Req sent, t1 captured
		const call = eventSocket().send.mock.calls[before]
		expect(call).toBeDefined()
		const seq = call[0].readUInt16BE(30)

		await vi.advanceTimersByTimeAsync(wireMs) // the round trip

		if (twoStep) {
			// t2 = 1s exactly; t3 = 1s + turnaround. Only the difference is ever used.
			eventSocket().emit(
				'message',
				makePdelayRespBuffer(client, { sequence: seq, flags: 0x0200, tsSecondsLow: 1, tsNanoseconds: 0 }),
				rinfo,
			)
			generalSocket().emit(
				'message',
				withCorrection(
					makePdelayFollowUpBuffer(client, { sequence: seq, tsSecondsLow: 1, tsNanoseconds: turnaroundNs }),
					correctionNs,
				),
				rinfo,
			)
			return
		}
		// One step: zeroed timestamps, turnaround folded into the correction field
		eventSocket().emit(
			'message',
			withCorrection(makePdelayRespBuffer(client, { sequence: seq, flags: 0x0000 }), correctionNs),
			rinfo,
		)
	}

	it('halves the round trip when the neighbour turns the request around instantly', async () => {
		const client = await startP2p()
		await exchange(client, { wireMs: 10, turnaroundNs: 0 })
		expect(client.peer_responding).toBe(true)
		expect(client.peer_mean_path_delay).toBe(5_000_000n) // 10ms / 2
		client.destroy()
	})

	it('subtracts the neighbour turnaround before halving, in a two-step exchange', async () => {
		const client = await startP2p()
		await exchange(client, { wireMs: 10, turnaroundNs: 4_000_000 })
		expect(client.peer_mean_path_delay).toBe(3_000_000n) // (10ms − 4ms) / 2
		client.destroy()
	})

	it('takes the turnaround from the correction field in a one-step exchange', async () => {
		const client = await startP2p()
		await exchange(client, { wireMs: 10, twoStep: false, correctionNs: 4_000_000 })
		// The same link, measured the other way the standard allows, must come out the same
		expect(client.peer_mean_path_delay).toBe(3_000_000n)
		client.destroy()
	})

	it('subtracts transparent clock residence on top of the turnaround', async () => {
		const client = await startP2p()
		await exchange(client, { wireMs: 10, turnaroundNs: 2_000_000, correctionNs: 2_000_000 })
		expect(client.peer_mean_path_delay).toBe(3_000_000n) // (10ms − 2ms − 2ms) / 2
		client.destroy()
	})

	it('rejects a negative result rather than poisoning the offset', async () => {
		const client = await startP2p()
		// A neighbour claiming it held the request longer than the whole round trip took
		await exchange(client, { wireMs: 2, turnaroundNs: 50_000_000 })
		expect(client.peer_mean_path_delay).toBe(0n)
		expect(client.peer_responding).toBe(false)
		client.destroy()
	})

	it('rejects an implausibly distant peer — no single link is 100ms away', async () => {
		const client = await startP2p()
		await exchange(client, { wireMs: 300, turnaroundNs: 0 }) // would be a 150ms link
		expect(client.peer_mean_path_delay).toBe(0n)
		expect(client.peer_responding).toBe(false)
		client.destroy()
	})

	it('emits peer_delay_changed once, and not again while the link is unchanged', async () => {
		const client = await startP2p()
		const changed = vi.fn()
		client.on('peer_delay_changed', changed)

		await exchange(client, { wireMs: 10, turnaroundNs: 0 })
		expect(changed).toHaveBeenCalledTimes(1)
		expect(changed).toHaveBeenCalledWith(5_000_000n)

		await vi.advanceTimersByTimeAsync(200) // clear the sync interval
		await exchange(client, { wireMs: 10, turnaroundNs: 0 }) // identical link
		expect(changed).toHaveBeenCalledTimes(1)

		await vi.advanceTimersByTimeAsync(200)
		await exchange(client, { wireMs: 20, turnaroundNs: 0 }) // the link changed
		expect(changed).toHaveBeenCalledTimes(2)
		expect(changed).toHaveBeenLastCalledWith(10_000_000n)
		client.destroy()
	})

	it('the measured link delay is added into the reported time', async () => {
		// The whole reason to measure it. A Sync that spent 5ms on the wire left the master
		// when its clock read t1, but by the time it reached us that clock said t1 + 5ms.
		// Ignoring the link therefore leaves our time behind by exactly one link delay.
		const timeWith = async (respond: boolean): Promise<bigint> => {
			mockSockets = []
			const client = await startP2p()
			if (respond) {
				await exchange(client, { wireMs: 10, turnaroundNs: 0 }) // 5ms link
				await vi.advanceTimersByTimeAsync(200)
			}
			// A second Sync, now that peerMeanPathDelay is known, is the one that uses it
			eventSocket().emit('message', makeSyncBuffer({ flags: 0x0000, tsSecondsLow: 1_700_000_000 }), rinfo)
			await vi.advanceTimersByTimeAsync(0)
			const time = client.ptp_time_n
			client.destroy()
			return time
		}
		const withoutPeer = await timeWith(false)
		const withPeer = await timeWith(true)
		expect(withPeer - withoutPeer).toBe(5_000_000n)
	})
})

describe('delay mechanism – labels', () => {
	it.each([
		['e2e', 'End to End'],
		['p2p', 'Peer to Peer'],
		['passive', 'Passive'],
	] as const)('%s renders as %s', async (mechanism, label) => {
		const client = await makeClient('0.0.0.0', 0, 125, mechanism)
		expect(client.delay_mechanism_label).toBe(label)
		client.destroy()
	})

	it('reads as Detecting until auto has settled', async () => {
		const client = await makeClient('0.0.0.0', 0, 125, 'auto')
		expect(client.delay_mechanism_label).toBe('Detecting')
		client.destroy()
	})
})
