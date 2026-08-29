import type ModuleInstance from './main.js'

/** This module exposes no actions — it only reports the state of the PTP clock. */
export type ActionsSchema = Record<string, never>

export function UpdateActions(self: ModuleInstance): void {
	self.setActionDefinitions({})
}
