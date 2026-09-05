import dgram from 'dgram'
import { EventEmitter } from 'events'
import { isIPv4 } from 'net'
import { networkInterfaces } from 'os'
import { randomBytes } from 'crypto'
import { lookupOui } from './oui.js'

export type PtpTime = [number, number]

// PTPv2 multicast addressing per IEEE 1588-2008 Annex D:
// Every domain shares the PTP primary multicast address 224.0.1.129. The domain is carried
// solely by the domainNumber byte of the header, which is why the receive path filters on it.
// The per-subdomain addresses 224.0.1.130–132 are an IEEE 1588-2002 (PTPv1) mechanism that
// PTPv2 replaced with domainNumber; no PTPv2 traffic is ever sent to them.
// Domains 0–127 are valid; 128–255 are reserved by the standard.
const PTP_PRIMARY_MULTICAST = '224.0.1.129'
// The peer delay mechanism has its own group, and it is deliberately link-local: 224.0.0.0/24
// is never forwarded by a router. Pdelay therefore only ever reaches the device on the other
// end of our own cable, which is what makes it measure a link rather than a path — and also
// why hearing no Pdelay proves nothing about the rest of the domain.
const PTP_PDELAY_MULTICAST = '224.0.0.107'

// IEEE 1588-2019 redefined the upper nibble of byte 1, reserved in 2008, as minorVersionPTP.
// A 2019 device therefore sends 0x12 rather than 0x02, and the version check must mask the
// low nibble or every packet from a modern grandmaster is discarded.
const PTP_VERSION = 2

const PTP_EVENT_PORT = 319
const PTP_GENERAL_PORT = 320

// Message types (low nibble of byte 0)
const MSG_SYNC = 0x00
const MSG_DELAY_REQ = 0x01
const MSG_PDELAY_REQ = 0x02
const MSG_PDELAY_RESP = 0x03
const MSG_FOLLOW_UP = 0x08
const MSG_DELAY_RESP = 0x09
const MSG_PDELAY_RESP_FOLLOW_UP = 0x0a
const MSG_ANNOUNCE = 0x0b

// Offsets into the PTP packet
const CORRECTION_FIELD_OFFSET = 8 // signed nanoseconds, scaled by 2^16
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
// Pdelay_Resp and Pdelay_Resp_Follow_Up echo the requester's portIdentity in the same place
// a Delay_Resp does. A Pdelay_Req is padded to the same length with a reserved tail, so that
// a responder timestamping at a fixed offset sees a conformant message.
const PDELAY_RESP_LENGTH = REQUESTING_PORT_IDENTITY_OFFSET + PORT_IDENTITY_LENGTH
const PDELAY_REQ_LENGTH = PDELAY_RESP_LENGTH

// Announce body, after the 34-byte header and its 10-byte originTimestamp
const ANNOUNCE_UTC_OFFSET = 44
const ANNOUNCE_PRIORITY_1 = 47
const ANNOUNCE_CLOCK_CLASS = 48
const ANNOUNCE_CLOCK_ACCURACY = 49
const ANNOUNCE_LOG_VARIANCE = 50
const ANNOUNCE_PRIORITY_2 = 52
const ANNOUNCE_GM_IDENTITY = 53
const ANNOUNCE_STEPS_REMOVED = 61
const ANNOUNCE_TIME_SOURCE = 63
const ANNOUNCE_LENGTH = 64

// TLVs follow the Announce body. IEEE 1588-2019 §16.2: the PATH_TRACE TLV carries the
// sequence of clockIdentity values the Announce has passed through, beginning with the
// grandmaster and ending with the clock that transmitted it.
const MESSAGE_LENGTH_OFFSET = 2
const TLV_OFFSET = ANNOUNCE_LENGTH
const TLV_HEADER_LENGTH = 4
const TLV_PATH_TRACE = 0x0008
const CLOCK_IDENTITY_LENGTH = 8

const NS_PER_S = 1_000_000_000n

// How long auto-detection listens before concluding the domain is E2E. Peer delay defaults to
// one exchange per second, so this covers several opportunities to hear one while keeping the
// wait before the first measurement short.
const AUTO_DETECT_WINDOW_MS = 4000
// A single link cannot plausibly be this far away — 100ms is some 20,000km of fibre. A peer
// answering with anything larger is malfunctioning, and folding that into the offset would do
// far more damage than ignoring the link delay altogether.
const MAX_PEER_DELAY_NS = 100_000_000n

// IEEE 1588-2008 §7.7.3.1: a receipt timeout is a whole multiple of the interval the master
// advertises for that message, not a fixed wall-clock duration. announceReceiptTimeout
// defaults to 3 and shall be at least 2; SMPTE ST 2059-2 specifies 3 for sync as well.
const ANNOUNCE_RECEIPT_TIMEOUT = 3
const SYNC_RECEIPT_TIMEOUT = 3
// Defaults until a master tells us otherwise: logSyncInterval 0 (1s), logAnnounceInterval 1 (2s)
const DEFAULT_LOG_SYNC_INTERVAL = 0
const DEFAULT_LOG_ANNOUNCE_INTERVAL = 1
// logMessageInterval is a signed log2 of seconds. Clamp the result so a malformed or
// profile-specific value cannot produce a timer of milliseconds or of days.
const MIN_MESSAGE_INTERVAL_MS = 1000 / 128 // logInterval -7
const MAX_MESSAGE_INTERVAL_MS = 16_000 // logInterval 4

/** The interval a logMessageInterval denotes, in milliseconds, clamped to a sane range. */
const messageIntervalMs = (logMessageInterval: number): number =>
	Math.min(Math.max(Math.pow(2, logMessageInterval) * 1000, MIN_MESSAGE_INTERVAL_MS), MAX_MESSAGE_INTERVAL_MS)

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
 * Read the correctionField as nanoseconds. It is a signed 64-bit fixed-point value with 16
 * fractional bits, and carries the residence time accumulated by transparent clocks along
 * the path. Ignoring it leaves the offset wrong by the total switch delay, which in a plant
 * full of PTP-aware switches is microseconds.
 */
const readCorrectionField = (buffer: Buffer): bigint => buffer.readBigInt64BE(CORRECTION_FIELD_OFFSET) / 65536n

/**
 * Format a portIdentity as `clock-identity:portNumber`, the conventional PTP rendering.
 */
const formatPortIdentity = (buffer: Buffer, at: number = SOURCE_PORT_IDENTITY_OFFSET): string | undefined => {
	const identity = buffer.toString('hex', at, at + 8).match(/.{1,2}/g)
	if (identity == null) return undefined
	return `${identity.join('-')}:${buffer.readUInt16BE(at + 8)}`
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

/** Render an 8-byte clockIdentity as `aa-bb-cc-dd-ee-ff-00-11`. */
const formatClockIdentity = (buffer: Buffer, at: number): string | undefined => {
	const identity = buffer.toString('hex', at, at + CLOCK_IDENTITY_LENGTH).match(/.{1,2}/g)
	return identity == null ? undefined : identity.join('-')
}

/**
 * Walk the TLVs that follow a message body and return the value of the first one of the
 * requested type. Bounded by messageLength as well as the datagram length, since a UDP
 * payload may be padded beyond the end of the PTP message.
 */
const findTlv = (buffer: Buffer, tlvType: number): Buffer | undefined => {
	const declared = buffer.readUInt16BE(MESSAGE_LENGTH_OFFSET)
	const end = Math.min(declared > 0 ? declared : buffer.length, buffer.length)
	let offset = TLV_OFFSET

	while (offset + TLV_HEADER_LENGTH <= end) {
		const type = buffer.readUInt16BE(offset)
		const length = buffer.readUInt16BE(offset + 2)
		// A TLV length is always even, and must not run past the end of the message
		if (length % 2 !== 0) return undefined
		const valueStart = offset + TLV_HEADER_LENGTH
		if (valueStart + length > end) return undefined
		if (type === tlvType) return buffer.subarray(valueStart, valueStart + length)
		offset = valueStart + length
	}
	return undefined
}

/**
 * The clockIdentity chain from a PATH_TRACE TLV. Empty when the master does not emit one,
 * which is common — path trace is optional and off by default on many grandmasters.
 */
const readPathTrace = (buffer: Buffer): string[] => {
	const value = findTlv(buffer, TLV_PATH_TRACE)
	if (value === undefined || value.length === 0 || value.length % CLOCK_IDENTITY_LENGTH !== 0) return []

	const path: string[] = []
	for (let at = 0; at < value.length; at += CLOCK_IDENTITY_LENGTH) {
		const identity = formatClockIdentity(value, at)
		if (identity === undefined) return []
		path.push(identity)
	}
	return path
}

/**
 * Recover the MAC from a clockIdentity, where the identity was derived from one.
 * IEEE 1588 §7.5.2.2.2 builds an EUI-64 from an EUI-48 by inserting FF FE in the middle, and
 * that marker at bytes 3–4 is what makes it reversible. An identity that was configured or
 * randomly generated has no MAC to recover, and undefined is returned rather than a guess.
 */
const macFromClockIdentity = (identity: Buffer): string | undefined => {
	if (identity.length !== 8 || identity[3] !== 0xff || identity[4] !== 0xfe) return undefined
	return [identity[0], identity[1], identity[2], identity[5], identity[6], identity[7]]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join(':')
}

/**
 * The OUI of a clockIdentity — the manufacturer's IEEE-assigned block. Reported as hex
 * rather than a vendor name: resolving one needs the IEEE registry, and a wrong name in
 * front of an engineer is worse than no name.
 */
const ouiFromClockIdentity = (identity: Buffer): string =>
	[identity[0], identity[1], identity[2]].map((byte) => byte.toString(16).padStart(2, '0')).join(':')

/**
 * The manufacturer behind a clockIdentity.
 *
 * Prefers the recovered MAC over the bare OUI: many professional audio and broadcast makers
 * hold only a 28 or 36 bit assignment, which a 3 byte OUI is too short to match.
 */
const vendorFromClockIdentity = (identity: Buffer): string | undefined =>
	lookupOui(macFromClockIdentity(identity)?.replace(/:/g, '') ?? identity.toString('hex', 0, 3))

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

/** Decoded flagField. Byte 6 is the high half of the big-endian read, byte 7 the low half. */
export interface PtpFlags {
	alternateMaster: boolean
	twoStep: boolean
	unicast: boolean
	leap61: boolean
	leap59: boolean
	currentUtcOffsetValid: boolean
	ptpTimescale: boolean
	timeTraceable: boolean
	frequencyTraceable: boolean
	synchronizationUncertain: boolean
}

/** The grandmaster properties advertised in an Announce message. */
export interface PtpAnnounce {
	/** The actual source of time, which behind a boundary clock is not the sending port */
	grandmasterIdentity: string
	/** Recovered from the clockIdentity when it is EUI-64 derived, otherwise undefined */
	grandmasterMac: string | undefined
	/** Manufacturer's IEEE-assigned block, as hex */
	grandmasterOui: string
	/** Manufacturer name, where the block is one we carry */
	grandmasterVendor: string | undefined
	grandmasterPriority1: number
	grandmasterPriority2: number
	clockClass: number
	clockClassLabel: string
	clockAccuracy: number
	clockAccuracyLabel: string
	offsetScaledLogVariance: number
	/** Boundary clocks between us and the grandmaster; 0 means we are talking to it directly */
	stepsRemoved: number
	timeSource: number
	timeSourceLabel: string
	currentUtcOffset: number
	/** log2 of the announce interval in seconds */
	logMessageInterval: number
	/**
	 * clockIdentity of every clock the Announce passed through, grandmaster first and the
	 * transmitting clock last. Empty when the master does not emit a PATH_TRACE TLV.
	 */
	pathTrace: string[]
	/** An identity appearing twice in the path means the Announce went round a loop */
	pathTraceLoop: boolean
}

const clockAccuracyLabels: Record<number, string> = {
	0x17: '1ps',
	0x18: '2.5ps',
	0x19: '10ps',
	0x1a: '25ps',
	0x1b: '100ps',
	0x1c: '250ps',
	0x1d: '1ns',
	0x1e: '2.5ns',
	0x1f: '10ns',
	0x20: '25ns',
	0x21: '100ns',
	0x22: '250ns',
	0x23: '1us',
	0x24: '2.5us',
	0x25: '10us',
	0x26: '25us',
	0x27: '100us',
	0x28: '250us',
	0x29: '1ms',
	0x2a: '2.5ms',
	0x2b: '10ms',
	0x2c: '25ms',
	0x2d: '100ms',
	0x2e: '250ms',
	0x2f: '1s',
	0x30: '10s',
	0x31: '>10s',
	0xfe: 'Unknown',
}

const timeSourceLabels: Record<number, string> = {
	0x10: 'Atomic Clock',
	0x20: 'GNSS',
	0x30: 'Terrestrial Radio',
	0x39: 'Serial Time Code',
	0x40: 'PTP',
	0x50: 'NTP',
	0x60: 'Hand Set',
	0x90: 'Other',
	0xa0: 'Internal Oscillator',
}

/** The clockClass values worth naming; the rest are reported numerically. */
const clockClassLabels: Record<number, string> = {
	6: 'Locked to primary reference',
	7: 'Holdover (was primary reference)',
	13: 'Locked to application-specific reference',
	14: 'Holdover (was application-specific)',
	52: 'Degraded A (holdover out of spec)',
	58: 'Degraded B (holdover out of spec)',
	187: 'Degraded A (application-specific)',
	193: 'Degraded B (application-specific)',
	248: 'Default',
	255: 'Slave only',
}

const decodeFlags = (flags: number): PtpFlags => ({
	alternateMaster: (flags & 0x0100) !== 0,
	twoStep: (flags & 0x0200) !== 0,
	unicast: (flags & 0x0400) !== 0,
	leap61: (flags & 0x0001) !== 0,
	leap59: (flags & 0x0002) !== 0,
	currentUtcOffsetValid: (flags & 0x0004) !== 0,
	ptpTimescale: (flags & 0x0008) !== 0,
	timeTraceable: (flags & 0x0010) !== 0,
	frequencyTraceable: (flags & 0x0020) !== 0,
	synchronizationUncertain: (flags & 0x0040) !== 0,
})

const readAnnounce = (buffer: Buffer): PtpAnnounce | undefined => {
	const grandmasterIdentity = formatClockIdentity(buffer, ANNOUNCE_GM_IDENTITY)
	if (grandmasterIdentity === undefined) return undefined
	const pathTrace = readPathTrace(buffer)
	const clockClass = buffer.readUInt8(ANNOUNCE_CLOCK_CLASS)
	const clockAccuracy = buffer.readUInt8(ANNOUNCE_CLOCK_ACCURACY)
	const timeSource = buffer.readUInt8(ANNOUNCE_TIME_SOURCE)
	const identityBytes = buffer.subarray(ANNOUNCE_GM_IDENTITY, ANNOUNCE_GM_IDENTITY + 8)
	return {
		grandmasterIdentity,
		grandmasterMac: macFromClockIdentity(identityBytes),
		grandmasterOui: ouiFromClockIdentity(identityBytes),
		grandmasterVendor: vendorFromClockIdentity(identityBytes),
		grandmasterPriority1: buffer.readUInt8(ANNOUNCE_PRIORITY_1),
		grandmasterPriority2: buffer.readUInt8(ANNOUNCE_PRIORITY_2),
		clockClass,
		clockClassLabel: clockClassLabels[clockClass] ?? `Class ${clockClass}`,
		clockAccuracy,
		clockAccuracyLabel: clockAccuracyLabels[clockAccuracy] ?? `Unknown (0x${clockAccuracy.toString(16)})`,
		offsetScaledLogVariance: buffer.readUInt16BE(ANNOUNCE_LOG_VARIANCE),
		stepsRemoved: buffer.readUInt16BE(ANNOUNCE_STEPS_REMOVED),
		timeSource,
		timeSourceLabel: timeSourceLabels[timeSource] ?? `Unknown (0x${timeSource.toString(16)})`,
		// signed: a positive value means TAI is ahead of UTC
		currentUtcOffset: buffer.readInt16BE(ANNOUNCE_UTC_OFFSET),
		logMessageInterval: buffer.readInt8(LOG_MSG_INTERVAL_OFFSET),
		pathTrace,
		pathTraceLoop: new Set(pathTrace).size !== pathTrace.length,
	}
}

/**
 * How the client establishes the delay between itself and the source of time.
 *
 * - `e2e`     Delay_Req/Delay_Resp with the master. The IEEE 1588 default, and what SMPTE
 *             ST 2059-2 and AES67 mandate.
 * - `p2p`     Pdelay exchange with the immediately attached neighbour, with the rest of the
 *             path taken from the Sync correctionField. Mandated by IEEE 802.1AS (gPTP).
 * - `passive` Transmit nothing at all; take the path from the correctionField and treat the
 *             local link as free. Correct to within one link delay in a P2P domain, and the
 *             only mode that is guaranteed not to put a single packet on the network.
 * - `auto`    Listen for peer delay traffic, then settle on `p2p` or `e2e`.
 */
export type DelayMechanism = 'auto' | 'e2e' | 'p2p' | 'passive'

/** What `auto` is allowed to settle on — every mechanism that actually defines behaviour. */
export type ResolvedDelayMechanism = Exclude<DelayMechanism, 'auto'>

export interface PTPv2ClientEvents {
	close: [msg: string]
	error: [err: Error]
	listening: [msg: string]

	announce: [announce: PtpAnnounce]
	flags_changed: [flags: PtpFlags]
	domains: [domains: SetIterator<number>]
	ptp_master_changed: [ptp_master: string, address: string, sync: boolean]
	ptp_time_synced: [time: PtpTime, lastSync: number]
	sync_changed: [sync: boolean]
	master_lost: [reason: string]
	version_changed: [version: string]
	delay_mechanism_changed: [mechanism: ResolvedDelayMechanism, detected: boolean]
	peer_delay_changed: [peerMeanPathDelay: bigint]
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
	private announceTimeout: NodeJS.Timeout | undefined = undefined
	private logSyncInterval: number = DEFAULT_LOG_SYNC_INTERVAL
	private logAnnounceInterval: number = DEFAULT_LOG_ANNOUNCE_INTERVAL
	private minorVersion: number = 0
	private ptpMaster: string = ''
	private ptpMasterAddress: string = ''
	private minSyncInterval: number = 10000
	private domainsFound: Set<number> = new Set<number>()
	private destroyed: boolean = false

	//delay mechanism — what was configured, and what the client is actually doing
	private delayMechanism: DelayMechanism = 'auto'
	private resolvedMechanism: ResolvedDelayMechanism | undefined = undefined
	private detectTimeout: NodeJS.Timeout | undefined = undefined
	private pdelaySeen: boolean = false

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
	private syncCorrection: bigint = 0n // correctionField of the Sync awaiting its Follow_Up
	private meanPathDelay: bigint = 0n
	private announce: PtpAnnounce | undefined
	private announceAddress: string = ''
	private ptpMasterIdentity: Buffer | undefined
	private lastAnnounce: number = 0
	private flags: PtpFlags = decodeFlags(0)
	private lastCorrection: bigint = 0n
	private hasSynced: boolean = false
	private sync_seq: number = 0
	private req_seq: number = 0
	private lastSync: number = 0
	private lastRequest: number = 0

	//peer delay — pt1/pt4 are local, pt2/pt3 come from the neighbour. Every term of the
	//measurement is a difference within one clock, so the two timebases never have to agree.
	private pt1: bigint = 0n // Pdelay_Req transmit time here
	private pt2: bigint = 0n // Pdelay_Req receive time at the neighbour
	private pt3: bigint = 0n // Pdelay_Resp transmit time at the neighbour
	private pt4: bigint = 0n // Pdelay_Resp receive time here
	private pdelayCorrection: bigint = 0n // accumulated correctionField of the response pair
	private peerMeanPathDelay: bigint = 0n
	private pdelay_seq: number = 0
	private awaitingPdelayFollowUp: boolean = false
	private peerResponding: boolean = false

	/**
	 * Initialise the client
	 *
	 * @param iface IPv4 address of the interface to bind to (defaults to '0.0.0.0' for all interfaces)
	 * @param domain PTP domain to listen to (0–127; every domain shares the 224.0.1.129
	 *               multicast group and is distinguished by the header's domainNumber)
	 * @param interval Minimum PTP sync interval (125ms)
	 * @param delayMechanism How to establish path delay: 'e2e', 'p2p', 'passive', or 'auto'
	 *                       to detect between P2P and E2E by listening first (default)
	 */

	constructor(
		iface: string = '0.0.0.0',
		domain: number = 0,
		interval: number = 10000,
		delayMechanism: DelayMechanism = 'auto',
	) {
		super()
		if (!isIPv4(iface)) {
			throw new TypeError(
				`Invalid interface address "${iface}": must be a valid IPv4 address (e.g. '192.168.1.10') or '0.0.0.0' for all interfaces.`,
			)
		}
		this.addr = iface
		if (domain >= 0 && domain <= 127) this.ptp_domain = Math.round(domain)
		if (interval >= 125) this.minSyncInterval = Math.round(interval)
		this.delayMechanism = delayMechanism

		if (delayMechanism === 'auto') {
			// Observe before transmitting. Sending Delay_Req into a P2P domain is traffic the
			// standard forbids mixing onto one path, so auto mode stays silent until it has
			// either heard peer delay or waited long enough to conclude there is none.
			this.detectTimeout = setTimeout(() => {
				this.detectTimeout = undefined
				this.resolveMechanism('e2e', true)
			}, AUTO_DETECT_WINDOW_MS)
			// A detection timer must never be the reason a process stays alive
			this.detectTimeout.unref?.()
		} else {
			this.resolvedMechanism = delayMechanism
		}

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
			const versionByte = buffer.readUInt8(1)
			const version = versionByte & 0x0f
			//const length = buffer.readUInt16BE(2)
			const domain = buffer.readUInt8(4)
			const flags = buffer.readUInt16BE(6)
			const source = formatPortIdentity(buffer)
			if (source === undefined) return
			const sequence = buffer.readUInt16BE(SEQUENCE_OFFSET)

			// Only record domains from packets that are actually PTPv2, so unrelated traffic
			// on ports 319/320 can't pollute the discovered-domain list
			if (version != PTP_VERSION) return
			this.addDomain(domain)
			if (domain != this.ptp_domain) return
			this.updateMinorVersion(versionByte >> 4)

			// Peer delay traffic is the one positive indicator that this domain runs P2P:
			// Pdelay_Req is what a neighbour transmits unprompted, Pdelay_Resp is its answer
			// to us. Both are event messages and so arrive here rather than on port 320.
			if (type == MSG_PDELAY_REQ || type == MSG_PDELAY_RESP) {
				this.notePdelaySeen()
				if (type == MSG_PDELAY_RESP) this.handlePdelayResp(buffer, recv_ts, flags)
				return
			}

			if (type != MSG_SYNC)
				//only process sync messages
				return

			//do we have a new ptp master?
			if (source != this.ptpMaster) {
				this.ptpMaster = source
				this.ptpMasterAddress = rinfo.address
				// copied, not a subarray: the socket's buffer is not ours to hold on to
				this.ptpMasterIdentity = Buffer.from(
					buffer.subarray(SOURCE_PORT_IDENTITY_OFFSET, SOURCE_PORT_IDENTITY_OFFSET + 8),
				)
				// Route through sync_change so listeners see the transition
				this.sync_change(false)
				this.emit('ptp_master_changed', this.ptpMaster, rinfo.address, this.sync)
			}

			this.updateFlags(flags, false)

			// The master advertises its own Sync rate; the receipt timeout follows it
			this.logSyncInterval = buffer.readInt8(LOG_MSG_INTERVAL_OFFSET)
			this.startSyncTimeout()

			//save sequence number
			this.sync_seq = sequence

			//check if master is two step or not
			if ((flags & 0x0200) == 0x0200) {
				//two step, wait for follow_up msg for accurate t1
				this.ts1 = recv_ts
				// The Sync's own correction still counts; the Follow_Up adds its own on top
				this.syncCorrection = readCorrectionField(buffer)
			} else if (this.dueForExchange()) {
				if (buffer.length < TIMESTAMP_OFFSET + TIMESTAMP_LENGTH) return
				//got accurate t1 (no follow_up msg)
				this.ts1 = recv_ts
				this.syncCorrection = 0n
				this.t1 = readPtpTimestamp(buffer) + readCorrectionField(buffer)

				this.completeSyncMeasurement()
			}
		})

		this.ptpClientGeneral.on('message', (buffer, rinfo): void => {
			//check buffer length
			if (buffer.length < SEQUENCE_OFFSET + 2) return

			//read values from buffer
			const type = buffer.readUInt8(0) & 0x0f
			const versionByte = buffer.readUInt8(1)
			const version = versionByte & 0x0f
			//const length = buffer.readUInt16BE(2)
			const domain = buffer.readUInt8(4)
			const sequence = buffer.readUInt16BE(SEQUENCE_OFFSET)

			if (version != PTP_VERSION) return
			this.addDomain(domain)
			if (domain != this.ptp_domain) return
			this.updateMinorVersion(versionByte >> 4)

			// The only general-message half of the peer delay exchange
			if (type == MSG_PDELAY_RESP_FOLLOW_UP) {
				this.notePdelaySeen()
				this.handlePdelayRespFollowUp(buffer, sequence)
				return
			}

			if (type == MSG_ANNOUNCE) {
				if (buffer.length < ANNOUNCE_LENGTH) return
				this.updateFlags(buffer.readUInt16BE(6), true)
				this.updateAnnounce(readAnnounce(buffer), rinfo.address)
				return
			}

			if (buffer.length < TIMESTAMP_OFFSET + TIMESTAMP_LENGTH) return

			if (type == MSG_FOLLOW_UP && this.sync_seq == sequence && this.dueForExchange()) {
				//follow up msg with current seq
				this.t1 = readPtpTimestamp(buffer) + this.syncCorrection + readCorrectionField(buffer)

				this.completeSyncMeasurement()
			} else if (type == MSG_DELAY_RESP && this.req_seq == sequence && this.isOurResponse(buffer)) {
				//delay_rsp msg
				this.ts2 = readPtpTimestamp(buffer) - readCorrectionField(buffer)

				// offset = ((t2 − t1) − (t4 − t3)) / 2, in this class's naming
				// ((ts1 − t1) − (ts2 − t2)) / 2. ts1 and t2 are already offset-corrected, so
				// this is the residual error and accumulates onto the running offset.
				const correction = (this.ts1 - this.t1 - (this.ts2 - this.t2)) / 2n
				// The first exchange carries the entire difference between the local timebase
				// and the PTP epoch (~1.7e18ns). That is the initial acquisition, not clock
				// drift, so it is not reported as a correction.
				this.lastCorrection = this.hasSynced ? correction : 0n
				this.hasSynced = true
				this.offset += correction

				// The other half of the same measurement: ((t2 − t1) + (t4 − t3)) / 2.
				// Rising path delay is how a congested or asymmetric link shows up.
				this.meanPathDelay = (this.ts1 - this.t1 + (this.ts2 - this.t2)) / 2n

				this.lastSync = Date.now()
				this.emit('ptp_time_synced', this.ptp_time, this.lastSync)
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
			socket.addMembership(PTP_PRIMARY_MULTICAST, this.addr)
			// Joined for every mechanism that could care about peer delay: p2p needs it to hear
			// its own responses, auto needs it to detect at all, and passive uses it to report
			// what the domain is really running. Only an explicit e2e has no use for it.
			if (this.delayMechanism !== 'e2e') socket.addMembership(PTP_PDELAY_MULTICAST, this.addr)
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

	/**
	 * Is this response answering our request, rather than another slave's? Delay_Resp,
	 * Pdelay_Resp and Pdelay_Resp_Follow_Up all echo the requester's portIdentity in the
	 * same place, so one check serves all three.
	 */
	private isOurResponse(buffer: Buffer): boolean {
		if (buffer.length < DELAY_RESP_LENGTH) return false
		return (
			buffer.compare(this.portIdentity, 0, PORT_IDENTITY_LENGTH, REQUESTING_PORT_IDENTITY_OFFSET, DELAY_RESP_LENGTH) ===
			0
		)
	}

	/**
	 * A Sync — and its Follow_Up, if the master is two-step — has yielded t1. What happens
	 * next is the whole of the difference between the mechanisms: E2E asks the master to
	 * measure the path, P2P applies the correction it already holds and refreshes its link
	 * measurement, passive applies the correction and transmits nothing at all.
	 *
	 * While auto-detection is still undecided nothing is sent. Probing with the wrong
	 * mechanism is precisely what auto mode exists to avoid.
	 */
	private completeSyncMeasurement(): void {
		switch (this.resolvedMechanism) {
			case 'e2e':
				this.sendDelayReq()
				break
			case 'p2p':
				this.applySyncOffset()
				this.sendPdelayReq()
				break
			case 'passive':
				this.applySyncOffset()
				break
			default:
				break //still detecting — observe only
		}
	}

	/**
	 * Offset from the Sync alone, for the mechanisms that do not ask the master to measure
	 * the path.
	 *
	 * t1 already carries the correctionField, which in a P2P domain is where the transparent
	 * clocks along the way have accumulated their residence and link times. What that leaves
	 * unaccounted for is the delay of our own cable to the neighbour, which is exactly what
	 * peerMeanPathDelay holds — zero in passive mode, and zero in P2P until the first Pdelay
	 * exchange completes. A Sync that spent time on the wire left the master when its clock
	 * read t1 but arrived when it read t1 plus that delay, so treating the link as free
	 * leaves the reported time behind by exactly one link delay.
	 */
	private applySyncOffset(): void {
		this.lastRequest = Date.now()
		const correction = this.ts1 - this.t1 - this.peerMeanPathDelay
		// As in the E2E path: the first measurement carries the whole gap between the local
		// timebase and the PTP epoch, which is acquisition rather than drift
		this.lastCorrection = this.hasSynced ? correction : 0n
		this.hasSynced = true
		this.offset += correction

		this.lastSync = Date.now()
		this.emit('ptp_time_synced', this.ptp_time, this.lastSync)
		this.sync_change(true)
	}

	/**
	 * Peer delay traffic seen. Positive detection is conclusive and immediate — nothing but
	 * a P2P domain puts these messages on the wire — so auto mode settles here rather than
	 * waiting out the rest of its window.
	 */
	private notePdelaySeen(): void {
		this.pdelaySeen = true
		if (this.delayMechanism === 'auto' && this.resolvedMechanism === undefined) {
			this.resolveMechanism('p2p', true)
		}
	}

	/** Settle on a mechanism and stop detecting. */
	private resolveMechanism(mechanism: ResolvedDelayMechanism, detected: boolean): void {
		if (this.detectTimeout) clearTimeout(this.detectTimeout)
		this.detectTimeout = undefined
		if (this.resolvedMechanism === mechanism) return
		this.resolvedMechanism = mechanism
		this.emit('delay_mechanism_changed', mechanism, detected)
	}

	/**
	 * Pdelay_Resp: the neighbour's answer, carrying t2 and — when it is a two-step responder
	 * — a promise of t3 in the Follow_Up to come.
	 */
	private handlePdelayResp(buffer: Buffer, recv_ts: bigint, flags: number): void {
		if (buffer.length < PDELAY_RESP_LENGTH) return
		if (this.pdelay_seq != buffer.readUInt16BE(SEQUENCE_OFFSET)) return
		if (!this.isOurResponse(buffer)) return

		this.pt4 = recv_ts
		this.pdelayCorrection = readCorrectionField(buffer)

		if ((flags & 0x0200) == 0x0200) {
			//two step: t2 is here, t3 follows in the Pdelay_Resp_Follow_Up
			this.pt2 = readPtpTimestamp(buffer)
			this.awaitingPdelayFollowUp = true
			return
		}
		// One step: the responder folded its own turnaround into the correctionField and sent
		// zeroed timestamps, so there is no t3 − t2 left to subtract separately.
		this.awaitingPdelayFollowUp = false
		this.completePdelay(0n)
	}

	/** Pdelay_Resp_Follow_Up: t3, completing a two-step exchange. */
	private handlePdelayRespFollowUp(buffer: Buffer, sequence: number): void {
		if (!this.awaitingPdelayFollowUp) return
		if (buffer.length < PDELAY_RESP_LENGTH) return
		if (this.pdelay_seq != sequence) return
		if (!this.isOurResponse(buffer)) return

		this.awaitingPdelayFollowUp = false
		this.pt3 = readPtpTimestamp(buffer)
		this.pdelayCorrection += readCorrectionField(buffer)
		this.completePdelay(this.pt3 - this.pt2)
	}

	/**
	 * meanLinkDelay = [(t4 − t1) − (t3 − t2) − corrections] / 2, per IEEE 1588-2008 §11.4.2.
	 *
	 * Note what this is and is not: it is the delay of the single link to the neighbour, not
	 * the delay to the grandmaster. In a P2P domain the rest of the path arrives already
	 * summed in the Sync correctionField.
	 */
	private completePdelay(turnaround: bigint): void {
		const delay = (this.pt4 - this.pt1 - turnaround - this.pdelayCorrection) / 2n
		// A neighbour answering with nonsense would otherwise poison every subsequent offset
		if (delay < 0n || delay > MAX_PEER_DELAY_NS) return

		this.peerResponding = true
		if (delay === this.peerMeanPathDelay) return
		this.peerMeanPathDelay = delay
		this.emit('peer_delay_changed', delay)
	}

	/**
	 * Send a Pdelay_Req to the link-local peer delay group. Unanswered requests are not an
	 * error: a neighbour that is not a P2P transparent clock simply never replies, and P2P
	 * then degrades to the passive calculation rather than failing outright.
	 */
	private sendPdelayReq(): void {
		setImmediate(() => {
			if (this.destroyed) return
			this.ptpClientEvent.send(this.ptp_pdelay_req(), PTP_EVENT_PORT, PTP_PDELAY_MULTICAST, (err, _bytes) => {
				if (err) {
					this.emit('error', err)
				} else {
					// only capture t1 after the packet has actually been sent
					this.pt1 = this.correctedTime()
				}
			})
		})
	}

	private sendDelayReq(): void {
		this.lastRequest = Date.now()
		setImmediate(() => {
			if (this.destroyed) return
			this.ptpClientEvent.send(this.ptp_delay_req(), PTP_EVENT_PORT, PTP_PRIMARY_MULTICAST, (err, _bytes) => {
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
	 * Close the sockets
	 *
	 */

	public destroy(): void {
		if (this.destroyed) return
		this.destroyed = true
		if (this.syncTimeout) clearTimeout(this.syncTimeout)
		this.syncTimeout = undefined
		if (this.announceTimeout) clearTimeout(this.announceTimeout)
		this.announceTimeout = undefined
		if (this.detectTimeout) clearTimeout(this.detectTimeout)
		this.detectTimeout = undefined
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

	/**
	 * Create ptp pdelay_req buffer
	 *
	 */

	private ptp_pdelay_req(): Buffer<ArrayBuffer> {
		const buffer = Buffer.alloc(PDELAY_REQ_LENGTH)
		this.pdelay_seq = (this.pdelay_seq + 1) % 0x10000
		this.awaitingPdelayFollowUp = false

		buffer.writeUInt8(MSG_PDELAY_REQ, 0)
		buffer.writeUInt8(2, 1)
		buffer.writeUInt16BE(PDELAY_REQ_LENGTH, 2)
		buffer.writeUInt8(this.ptp_domain, 4)
		// The neighbour echoes this back in its response; without it we could not tell our own
		// exchange apart from that of every other client on the link
		this.portIdentity.copy(buffer, SOURCE_PORT_IDENTITY_OFFSET)
		buffer.writeUInt16BE(this.pdelay_seq, SEQUENCE_OFFSET)
		buffer.writeUInt8(0x05, CONTROL_FIELD_OFFSET) // controlField: all others
		buffer.writeUInt8(0x7f, LOG_MSG_INTERVAL_OFFSET) // logMessageInterval: not periodic
		// bytes 44-53 are a reserved tail, transmitted as zero

		return buffer
	}

	/**
	 * Sync receipt timeout: syncReceiptTimeout × the master's advertised sync interval.
	 * Armed on every Sync, so it measures the master's message flow rather than the
	 * success of our own delay request exchange.
	 */
	private startSyncTimeout(): void {
		if (this.syncTimeout) clearTimeout(this.syncTimeout)
		this.syncTimeout = setTimeout(() => {
			this.syncTimeout = undefined
			if (this.sync) this.emit('master_lost', `No Sync for ${this.sync_receipt_timeout}ms`)
			this.sync_change(false)
		}, this.sync_receipt_timeout)
	}

	/**
	 * Announce receipt timeout: announceReceiptTimeout × the master's advertised announce
	 * interval. Expiry means the master is gone, so the grandmaster data is dropped rather
	 * than left on display as though it were current.
	 */
	private startAnnounceTimeout(): void {
		if (this.announceTimeout) clearTimeout(this.announceTimeout)
		this.announceTimeout = setTimeout(() => {
			this.announceTimeout = undefined
			this.announce = undefined
			// defensive: grandmaster_address already returns '' once announce is undefined,
			// so this only matters if the raw address is ever exposed directly
			this.announceAddress = ''
			this.emit('master_lost', `No Announce for ${this.announce_receipt_timeout}ms`)
			this.sync_change(false)
		}, this.announce_receipt_timeout)
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
	 * Publish the decoded flagField, emitting only when something actually changed.
	 * leap61/leap59 and the traceability bits are the ones worth alerting on.
	 *
	 */

	private updateFlags(flags: number, fromAnnounce: boolean): void {
		const decoded = decodeFlags(flags)
		// IEEE 1588-2008 Table 20: the leap, UTC and traceability bits are defined for
		// Announce only, and are transmitted as false in every other message type. Taking
		// them from a Sync would clear whatever the last Announce reported.
		const next: PtpFlags = fromAnnounce
			? { ...decoded, twoStep: this.flags.twoStep }
			: {
					...this.flags,
					alternateMaster: decoded.alternateMaster,
					twoStep: decoded.twoStep,
					unicast: decoded.unicast,
				}
		const changed = (Object.keys(next) as (keyof PtpFlags)[]).some((key) => next[key] !== this.flags[key])
		this.flags = next
		if (changed) this.emit('flags_changed', next)
	}

	/**
	 * Publish the grandmaster properties from an Announce, emitting only on change.
	 *
	 */

	private updateAnnounce(announce: PtpAnnounce | undefined, sourceAddress: string): void {
		if (announce === undefined) return
		this.lastAnnounce = Date.now()
		this.announceAddress = sourceAddress
		this.logAnnounceInterval = announce.logMessageInterval
		this.startAnnounceTimeout()
		const previous = this.announce
		// pathTrace is an array, so a reference comparison would report a change on every
		// single Announce; compare its contents instead
		const changed =
			previous === undefined ||
			(Object.keys(announce) as (keyof PtpAnnounce)[]).some((key) =>
				key === 'pathTrace'
					? announce.pathTrace.length !== previous.pathTrace.length ||
						announce.pathTrace.some((identity, i) => identity !== previous.pathTrace[i])
					: announce[key] !== previous[key],
			)
		this.announce = announce
		if (changed) this.emit('announce', announce)
	}

	/**
	 * Track the minorVersionPTP the master is using. 0 is IEEE 1588-2008, 1 is IEEE 1588-2019.
	 * Both are accepted; this is reported for monitoring rather than used to gate anything.
	 *
	 */

	private updateMinorVersion(minorVersion: number): void {
		if (minorVersion === this.minorVersion) return
		this.minorVersion = minorVersion
		this.emit('version_changed', this.ptp_version)
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
	 * Mean path delay to the master, in nanoseconds, from the last completed exchange
	 *
	 */

	public get mean_path_delay(): bigint {
		return this.meanPathDelay
	}

	/**
	 * How far the clock had drifted when the last exchange completed, in nanoseconds.
	 * This is the correction that was applied, so a consistently large value means the
	 * measurement is unstable rather than that the clock is wrong.
	 *
	 */

	public get last_correction(): bigint {
		return this.lastCorrection
	}

	/**
	 * Grandmaster properties from the most recent Announce, or undefined if none seen.
	 * This names the real source of time; `ptp_master` only names the port that sent Sync,
	 * which behind a boundary clock is a different clock entirely.
	 *
	 */

	public get grandmaster(): PtpAnnounce | undefined {
		return this.announce
	}

	/**
	 * The grandmaster's IP address, or '' when it cannot be known.
	 *
	 * PTP carries no field for the grandmaster's address; all that is ever available is the
	 * source address of the packet that arrived. That is the grandmaster only when it sent
	 * the Announce itself, so this is populated only when stepsRemoved is 0. Behind a
	 * boundary clock the address belongs to that boundary clock — see `ptp_master_address`.
	 *
	 */

	public get grandmaster_address(): string {
		if (this.announce === undefined || this.announce.stepsRemoved !== 0) return ''
		return this.announceAddress
	}

	/**
	 * The clockIdentity chain the Announce travelled, grandmaster first and the transmitting
	 * clock last. Empty unless the grandmaster emits a PATH_TRACE TLV, which is optional and
	 * off by default on many devices.
	 *
	 */

	public get path_trace(): string[] {
		return this.announce?.pathTrace ?? []
	}

	/**
	 * MAC of the port sending Sync, recovered from its clockIdentity where possible
	 *
	 */

	public get ptp_master_mac(): string | undefined {
		return this.ptpMasterIdentity ? macFromClockIdentity(this.ptpMasterIdentity) : undefined
	}

	/**
	 * Manufacturer of the port sending Sync, where its block is one we carry
	 *
	 */

	public get ptp_master_vendor(): string | undefined {
		return this.ptpMasterIdentity ? vendorFromClockIdentity(this.ptpMasterIdentity) : undefined
	}

	/**
	 * OUI of the port sending Sync
	 *
	 */

	public get ptp_master_oui(): string {
		return this.ptpMasterIdentity ? ouiFromClockIdentity(this.ptpMasterIdentity) : ''
	}

	/**
	 * @returns timestamp of the last Announce received
	 *
	 */

	public get last_announce(): number {
		return this.lastAnnounce
	}

	/**
	 * Decoded flagField from the most recent Sync or Announce
	 *
	 */

	public get ptp_flags(): PtpFlags {
		return this.flags
	}

	/**
	 * Sync receipt timeout in ms — syncReceiptTimeout × the advertised sync interval
	 *
	 */

	public get sync_receipt_timeout(): number {
		return Math.round(messageIntervalMs(this.logSyncInterval) * SYNC_RECEIPT_TIMEOUT)
	}

	/**
	 * Announce receipt timeout in ms — announceReceiptTimeout × the advertised announce interval
	 *
	 */

	public get announce_receipt_timeout(): number {
		return Math.round(messageIntervalMs(this.logAnnounceInterval) * ANNOUNCE_RECEIPT_TIMEOUT)
	}

	/**
	 * The master's advertised Sync interval in seconds
	 *
	 */

	public get sync_interval(): number {
		return messageIntervalMs(this.logSyncInterval) / 1000
	}

	/**
	 * The PTP version the master is using, as `major.minor` — `2.0` for IEEE 1588-2008 and
	 * `2.1` for IEEE 1588-2019
	 *
	 */

	public get ptp_version(): string {
		return `${PTP_VERSION}.${this.minorVersion}`
	}

	/**
	 * The delay mechanism actually in use — 'detecting' while auto mode is still listening
	 *
	 */

	public get delay_mechanism(): ResolvedDelayMechanism | 'detecting' {
		return this.resolvedMechanism ?? 'detecting'
	}

	/** The delay mechanism in use, for display */
	public get delay_mechanism_label(): string {
		switch (this.delay_mechanism) {
			case 'e2e':
				return 'End to End'
			case 'p2p':
				return 'Peer to Peer'
			case 'passive':
				return 'Passive'
			default:
				return 'Detecting'
		}
	}

	/**
	 * Measured delay of the link to the directly attached neighbour, in nanoseconds. This is
	 * not the path delay to the grandmaster — in a P2P domain that arrives in the Sync
	 * correctionField. Zero until a peer delay exchange completes.
	 *
	 */

	public get peer_mean_path_delay(): bigint {
		return this.peerMeanPathDelay
	}

	/**
	 * Whether the neighbour has answered a Pdelay_Req. False in a P2P domain means the
	 * attached port is not acting as a peer delay responder, and the reported time is short
	 * by one link delay.
	 *
	 */

	public get peer_responding(): boolean {
		return this.peerResponding
	}

	/**
	 * Whether any peer delay traffic has been seen on this domain. Meaningful in both
	 * directions only as evidence of P2P — absence is not evidence of E2E, since Pdelay is
	 * link-local and a neighbour that is not a P2P clock hides a P2P domain entirely.
	 *
	 */

	public get pdelay_seen(): boolean {
		return this.pdelaySeen
	}

	/**
	 * Get iterator of domains found
	 *
	 */

	public get domains(): SetIterator<number> {
		return this.domainsFound.values()
	}
}
