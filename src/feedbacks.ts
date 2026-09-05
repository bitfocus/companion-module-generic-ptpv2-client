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
	// Everything but PTP Synced is derived from the Announce message, which PTPv1 does not
	// have. Defining them anyway would offer the user feedbacks that can only ever be false.
	const isV1 = self.config?.ptpVersion === 'v1'
	self.setFeedbackDefinitions({
		[FeedbackIDs.IsSynced]: {
			type: 'boolean',
			name: 'PTP Synced',
			description: 'True while a measurement has completed and Sync messages are still arriving',
			defaultStyle: alarmStyle,
			options: [],
			callback: () => {
				return self.client?.is_synced ?? false
			},
		},
		[FeedbackIDs.TimeTraceable]: isV1
			? undefined
			: {
					type: 'boolean',
					name: 'Time Traceable',
					description: 'True while the grandmaster reports its time as traceable to a primary reference',
					defaultStyle: warnStyle,
					options: [],
					callback: () => {
						return self.v2?.ptp_flags.timeTraceable ?? false
					},
				},
		[FeedbackIDs.LeapSecondPending]: isV1
			? undefined
			: {
					type: 'boolean',
					name: 'Leap Second Pending',
					description: 'True when the grandmaster announces a leap second at the end of the current UTC day',
					defaultStyle: warnStyle,
					options: [],
					callback: () => {
						const flags = self.v2?.ptp_flags
						return (flags?.leap59 ?? false) || (flags?.leap61 ?? false)
					},
				},
		[FeedbackIDs.GrandmasterClockClass]: isV1
			? undefined
			: {
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
						const clockClass = self.v2?.grandmaster?.clockClass
						if (clockClass === undefined) return false
						return clockClass > feedback.options.maxClockClass
					},
				},
		[FeedbackIDs.StepsRemoved]: isV1
			? undefined
			: {
					type: 'boolean',
					name: 'Steps Removed Above',
					description:
						'True when there are more boundary clocks between this host and the grandmaster than the threshold',
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
						const steps = self.v2?.grandmaster?.stepsRemoved
						if (steps === undefined) return false
						return steps > feedback.options.maxSteps
					},
				},
		[FeedbackIDs.PathDelay]: isV1
			? undefined
			: {
					type: 'boolean',
					name: 'Mean Path Delay Above',
					description:
						'True when the measured mean path delay exceeds the threshold. A rising delay indicates a congested or asymmetric path. ' +
						'End to End only — no other delay mechanism measures the path to the master.',
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
						const client = self.v2
						if (!client || client.last_sync === 0) return false
						return client.mean_path_delay > BigInt(Math.round(feedback.options.maxDelay))
					},
				},
		[FeedbackIDs.PathTraceLoop]: isV1
			? undefined
			: {
					type: 'boolean',
					name: 'Path Trace Loop Detected',
					description:
						'True when a clock identity appears more than once in the PATH_TRACE of an Announce, meaning it travelled a loop. Requires the grandmaster to emit path trace.',
					defaultStyle: alarmStyle,
					options: [],
					callback: () => {
						return self.v2?.grandmaster?.pathTraceLoop ?? false
					},
				},
	})
}
