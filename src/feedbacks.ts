import { combineRgb } from '@companion-module/base'
import type ModuleInstance from './main.js'

export enum FeedbackIDs {
	IsSynced = 'isSynced',
}

export type FeedbacksSchema = {
	[FeedbackIDs.IsSynced]: {
		type: 'boolean'
		options: Record<string, never>
	}
}

export function UpdateFeedbacks(self: ModuleInstance): void {
	self.setFeedbackDefinitions({
		[FeedbackIDs.IsSynced]: {
			type: 'boolean',
			name: 'PTP Synced',
			defaultStyle: {
				bgcolor: combineRgb(255, 0, 0),
				color: combineRgb(0, 0, 0),
			},
			options: [],
			callback: () => {
				return self.client?.is_synced ?? false
			},
		},
	})
}
