import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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

const {
	PTPv1Client,
	PTP_MULTICAST,
	PTP_MULTICAST_GROUPS,
	multicastForSubdomain,
	PTP_SUBDOMAIN_DEFAULT,
	PTP_SUBDOMAIN_ALT1,
	PTP_SUBDOMAIN_ALT2,
} = await import('../ptpv1.js')
type PTP_SUBDOMAINS = import('../ptpv1.js').PTP_SUBDOMAINS

// ---------------------------------------------------------------------------
// Packet builder
// ---------------------------------------------------------------------------
// IEEE 1588-2002 6.2.2. The common header is 40 bytes. Note the 4-byte reserved field
// after the flags, which is what puts originTimestamp at byte 40 rather than 36:
//
//   0-1   versionPTP                    (uint16 BE, 1)
//   2-3   versionNetwork                (uint16 BE, 1)
//   4-19  subdomain name                (16 bytes, null padded)
//   20    messageType
//   21    sourceCommunicationTechnology
//   22-27 sourceUuid                    (6 bytes, an EUI-48)
//   28-29 sourcePortId                  (uint16 BE)
//   30-31 sequenceId                    (uint16 BE)
//   32    control
//   33    reserved
//   34-35 flags                         (uint16 BE)
//   36-39 reserved
//   40-43 originTimestamp.seconds       (uint32 BE)
//   44-47 originTimestamp.nanoseconds   (int32 BE, signed per spec)

const MSG_SYNC = 0x01
const MSG_DELAY_REQ = 0x02
const MSG_FOLLOW_UP = 0x03
const MSG_DELAY_RESP = 0x04
const FLAG_ASSIST = 0x0008 // two-step: a Follow_Up will carry the precise timestamp

interface PacketOpts {
	subdomain?: string
	msgType?: number
	uuid?: string
	portId?: number
	sequence?: number
	flags?: number
	tsSeconds?: number
	tsNanos?: number
	length?: number
	version?: number
	reserved?: number
}

const makePacket = ({
	subdomain = '_DFLT',
	msgType = MSG_SYNC,
	uuid = 'aabbccddeeff',
	portId = 1,
	sequence = 1,
	flags = 0x0000,
	tsSeconds = 0,
	tsNanos = 0,
	length = 48,
	version = 1,
	reserved = 0xdeadbeef,
}: PacketOpts = {}): Buffer => {
	const buf = Buffer.alloc(Math.max(length, 48), 0)
	buf.writeUInt16BE(version, 0)
	buf.writeUInt16BE(1, 2)
	Buffer.from(subdomain, 'ascii').copy(buf, 4, 0, Math.min(subdomain.length, 15))
	buf.writeUInt8(msgType, 20)
	Buffer.from(uuid, 'hex').copy(buf, 22)
	buf.writeUInt16BE(portId, 28)
	buf.writeUInt16BE(sequence, 30)
	buf.writeUInt16BE(flags, 34)
	// 36-39 is the reserved word that makes the header 40 bytes rather than 36. Filling it
	// with something recognisable means a body read that is 4 bytes early cannot pass by
	// accident: it would pick this up as the seconds field.
	buf.writeUInt32BE(reserved >>> 0, 36)
	buf.writeUInt32BE(tsSeconds >>> 0, 40)
	buf.writeInt32BE(tsNanos, 44)
	return buf
}

const makeSync = (o: PacketOpts = {}) => makePacket({ ...o, msgType: MSG_SYNC })

/**
 * A Follow_Up does not share the Sync body layout: associatedSequenceId sits at 42 and
 * pushes preciseOriginTimestamp out to 44/48.
 */
const makeFollowUp = (o: PacketOpts & { associatedSequence?: number } = {}): Buffer => {
	const buf = makePacket({ ...o, msgType: MSG_FOLLOW_UP, length: 52 })
	buf.writeUInt16BE(o.associatedSequence ?? o.sequence ?? 1, 42)
	buf.writeUInt32BE((o.tsSeconds ?? 0) >>> 0, 44)
	buf.writeInt32BE(o.tsNanos ?? 0, 48)
	return buf
}

/** The identity a master echoes back so a slave can recognise its own Delay_Resp */
interface Requester {
	uuid: string
	portId: number
	sequence: number
}

const makeDelayResp = (requester: Requester | undefined, o: PacketOpts = {}): Buffer => {
	const buf = makePacket({ ...o, msgType: MSG_DELAY_RESP, length: 60 })
	if (requester) {
		Buffer.from(requester.uuid, 'hex').copy(buf, 50)
		buf.writeUInt16BE(requester.portId, 56)
		buf.writeUInt16BE(requester.sequence, 58)
	}
	return buf
}

/** The Delay_Resp a master would send in answer to this client's last Delay_Req */
const respondTo = (
	client: { source_uuid: string; source_port_id: number },
	sequence: number,
	o: PacketOpts = {},
): Buffer => makeDelayResp({ uuid: client.source_uuid, portId: client.source_port_id, sequence }, o)

const rinfo = { address: '192.168.1.1', family: 'IPv4', port: 319, size: 48 }

const eventSocket = () => mockSockets[mockSockets.length - 2]
const generalSocket = () => mockSockets[mockSockets.length - 1]

const makeClient = async (iface = '0.0.0.0', subdomain: PTP_SUBDOMAINS = '_DFLT', interval = 125) => {
	const client = new PTPv1Client(iface, subdomain, interval)
	await new Promise<void>((r) => setImmediate(r))
	await new Promise<void>((r) => setImmediate(r))
	return client
}

/** Drive a one-step Sync and let the resulting Delay_Req go out */
const syncAndRequest = async (opts: PacketOpts = {}) => {
	eventSocket().emit('message', makeSync(opts), rinfo)
	await new Promise<void>((r) => setImmediate(r))
	await new Promise<void>((r) => setImmediate(r))
}

beforeEach(() => {
	mockSockets = []
	vi.clearAllMocks()
})

// ===========================================================================
// Constructor validation
// ===========================================================================
describe('PTPv1 constructor - interface', () => {
	it.each(['192.168.1.10', '0.0.0.0', '127.0.0.1'])('accepts %s', (iface) => {
		expect(() => new PTPv1Client(iface)).not.toThrow()
	})

	it.each(['', 'eth0', '::1', '10.0.0', '256.0.0.1', '10.0.0.0/8'])('rejects %s', (iface) => {
		expect(() => new PTPv1Client(iface)).toThrow(TypeError)
	})

	it('names the offending value in the error', () => {
		expect(() => new PTPv1Client('not-an-ip')).toThrow(/not-an-ip/)
	})
})

describe('PTPv1 constructor - subdomain', () => {
	it.each(['_DFLT', '_ALT1', '_ALT2', '_ALT3', '_ALT4'] as const)('accepts %s', (sd) => {
		expect(() => new PTPv1Client('0.0.0.0', sd)).not.toThrow()
	})

	it('rejects an empty subdomain', () => {
		expect(() => new PTPv1Client('0.0.0.0', '')).toThrow(TypeError)
	})

	it('rejects a subdomain longer than the 15 characters the field holds', () => {
		expect(() => new PTPv1Client('0.0.0.0', 'x'.repeat(16) as PTP_SUBDOMAINS)).toThrow(TypeError)
	})

	it('rejects non-printable characters, which the field cannot carry', () => {
		const withControlChar = `_DF${String.fromCharCode(1)}T`
		expect(() => new PTPv1Client('0.0.0.0', withControlChar as PTP_SUBDOMAINS)).toThrow(TypeError)
	})

	it('reports the subdomain it is listening on', async () => {
		const client = await makeClient('0.0.0.0', PTP_SUBDOMAIN_ALT1)
		expect(client.ptp_subdomain).toBe('_ALT1')
		client.destroy()
	})
})

// ===========================================================================
// Sockets
// ===========================================================================
describe('PTPv1 sockets', () => {
	it('binds the PTP ports to INADDR_ANY, not to the interface address', async () => {
		// A socket bound to a specific unicast address receives no multicast at all. The
		// interface is chosen by addMembership, which is where the configured address goes.
		const client = await makeClient('192.168.1.10')
		expect(eventSocket().bind).toHaveBeenCalledWith(319)
		expect(generalSocket().bind).toHaveBeenCalledWith(320)
		expect(eventSocket().addMembership).toHaveBeenCalledWith('224.0.1.129', '192.168.1.10')
		client.destroy()
	})

	it.each([
		['_DFLT', '224.0.1.129'],
		['_ALT1', '224.0.1.130'],
		['_ALT2', '224.0.1.131'],
		['_ALT3', '224.0.1.132'],
	] as const)('subdomain %s joins %s', async (subdomain, group) => {
		const client = await makeClient('0.0.0.0', subdomain)
		expect(eventSocket().addMembership).toHaveBeenCalledWith(group, '0.0.0.0')
		expect(generalSocket().addMembership).toHaveBeenCalledWith(group, '0.0.0.0')
		client.destroy()
	})

	it('matches the addresses Audinate documents for Dante', () => {
		expect(PTP_MULTICAST).toEqual({
			_DFLT: '224.0.1.129',
			_ALT1: '224.0.1.130',
			_ALT2: '224.0.1.131',
			_ALT3: '224.0.1.132',
			// Not a typo. IEEE 1588-2002 defines only three alternate addresses, so Dante's
			// fifth subdomain doubles up on _ALT2's group and the subdomain name separates them.
			_ALT4: '224.0.1.131',
		})
	})

	it('_ALT4 joins the same group as _ALT2, as Dante actually uses it', async () => {
		const client = await makeClient('0.0.0.0', '_ALT4')
		expect(eventSocket().addMembership).toHaveBeenCalledWith('224.0.1.131', '0.0.0.0')
		client.destroy()
	})

	it('separates two subdomains sharing one group by name alone', async () => {
		// The whole reason the receive path compares the 16-byte name rather than trusting the
		// group: on 224.0.1.131 both _ALT2 and _ALT4 traffic arrives at every listener
		const client = await makeClient('0.0.0.0', '_ALT4')
		const changed = vi.fn()
		client.on('ptp_master_changed', changed)

		eventSocket().emit('message', makeSync({ subdomain: '_ALT2', uuid: '111111111111' }), rinfo)
		expect(changed).not.toHaveBeenCalled()

		eventSocket().emit('message', makeSync({ subdomain: '_ALT4', uuid: '222222222222' }), rinfo)
		expect(changed).toHaveBeenCalledTimes(1)
		expect(client.ptp_master[0]).toBe('22-22-22-22-22-22:1')
		// The other domain on the shared group is still recorded as seen
		expect([...client.subdomains]).toEqual(expect.arrayContaining(['_ALT2', '_ALT4']))
		client.destroy()
	})

	it('closes both sockets on destroy', async () => {
		const client = await makeClient()
		client.destroy()
		expect(eventSocket().close).toHaveBeenCalled()
		expect(generalSocket().close).toHaveBeenCalled()
	})

	it('destroy is idempotent, since it runs on every config change and again at teardown', async () => {
		const client = await makeClient()
		client.destroy()
		client.destroy()
		expect(eventSocket().close).toHaveBeenCalledTimes(1)
	})

	it('emits close when a socket closes', async () => {
		const client = await makeClient()
		const closed = vi.fn()
		client.on('close', closed)
		eventSocket().emit('close')
		expect(closed).toHaveBeenCalled()
		client.destroy()
	})

	it('emits listening once each socket is up', async () => {
		const listening = vi.fn()
		const client = new PTPv1Client('0.0.0.0')
		client.on('listening', listening)
		await new Promise<void>((r) => setImmediate(r))
		await new Promise<void>((r) => setImmediate(r))
		expect(listening).toHaveBeenCalledTimes(2)
		client.destroy()
	})

	it('surfaces a socket error rather than throwing', async () => {
		const client = await makeClient()
		const onError = vi.fn()
		client.on('error', onError)
		eventSocket().emit('error', new Error('boom'))
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }))
		client.destroy()
	})
})

// ===========================================================================
// Subdomain filtering and discovery
// ===========================================================================
describe('PTPv1 subdomain handling', () => {
	it('processes a Sync carrying the configured subdomain', async () => {
		const client = await makeClient('0.0.0.0', PTP_SUBDOMAIN_DEFAULT)
		const changed = vi.fn()
		client.on('ptp_master_changed', changed)
		eventSocket().emit('message', makeSync({ subdomain: '_DFLT' }), rinfo)
		expect(changed).toHaveBeenCalled()
		client.destroy()
	})

	it('ignores a Sync from another subdomain', async () => {
		const client = await makeClient('0.0.0.0', PTP_SUBDOMAIN_DEFAULT)
		const changed = vi.fn()
		client.on('ptp_master_changed', changed)
		eventSocket().emit('message', makeSync({ subdomain: '_ALT1' }), rinfo)
		expect(changed).not.toHaveBeenCalled()
		client.destroy()
	})

	it('a prefix of the configured name is not a match', async () => {
		// The comparison covers the whole 16-byte field, so _DFL must not match _DFLT
		const client = await makeClient('0.0.0.0', PTP_SUBDOMAIN_DEFAULT)
		const changed = vi.fn()
		client.on('ptp_master_changed', changed)
		eventSocket().emit('message', makeSync({ subdomain: '_DFL' }), rinfo)
		expect(changed).not.toHaveBeenCalled()
		client.destroy()
	})

	it('still records subdomains it is not listening to', async () => {
		// On a Dante network the subdomain follows the sample rate family, so an unexpected
		// one on the wire is how you find a device running on the wrong clock
		const client = await makeClient('0.0.0.0', PTP_SUBDOMAIN_DEFAULT)
		const seen = vi.fn()
		client.on('domains', seen)
		eventSocket().emit('message', makeSync({ subdomain: '_ALT2' }), rinfo)
		expect(seen).toHaveBeenCalled()
		expect([...client.subdomains]).toContain('_ALT2')
		client.destroy()
	})

	it('records each subdomain only once', async () => {
		const client = await makeClient()
		const seen = vi.fn()
		client.on('domains', seen)
		eventSocket().emit('message', makeSync({ subdomain: '_ALT3' }), rinfo)
		eventSocket().emit('message', makeSync({ subdomain: '_ALT3' }), rinfo)
		expect(seen).toHaveBeenCalledTimes(1)
		client.destroy()
	})

	it('discovers subdomains from the general socket too', async () => {
		const client = await makeClient()
		generalSocket().emit('message', makeFollowUp({ subdomain: '_ALT1' }), rinfo)
		expect([...client.subdomains]).toContain('_ALT1')
		client.destroy()
	})
})

// ===========================================================================
// Master identity
// ===========================================================================
describe('PTPv1 master identity', () => {
	it('renders the source as uuid:portId', async () => {
		const client = await makeClient()
		eventSocket().emit('message', makeSync({ uuid: 'aabbccddeeff', portId: 1 }), rinfo)
		expect(client.ptp_master[0]).toBe('aa-bb-cc-dd-ee-ff:1')
		expect(client.ptp_master[1]).toBe('192.168.1.1')
		client.destroy()
	})

	it('does not re-announce the same master', async () => {
		const client = await makeClient()
		const changed = vi.fn()
		client.on('ptp_master_changed', changed)
		eventSocket().emit('message', makeSync({ sequence: 1 }), rinfo)
		eventSocket().emit('message', makeSync({ sequence: 2 }), rinfo)
		expect(changed).toHaveBeenCalledTimes(1)
		client.destroy()
	})

	it.each([
		['a different uuid', { uuid: '112233445566' }],
		['a different port on the same clock', { portId: 2 }],
	])('announces a new master for %s', async (_label, opts) => {
		const client = await makeClient()
		const changed = vi.fn()
		client.on('ptp_master_changed', changed)
		eventSocket().emit('message', makeSync(), rinfo)
		eventSocket().emit('message', makeSync(opts), rinfo)
		expect(changed).toHaveBeenCalledTimes(2)
		client.destroy()
	})
})

// ===========================================================================
// Message filtering
// ===========================================================================
describe('PTPv1 message filtering', () => {
	it('ignores a datagram too short to be a PTPv1 header', async () => {
		const client = await makeClient()
		expect(() => eventSocket().emit('message', Buffer.alloc(8), rinfo)).not.toThrow()
		expect(() => generalSocket().emit('message', Buffer.alloc(8), rinfo)).not.toThrow()
		client.destroy()
	})

	it('ignores a non-Sync message on the event socket', async () => {
		const client = await makeClient()
		const changed = vi.fn()
		client.on('ptp_master_changed', changed)
		eventSocket().emit('message', makePacket({ msgType: MSG_DELAY_REQ }), rinfo)
		expect(changed).not.toHaveBeenCalled()
		client.destroy()
	})

	it('ignores a Delay_Resp for another sequence', async () => {
		const client = await makeClient()
		const synced = vi.fn()
		client.on('ptp_time_synced', synced)
		await syncAndRequest()
		generalSocket().emit('message', respondTo(client, 9999), rinfo)
		expect(synced).not.toHaveBeenCalled()
		client.destroy()
	})
})

// ===========================================================================
// Delay_Req
// ===========================================================================
describe('PTPv1 Delay_Req', () => {
	it('is sent to the subdomain multicast group on the event port', async () => {
		const client = await makeClient('0.0.0.0', PTP_SUBDOMAIN_ALT2)
		await syncAndRequest({ subdomain: '_ALT2' })
		expect(eventSocket().send).toHaveBeenCalledTimes(1)
		const [, port, addr] = eventSocket().send.mock.calls[0]
		expect(port).toBe(319)
		expect(addr).toBe(PTP_MULTICAST[PTP_SUBDOMAIN_ALT2])
		client.destroy()
	})

	it('is a conformant PTPv1 packet', async () => {
		const client = await makeClient()
		await syncAndRequest()
		const buf = eventSocket().send.mock.calls[0][0]
		expect(buf.readUInt16BE(0)).toBe(1) // versionPTP
		expect(buf.readUInt16BE(2)).toBe(1) // versionNetwork
		expect(buf.toString('ascii', 4, 9)).toBe('_DFLT') // subdomain
		expect(buf.readUInt8(20)).toBe(MSG_DELAY_REQ)
		expect(buf.readUInt8(32)).toBe(0x01) // control: Delay_Req
		client.destroy()
	})

	it('carries the configured subdomain, not the default', async () => {
		const client = await makeClient('0.0.0.0', PTP_SUBDOMAIN_ALT1)
		await syncAndRequest({ subdomain: '_ALT1' })
		const buf = eventSocket().send.mock.calls[0][0]
		expect(buf.toString('ascii', 4, 9)).toBe('_ALT1')
		client.destroy()
	})

	it('follows a two-step master onto its Follow_Up', async () => {
		const client = await makeClient()
		eventSocket().emit('message', makeSync({ flags: FLAG_ASSIST, sequence: 5 }), rinfo)
		expect(eventSocket().send).not.toHaveBeenCalled() // waiting for the Follow_Up
		generalSocket().emit('message', makeFollowUp({ sequence: 5 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		expect(eventSocket().send).toHaveBeenCalledTimes(1)
		client.destroy()
	})

	it('ignores a Follow_Up whose sequence does not match the Sync', async () => {
		const client = await makeClient()
		eventSocket().emit('message', makeSync({ flags: FLAG_ASSIST, sequence: 5 }), rinfo)
		generalSocket().emit('message', makeFollowUp({ sequence: 6 }), rinfo)
		await new Promise<void>((r) => setImmediate(r))
		expect(eventSocket().send).not.toHaveBeenCalled()
		client.destroy()
	})

	it('is not sent after destroy', async () => {
		const client = await makeClient()
		eventSocket().emit('message', makeSync(), rinfo)
		client.destroy()
		await new Promise<void>((r) => setImmediate(r))
		await new Promise<void>((r) => setImmediate(r))
		expect(eventSocket().send).not.toHaveBeenCalled()
	})
})

// ===========================================================================
// Sync state
// ===========================================================================
describe('PTPv1 sync state', () => {
	it('starts unsynced with no master and no last sync', async () => {
		const client = await makeClient()
		expect(client.is_synced).toBe(false)
		expect(client.ptp_master).toEqual(['', ''])
		expect(client.last_sync).toBe(0)
		client.destroy()
	})

	it('completes an exchange and reports sync', async () => {
		const client = await makeClient()
		const synced = vi.fn()
		const syncChanged = vi.fn()
		client.on('ptp_time_synced', synced)
		client.on('sync_changed', syncChanged)

		await syncAndRequest()
		const seq = eventSocket().send.mock.calls[0][0].readUInt16BE(30)
		generalSocket().emit('message', respondTo(client, seq), rinfo)

		expect(synced).toHaveBeenCalled()
		expect(syncChanged).toHaveBeenCalledWith(true)
		expect(client.is_synced).toBe(true)
		expect(client.last_sync).toBeGreaterThan(0)
		client.destroy()
	})

	it('does not repeat sync_changed while it stays synced', async () => {
		const client = await makeClient()
		const syncChanged = vi.fn()
		client.on('sync_changed', syncChanged)
		await syncAndRequest()
		const seq = eventSocket().send.mock.calls[0][0].readUInt16BE(30)
		generalSocket().emit('message', respondTo(client, seq), rinfo)
		generalSocket().emit('message', respondTo(client, seq), rinfo)
		expect(syncChanged).toHaveBeenCalledTimes(1)
		client.destroy()
	})

	it('drops sync on destroy so a stale lock is not left on display', async () => {
		const client = await makeClient()
		await syncAndRequest()
		const seq = eventSocket().send.mock.calls[0][0].readUInt16BE(30)
		generalSocket().emit('message', respondTo(client, seq), rinfo)
		const syncChanged = vi.fn()
		client.on('sync_changed', syncChanged)
		client.destroy()
		expect(syncChanged).toHaveBeenCalledWith(false)
		expect(client.is_synced).toBe(false)
	})

	it('exposes the derived time in both shapes', async () => {
		const client = await makeClient()
		const [s, ns] = client.ptp_time
		expect(Number.isFinite(s)).toBe(true)
		expect(ns).toBeGreaterThanOrEqual(0)
		expect(ns).toBeLessThan(1_000_000_000)
		expect(typeof client.ptp_time_n).toBe('bigint')
		client.destroy()
	})
})

// ===========================================================================
// Timestamps and offset
// ===========================================================================
// Every term of the offset is a nanosecond count in the region of 1.7e18 - some two hundred
// times past what a double holds exactly - so with hrtime faked the whole calculation becomes
// exact and can be asserted outright rather than bounded.
describe('PTPv1 timestamps and offset', () => {
	const MASTER_SECONDS = 1_700_000_000
	const MASTER_NS = BigInt(MASTER_SECONDS) * 1_000_000_000n

	beforeEach(() => {
		vi.useFakeTimers({
			toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'Date', 'hrtime'],
		})
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	const startClient = async () => {
		const client = new PTPv1Client('0.0.0.0', '_DFLT', 125)
		await vi.advanceTimersByTimeAsync(0)
		return client
	}

	/**
	 * A complete one-step exchange with the clock held still. The master claims it sent the
	 * Sync at MASTER_SECONDS and received our request at the same instant, which makes the
	 * derived time exactly MASTER_SECONDS.
	 */
	const exchange = async (client: Awaited<ReturnType<typeof startClient>>, opts: PacketOpts = {}) => {
		eventSocket().emit('message', makeSync({ tsSeconds: MASTER_SECONDS, ...opts }), rinfo)
		await vi.advanceTimersByTimeAsync(0)
		const seq = eventSocket().send.mock.calls[eventSocket().send.mock.calls.length - 1][0].readUInt16BE(30)
		generalSocket().emit('message', respondTo(client, seq, { tsSeconds: MASTER_SECONDS }), rinfo)
	}

	it('reads originTimestamp from byte 40, not from the reserved word at 36', async () => {
		const client = await startClient()
		await exchange(client)
		// Reading four bytes early would take 0xdeadbeef as the seconds and the real seconds
		// as the nanoseconds, landing the clock roughly 118 years away
		expect(client.ptp_time[0]).toBe(MASTER_SECONDS)
		client.destroy()
	})

	it('derives the time to the nanosecond, without floating point rounding', async () => {
		const client = await startClient()
		await exchange(client)
		expect(client.ptp_time_n).toBe(MASTER_NS)
		expect(client.ptp_time).toEqual([MASTER_SECONDS, 0])
		client.destroy()
	})

	it('carries the nanoseconds field through as well as the seconds', async () => {
		const client = await startClient()
		eventSocket().emit('message', makeSync({ tsSeconds: MASTER_SECONDS, tsNanos: 500_000_000 }), rinfo)
		await vi.advanceTimersByTimeAsync(0)
		const seq = eventSocket().send.mock.calls[0][0].readUInt16BE(30)
		generalSocket().emit('message', respondTo(client, seq, { tsSeconds: MASTER_SECONDS, tsNanos: 500_000_000 }), rinfo)
		expect(client.ptp_time_n).toBe(MASTER_NS + 500_000_000n)
		client.destroy()
	})

	it('handles the signed nanoseconds the standard allows', async () => {
		// IEEE 1588-2002 makes the nanoseconds field a signed int32; read as unsigned it would
		// come out around +4.29e9 rather than negative
		const client = await startClient()
		eventSocket().emit('message', makeSync({ tsSeconds: MASTER_SECONDS, tsNanos: -250_000_000 }), rinfo)
		await vi.advanceTimersByTimeAsync(0)
		const seq = eventSocket().send.mock.calls[0][0].readUInt16BE(30)
		generalSocket().emit('message', respondTo(client, seq, { tsSeconds: MASTER_SECONDS, tsNanos: -250_000_000 }), rinfo)
		expect(client.ptp_time_n).toBe(MASTER_NS - 250_000_000n)
		client.destroy()
	})

	it('takes the round trip into account, halving it as the standard prescribes', async () => {
		// The master receives our Delay_Req 10ms after it sent the Sync, so each leg took 5ms.
		// The Sync therefore reached us when the master's clock already read MASTER + 5ms, and
		// the derived time is that much later than the timestamp the packet carried.
		const client = await startClient()
		eventSocket().emit('message', makeSync({ tsSeconds: MASTER_SECONDS }), rinfo)
		await vi.advanceTimersByTimeAsync(0)
		const seq = eventSocket().send.mock.calls[0][0].readUInt16BE(30)
		generalSocket().emit('message', respondTo(client, seq, { tsSeconds: MASTER_SECONDS, tsNanos: 10_000_000 }), rinfo)
		expect(client.ptp_time_n).toBe(MASTER_NS + 5_000_000n)
		client.destroy()
	})

	it('reads a two-step preciseOriginTimestamp from byte 44', async () => {
		// A Follow_Up puts associatedSequenceId at 42, which pushes its timestamp 4 bytes past
		// where a Sync carries one
		const client = await startClient()
		eventSocket().emit('message', makeSync({ flags: FLAG_ASSIST, sequence: 7 }), rinfo)
		generalSocket().emit('message', makeFollowUp({ sequence: 7, tsSeconds: MASTER_SECONDS }), rinfo)
		await vi.advanceTimersByTimeAsync(0)
		const seq = eventSocket().send.mock.calls[0][0].readUInt16BE(30)
		generalSocket().emit('message', respondTo(client, seq, { tsSeconds: MASTER_SECONDS }), rinfo)
		expect(client.ptp_time[0]).toBe(MASTER_SECONDS)
		client.destroy()
	})

	it('matches a Follow_Up on associatedSequenceId, not on its own header sequence', async () => {
		// A master that numbers its Follow_Ups independently is still answering our Sync
		const client = await startClient()
		eventSocket().emit('message', makeSync({ flags: FLAG_ASSIST, sequence: 7 }), rinfo)
		generalSocket().emit('message', makeFollowUp({ sequence: 999, associatedSequence: 7 }), rinfo)
		await vi.advanceTimersByTimeAsync(0)
		expect(eventSocket().send).toHaveBeenCalledTimes(1)
		client.destroy()
	})

	it('ignores a Follow_Up whose associatedSequenceId belongs to another exchange', async () => {
		const client = await startClient()
		eventSocket().emit('message', makeSync({ flags: FLAG_ASSIST, sequence: 7 }), rinfo)
		generalSocket().emit('message', makeFollowUp({ sequence: 7, associatedSequence: 8 }), rinfo)
		await vi.advanceTimersByTimeAsync(0)
		expect(eventSocket().send).not.toHaveBeenCalled()
		client.destroy()
	})

	it('ignores a Follow_Up too short to hold its timestamp', async () => {
		const client = await startClient()
		eventSocket().emit('message', makeSync({ flags: FLAG_ASSIST, sequence: 7 }), rinfo)
		generalSocket().emit('message', makePacket({ msgType: MSG_FOLLOW_UP, length: 48 }), rinfo)
		await vi.advanceTimersByTimeAsync(0)
		expect(eventSocket().send).not.toHaveBeenCalled()
		client.destroy()
	})
})

// ===========================================================================
// Delay_Resp ownership
// ===========================================================================
describe('PTPv1 Delay_Resp ownership', () => {
	/** Drive a Sync through to the Delay_Req and return the sequence it went out with */
	const completeExchange = async (): Promise<number> => {
		await syncAndRequest()
		return eventSocket().send.mock.calls[0][0].readUInt16BE(30)
	}

	it('stamps our own uuid and port on the Delay_Req', async () => {
		// Without these the master echoes back zeroes and every slave on the subdomain looks
		// identical in the response
		const client = await makeClient()
		await syncAndRequest()
		const buf = eventSocket().send.mock.calls[0][0]
		expect(buf.toString('hex', 22, 28)).toBe(client.source_uuid)
		expect(buf.readUInt16BE(28)).toBe(client.source_port_id)
		expect(client.source_uuid).not.toBe('000000000000')
		client.destroy()
	})

	it('accepts a Delay_Resp stamped with our identity', async () => {
		const client = await makeClient()
		const seq = await completeExchange()
		generalSocket().emit('message', respondTo(client, seq), rinfo)
		expect(client.is_synced).toBe(true)
		client.destroy()
	})

	it('ignores a Delay_Resp addressed to another slave', async () => {
		const client = await makeClient()
		const seq = await completeExchange()
		generalSocket().emit(
			'message',
			makeDelayResp({ uuid: 'ffeeddccbbaa', portId: client.source_port_id, sequence: seq }),
			rinfo,
		)
		expect(client.is_synced).toBe(false)
		client.destroy()
	})

	it('ignores a Delay_Resp for another port of the same clock', async () => {
		const client = await makeClient()
		const seq = await completeExchange()
		generalSocket().emit('message', makeDelayResp({ uuid: client.source_uuid, portId: 99, sequence: seq }), rinfo)
		expect(client.is_synced).toBe(false)
		client.destroy()
	})

	it('ignores a Delay_Resp for a stale sequence', async () => {
		const client = await makeClient()
		await completeExchange()
		generalSocket().emit('message', respondTo(client, 9999), rinfo)
		expect(client.is_synced).toBe(false)
		client.destroy()
	})

	it('ignores a Delay_Resp too short to carry the requesting identity', async () => {
		const client = await makeClient()
		const seq = await completeExchange()
		generalSocket().emit('message', makePacket({ msgType: MSG_DELAY_RESP, length: 48, sequence: seq }), rinfo)
		expect(client.is_synced).toBe(false)
		client.destroy()
	})
})

// ===========================================================================
// Request rate and sync loss
// ===========================================================================
describe('PTPv1 request rate', () => {
	it('sends only one Delay_Req for a burst of Syncs with no response', async () => {
		// Keyed on the last attempt: keying it on the last success means a silent master
		// draws a fresh request from every single Sync
		const client = await makeClient('0.0.0.0', '_DFLT', 10000)
		for (let i = 1; i <= 5; i++) {
			eventSocket().emit('message', makeSync({ sequence: i }), rinfo)
			await new Promise<void>((r) => setImmediate(r))
			await new Promise<void>((r) => setImmediate(r))
		}
		expect(eventSocket().send).toHaveBeenCalledTimes(1)
		client.destroy()
	})
})

describe('PTPv1 sync loss', () => {
	beforeEach(() => {
		vi.useFakeTimers({
			toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'Date', 'hrtime'],
		})
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	/** A Sync long enough to carry the master's advertised syncInterval at byte 83 */
	const syncWithInterval = (logInterval: number, opts: PacketOpts = {}) => {
		const buf = makeSync({ ...opts, length: 124 })
		buf.writeInt8(logInterval, 83)
		return buf
	}

	it('defaults to the 2 second interval the standard specifies', async () => {
		const client = new PTPv1Client('0.0.0.0', '_DFLT', 125)
		await vi.advanceTimersByTimeAsync(0)
		expect(client.sync_interval).toBe(2)
		expect(client.sync_receipt_timeout).toBe(6000)
		client.destroy()
	})

	it.each([
		[-1, 0.5, 1500],
		[0, 1, 3000],
		[1, 2, 6000],
		[2, 4, 12000],
	])('takes the interval the master advertises (log %i)', async (logInterval, seconds, timeout) => {
		const client = new PTPv1Client('0.0.0.0', '_DFLT', 125)
		await vi.advanceTimersByTimeAsync(0)
		eventSocket().emit('message', syncWithInterval(logInterval), rinfo)
		expect(client.sync_interval).toBe(seconds)
		expect(client.sync_receipt_timeout).toBe(timeout)
		client.destroy()
	})

	it('drops sync after three of the master own intervals, not a multiple of our poll rate', async () => {
		const client = new PTPv1Client('0.0.0.0', '_DFLT', 125)
		await vi.advanceTimersByTimeAsync(0)
		const syncChanged = vi.fn()

		eventSocket().emit('message', syncWithInterval(0), rinfo) // 1s interval, so 3s timeout
		await vi.advanceTimersByTimeAsync(0)
		const seq = eventSocket().send.mock.calls[0][0].readUInt16BE(30)
		generalSocket().emit('message', respondTo(client, seq), rinfo)
		expect(client.is_synced).toBe(true)
		client.on('sync_changed', syncChanged)

		await vi.advanceTimersByTimeAsync(2_900)
		expect(syncChanged).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(200)
		expect(syncChanged).toHaveBeenCalledWith(false)
		expect(client.is_synced).toBe(false)
		client.destroy()
	})

	it('a continuing flow of Syncs holds sync up', async () => {
		const client = new PTPv1Client('0.0.0.0', '_DFLT', 125)
		await vi.advanceTimersByTimeAsync(0)
		eventSocket().emit('message', syncWithInterval(0), rinfo)
		await vi.advanceTimersByTimeAsync(0)
		const seq = eventSocket().send.mock.calls[0][0].readUInt16BE(30)
		generalSocket().emit('message', respondTo(client, seq), rinfo)

		for (let i = 0; i < 5; i++) {
			await vi.advanceTimersByTimeAsync(1_000)
			eventSocket().emit('message', syncWithInterval(0, { sequence: i + 2 }), rinfo)
		}
		expect(client.is_synced).toBe(true)
		client.destroy()
	})

	it('arms the timeout from the Sync itself, not only from a completed exchange', async () => {
		// A master that never answers Delay_Req must still be declared lost when it stops
		const client = new PTPv1Client('0.0.0.0', '_DFLT', 125)
		await vi.advanceTimersByTimeAsync(0)
		eventSocket().emit('message', syncWithInterval(0), rinfo)
		const syncChanged = vi.fn()
		client.on('sync_changed', syncChanged)
		await vi.advanceTimersByTimeAsync(3_100)
		// never synced, so there is no true->false transition to report, but the timer must
		// have run rather than never having been armed
		expect(client.is_synced).toBe(false)
		client.destroy()
	})
})

// ===========================================================================
// Custom subdomains
// ===========================================================================
// A Dante Domain Manager network can be given any subdomain name, which Audinate maps onto
// one of the three alternate groups by a rule it does not publish. The name therefore cannot
// yield the address, and the group has to be supplied alongside it.
describe('PTPv1 custom subdomains', () => {
	const CUSTOM = 'H~O$L'

	it('joins the group it was given rather than guessing one', async () => {
		const client = new PTPv1Client('0.0.0.0', CUSTOM, 125, '224.0.1.132')
		await new Promise<void>((r) => setImmediate(r))
		await new Promise<void>((r) => setImmediate(r))
		expect(eventSocket().addMembership).toHaveBeenCalledWith('224.0.1.132', '0.0.0.0')
		expect(generalSocket().addMembership).toHaveBeenCalledWith('224.0.1.132', '0.0.0.0')
		expect(client.ptp_multicast).toBe('224.0.1.132')
		expect(client.ptp_subdomain).toBe(CUSTOM)
		client.destroy()
	})

	it('refuses a name it cannot place, rather than silently joining the default', () => {
		// Defaulting to 224.0.1.129 here would look like it worked and receive nothing
		expect(() => new PTPv1Client('0.0.0.0', CUSTOM, 125)).toThrow(TypeError)
		expect(() => new PTPv1Client('0.0.0.0', CUSTOM, 125)).toThrow(/multicast group/)
	})

	it.each(['224.0.1.128', '224.0.1.133', '239.255.0.1', 'not-an-address', ''])(
		'rejects %s, which is not a PTPv1 group',
		(group) => {
			expect(() => new PTPv1Client('0.0.0.0', CUSTOM, 125, group)).toThrow(TypeError)
		},
	)

	it.each(PTP_MULTICAST_GROUPS)('accepts the defined group %s', (group) => {
		expect(() => new PTPv1Client('0.0.0.0', CUSTOM, 125, group)).not.toThrow()
	})

	it('applies the same name rules as a well-known subdomain', () => {
		expect(() => new PTPv1Client('0.0.0.0', 'x'.repeat(16), 125, '224.0.1.130')).toThrow(TypeError)
		expect(() => new PTPv1Client('0.0.0.0', '', 125, '224.0.1.130')).toThrow(TypeError)
		expect(() => new PTPv1Client('0.0.0.0', `a${String.fromCharCode(1)}b`, 125, '224.0.1.130')).toThrow(TypeError)
		expect(() => new PTPv1Client('0.0.0.0', 'x'.repeat(15), 125, '224.0.1.130')).not.toThrow()
	})

	it('filters on the custom name, ignoring other domains on the same group', async () => {
		const client = new PTPv1Client('0.0.0.0', CUSTOM, 125, '224.0.1.131')
		await new Promise<void>((r) => setImmediate(r))
		await new Promise<void>((r) => setImmediate(r))
		const changed = vi.fn()
		client.on('ptp_master_changed', changed)

		eventSocket().emit('message', makeSync({ subdomain: '_ALT2', uuid: '111111111111' }), rinfo)
		expect(changed).not.toHaveBeenCalled()

		eventSocket().emit('message', makeSync({ subdomain: CUSTOM, uuid: '222222222222' }), rinfo)
		expect(changed).toHaveBeenCalledTimes(1)
		client.destroy()
	})

	it('sends its Delay_Req to the given group carrying the custom name', async () => {
		const client = new PTPv1Client('0.0.0.0', CUSTOM, 125, '224.0.1.130')
		await new Promise<void>((r) => setImmediate(r))
		await new Promise<void>((r) => setImmediate(r))
		await syncAndRequest({ subdomain: CUSTOM })

		const [buf, , addr] = eventSocket().send.mock.calls[0]
		expect(addr).toBe('224.0.1.130')
		expect(buf.toString('ascii', 4, 4 + CUSTOM.length)).toBe(CUSTOM)
		// the field is null padded out to 16 bytes
		expect(buf.readUInt8(4 + CUSTOM.length)).toBe(0)
		client.destroy()
	})

	it('an explicit group overrides the table for a well-known name too', async () => {
		// The Dante Domain Manager tables show a well-known name can sit on another group
		const client = new PTPv1Client('0.0.0.0', '_ALT1', 125, '224.0.1.132')
		await new Promise<void>((r) => setImmediate(r))
		await new Promise<void>((r) => setImmediate(r))
		expect(client.ptp_multicast).toBe('224.0.1.132')
		client.destroy()
	})

	it('multicastForSubdomain answers only for the well-known names', () => {
		expect(multicastForSubdomain('_DFLT')).toBe('224.0.1.129')
		expect(multicastForSubdomain('_ALT4')).toBe('224.0.1.131')
		expect(multicastForSubdomain(CUSTOM)).toBeUndefined()
		expect(multicastForSubdomain('')).toBeUndefined()
		// A name that collides with an Object.prototype key must not resolve to a function
		expect(multicastForSubdomain('toString')).toBeUndefined()
	})
})

// ===========================================================================
// Subdomain discovery
// ===========================================================================
// The subdomain of a Dante Domain Manager network is not chosen by the user, so reading the
// names off the wire is the only practical way to find out what to configure. Discovery is
// deliberately unfiltered: it reports what is on the group, including domains this connection
// is not listening to.
describe('PTPv1 subdomain discovery', () => {
	it('starts empty', async () => {
		const client = await makeClient()
		expect([...client.subdomains]).toEqual([])
		client.destroy()
	})

	it('reports names this connection is not listening to', async () => {
		const client = await makeClient('0.0.0.0', '_ALT2')
		eventSocket().emit('message', makeSync({ subdomain: '_ALT4' }), rinfo)
		expect([...client.subdomains]).toEqual(['_ALT4'])
		client.destroy()
	})

	it('reports a custom name verbatim, which is the point of it', async () => {
		// A DDM name is arbitrary text; it has to survive to the user exactly as sent
		const client = new PTPv1Client('0.0.0.0', '_DFLT', 125, '224.0.1.131')
		await new Promise<void>((r) => setImmediate(r))
		await new Promise<void>((r) => setImmediate(r))
		eventSocket().emit('message', makeSync({ subdomain: 'H~O$L' }), rinfo)
		expect([...client.subdomains]).toEqual(['H~O$L'])
		client.destroy()
	})

	it('keeps the order names were first heard in, and does not repeat them', async () => {
		const client = await makeClient()
		for (const subdomain of ['_ALT3', '_DFLT', '_ALT3', 'H~O$L', '_DFLT']) {
			eventSocket().emit('message', makeSync({ subdomain }), rinfo)
		}
		expect([...client.subdomains]).toEqual(['_ALT3', '_DFLT', 'H~O$L'])
		client.destroy()
	})

	it('gathers names from both sockets', async () => {
		const client = await makeClient()
		eventSocket().emit('message', makeSync({ subdomain: '_ALT1' }), rinfo)
		generalSocket().emit('message', makeFollowUp({ subdomain: '_ALT2' }), rinfo)
		expect([...client.subdomains]).toEqual(['_ALT1', '_ALT2'])
		client.destroy()
	})

	it('emits every time a new name appears, carrying the full set', async () => {
		const client = await makeClient()
		const seen = vi.fn()
		client.on('domains', seen)
		eventSocket().emit('message', makeSync({ subdomain: '_ALT1' }), rinfo)
		eventSocket().emit('message', makeSync({ subdomain: '_ALT2' }), rinfo)
		expect(seen).toHaveBeenCalledTimes(2)
		expect([...seen.mock.calls[1][0]]).toEqual(['_ALT1', '_ALT2'])
		client.destroy()
	})

	it('does not record a name from a datagram too short to be PTPv1', async () => {
		const client = await makeClient()
		eventSocket().emit('message', Buffer.alloc(8), rinfo)
		expect([...client.subdomains]).toEqual([])
		client.destroy()
	})
})
