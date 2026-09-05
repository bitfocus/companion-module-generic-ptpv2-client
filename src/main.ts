import { InstanceBase, InstanceStatus, type SomeCompanionConfigField } from '@companion-module/base'
import { GetConfigFields, type ModuleConfig } from './config.js'
import { UpdateVariableDefinitions, type VariablesSchema } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions, type ActionsSchema } from './actions.js'
import { UpdateFeedbacks, type FeedbacksSchema } from './feedbacks.js'
import { PTPv2Client, type PtpAnnounce, type PtpFlags } from './ptpv2.js'
import { StatusManager } from './status.js'

export type ModuleSchema = {
	config: ModuleConfig
	secrets: undefined
	actions: ActionsSchema
	feedbacks: FeedbacksSchema
	variables: VariablesSchema
}

export { UpgradeScripts }

export default class ModuleInstance extends InstanceBase<ModuleSchema> {
	config!: ModuleConfig // Setup in init()
	client: PTPv2Client | undefined
	statusManager = new StatusManager(this)
	/** P2P with an unresponsive neighbour is worth saying once, not on every sync */
	private warnedNoPeerDelay = false

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		this.updateActions() // export actions
		this.updateFeedbacks() // export feedbacks
		this.updateVariableDefinitions() // export variable definitions
		this.statusManager.updateStatus(InstanceStatus.Connecting)
		void this.configUpdated(config)
	}
	// When module gets deleted
	async destroy(): Promise<void> {
		this.log('debug', `destroy ${this.id}:${this.label}`)
		this.client?.destroy()
		this.client = undefined
		this.statusManager.destroy()
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		this.config = config
		process.title = this.label

		this.client?.destroy()
		this.client = undefined
		this.warnedNoPeerDelay = false

		if (config.interface) {
			try {
				// The upgrade script pins pre-existing connections to 'e2e' and the config field
				// defaults new ones to 'auto', so this only guards against a config that reached
				// us without going through either
				this.client = new PTPv2Client(config.interface, config.domain, config.interval, config.delayMechanism ?? 'auto')
				this.listenForClientEvents()
				this.getVarValues()
				this.statusManager.updateStatus(InstanceStatus.Ok)
			} catch (e) {
				this.statusManager.updateStatus(InstanceStatus.UnknownError)
				this.log('warn', `Could not initialise PTP client ${e}`)
			}
		} else {
			this.statusManager.updateStatus(InstanceStatus.BadConfig)
		}
	}

	private listenForClientEvents(): void {
		if (!this.client) return
		this.client.on('ptp_master_changed', (ptp_master, master_address, sync) => {
			this.log('info', `PTPv2 Master Changed: ${ptp_master} Address: ${master_address}`)
			this.log(sync ? 'info' : 'warn', `PTP Sync Changed. ${sync ? 'Locked' : 'Unlocked'}`)
			this.checkAllFeedbacks()
			this.setVariableValues({
				ptpMaster: ptp_master,
				ptpMasterAddress: master_address,
				ptpMasterMac: this.client?.ptp_master_mac ?? '',
				ptpMasterOui: this.client?.ptp_master_oui ?? '',
				ptpMasterVendor: this.client?.ptp_master_vendor ?? '',
			})
		})
		this.client.on('ptp_time_synced', (time, lastSync) => {
			const syncTime = new Date(lastSync)
			this.log('debug', `Time Synced ${time}. Timestamp of sync: ${syncTime.toISOString()}`)
			this.setVariableValues({
				ptpTimeS: time[0],
				ptpTimeNS: time[1],
				ptpTime: this.client?.ptp_time_n.toString(),
				lastSync: syncTime.toISOString(),
				...this.measurementValues(),
			})
			this.statusManager.updateStatus(InstanceStatus.Ok)
			this.checkPeerDelay()
		})
		this.client.on('delay_mechanism_changed', (mechanism, detected) => {
			const label = this.client?.delay_mechanism_label ?? mechanism
			this.log(
				'info',
				detected
					? `Delay mechanism detected: ${label}${mechanism === 'e2e' ? ' (no peer delay traffic seen)' : ''}`
					: `Delay mechanism: ${label}`,
			)
			this.setVariableValues({ delayMechanism: label })
			this.checkAllFeedbacks()
		})
		this.client.on('peer_delay_changed', (peerDelay) => {
			this.log('debug', `Peer link delay: ${peerDelay}ns`)
			this.setVariableValues({
				peerMeanPathDelay: Number(peerDelay),
				peerDelayResponding: this.client?.peer_responding ?? false,
			})
		})
		this.client.on('version_changed', (version) => {
			this.log('info', `PTP version in use: ${version}${version === '2.1' ? ' (IEEE 1588-2019)' : ' (IEEE 1588-2008)'}`)
			this.setVariableValues({ ptpVersion: version })
			this.checkAllFeedbacks()
		})
		this.client.on('master_lost', (reason) => {
			this.log('warn', `PTP master lost: ${reason}`)
			this.statusManager.updateStatus(InstanceStatus.ConnectionFailure, reason)
			this.setVariableValues(
				announceValues(
					this.client?.grandmaster,
					this.client?.last_announce ?? 0,
					this.client?.grandmaster_address ?? '',
				),
			)
			this.checkAllFeedbacks()
		})
		this.client.on('announce', (announce) => {
			this.log(
				'info',
				`Grandmaster: ${announce.grandmasterIdentity}${announce.grandmasterVendor ? ` [${announce.grandmasterVendor}]` : ''} ` +
					`(${announce.clockClassLabel}, ${announce.timeSourceLabel}), ` +
					`${announce.stepsRemoved} step(s) removed`,
			)
			if (announce.pathTrace.length > 0) this.log('debug', `Path: ${announce.pathTrace.join(' > ')}`)
			if (announce.pathTraceLoop) {
				this.log('warn', `Path trace contains a repeated clock identity, indicating a loop in the PTP network`)
			}
			this.setVariableValues(
				announceValues(announce, this.client?.last_announce ?? 0, this.client?.grandmaster_address ?? ''),
			)
			this.checkAllFeedbacks()
		})
		this.client.on('flags_changed', (flags) => {
			if (flags.leap61 || flags.leap59) {
				this.log('warn', `Leap second pending: ${flags.leap61 ? '+1' : '-1'} second`)
			}
			if (!flags.timeTraceable) this.log('warn', `Grandmaster time is no longer traceable to a primary reference`)
			this.setVariableValues(flagValues(flags))
			this.checkAllFeedbacks()
		})
		this.client.on('sync_changed', (sync) => {
			this.log(sync ? 'info' : 'warn', `PTP Sync Changed. ${sync ? 'Locked' : 'Unlocked'}`)
			this.checkAllFeedbacks()
		})
		this.client.on('error', (err) => {
			this.statusManager.updateStatus(InstanceStatus.UnknownError, err.message)
			// Error has no enumerable own properties, so JSON.stringify would render every
			// real socket failure as '{}'
			this.log('warn', `Error: ${err.message}`)
		})

		this.client.on('close', (msg) => {
			this.log('warn', msg)
			this.statusManager.updateStatus(InstanceStatus.Disconnected)
		})
		this.client.on('listening', (msg) => {
			this.log('info', msg)
			this.statusManager.updateStatus(InstanceStatus.Ok)
		})
	}

	/**
	 * The per-exchange measurement quality figures, as plain numbers for Companion.
	 *
	 * Mean path delay is only ever measured by the end to end exchange. Reporting the
	 * untouched zero of the other mechanisms as though it were a measurement would read as a
	 * perfect path rather than as no measurement at all, so it is left undefined instead.
	 */
	private measurementValues(): Partial<VariablesSchema> {
		if (!this.client || this.client.last_sync === 0) return {}
		const mechanism = this.client.delay_mechanism
		return {
			meanPathDelay: mechanism === 'e2e' ? Number(this.client.mean_path_delay) : undefined,
			peerMeanPathDelay:
				mechanism === 'p2p' && this.client.peer_responding ? Number(this.client.peer_mean_path_delay) : undefined,
			peerDelayResponding: this.client.peer_responding,
			delayMechanism: this.client.delay_mechanism_label,
			lastCorrection: Number(this.client.last_correction),
		}
	}

	/**
	 * A P2P domain whose switch port does not answer Pdelay leaves the reported time short by
	 * one link delay. That is usually sub-microsecond and often acceptable, but it is silent,
	 * so it gets said once.
	 */
	private checkPeerDelay(): void {
		if (this.warnedNoPeerDelay) return
		if (!this.client || this.client.delay_mechanism !== 'p2p') return
		if (this.client.peer_responding) return
		this.warnedNoPeerDelay = true
		this.log(
			'warn',
			`Peer to peer delay requested but the attached port is not answering Pdelay_Req. ` +
				`Reported time excludes the delay of the local link.`,
		)
	}

	private getVarValues(): void {
		if (!this.client) return
		const time = this.client.ptp_time
		const ptp_master = this.client.ptp_master
		const syncTime = new Date(this.client.last_sync)
		this.setVariableValues({
			ptpTimeS: this.client.last_sync == 0 ? undefined : time[0],
			ptpTimeNS: this.client.last_sync == 0 ? undefined : time[1],
			ptpTime: this.client.last_sync == 0 ? undefined : this.client.ptp_time_n.toString(),
			lastSync: this.client.last_sync == 0 ? '' : syncTime.toISOString(),
			ptpMaster: ptp_master[0],
			ptpMasterAddress: ptp_master[1],
			ptpMasterMac: this.client.ptp_master_mac ?? '',
			ptpMasterOui: this.client.ptp_master_oui,
			ptpMasterVendor: this.client.ptp_master_vendor ?? '',
			ptpVersion: this.client.ptp_version,
			delayMechanism: this.client.delay_mechanism_label,
			peerDelayResponding: this.client.peer_responding,
			...this.measurementValues(),
			...announceValues(this.client.grandmaster, this.client.last_announce, this.client.grandmaster_address),
			...flagValues(this.client.ptp_flags),
		})
		this.checkAllFeedbacks()
	}

	// Return config fields for web config
	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	updateActions(): void {
		UpdateActions(this)
	}

	updateFeedbacks(): void {
		UpdateFeedbacks(this)
	}

	updateVariableDefinitions(): void {
		UpdateVariableDefinitions(this)
	}
}

/**
 * Announce data as Companion variables. Before the first Announce there is no grandmaster
 * to report, so the fields are blanked rather than left showing a stale one.
 */
function announceValues(
	announce: PtpAnnounce | undefined,
	lastAnnounce: number,
	grandmasterAddress: string,
): Partial<VariablesSchema> {
	if (announce === undefined) {
		return {
			grandmaster: '',
			grandmasterMac: '',
			grandmasterOui: '',
			grandmasterVendor: '',
			grandmasterAddress: '',
			grandmasterClockClass: undefined,
			grandmasterClockClassLabel: '',
			grandmasterAccuracy: '',
			grandmasterTimeSource: '',
			grandmasterPriority1: undefined,
			grandmasterPriority2: undefined,
			stepsRemoved: undefined,
			announceInterval: undefined,
			lastAnnounce: '',
			pathTrace: '',
			pathTraceHops: undefined,
			pathTraceLoop: false,
			utcOffset: undefined,
		}
	}
	return {
		grandmaster: announce.grandmasterIdentity,
		grandmasterMac: announce.grandmasterMac ?? '',
		grandmasterOui: announce.grandmasterOui,
		grandmasterVendor: announce.grandmasterVendor ?? '',
		// empty unless the Announce came straight from the grandmaster; see grandmaster_address
		grandmasterAddress,
		grandmasterClockClass: announce.clockClass,
		grandmasterClockClassLabel: announce.clockClassLabel,
		grandmasterAccuracy: announce.clockAccuracyLabel,
		grandmasterTimeSource: announce.timeSourceLabel,
		grandmasterPriority1: announce.grandmasterPriority1,
		grandmasterPriority2: announce.grandmasterPriority2,
		stepsRemoved: announce.stepsRemoved,
		// logMessageInterval is log2 of the interval in seconds, and may be negative
		announceInterval: Math.pow(2, announce.logMessageInterval),
		lastAnnounce: lastAnnounce === 0 ? '' : new Date(lastAnnounce).toISOString(),
		// grandmaster first, transmitting clock last; empty when the master emits no PATH_TRACE
		pathTrace: announce.pathTrace.join(' > '),
		pathTraceHops: announce.pathTrace.length,
		pathTraceLoop: announce.pathTraceLoop,
		utcOffset: announce.currentUtcOffset,
	}
}

/** Decoded flagField as Companion variables. */
function flagValues(flags: PtpFlags): Partial<VariablesSchema> {
	return {
		utcOffsetValid: flags.currentUtcOffsetValid,
		leapSecond: flags.leap61 ? '+1' : flags.leap59 ? '-1' : 'none',
		ptpTimescale: flags.ptpTimescale,
		timeTraceable: flags.timeTraceable,
		frequencyTraceable: flags.frequencyTraceable,
		syncUncertain: flags.synchronizationUncertain,
		twoStep: flags.twoStep,
	}
}
