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
	public sync = false
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
		this.log('debug', 'destroy')
		this.client.destroy()
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		this.config = config
		process.title = this.label

		if (this.client) this.client.destroy()

		this.client = new PTPv2Client()
		if (config.interface) {
			this.client.init(config.interface, config.domain)
			this.listenForClientEvents()
			this.getVarValues()
			this.updateStatus(InstanceStatus.Ok)
		} else {
			this.updateStatus(InstanceStatus.BadConfig)
		}
	}

	private listenForClientEvents(): void {
		this.client.on('ptp_master_changed', (ptp_master, sync) => {
			this.log('info', `PTPv2 Master Changed: ${ptp_master}`)
			this.log(sync ? 'info' : 'warn', `PTP Sync Changed. ${sync ? 'Locked' : 'Unlocked'}`)
			this.sync = sync
			this.checkFeedbacks()
			this.setVariableValues({ ptpMaster: ptp_master })
		})
		this.client.on('ptp_time_synced', (time, lastSync) => {
			this.log('info', `Time Synced ${time}`)
			const syncTime = new Date(lastSync)
			this.setVariableValues({ ptpTimeS: time[0], ptpTimeNS: time[1], lastSync: syncTime.toISOString() })
		})
		this.client.on('sync_changed', (sync) => {
			this.log(sync ? 'info' : 'warn', `PTP Sync Changed. ${sync ? 'Locked' : 'Unlocked'}`)
			this.sync = sync
			this.checkFeedbacks()
		})
	}

	private getVarValues() {
		const time = this.client.ptp_time
		const ptp_master = this.client.ptp_master
		const syncTime = new Date(this.client.last_sync)
		this.sync = this.client.is_synced
		this.setVariableValues({
			ptpTimeS: time[0],
			ptpTimeNS: time[1],
			lastSync: syncTime.toISOString(),
			ptpMaster: ptp_master,
		})
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
