import { describe, it, expect } from 'vitest'
import {
	SlidingWindow,
	StepDetector,
	median,
	missedBetween,
	round,
	METRICS_WINDOW_MS,
	STEP_SAMPLES,
} from '../metrics.js'

// ===========================================================================
// Sequence gap accounting
// ===========================================================================
/**
 * A passive observer cannot see a message that never arrived. The only evidence it was sent
 * is the hole it leaves in the sender's sequence numbering, which is what this counts.
 */
describe('missedBetween', () => {
	it('reports nothing missed for consecutive messages', () => {
		expect(missedBetween(10, 11)).toBe(0)
	})

	it('counts the messages a gap implies', () => {
		expect(missedBetween(10, 11)).toBe(0)
		expect(missedBetween(10, 12)).toBe(1)
		expect(missedBetween(10, 15)).toBe(4)
	})

	it('counts across the 16 bit wrap, which every PTP sequence does', () => {
		expect(missedBetween(65535, 0)).toBe(0)
		// 65534 -> 1 skips both 65535 and 0
		expect(missedBetween(65534, 1)).toBe(2)
	})

	it('refuses to guess at a repeat', () => {
		// The same message twice is not loss, and must not re-base the count either
		expect(missedBetween(10, 10)).toBeUndefined()
	})

	it('refuses to guess at a message that arrived out of order', () => {
		expect(missedBetween(10, 9)).toBeUndefined()
		expect(missedBetween(10, 5)).toBeUndefined()
	})

	it('treats a jump too large to be loss as a restart', () => {
		// Loss on that scale would have tripped the receipt timeout many times over, so
		// counting it would only inflate the figure every time a master reboots
		expect(missedBetween(10, 5000)).toBeUndefined()
		expect(missedBetween(60000, 1000)).toBeUndefined()
	})

	it('still counts a gap just under the discontinuity threshold', () => {
		expect(missedBetween(0, 999)).toBe(998)
	})
})

// ===========================================================================
// Sliding window
// ===========================================================================
describe('SlidingWindow', () => {
	it('counts only what is still inside the window', () => {
		const w = new SlidingWindow(1000)
		w.add(1, 0)
		w.add(1, 500)
		expect(w.count(900)).toBe(2)
		// 0 has aged out by 1001
		expect(w.count(1001)).toBe(1)
		expect(w.count(2000)).toBe(0)
	})

	it('measures the rate across the span the events cover, not the window length', () => {
		// A window that has only just started filling would otherwise report a rate diluted
		// by the silence before the first event, which reads as loss that is not there
		const w = new SlidingWindow(10_000)
		for (let i = 0; i < 9; i++) w.add(1, i * 125) // 8/s, but only 1s of a 10s window
		expect(round(w.perSecond(1000))).toBe(8)
	})

	it('reports no rate until there are two events to measure between', () => {
		const w = new SlidingWindow(1000)
		expect(w.perSecond(0)).toBe(0)
		w.add(1, 0)
		expect(w.perSecond(0)).toBe(0)
	})

	it('adds several events at one instant, as a detected gap does', () => {
		const w = new SlidingWindow(1000)
		w.add(4, 0)
		expect(w.count(0)).toBe(4)
	})

	it('drops everything on reset, as a master change requires', () => {
		const w = new SlidingWindow(1000)
		w.add(3, 0)
		w.reset()
		expect(w.count(0)).toBe(0)
	})

	it('defaults to the documented averaging window', () => {
		const w = new SlidingWindow()
		w.add(1, 0)
		expect(w.count(METRICS_WINDOW_MS - 1)).toBe(1)
		expect(w.count(METRICS_WINDOW_MS + 1)).toBe(0)
	})
})

describe('round', () => {
	it('keeps a rate readable rather than exact', () => {
		expect(round(7.999999999)).toBe(8)
		expect(round(0.123456)).toBe(0.12)
		expect(round(1 / 3, 3)).toBe(0.333)
	})
})

// ===========================================================================
// Path delay step detection
// ===========================================================================
describe('median', () => {
	it('averages the two middle values of an even set', () => {
		expect(median([1n, 2n, 3n, 4n])).toBe(2n)
		expect(median([10n, 20n, 30n, 40n])).toBe(25n)
	})

	it('takes the middle of an odd set', () => {
		expect(median([3n, 1n, 2n])).toBe(2n)
	})

	it('is unmoved by an outlier, which is the whole point', () => {
		const steady = [10n, 10n, 10n, 10n, 10n, 10n, 10n]
		expect(median(steady)).toBe(10n)
		expect(median([...steady, 9_000_000n])).toBe(10n)
	})

	it('handles an empty set rather than throwing', () => {
		expect(median([])).toBe(0n)
	})
})

describe('StepDetector', () => {
	/**
	 * Push a value until the window holds nothing else, returning the step if one was
	 * reported along the way. The median flips partway through — once five of the eight
	 * samples are the new value — so the step does not arrive on the final push.
	 */
	const fill = (d: StepDetector, value: bigint, times = STEP_SAMPLES) => {
		let step: [bigint, bigint] | undefined
		for (let i = 0; i < times; i++) step = d.push(value) ?? step
		return step
	}

	it('says nothing until it has a full window to take a median over', () => {
		const d = new StepDetector()
		for (let i = 0; i < STEP_SAMPLES - 1; i++) expect(d.push(5_000_000n)).toBeUndefined()
	})

	it('reports a sustained move that clears both tests', () => {
		const d = new StepDetector()
		fill(d, 2_000_000n) // 2ms baseline
		const step = fill(d, 8_000_000n) // 8ms: +6ms, and far more than half
		expect(step).toEqual([2_000_000n, 8_000_000n])
	})

	it('reports a move once, naming the two plateaus and not a value in between', () => {
		// Mid-transition the window holds both, and its median sits between them — a value
		// the path delay never actually had
		const d = new StepDetector()
		fill(d, 2_000_000n)
		const steps: [bigint, bigint][] = []
		for (let i = 0; i < STEP_SAMPLES * 2; i++) {
			const step = d.push(8_000_000n)
			if (step) steps.push(step)
		}
		expect(steps).toEqual([[2_000_000n, 8_000_000n]])
	})

	it('ignores a single outlier, however wild', () => {
		const d = new StepDetector()
		fill(d, 2_000_000n)
		expect(d.push(900_000_000n)).toBeUndefined()
		expect(d.push(2_000_000n)).toBeUndefined()
	})

	it('ignores a move below the absolute floor, however large in proportion', () => {
		// 20us to 60us trebles, but this module cannot tell that from its own scheduling noise
		const d = new StepDetector()
		fill(d, 20_000n)
		expect(fill(d, 60_000n)).toBeUndefined()
	})

	it('ignores a move below the proportional test, however large in absolute terms', () => {
		// 100ms to 102ms clears the floor but is well within normal variation on such a path
		const d = new StepDetector()
		fill(d, 100_000_000n)
		expect(fill(d, 102_000_000n)).toBeUndefined()
	})

	it('re-bases on the new plateau, so a move back is reported separately', () => {
		const d = new StepDetector()
		fill(d, 2_000_000n)
		expect(fill(d, 8_000_000n)).toEqual([2_000_000n, 8_000_000n])
		expect(fill(d, 2_000_000n)).toEqual([8_000_000n, 2_000_000n])
	})

	it('does not report the same plateau twice', () => {
		const d = new StepDetector()
		fill(d, 2_000_000n)
		expect(fill(d, 8_000_000n)).toEqual([2_000_000n, 8_000_000n])
		expect(fill(d, 8_000_000n)).toBeUndefined()
	})

	it('applies only the floor when the baseline is zero', () => {
		const d = new StepDetector()
		fill(d, 0n)
		expect(fill(d, 4_000_000n)).toEqual([0n, 4_000_000n])
	})

	it('handles a negative delay, which corrections can produce', () => {
		const d = new StepDetector()
		fill(d, -5_000_000n)
		expect(fill(d, 5_000_000n)).toEqual([-5_000_000n, 5_000_000n])
	})

	it('forgets everything on reset, as a master change requires', () => {
		const d = new StepDetector()
		fill(d, 2_000_000n)
		d.reset()
		// The first full window after a reset only re-establishes the baseline
		expect(fill(d, 8_000_000n)).toBeUndefined()
	})
})
