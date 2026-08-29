import type { SomeCompanionConfigField, DropdownChoice } from '@companion-module/base'
import os from 'os'

export type ModuleConfig = {
	interface: string
	domain: number
	interval: number
}

export function GetConfigFields(): SomeCompanionConfigField[] {
	const isLinuxUser = os.platform() === 'linux' && os.userInfo().username !== 'root'
	const interfaces = os.networkInterfaces()
	const localNics: DropdownChoice[] = []
	const interface_names = Object.keys(interfaces)
	interface_names.forEach((nic) => {
		if (interfaces[nic] === undefined) return
		interfaces[nic].forEach((ip) => {
			if (ip.family == 'IPv4') {
				localNics.push({ id: ip.address, label: `${nic}: ${ip.address}` })
			}
		})
	})
	return [
		{
			type: 'dropdown',
			id: 'interface',
			label: 'Interface',
			width: 8,
			choices: localNics,
			default: localNics[0]?.id ?? 'No available NICs',
		},
		{
			type: 'number',
			id: 'domain',
			label: 'Domain',
			width: 4,
			min: 0,
			max: 127,
			default: 0,
			range: true,
			step: 1,
		},
		{
			type: 'number',
			id: 'interval',
			label: 'Sync Interval (ms)',
			width: 4,
			min: 125,
			max: 30000,
			default: 10000,
		},
		{
			type: 'static-text',
			id: 'linuxPrivilegedPortWarning',
			label: 'Privileged Port Warning',
			value: `This module will attempt to bind to privileged ports 319 and 320, which requires elevated permissions on Linux. You may need to grant the Node.js binary the <code>CAP_NET_BIND_SERVICE</code> capability. You can do this with one of the following tools: <strong>setcap</strong>, <strong>authbind</strong>.`,
			width: 12,
			isVisibleExpression: `${isLinuxUser}`,
		},
	]
}
