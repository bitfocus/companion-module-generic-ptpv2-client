import { InstanceBase, InstanceStatus, type SomeCompanionConfigField } from '@companion-module/base'
import { GetConfigFields, type ModuleConfig } from './config.js'
import { UpdateVariableDefinitions, type VariablesSchema } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions, type ActionsSchema } from './actions.js'
import { UpdateFeedbacks, type FeedbacksSchema } from './feedbacks.js'
import { PTPv2Client, type PtpAnnounce, type PtpFlags } from './ptpv2.js'
import { PTPv1Client } from './ptpv1.js'
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
	/**
	 * The two protocols are not versions of one another, so they get separate clients. What
	 * they share — sync state, master identity, the derived time — is reachable through this
	 * union; anything protocol-specific goes through `v2` or `v1`.
	 */
	client: PTPv2Client | PTPv1Client | undefined
	statusManager = new StatusManager(this)
	/** P2P with an unresponsive neighbour is worth saying once, not on every sync */
	private warnedNoPeerDelay = false

	/** The client when this connection is speaking PTPv2, for everything PTPv1 cannot report */
	get v2(): PTPv2Client | undefined {
		return this.client instanceof PTPv2Client ? this.client : undefined
	}

	/** The client when this connection is speaking PTPv1 */
	get v1(): PTPv1Client | undefined {
		return this.client instanceof PTPv1Client ? this.client : undefined
	}

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		this.updateActions() // export actions
		this.statusManager.updateStatus(InstanceStatus.Connecting)
		// Feedback and variable definitions depend on the protocol in use, so configUpdated
		// publishes them once the config is in hand
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

		// Which variables and feedbacks exist depends on the protocol, so they are republished
		// on every config change rather than only at init
		this.updateFeedbacks()
		this.updateVariableDefinitions()

		if (config.interface) {
			try {
				if (config.ptpVersion === 'v1') {
					const subdomain = v1Subdomain(config)
					if (subdomain === undefined) {
						this.statusManager.updateStatus(InstanceStatus.BadConfig, 'Custom subdomain name is not valid')
						this.log(
							'warn',
							`Custom subdomain "${config.customSubdomain}" is not usable: it must be 1 to 15 printable ASCII characters.`,
						)
						return
					}
					const client = new PTPv1Client(config.interface, subdomain.name, config.interval, subdomain.multicast)
					this.client = client
					this.listenForV1ClientEvents(client)
				} else {
					// The upgrade script pins pre-existing connections to 'e2e' and the config field
					// defaults new ones to 'auto', so this only guards against a config that reached
					// us without going through either
					const client = new PTPv2Client(
						config.interface,
						config.domain,
						config.interval,
						config.delayMechanism ?? 'auto',
					)
					this.client = client
					this.listenForClientEvents(client)
				}
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

	private listenForClientEvents(client: PTPv2Client): void {
		client.on('ptp_master_changed', (ptp_master, master_address, sync) => {
			this.log('info', `PTPv2 Master Changed: ${ptp_master} Address: ${master_address}`)
			this.log(sync ? 'info' : 'warn', `PTP Sync Changed. ${sync ? 'Locked' : 'Unlocked'}`)
			this.checkAllFeedbacks()
			this.setVariableValues({
				ptpMaster: ptp_master,
				ptpMasterAddress: master_address,
				ptpMasterMac: this.v2?.ptp_master_mac ?? '',
				ptpMasterOui: this.v2?.ptp_master_oui ?? '',
				ptpMasterVendor: this.v2?.ptp_master_vendor ?? '',
			})
		})
		client.on('ptp_time_synced', (time, lastSync) => {
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
		client.on('delay_mechanism_changed', (mechanism, detected) => {
			const label = this.v2?.delay_mechanism_label ?? mechanism
			this.log(
				'info',
				detected
					? `Delay mechanism detected: ${label}${mechanism === 'e2e' ? ' (no peer delay traffic seen)' : ''}`
					: `Delay mechanism: ${label}`,
			)
			this.setVariableValues({ delayMechanism: label })
			this.checkAllFeedbacks()
		})
		client.on('peer_delay_changed', (peerDelay) => {
			this.log('debug', `Peer link delay: ${peerDelay}ns`)
			this.setVariableValues({
				peerMeanPathDelay: Number(peerDelay),
				peerDelayResponding: this.v2?.peer_responding ?? false,
			})
		})
		client.on('version_changed', (version) => {
			this.log('info', `PTP version in use: ${version}${version === '2.1' ? ' (IEEE 1588-2019)' : ' (IEEE 1588-2008)'}`)
			this.setVariableValues({ ptpVersion: version })
			this.checkAllFeedbacks()
		})
		client.on('master_lost', (reason) => {
			this.log('warn', `PTP master lost: ${reason}`)
			this.statusManager.updateStatus(InstanceStatus.ConnectionFailure, reason)
			this.setVariableValues(
				announceValues(this.v2?.grandmaster, this.v2?.last_announce ?? 0, this.v2?.grandmaster_address ?? ''),
			)
			this.checkAllFeedbacks()
		})
		client.on('announce', (announce) => {
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
			this.setVariableValues(announceValues(announce, this.v2?.last_announce ?? 0, this.v2?.grandmaster_address ?? ''))
			this.checkAllFeedbacks()
		})
		client.on('flags_changed', (flags) => {
			if (flags.leap61 || flags.leap59) {
				this.log('warn', `Leap second pending: ${flags.leap61 ? '+1' : '-1'} second`)
			}
			if (!flags.timeTraceable) this.log('warn', `Grandmaster time is no longer traceable to a primary reference`)
			this.setVariableValues(flagValues(flags))
			this.checkAllFeedbacks()
		})
		client.on('sync_changed', (sync) => {
			this.log(sync ? 'info' : 'warn', `PTP Sync Changed. ${sync ? 'Locked' : 'Unlocked'}`)
			this.checkAllFeedbacks()
		})
		client.on('error', (err) => {
			this.statusManager.updateStatus(InstanceStatus.UnknownError, err.message)
			// Error has no enumerable own properties, so JSON.stringify would render every
			// real socket failure as '{}'
			this.log('warn', `Error: ${err.message}`)
		})

		client.on('close', (msg) => {
			this.log('warn', msg)
			this.statusManager.updateStatus(InstanceStatus.Disconnected)
		})
		client.on('listening', (msg) => {
			this.log('info', msg)
			this.statusManager.updateStatus(InstanceStatus.Ok)
		})
	}

	/**
	 * PTPv1 reports a strict subset of what PTPv2 does. There is no Announce message, so no
	 * grandmaster, no flag field and no path trace; and no delay mechanism to choose, since
	 * IEEE 1588-2002 defines only the end to end exchange.
	 */
	private listenForV1ClientEvents(client: PTPv1Client): void {
		client.on('ptp_master_changed', (ptp_master, master_address, sync) => {
			this.log('info', `PTPv1 Master Changed: ${ptp_master} Address: ${master_address}`)
			this.log(sync ? 'info' : 'warn', `PTP Sync Changed. ${sync ? 'Locked' : 'Unlocked'}`)
			this.checkAllFeedbacks()
			this.setVariableValues({ ptpMaster: ptp_master, ptpMasterAddress: master_address })
		})
		client.on('ptp_time_synced', (time, lastSync) => {
			const syncTime = new Date(lastSync)
			this.log('debug', `Time Synced ${time}. Timestamp of sync: ${syncTime.toISOString()}`)
			this.setVariableValues(this.sharedValues())
			this.statusManager.updateStatus(InstanceStatus.Ok)
		})
		client.on('sync_changed', (sync) => {
			this.log(sync ? 'info' : 'warn', `PTP Sync Changed. ${sync ? 'Locked' : 'Unlocked'}`)
			this.checkAllFeedbacks()
		})
		client.on('domains', (subdomains) => {
			// Two uses. A Dante device's subdomain follows its pull-up/pull-down rate, so an
			// unexpected name is a device on the wrong clock. And a Dante Domain Manager
			// network's subdomain name is not chosen by the user at all, so reading it off the
			// wire here is the only practical way to find out what to configure.
			const found = [...subdomains]
			this.log('debug', `PTPv1 subdomains heard: ${found.join(', ')}`)
			this.setVariableValues({ subdomainsFound: found })
		})
		client.on('error', (err) => {
			this.statusManager.updateStatus(InstanceStatus.UnknownError, err.message)
			this.log('warn', `Error: ${err.message}`)
		})
		client.on('close', (msg) => {
			this.log('warn', msg)
			this.statusManager.updateStatus(InstanceStatus.Disconnected)
		})
		client.on('listening', (msg) => {
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
		const client = this.v2
		if (!client || client.last_sync === 0) return {}
		const mechanism = client.delay_mechanism
		return {
			meanPathDelay: mechanism === 'e2e' ? Number(client.mean_path_delay) : undefined,
			peerMeanPathDelay:
				mechanism === 'p2p' && client.peer_responding ? Number(client.peer_mean_path_delay) : undefined,
			peerDelayResponding: client.peer_responding,
			delayMechanism: client.delay_mechanism_label,
			lastCorrection: Number(client.last_correction),
		}
	}

	/**
	 * A P2P domain whose switch port does not answer Pdelay leaves the reported time short by
	 * one link delay. That is usually sub-microsecond and often acceptable, but it is silent,
	 * so it gets said once.
	 */
	private checkPeerDelay(): void {
		if (this.warnedNoPeerDelay) return
		if (!this.v2 || this.v2.delay_mechanism !== 'p2p') return
		if (this.v2.peer_responding) return
		this.warnedNoPeerDelay = true
		this.log(
			'warn',
			`Peer to peer delay requested but the attached port is not answering Pdelay_Req. ` +
				`Reported time excludes the delay of the local link.`,
		)
	}

	/** The values both protocols can report, from whichever client is running */
	private sharedValues(): Partial<VariablesSchema> {
		if (!this.client) return {}
		const time = this.client.ptp_time
		const ptp_master = this.client.ptp_master
		const unsynced = this.client.last_sync === 0
		return {
			ptpTimeS: unsynced ? undefined : time[0],
			ptpTimeNS: unsynced ? undefined : time[1],
			ptpTime: unsynced ? undefined : this.client.ptp_time_n.toString(),
			lastSync: unsynced ? '' : new Date(this.client.last_sync).toISOString(),
			ptpMaster: ptp_master[0],
			ptpMasterAddress: ptp_master[1],
		}
	}

	private getVarValues(): void {
		const v1 = this.v1
		if (v1) {
			this.setVariableValues({
				...this.sharedValues(),
				// IEEE 1588-2002 has no minor version to report
				ptpVersion: '1.0',
				subdomain: v1.ptp_subdomain,
				subdomainsFound: [...v1.subdomains],
			})
			this.checkAllFeedbacks()
			return
		}
		const v2 = this.v2
		if (!v2) return
		this.setVariableValues({
			...this.sharedValues(),
			ptpMasterMac: v2.ptp_master_mac ?? '',
			ptpMasterOui: v2.ptp_master_oui,
			ptpMasterVendor: v2.ptp_master_vendor ?? '',
			ptpVersion: v2.ptp_version,
			delayMechanism: v2.delay_mechanism_label,
			peerDelayResponding: v2.peer_responding,
			...this.measurementValues(),
			...announceValues(v2.grandmaster, v2.last_announce, v2.grandmaster_address),
			...flagValues(v2.ptp_flags),
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
 * The subdomain name and multicast group a PTPv1 connection should actually use.
 *
 * A well-known name carries its own group; a custom one has to be told which group it lives
 * on. Returns undefined when the custom name is unusable — the config field's regex only
 * advises the user, it does not prevent the value being stored, so it is checked again here.
 */
function v1Subdomain(config: ModuleConfig): { name: string; multicast?: string } | undefined {
	if (config.subdomain !== 'custom') return { name: config.subdomain ?? '_DFLT' }
	const name = config.customSubdomain ?? ''
	if (!/^[\x20-\x7E]{1,15}$/.test(name)) return undefined
	return { name, multicast: config.customSubdomainGroup ?? '224.0.1.130' }
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
