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
		const config = { ...legacyConfig(), delayMechanism: mechanism }
		expect(runAll(config)?.delayMechanism).toBe(mechanism)
	})

	it('reports no change when there is nothing to do', () => {
		const config = { ...legacyConfig(), delayMechanism: 'p2p' as const }
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
