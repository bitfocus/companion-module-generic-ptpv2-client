import type ModuleInstance from './main.js'

export type VariablesSchema = {
	ptpTimeS: number | undefined
	ptpTimeNS: number | undefined
	ptpTime: string
	ptpMaster: string
	ptpMasterAddress: string
	lastSync: string
}

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	self.setVariableDefinitions({
		ptpTimeS: { name: 'PTP Time (s)' },
		ptpTimeNS: { name: 'PTP Time (ns)' },
		ptpTime: { name: 'PTP Time' },
		ptpMaster: { name: 'PTP Master (Clock Identity)' },
		ptpMasterAddress: { name: 'PTP Master (Address)' },
		lastSync: { name: 'Last Sync Timestamp' },
	})
}
