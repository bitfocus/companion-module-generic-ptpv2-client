import {
	type CompanionStaticUpgradeProps,
	type CompanionStaticUpgradeResult,
	type CompanionUpgradeContext,
	type CompanionStaticUpgradeScript,
} from '@companion-module/base'
import { PTP_SUBDOMAIN_DEFAULT } from './ptpv1.js'
import type { ModuleConfig } from './config.js'

export const UpgradeScripts: CompanionStaticUpgradeScript<ModuleConfig>[] = [
	/*
	 * Place your upgrade scripts here
	 * Remember that once it has been added it cannot be removed!
	 */
	// function (context, props) {
	// 	return {
	// 		updatedConfig: null,
	// 		updatedActions: [],
	// 		updatedFeedbacks: [],
	// 	}
	// },
	function v110(
		_context: CompanionUpgradeContext<ModuleConfig>,
		props: CompanionStaticUpgradeProps<ModuleConfig>,
	): CompanionStaticUpgradeResult<ModuleConfig> {
		const result: CompanionStaticUpgradeResult<ModuleConfig> = {
			updatedActions: [],
			updatedConfig: null,
			updatedFeedbacks: [],
		}
		if (props.config !== null) {
			const config = props.config
			if (!config.version) config.version = 'ptpv2'
			if (!config.subdomain) config.subdomain = PTP_SUBDOMAIN_DEFAULT
			result.updatedConfig = config
		}

		return result
	},
]
