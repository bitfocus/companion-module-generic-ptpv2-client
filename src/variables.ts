import type { ModuleInstance } from './main.js'

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	self.setVariableDefinitions([
		{ variableId: 'ptpTimeS', name: 'PTP Time (s)' },
		{ variableId: 'ptpTimeNS', name: 'PTP Time (ns)' },
		{ variableId: 'ptpMaster', name: 'PTP Master (Clock Identity)' },
		{ variableId: 'lastSync', name: 'Last Sync Timestamp' },
	])
}
