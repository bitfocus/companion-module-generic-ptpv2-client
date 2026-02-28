import { combineRgb } from '@companion-module/base'
import type { ModuleInstance } from './main.js'
import { PTPv1Client } from './ptpv1.js'

export function UpdateFeedbacks(self: ModuleInstance): void {
	self.setFeedbackDefinitions({
		isSynced: {
			name: 'PTP Synced',
			type: 'boolean',
			defaultStyle: {
				bgcolor: combineRgb(255, 0, 0),
				color: combineRgb(0, 0, 0),
			},
			options: [],
			callback: (_feedback) => {
				return self.client.is_synced
			},
		},
		domains: {
			name: self.config?.version == 'ptpv1' ? 'Subdomains' : 'Domains',
			description: `Return an array of discovered ${self.config?.version == 'ptpv1' ? 'subdomains' : 'domains'}`,
			type: 'value',
			options: [],
			callback: (_feedback): Array<string | number> => {
				if (self.client instanceof PTPv1Client) return [...self.client.subdomains]
				else return [...self.client.domains]
			},
		},

		ptpTimeNs: {
			name: 'PTP Time (nS)',
			type: 'value',
			options: [],
			callback: (_feedback): string => {
				return self.client.ptp_time_ns.toString()
			},
		},
	})
}
