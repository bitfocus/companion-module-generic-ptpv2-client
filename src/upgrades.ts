import type {
	CompanionStaticUpgradeProps,
	CompanionStaticUpgradeResult,
	CompanionStaticUpgradeScript,
	CompanionUpgradeContext,
} from '@companion-module/base'
import type { ModuleConfig } from './config.js'

export const UpgradeScripts: CompanionStaticUpgradeScript<ModuleConfig>[] = [
	/*
	 * Place your upgrade scripts here
	 * Remember that once it has been added it cannot be removed!
	 */

	/**
	 * Delay Mechanism was added after release, so a connection configured before it existed
	 * has no stored value for it.
	 *
	 * These are pinned to 'e2e' rather than to the field's own 'auto' default, because the
	 * end to end exchange is the only thing the module ever used to do. Adopting 'auto' here
	 * would silently change how an already working connection measures its clock — and on a
	 * network where auto guesses wrong, would stop it measuring at all. A new connection still
	 * gets 'auto'; this is only about not moving the ground under an existing one.
	 */
	function addDelayMechanism(
		_context: CompanionUpgradeContext<ModuleConfig>,
		props: CompanionStaticUpgradeProps<ModuleConfig, undefined>,
	): CompanionStaticUpgradeResult<ModuleConfig, undefined> {
		if (props.config === null) {
			return { updatedConfig: null, updatedActions: [], updatedFeedbacks: [] }
		}
		// The stored config predates the field, so the declared type overstates what is there
		const stored = props.config as Partial<ModuleConfig>
		if (stored.delayMechanism !== undefined) {
			return { updatedConfig: null, updatedActions: [], updatedFeedbacks: [] }
		}
		return {
			updatedConfig: { ...props.config, delayMechanism: 'e2e' },
			updatedActions: [],
			updatedFeedbacks: [],
		}
	},
]
