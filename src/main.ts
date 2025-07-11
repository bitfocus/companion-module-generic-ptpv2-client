import { InstanceBase, runEntrypoint, InstanceStatus, SomeCompanionConfigField } from '@companion-module/base'
import { GetConfigFields, type ModuleConfig } from './config.js'
import { UpdateVariableDefinitions } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'
import { PTPv2Client } from './ptpv2.js'
export class ModuleInstance extends InstanceBase<ModuleConfig> {
	config!: ModuleConfig // Setup in init()
	client!: PTPv2Client
	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		this.updateActions() // export actions
		this.updateFeedbacks() // export feedbacks
		this.updateVariableDefinitions() // export variable definitions
		this.updateStatus(InstanceStatus.Connecting)
		this.configUpdated(config).catch(() => {})
	}
	// When module gets deleted
	async destroy(): Promise<void> {
		this.log('debug', `destroy ${this.id}`)
		this.client.destroy()
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		this.config = config
		process.title = this.label

		if (this.client) this.client.destroy()

		if (config.interface) {
			try {
				this.client = new PTPv2Client()
				this.client.init(config.interface, config.domain, config.interval)
				this.listenForClientEvents()
				this.getVarValues()
				this.updateStatus(InstanceStatus.Ok)
			} catch (e) {
				this.updateStatus(InstanceStatus.UnknownError)
				this.log('warn', `Could not initialise PTP client ${e}`)
			}
		} else {
			this.updateStatus(InstanceStatus.BadConfig)
		}
	}

	private listenForClientEvents(): void {
		this.client.on('ptp_master_changed', (ptp_master, master_address, sync) => {
			this.log('info', `PTPv2 Master Changed: ${ptp_master} Address: ${master_address}`)
			this.log(sync ? 'info' : 'warn', `PTP Sync Changed. ${sync ? 'Locked' : 'Unlocked'}`)
			this.checkFeedbacks()
			this.setVariableValues({ ptpMaster: ptp_master, ptpMasterAddress: master_address })
		})
		this.client.on('ptp_time_synced', (time, lastSync) => {
			const syncTime = new Date(lastSync)
			this.log('info', `Time Synced ${time}. Timestemp of sync: ${syncTime.toISOString()}`)
			this.setVariableValues({ ptpTimeS: time[0], ptpTimeNS: time[1], lastSync: syncTime.toISOString() })
		})
		this.client.on('sync_changed', (sync) => {
			this.log(sync ? 'info' : 'warn', `PTP Sync Changed. ${sync ? 'Locked' : 'Unlocked'}`)
			this.checkFeedbacks()
		})
		this.client.on('error', (err) => {
			if (typeof err == 'string') {
				this.log('warn', `Error binding to ports. ${err}`)
				this.updateStatus(InstanceStatus.UnknownError)
			} else {
				this.log('warn', `Message send failure: ${JSON.stringify(err)}`)
			}
		})

		this.client.on('close', (msg) => {
			this.log('warn', msg)
			this.updateStatus(InstanceStatus.Disconnected)
		})
		this.client.on('listening', (msg) => {
			this.log('info', msg)
			this.updateStatus(InstanceStatus.Ok)
		})
	}

	private getVarValues() {
		const time = this.client.ptp_time
		const ptp_master = this.client.ptp_master
		const syncTime = new Date(this.client.last_sync)
		this.setVariableValues({
			ptpTimeS: time[0],
			ptpTimeNS: time[1],
			lastSync: syncTime.toISOString(),
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
