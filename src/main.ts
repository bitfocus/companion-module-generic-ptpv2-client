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
		this.config = config
		process.title = this.label
		this.updateActions() // export actions
		this.updateFeedbacks() // export feedbacks
		this.updateVariableDefinitions() // export variable definitions
		this.updateStatus(InstanceStatus.Ok)
		this.client = new PTPv2Client()
		this.client.init(config.interface, config.domain)
		this.listenForClientEvents()
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
		this.client.init(config.interface, config.domain)
		this.listenForClientEvents()
	}

	listenForClientEvents(): void {
		this.client.on('ptp_master_changed', (ptp_master) => {
			this.log('info', `PTPv2 Master ${ptp_master}`)
			this.setVariableValues({ ptpMaster: ptp_master })
		})
		this.client.on('ptp_time_synced', (time) => {
			this.log('info', `Time Synced ${time}`)
			this.setVariableValues({ ptpTimeS: time[0], ptpTimeNS: time[1] })
		})
		this.client.on('sync_changed', (sync) => {
			this.log('info', `PTP Sync Changed. ${sync ? 'Locked' : 'Unlocked'}`)
			this.sync = sync
			this.checkFeedbacks()
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
