import type { SomeCompanionConfigField, DropdownChoice } from '@companion-module/base'
import os from 'os'
import type { DelayMechanism } from './ptpv2.js'

export type ModuleConfig = {
	interface: string
	domain: number
	interval: number
	delayMechanism: DelayMechanism
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
			type: 'dropdown',
			id: 'delayMechanism',
			label: 'Delay Mechanism',
			width: 12,
			default: 'auto',
			choices: [
				{ id: 'auto', label: 'Auto — detect peer delay, otherwise end to end' },
				{ id: 'e2e', label: 'End to End (E2E) — SMPTE ST 2059-2, AES67' },
				{ id: 'p2p', label: 'Peer to Peer (P2P) — IEEE 802.1AS / gPTP, AVB, Milan' },
				{ id: 'passive', label: 'Passive — listen only, never transmit' },
			],
		},
		{
			type: 'static-text',
			id: 'delayMechanismHelp',
			label: '',
			value:
				`The delay mechanism must match the one your grandmaster is configured for — the standard forbids mixing them on one path. ` +
				`<strong>Auto</strong> listens for peer delay traffic before transmitting anything, and falls back to end to end if it hears none. ` +
				`Because peer delay is link-local, it is only visible when the switch port you are plugged into is itself a peer delay responder, ` +
				`so on a P2P network behind a switch that is not, choose <strong>P2P</strong> or <strong>Passive</strong> explicitly. ` +
				`<strong>Passive</strong> transmits nothing at all and takes the path delay from the Sync correction field, which on a P2P network ` +
				`is accurate to within the delay of your own link — normally well under a microsecond.`,
			width: 12,
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
