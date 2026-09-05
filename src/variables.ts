import type ModuleInstance from './main.js'

export type VariablesSchema = {
	// Time
	ptpTimeS: number | undefined
	ptpTimeNS: number | undefined
	ptpTime: string | undefined
	lastSync: string

	// Measurement quality
	meanPathDelay: number | undefined
	lastCorrection: number | undefined

	// Delay mechanism. peerMeanPathDelay is the local link only — in a P2P domain the rest
	// of the path arrives already summed in the Sync correction field.
	delayMechanism: string
	peerMeanPathDelay: number | undefined
	peerDelayResponding: boolean

	// The port sending Sync — behind a boundary clock this is not the grandmaster
	ptpMaster: string
	ptpMasterAddress: string
	ptpMasterMac: string
	ptpMasterOui: string
	ptpMasterVendor: string

	ptpVersion: string

	// The actual source of time, from Announce
	grandmaster: string
	grandmasterMac: string
	grandmasterOui: string
	grandmasterVendor: string
	grandmasterAddress: string
	grandmasterClockClass: number | undefined
	grandmasterClockClassLabel: string
	grandmasterAccuracy: string
	grandmasterTimeSource: string
	grandmasterPriority1: number | undefined
	grandmasterPriority2: number | undefined
	stepsRemoved: number | undefined
	announceInterval: number | undefined
	lastAnnounce: string
	pathTrace: string
	pathTraceHops: number | undefined
	pathTraceLoop: boolean

	// Time properties and flags
	utcOffset: number | undefined
	utcOffsetValid: boolean
	leapSecond: string
	ptpTimescale: boolean
	timeTraceable: boolean
	frequencyTraceable: boolean
	syncUncertain: boolean
	twoStep: boolean
}

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	self.setVariableDefinitions({
		ptpTimeS: { name: 'PTP Time (s)' },
		ptpTimeNS: { name: 'PTP Time (ns)' },
		ptpTime: { name: 'PTP Time' },
		lastSync: { name: 'Last Sync Timestamp' },

		meanPathDelay: { name: 'Mean Path Delay (ns)' },
		delayMechanism: { name: 'Delay Mechanism' },
		peerMeanPathDelay: { name: 'Peer Mean Path Delay (ns)' },
		peerDelayResponding: { name: 'Peer Delay Responding' },
		lastCorrection: { name: 'Last Clock Correction (ns)' },

		ptpMaster: { name: 'PTP Master (Clock Identity)' },
		ptpMasterAddress: { name: 'PTP Master (Address)' },
		ptpMasterMac: { name: 'PTP Master (MAC)' },
		ptpMasterOui: { name: 'PTP Master (OUI)' },
		ptpMasterVendor: { name: 'PTP Master (Manufacturer)' },
		ptpVersion: { name: 'PTP Version' },

		grandmaster: { name: 'Grandmaster (Clock Identity)' },
		grandmasterMac: { name: 'Grandmaster (MAC)' },
		grandmasterOui: { name: 'Grandmaster (OUI)' },
		grandmasterVendor: { name: 'Grandmaster (Manufacturer)' },
		grandmasterAddress: { name: 'Grandmaster (Address)' },
		grandmasterClockClass: { name: 'Grandmaster Clock Class' },
		grandmasterClockClassLabel: { name: 'Grandmaster Clock Class (Description)' },
		grandmasterAccuracy: { name: 'Grandmaster Clock Accuracy' },
		grandmasterTimeSource: { name: 'Grandmaster Time Source' },
		grandmasterPriority1: { name: 'Grandmaster Priority 1' },
		grandmasterPriority2: { name: 'Grandmaster Priority 2' },
		stepsRemoved: { name: 'Steps Removed from Grandmaster' },
		announceInterval: { name: 'Announce Interval (s)' },
		lastAnnounce: { name: 'Last Announce Timestamp' },
		pathTrace: { name: 'Path Trace (Clock Identity Chain)' },
		pathTraceHops: { name: 'Path Trace (Clocks in Path)' },
		pathTraceLoop: { name: 'Path Trace Loop Detected' },

		utcOffset: { name: 'UTC Offset (s)' },
		utcOffsetValid: { name: 'UTC Offset Valid' },
		leapSecond: { name: 'Leap Second Pending' },
		ptpTimescale: { name: 'PTP Timescale' },
		timeTraceable: { name: 'Time Traceable' },
		frequencyTraceable: { name: 'Frequency Traceable' },
		syncUncertain: { name: 'Synchronisation Uncertain' },
		twoStep: { name: 'Master is Two-Step' },
	})
}
