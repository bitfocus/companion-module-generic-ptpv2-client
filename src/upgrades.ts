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

	/**
	 * PTP Version, and the subdomain that goes with PTPv1, were added when PTPv1 support was.
	 *
	 * Every connection that predates the field is by definition a PTPv2 one — it is the only
	 * protocol the module spoke — so they are pinned to 'v2'. The subdomain is filled in with
	 * the field default so that switching an existing connection to PTPv1 in the UI does not
	 * start from an empty value.
	 */
	function addPtpVersion(
		_context: CompanionUpgradeContext<ModuleConfig>,
		props: CompanionStaticUpgradeProps<ModuleConfig, undefined>,
	): CompanionStaticUpgradeResult<ModuleConfig, undefined> {
		if (props.config === null) {
			return { updatedConfig: null, updatedActions: [], updatedFeedbacks: [] }
		}
		const stored = props.config as Partial<ModuleConfig>
		if (stored.ptpVersion !== undefined && stored.subdomain !== undefined) {
			return { updatedConfig: null, updatedActions: [], updatedFeedbacks: [] }
		}
		return {
			updatedConfig: {
				...props.config,
				ptpVersion: stored.ptpVersion ?? 'v2',
				subdomain: stored.subdomain ?? '_DFLT',
			},
			updatedActions: [],
			updatedFeedbacks: [],
		}
	},

	/**
	 * The custom subdomain fields arrived with the Custom option on the subdomain dropdown.
	 *
	 * They only mean anything when the subdomain is set to 'custom', but they are filled in
	 * regardless so that neither is ever undefined: an undefined value reaching the config
	 * form shows as an empty control that the user cannot tell apart from one they cleared
	 * themselves, and an undefined group would leave the client with nothing to join.
	 *
	 * No existing connection can have been using a custom subdomain — the option did not
	 * exist — so the name defaults to empty and the group to the first alternate. A
	 * connection that later switches to Custom starts from a valid group and a name the
	 * field's own regex will flag until it is filled in.
	 */
	function addCustomSubdomain(
		_context: CompanionUpgradeContext<ModuleConfig>,
		props: CompanionStaticUpgradeProps<ModuleConfig, undefined>,
	): CompanionStaticUpgradeResult<ModuleConfig, undefined> {
		if (props.config === null) {
			return { updatedConfig: null, updatedActions: [], updatedFeedbacks: [] }
		}
		const stored = props.config as Partial<ModuleConfig>
		if (stored.customSubdomain !== undefined && stored.customSubdomainGroup !== undefined) {
			return { updatedConfig: null, updatedActions: [], updatedFeedbacks: [] }
		}
		return {
			updatedConfig: {
				...props.config,
				customSubdomain: stored.customSubdomain ?? '',
				customSubdomainGroup: stored.customSubdomainGroup ?? '224.0.1.130',
			},
			updatedActions: [],
			updatedFeedbacks: [],
		}
	},
]
