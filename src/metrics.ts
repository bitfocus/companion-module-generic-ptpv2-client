/**
 * Observed message rates and loss, shared by both protocol clients.
 *
 * These measure what actually arrives rather than what a master advertises. The difference
 * is the whole point: a grandmaster claiming 8 Sync per second while 6 arrive is the
 * signature of multicast being dropped somewhere in between, and nothing else the module
 * reports would show it.
 */

/** PTP sequence numbers are 16-bit and wrap */
const SEQUENCE_MODULUS = 0x10000

/**
 * A forward gap larger than this is read as a master restart or a renumbering rather than as
 * loss. Real loss large enough to reach this would already have tripped the sync receipt
 * timeout several times over, so counting it as missed messages would only inflate the
 * figure after every restart.
 */
const SEQUENCE_DISCONTINUITY = 1000

/** How much history the rate and loss figures are averaged over */
export const METRICS_WINDOW_MS = 10_000

/**
 * How many messages went missing between two sequence numbers.
 *
 * @returns the number of messages missed, or `undefined` when the two numbers cannot be
 *          compared — a repeat, a reordering, or a jump large enough to be a restart. The
 *          caller re-bases on the new value in that case rather than counting anything.
 */
export function missedBetween(previous: number, current: number): number | undefined {
	const delta = (current - previous + SEQUENCE_MODULUS) % SEQUENCE_MODULUS
	if (delta === 0) return undefined // the same message twice
	if (delta > SEQUENCE_DISCONTINUITY) return undefined // restart, renumber, or arrived late
	return delta - 1
}

/**
 * A count of events over a sliding time window.
 *
 * Rates are taken from the span the events themselves cover, not from the nominal window
 * length. A window that has only started filling would otherwise report a rate diluted by
 * the silence before the first event, which reads as loss that is not there.
 */
export class SlidingWindow {
	private events: number[] = []

	constructor(private readonly windowMs: number = METRICS_WINDOW_MS) {}

	/** Record `count` events as having happened at `now` */
	add(count: number = 1, now: number = Date.now()): void {
		for (let i = 0; i < count; i++) this.events.push(now)
		this.prune(now)
	}

	/** Events still inside the window */
	count(now: number = Date.now()): number {
		this.prune(now)
		return this.events.length
	}

	/** Events per second across the span they cover, or 0 until there are two to measure between */
	perSecond(now: number = Date.now()): number {
		this.prune(now)
		if (this.events.length < 2) return 0
		const span = this.events[this.events.length - 1] - this.events[0]
		if (span <= 0) return 0
		return ((this.events.length - 1) * 1000) / span
	}

	reset(): void {
		this.events = []
	}

	private prune(now: number): void {
		const cutoff = now - this.windowMs
		let stale = 0
		while (stale < this.events.length && this.events[stale] <= cutoff) stale++
		if (stale > 0) this.events.splice(0, stale)
	}
}

/** Round to `places` decimals, so a rate does not reach a button as 7.999999999 */
export const round = (value: number, places: number = 2): number => {
	const scale = 10 ** places
	return Math.round(value * scale) / scale
}

// ---------------------------------------------------------------------------
// Path delay step detection
// ---------------------------------------------------------------------------

/** How many measurements the median is taken over */
export const STEP_SAMPLES = 8

/**
 * The smallest move worth reporting, in nanoseconds.
 *
 * This module timestamps in userspace, so two of the four terms behind a path delay carry
 * whatever scheduling delay the host happened to add. Measured over 200 runs on an idle
 * machine that noise ran to a median of 35us and a maximum of 545us, and a loaded host is
 * worse. A one millisecond floor sits comfortably clear of it.
 *
 * The consequence is worth stating plainly: a path delay step smaller than this is not
 * detectable here. Seeing one needs hardware timestamping, which this module does not have
 * and is not trying to be.
 */
export const STEP_FLOOR_NS = 1_000_000n

/** A step must also be this fraction of the value it moved from — expressed as a divisor, so 2 is a half */
export const STEP_FRACTION = 2n

/** Middle value of a set, averaging the two middle ones when the count is even */
export function median(values: readonly bigint[]): bigint {
	if (values.length === 0) return 0n
	const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
	const middle = sorted.length >> 1
	if (sorted.length % 2 === 1) return sorted[middle]
	return (sorted[middle - 1] + sorted[middle]) / 2n
}

const magnitude = (value: bigint): bigint => (value < 0n ? -value : value)

/**
 * Reports a sustained change in a measurement, ignoring the noise around it.
 *
 * A route change or a newly asymmetric path moves the delay to a different plateau, which is
 * an event rather than a state — there is no threshold it is above or below afterwards, so
 * this is deliberately not a feedback. The median is what makes it a step rather than an
 * outlier: a single wild sample cannot move it, but eight consistent ones will.
 *
 * A move must clear both tests to count. The proportional one is what makes it meaningful on
 * a network of any size, and the absolute floor is what keeps this host's own scheduling
 * noise from raising it.
 */
export class StepDetector {
	private samples: bigint[] = []
	private baseline: bigint | undefined = undefined

	constructor(
		private readonly floor: bigint = STEP_FLOOR_NS,
		private readonly fraction: bigint = STEP_FRACTION,
		private readonly window: number = STEP_SAMPLES,
	) {}

	/**
	 * @returns `[from, to]` when the median has stepped, otherwise undefined. The baseline
	 *          moves to the new plateau on a step, so a drift back reports separately.
	 */
	push(value: bigint): [bigint, bigint] | undefined {
		this.samples.push(value)
		if (this.samples.length > this.window) this.samples.shift()
		if (this.samples.length < this.window) return undefined

		const sorted = [...this.samples].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
		// While the window straddles two plateaus its median sits between them, and reporting
		// then would both fire twice and name a value the delay never actually had. The
		// interquartile range is what says the window has settled on one value again — the
		// full spread would be held open by a single outlier, which is the thing the median
		// exists to ignore.
		const quarter = this.window >> 2
		const spread = sorted[this.window - 1 - quarter] - sorted[quarter]
		if (spread >= this.floor) return undefined

		const current = median(sorted)
		if (this.baseline === undefined) {
			this.baseline = current
			return undefined
		}

		const delta = magnitude(current - this.baseline)
		if (delta < this.floor) return undefined
		if (delta * this.fraction < magnitude(this.baseline)) return undefined

		const from = this.baseline
		this.baseline = current
		return [from, current]
	}

	reset(): void {
		this.samples = []
		this.baseline = undefined
	}
}
