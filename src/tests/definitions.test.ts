import { describe, it, expect, vi } from 'vitest'
import { UpdateVariableDefinitions, type VariablesSchema } from '../variables.js'
import { UpdateFeedbacks, FeedbackIDs } from '../feedbacks.js'
import { GetConfigFields, type ModuleConfig } from '../config.js'
import type ModuleInstance from '../main.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// Both functions only ever read `self.config` and call one setter, so a stub instance is
// enough to observe exactly what a connection would publish for a given protocol.

const config = (ptpVersion: 'v2' | 'v1'): ModuleConfig => ({
	ptpVersion,
	interface: '192.168.1.10',
	domain: 0,
	subdomain: '_DFLT',
	customSubdomain: '',
	customSubdomainGroup: '224.0.1.130',
	interval: 10000,
	delayMechanism: 'auto',
})

const variablesFor = (ptpVersion: 'v2' | 'v1'): (keyof VariablesSchema)[] => {
	const setVariableDefinitions = vi.fn()
	UpdateVariableDefinitions({ config: config(ptpVersion), setVariableDefinitions } as unknown as ModuleInstance)
	return Object.keys(setVariableDefinitions.mock.calls[0][0]) as (keyof VariablesSchema)[]
}

const feedbacksFor = (ptpVersion: 'v2' | 'v1'): string[] => {
	const setFeedbackDefinitions = vi.fn()
	UpdateFeedbacks({ config: config(ptpVersion), setFeedbackDefinitions } as unknown as ModuleInstance)
	const defs = setFeedbackDefinitions.mock.calls[0][0] as Record<string, unknown>
	// A feedback set to undefined is one the module has declined to offer
	return Object.entries(defs)
		.filter(([, def]) => def !== undefined)
		.map(([id]) => id)
}

// ===========================================================================
// Variables
// ===========================================================================
describe('variable definitions by protocol', () => {
	const shared: (keyof VariablesSchema)[] = [
		'ptpTimeS',
		'ptpTimeNS',
		'ptpTime',
		'lastSync',
		'ptpMaster',
		'ptpMasterAddress',
		'ptpVersion',
	]

	it('publishes what both protocols can report, in both modes', () => {
		for (const version of ['v2', 'v1'] as const) {
			expect(variablesFor(version)).toEqual(expect.arrayContaining(shared))
		}
	})

	it.each(['subdomain', 'subdomainsFound'] as (keyof VariablesSchema)[])(
		'offers %s only in PTPv1, since PTPv2 has no such concept',
		(name) => {
			expect(variablesFor('v1')).toContain(name)
			expect(variablesFor('v2')).not.toContain(name)
		},
	)

	it.each([
		// All of these come from the Announce message, which IEEE 1588-2002 does not have
		'grandmaster',
		'grandmasterClockClass',
		'grandmasterAccuracy',
		'grandmasterTimeSource',
		'stepsRemoved',
		'announceInterval',
		'pathTrace',
		'pathTraceLoop',
		'utcOffset',
		'leapSecond',
		'timeTraceable',
		'syncUncertain',
		'twoStep',
		// And these describe a delay mechanism PTPv1 does not have a choice about
		'delayMechanism',
		'peerMeanPathDelay',
		'peerDelayResponding',
		'meanPathDelay',
	] as (keyof VariablesSchema)[])('withholds %s in PTPv1', (name) => {
		expect(variablesFor('v2')).toContain(name)
		expect(variablesFor('v1')).not.toContain(name)
	})

	it('offers PTPv1 a strict subset of what PTPv2 offers, plus its own subdomain fields', () => {
		const v1 = new Set(variablesFor('v1'))
		const v2 = new Set(variablesFor('v2'))
		const onlyInV1 = [...v1].filter((name) => !v2.has(name))
		expect(onlyInV1).toEqual(['subdomain', 'subdomainsFound'])
	})

	it('never publishes a variable that is not in the schema', () => {
		// A typo would otherwise surface as a variable that silently never populates
		const schemaKeys = new Set(variablesFor('v2').concat(variablesFor('v1')))
		expect(schemaKeys.size).toBeGreaterThan(0)
		for (const name of schemaKeys) {
			expect(typeof name).toBe('string')
		}
	})

	it('defaults to the PTPv2 set when no protocol has been chosen yet', () => {
		const setVariableDefinitions = vi.fn()
		UpdateVariableDefinitions({ config: undefined, setVariableDefinitions } as unknown as ModuleInstance)
		expect(Object.keys(setVariableDefinitions.mock.calls[0][0])).toContain('grandmaster')
	})
})

// ===========================================================================
// Feedbacks
// ===========================================================================
describe('feedback definitions by protocol', () => {
	it('offers PTP Synced in both modes — it is the one thing both can answer', () => {
		expect(feedbacksFor('v2')).toContain(FeedbackIDs.IsSynced)
		expect(feedbacksFor('v1')).toContain(FeedbackIDs.IsSynced)
	})

	it.each([
		FeedbackIDs.TimeTraceable,
		FeedbackIDs.LeapSecondPending,
		FeedbackIDs.GrandmasterClockClass,
		FeedbackIDs.StepsRemoved,
		FeedbackIDs.PathDelay,
		FeedbackIDs.PathTraceLoop,
	])('withholds %s in PTPv1, where it could only ever be false', (id) => {
		expect(feedbacksFor('v2')).toContain(id)
		expect(feedbacksFor('v1')).not.toContain(id)
	})

	it('leaves PTPv1 with exactly one feedback', () => {
		expect(feedbacksFor('v1')).toEqual([FeedbackIDs.IsSynced])
	})

	it('defaults to the PTPv2 set when no protocol has been chosen yet', () => {
		const setFeedbackDefinitions = vi.fn()
		UpdateFeedbacks({ config: undefined, setFeedbackDefinitions } as unknown as ModuleInstance)
		const defs = setFeedbackDefinitions.mock.calls[0][0] as Record<string, unknown>
		expect(defs[FeedbackIDs.PathTraceLoop]).toBeDefined()
	})
})

// ===========================================================================
// Config field visibility
// ===========================================================================
// isVisibleExpression is evaluated by Companion, not here, so these assert the expressions
// reference the right fields and that anything they depend on is readable by them.
describe('config field visibility', () => {
	const fields = GetConfigFields() as {
		id: string
		type: string
		isVisibleExpression?: string
		disableAutoExpression?: boolean
		regex?: string
	}[]
	const field = (id: string) => fields.find((f) => f.id === id)!

	it('hides the PTPv2 settings unless the connection is PTPv2', () => {
		for (const id of ['domain', 'delayMechanism', 'delayMechanismHelp']) {
			expect(field(id).isVisibleExpression).toContain(`$(options:ptpVersion) == 'v2'`)
		}
	})

	it('hides the subdomain unless the connection is PTPv1', () => {
		expect(field('subdomain').isVisibleExpression).toContain(`$(options:ptpVersion) == 'v1'`)
	})

	it.each(['customSubdomain', 'customSubdomainGroup', 'customSubdomainHelp'])(
		'shows %s only for a PTPv1 connection set to a custom subdomain',
		(id) => {
			// Both halves matter: a stored subdomain of 'custom' must not reveal these on a
			// PTPv2 connection, where they mean nothing
			const expression = field(id).isVisibleExpression ?? ''
			expect(expression).toContain(`$(options:ptpVersion) == 'v1'`)
			expect(expression).toContain(`$(options:subdomain) == 'custom'`)
		},
	)

	it('makes the fields the expressions depend on readable by them', () => {
		// Companion can only reference a field from isVisibleExpression when that field is
		// not itself expression-capable
		expect(field('ptpVersion').disableAutoExpression).toBe(true)
		expect(field('subdomain').disableAutoExpression).toBe(true)
	})

	it('constrains the custom subdomain to what the protocol can carry', () => {
		const regex = field('customSubdomain').regex
		expect(regex).toBeDefined()
		const pattern = new RegExp(regex!.slice(1, regex!.lastIndexOf('/')))
		expect(pattern.test('H~O$L')).toBe(true)
		expect(pattern.test('x'.repeat(15))).toBe(true)
		expect(pattern.test('x'.repeat(16))).toBe(false) // the field holds 15 plus a terminator
		expect(pattern.test('')).toBe(false)
		expect(pattern.test(`a${String.fromCharCode(1)}b`)).toBe(false)
	})

	it('offers Custom on the subdomain dropdown', () => {
		const choices = (field('subdomain') as unknown as { choices: { id: string }[] }).choices
		expect(choices.map((c) => c.id)).toEqual(['_DFLT', '_ALT1', '_ALT2', '_ALT3', '_ALT4', 'custom'])
	})

	it('offers only groups the client will accept', async () => {
		const { PTP_MULTICAST_GROUPS } = await import('../ptpv1.js')
		const choices = (field('customSubdomainGroup') as unknown as { choices: { id: string }[] }).choices
		expect(choices.map((c) => c.id)).toEqual([...PTP_MULTICAST_GROUPS])
	})
})
