import { InstanceBase, runEntrypoint, InstanceStatus, SomeCompanionConfigField } from '@companion-module/base'
import { GetConfigFields, type ModuleConfig } from './config.js'
import { UpdateVariableDefinitions } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'
import { PTPv1Client } from './ptpv1.js'
import { PTPv2Client } from './ptpv2.js'
import { StatusManager } from './status.js'
export class ModuleInstance extends InstanceBase<ModuleConfig> {
	config!: ModuleConfig // Setup in init()
	client!: PTPv1Client | PTPv2Client
	statusManager = new StatusManager(this)
	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		this.config = config
		this.statusManager.updateStatus(InstanceStatus.Connecting)
		this.configUpdated(config).catch(() => {})
	}
	// When module gets deleted
	async destroy(): Promise<void> {
		this.log('debug', `destroy ${this.id}`)
		this.client.destroy()
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		this.log('info', `Config Updated: ${this.id}: ${this.label}`)
		this.log('debug', JSON.stringify(config))
		this.config = config

		if (this.client) this.client.destroy()

		if (config.interface) {
			try {
				switch (config?.version) {
					case 'ptpv1':
						this.log('info', `Initialising PTPv1 client. On: ${config.interface}, subdomain: ${config.subdomain}`)
						this.client = new PTPv1Client(config.interface, config.subdomain, config.interval)
						break
					case 'ptpv2':
					default:
						this.log('info', `Initialising PTPv2 client. On: ${config.interface}, domain: ${config.domain}`)
						this.client = new PTPv2Client(config.interface, config.domain, config.interval)
				}
				this.listenForClientEvents()
				this.getVarValues()
				this.updateActions() // export actions
				this.updateFeedbacks() // export feedbacks
				this.updateVariableDefinitions() // export variable definitions
			} catch (e) {
				this.statusManager.updateStatus(InstanceStatus.UnknownError)
				this.log('error', `Could not initialise PTP client ${e instanceof Error ? e.message : e}`)
			}
		} else {
			this.statusManager.updateStatus(InstanceStatus.BadConfig)
		}
	}

	private listenForClientEvents(): void {
		this.client.on('ptp_master_changed', (ptp_master, master_address, sync) => {
			this.log('info', `PTP Master Changed: ${ptp_master} Address: ${master_address}`)
			this.log(sync ? 'info' : 'warn', `PTP Sync Changed. ${sync ? 'Locked' : 'Unlocked'}`)
			this.checkFeedbacks()
			this.setVariableValues({ ptpMaster: ptp_master, ptpMasterAddress: master_address })
		})
		this.client.on('ptp_time_synced', (time, lastSync) => {
			const syncTime = new Date(lastSync)
			this.log('debug', `Time Synced ${time}. Timestamp of sync: ${syncTime.toISOString()}`)
			this.setVariableValues({ ptpTimeS: time[0], ptpTimeNS: time[1], lastSync: syncTime.toISOString() })
			this.statusManager.updateStatus(InstanceStatus.Ok)
		})
		this.client.on('sync_changed', (sync) => {
			this.log(sync ? 'info' : 'warn', `PTP Sync Changed. ${sync ? 'Locked' : 'Unlocked'}`)
			this.checkFeedbacks()
		})
		this.client.on('error', (err) => {
			this.statusManager.updateStatus(InstanceStatus.UnknownError)
			this.log('warn', `Error: ${JSON.stringify(err)}`)
		})

		this.client.on('close', (msg) => {
			this.log('warn', msg)
			this.statusManager.updateStatus(InstanceStatus.Disconnected)
		})
		this.client.on('listening', (msg) => {
			this.log('info', msg)
			this.statusManager.updateStatus(
				InstanceStatus.Ok,
				`Listening for ${this.config.version == 'ptpv1' ? 'PTPv1' : 'PTPv2'} on ${this.config.interface}`,
			)
		})
	}

	private getVarValues() {
		const time = this.client.ptp_time
		const ptp_master = this.client.ptp_master
		const syncTime = new Date(this.client.last_sync)
		this.setVariableValues({
			ptpTimeS: this.client.last_sync == 0 ? undefined : time[0],
			ptpTimeNS: this.client.last_sync == 0 ? undefined : time[1],
			lastSync: this.client.last_sync == 0 ? '' : syncTime.toISOString(),
			ptpMaster: ptp_master[0],
			ptpMasterAddress: ptp_master[1],
		})
		this.checkFeedbacks()
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

runEntrypoint(ModuleInstance, UpgradeScripts)
