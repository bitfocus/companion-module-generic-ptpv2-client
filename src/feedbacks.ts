import { combineRgb } from '@companion-module/base'
import type ModuleInstance from './main.js'

export enum FeedbackIDs {
	IsSynced = 'isSynced',
	TimeTraceable = 'timeTraceable',
	LeapSecondPending = 'leapSecondPending',
	GrandmasterClockClass = 'grandmasterClockClass',
	StepsRemoved = 'stepsRemoved',
	PathDelay = 'pathDelay',
	PathTraceLoop = 'pathTraceLoop',
}

export type FeedbacksSchema = {
	[FeedbackIDs.IsSynced]: { type: 'boolean'; options: Record<string, never> }
	[FeedbackIDs.TimeTraceable]: { type: 'boolean'; options: Record<string, never> }
	[FeedbackIDs.LeapSecondPending]: { type: 'boolean'; options: Record<string, never> }
	[FeedbackIDs.GrandmasterClockClass]: { type: 'boolean'; options: { maxClockClass: number } }
	[FeedbackIDs.StepsRemoved]: { type: 'boolean'; options: { maxSteps: number } }
	[FeedbackIDs.PathDelay]: { type: 'boolean'; options: { maxDelay: number } }
	[FeedbackIDs.PathTraceLoop]: { type: 'boolean'; options: Record<string, never> }
}

const alarmStyle = {
	bgcolor: combineRgb(255, 0, 0),
	color: combineRgb(0, 0, 0),
}

const warnStyle = {
	bgcolor: combineRgb(255, 191, 0),
	color: combineRgb(0, 0, 0),
}

export function UpdateFeedbacks(self: ModuleInstance): void {
	self.setFeedbackDefinitions({
		[FeedbackIDs.IsSynced]: {
			type: 'boolean',
			name: 'PTP Synced',
			description: 'True while a delay exchange has completed and Sync messages are still arriving',
			defaultStyle: alarmStyle,
			options: [],
			callback: () => {
				return self.client?.is_synced ?? false
			},
		},
		[FeedbackIDs.TimeTraceable]: {
			type: 'boolean',
			name: 'Time Traceable',
			description: 'True while the grandmaster reports its time as traceable to a primary reference',
			defaultStyle: warnStyle,
			options: [],
			callback: () => {
				return self.client?.ptp_flags.timeTraceable ?? false
			},
		},
		[FeedbackIDs.LeapSecondPending]: {
			type: 'boolean',
			name: 'Leap Second Pending',
			description: 'True when the grandmaster announces a leap second at the end of the current UTC day',
			defaultStyle: warnStyle,
			options: [],
			callback: () => {
				const flags = self.client?.ptp_flags
				return (flags?.leap59 ?? false) || (flags?.leap61 ?? false)
			},
		},
		[FeedbackIDs.GrandmasterClockClass]: {
			type: 'boolean',
			name: 'Grandmaster Clock Class Worse Than',
			description:
				'True when the grandmaster clock class is above the threshold. Lower is better: 6 is locked to a primary reference, 7 is holdover, 248 is a default free-running clock.',
			defaultStyle: alarmStyle,
			options: [
				{
					id: 'maxClockClass',
					type: 'number',
					label: 'Clock class worse than',
					default: 6,
					min: 0,
					max: 255,
					asInteger: true,
				},
			],
			callback: (feedback) => {
				const clockClass = self.client?.grandmaster?.clockClass
				if (clockClass === undefined) return false
				return clockClass > feedback.options.maxClockClass
			},
		},
		[FeedbackIDs.StepsRemoved]: {
			type: 'boolean',
			name: 'Steps Removed Above',
			description: 'True when there are more boundary clocks between this host and the grandmaster than the threshold',
			defaultStyle: warnStyle,
			options: [
				{
					id: 'maxSteps',
					type: 'number',
					label: 'Steps removed above',
					default: 1,
					min: 0,
					max: 255,
					asInteger: true,
				},
			],
			callback: (feedback) => {
				const steps = self.client?.grandmaster?.stepsRemoved
				if (steps === undefined) return false
				return steps > feedback.options.maxSteps
			},
		},
		[FeedbackIDs.PathDelay]: {
			type: 'boolean',
			name: 'Mean Path Delay Above',
			description:
				'True when the measured mean path delay exceeds the threshold. A rising delay indicates a congested or asymmetric path.',
			defaultStyle: warnStyle,
			options: [
				{
					id: 'maxDelay',
					type: 'number',
					label: 'Mean path delay above (ns)',
					default: 1_000_000,
					min: 0,
					max: 1_000_000_000,
					asInteger: true,
				},
			],
			callback: (feedback) => {
				const client = self.client
				if (!client || client.last_sync === 0) return false
				return client.mean_path_delay > BigInt(Math.round(feedback.options.maxDelay))
			},
		},
		[FeedbackIDs.PathTraceLoop]: {
			type: 'boolean',
			name: 'Path Trace Loop Detected',
			description:
				'True when a clock identity appears more than once in the PATH_TRACE of an Announce, meaning it travelled a loop. Requires the grandmaster to emit path trace.',
			defaultStyle: alarmStyle,
			options: [],
			callback: () => {
				return self.client?.grandmaster?.pathTraceLoop ?? false
			},
		},
	})
}
