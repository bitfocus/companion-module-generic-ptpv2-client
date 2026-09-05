import { describe, it, expect } from 'vitest'
import { UpgradeScripts } from '../upgrades.js'
import type { ModuleConfig } from '../config.js'
import type { DelayMechanism } from '../ptpv2.js'
import type { CompanionStaticUpgradeProps, CompanionUpgradeContext } from '@companion-module/base'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A connection stored before Delay Mechanism existed: every other field, and not that one */
const legacyConfig = (): ModuleConfig =>
	({
		interface: '192.168.1.10',
		domain: 0,
		interval: 10000,
	}) as unknown as ModuleConfig

/** A connection already carrying every field the current module defines */
const upToDateConfig = (): ModuleConfig => ({
	ptpVersion: 'v2',
	interface: '192.168.1.10',
	domain: 0,
	subdomain: '_DFLT',
	customSubdomain: '',
	customSubdomainGroup: '224.0.1.130',
	interval: 10000,
	delayMechanism: 'p2p',
})

const context = (config: ModuleConfig | null): CompanionUpgradeContext<ModuleConfig> =>
	({ currentConfig: config }) as CompanionUpgradeContext<ModuleConfig>

const props = (config: ModuleConfig | null): CompanionStaticUpgradeProps<ModuleConfig, undefined> => ({
	config,
	secrets: null,
	actions: [],
	feedbacks: [],
})

const runAll = (config: ModuleConfig | null): ModuleConfig | null => {
	let current = config
	for (const script of UpgradeScripts) {
		const result = script(context(current), props(current))
		if (result.updatedConfig !== null) current = result.updatedConfig
	}
	return current
}

// ===========================================================================
// Delay Mechanism
// ===========================================================================
describe('upgrade – delay mechanism', () => {
	it('gives a connection that predates the field the behaviour it already had', () => {
		// Not 'auto': the module only ever did end to end, and an upgrade must not change how
		// a working connection measures its clock
		expect(runAll(legacyConfig())?.delayMechanism).toBe('e2e')
	})

	it('leaves every other setting untouched', () => {
		const upgraded = runAll(legacyConfig())
		expect(upgraded).toMatchObject({ interface: '192.168.1.10', domain: 0, interval: 10000 })
	})

	it.each(['auto', 'e2e', 'p2p', 'passive'] as const)('does not overwrite a stored %s', (mechanism) => {
		const config = { ...upToDateConfig(), delayMechanism: mechanism }
		expect(runAll(config)?.delayMechanism).toBe(mechanism)
	})

	it('reports no change when there is nothing to do', () => {
		const config = upToDateConfig()
		for (const script of UpgradeScripts) {
			expect(script(context(config), props(config)).updatedConfig).toBeNull()
		}
	})

	it('tolerates a null config rather than throwing', () => {
		expect(() => runAll(null)).not.toThrow()
		for (const script of UpgradeScripts) {
			expect(script(context(null), props(null)).updatedConfig).toBeNull()
		}
	})

	it('is idempotent across repeated runs', () => {
		const once = runAll(legacyConfig())
		const twice = runAll(once)
		expect(twice).toEqual(once)
	})

	it('leaves actions and feedbacks alone — this module has no actions to migrate', () => {
		for (const script of UpgradeScripts) {
			const result = script(context(legacyConfig()), props(legacyConfig()))
			expect(result.updatedActions).toEqual([])
			expect(result.updatedFeedbacks).toEqual([])
		}
	})

	it('produces a value that is actually one of the mechanisms', () => {
		// The compiler already rejects a typo here; this is the runtime half of that guarantee,
		// and costs nothing. Constructing a real client instead would bind the privileged
		// ports 319/320 for no extra coverage.
		const valid: DelayMechanism[] = ['auto', 'e2e', 'p2p', 'passive']
		expect(valid).toContain(runAll(legacyConfig())?.delayMechanism)
	})
})

// ===========================================================================
// PTP Version
// ===========================================================================
describe('upgrade – ptp version', () => {
	it('treats a connection that predates the field as PTPv2', () => {
		// It is the only protocol the module spoke, so there is nothing else it could be
		expect(runAll(legacyConfig())?.ptpVersion).toBe('v2')
	})

	it('fills in a subdomain so switching to PTPv1 does not start from nothing', () => {
		expect(runAll(legacyConfig())?.subdomain).toBe('_DFLT')
	})

	it.each(['v2', 'v1'] as const)('does not overwrite a stored %s', (version) => {
		const config = { ...upToDateConfig(), ptpVersion: version }
		expect(runAll(config)?.ptpVersion).toBe(version)
	})

	it('does not overwrite a stored subdomain', () => {
		const config = { ...upToDateConfig(), ptpVersion: 'v1' as const, subdomain: '_ALT2' as const }
		const upgraded = runAll(config)
		expect(upgraded?.subdomain).toBe('_ALT2')
		expect(upgraded?.ptpVersion).toBe('v1')
	})

	it('fills in only the half that is missing', () => {
		// A connection upgraded once already, then the subdomain field arriving later
		const partial = { ...legacyConfig(), ptpVersion: 'v1' as const } as ModuleConfig
		const upgraded = runAll(partial)
		expect(upgraded?.ptpVersion).toBe('v1') // kept
		expect(upgraded?.subdomain).toBe('_DFLT') // filled
	})

	it('leaves the delay mechanism upgrade to do its own job', () => {
		const upgraded = runAll(legacyConfig())
		expect(upgraded).toMatchObject({ ptpVersion: 'v2', subdomain: '_DFLT', delayMechanism: 'e2e' })
	})
})

// ===========================================================================
// Custom subdomain fields
// ===========================================================================
describe('upgrade – custom subdomain', () => {
	it('never leaves the custom fields undefined', () => {
		// An undefined value shows in the config form as a control the user cannot tell apart
		// from one they cleared, and an undefined group leaves the client nothing to join
		const upgraded = runAll(legacyConfig())
		expect(upgraded?.customSubdomain).toBeDefined()
		expect(upgraded?.customSubdomainGroup).toBeDefined()
	})

	it('starts from an empty name and a valid group', () => {
		// No existing connection can have used a custom subdomain, since the option is new
		const upgraded = runAll(legacyConfig())
		expect(upgraded?.customSubdomain).toBe('')
		expect(upgraded?.customSubdomainGroup).toBe('224.0.1.130')
	})

	it('leaves the chosen subdomain alone — this upgrade is not about switching to custom', () => {
		expect(runAll(legacyConfig())?.subdomain).toBe('_DFLT')
	})

	it('does not overwrite a name and group already set', () => {
		const config = { ...upToDateConfig(), customSubdomain: 'H~O$L', customSubdomainGroup: '224.0.1.132' as const }
		const upgraded = runAll(config)
		expect(upgraded?.customSubdomain).toBe('H~O$L')
		expect(upgraded?.customSubdomainGroup).toBe('224.0.1.132')
	})

	it('fills in only the half that is missing', () => {
		const partial = { ...legacyConfig(), customSubdomain: 'H~O$L' }
		const upgraded = runAll(partial)
		expect(upgraded?.customSubdomain).toBe('H~O$L') // kept
		expect(upgraded?.customSubdomainGroup).toBe('224.0.1.130') // filled
	})

	it('offers a group the client will actually accept', async () => {
		const { PTP_MULTICAST_GROUPS } = await import('../ptpv1.js')
		expect(PTP_MULTICAST_GROUPS).toContain(runAll(legacyConfig())?.customSubdomainGroup)
	})

	it('is idempotent', () => {
		const once = runAll(legacyConfig())
		expect(runAll(once)).toEqual(once)
	})
})
