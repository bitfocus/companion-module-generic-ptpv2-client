import type { CompanionVariableDefinitions } from '@companion-module/base'
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

	// PTPv1 selects its clock domain by subdomain name rather than by a domain number
	subdomain: string
	// Every subdomain name heard on the joined multicast group, in the order first seen
	subdomainsFound: string[]
}

/**
 * A subset of the schema's variables. Which ones a connection publishes depends on the
 * protocol it is speaking, so this is deliberately partial.
 */
type VariableDefs = Partial<Record<keyof VariablesSchema, { name: string }>>

/** Everything both protocols can actually report */
const sharedDefs: VariableDefs = {
	ptpTimeS: { name: 'PTP Time (s)' },
	ptpTimeNS: { name: 'PTP Time (ns)' },
	ptpTime: { name: 'PTP Time' },
	lastSync: { name: 'Last Sync Timestamp' },

	ptpMaster: { name: 'PTP Master (Clock Identity)' },
	ptpMasterAddress: { name: 'PTP Master (Address)' },
	ptpVersion: { name: 'PTP Version' },
}

/**
 * PTPv2 only. Almost all of it comes from the Announce message, which PTPv1 does not have —
 * a PTPv1 clock advertises itself inside the Sync body instead, and the PTPv1 client does not
 * yet read it. The delay figures are equally absent: PTPv1 has no peer delay mechanism, and
 * the PTPv1 client does not derive a path delay from its exchange.
 */
const v2Defs: VariableDefs = {
	meanPathDelay: { name: 'Mean Path Delay (ns)' },
	delayMechanism: { name: 'Delay Mechanism' },
	peerMeanPathDelay: { name: 'Peer Mean Path Delay (ns)' },
	peerDelayResponding: { name: 'Peer Delay Responding' },
	lastCorrection: { name: 'Last Clock Correction (ns)' },

	ptpMasterMac: { name: 'PTP Master (MAC)' },
	ptpMasterOui: { name: 'PTP Master (OUI)' },
	ptpMasterVendor: { name: 'PTP Master (Manufacturer)' },

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
}

/** PTPv1 only */
const v1Defs: VariableDefs = {
	subdomain: { name: 'PTP Subdomain' },
	subdomainsFound: { name: 'PTP Subdomains Found' },
}

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	const defs: VariableDefs =
		self.config?.ptpVersion === 'v1' ? { ...sharedDefs, ...v1Defs } : { ...sharedDefs, ...v2Defs }
	// Publishing a subset is the point — a variable that cannot be populated should not be
	// offered in the picker at all. The mapped type demands every key, so the narrowing is
	// asserted here rather than each definition being made optional in the schema.
	self.setVariableDefinitions(defs as CompanionVariableDefinitions<VariablesSchema>)
}
