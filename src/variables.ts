import type { ModuleInstance } from './main.js'

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	self.setVariableDefinitions([
		{ variableId: 'ptpTimeS', name: 'PTP Time (S)' },
		{ variableId: 'ptpTimeNS', name: 'PTP Time (nS)' },
		{ variableId: 'ptpMaster', name: 'PTP Master' },
	])
}
