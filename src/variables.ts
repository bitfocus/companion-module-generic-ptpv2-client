import type { ModuleInstance } from './main.js'

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	self.setVariableDefinitions([
		{ variableId: 'ptpTimeS', name: 'PTP Time (s)' },
		{ variableId: 'ptpTimeNS', name: 'PTP Time (ns)' },
		{
			variableId: 'ptpMaster',
			name: `PTP Master (${self.config.version == 'ptpv1' ? 'Source Identity' : 'Clock Identity'})`,
		},
		{ variableId: 'ptpMasterAddress', name: 'PTP Master (Address)' },
		{ variableId: 'lastSync', name: 'Last Sync Timestamp' },
	])
}
