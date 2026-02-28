import type { SomeCompanionConfigField, DropdownChoice } from '@companion-module/base'
import os from 'os'
import {
	PTP_SUBDOMAIN_DEFAULT,
	PTP_SUBDOMAIN_ALT1,
	PTP_SUBDOMAIN_ALT2,
	PTP_SUBDOMAIN_ALT3,
	PTP_SUBDOMAIN_ALT4,
	type PTP_SUBDOMAINS,
} from './ptpv1.js'

export type PtpVersion = 'ptpv1' | 'ptpv2'

export interface ModuleConfig {
	interface: string
	version: PtpVersion
	domain: number
	subdomain: PTP_SUBDOMAINS
	interval: number
}

export function GetConfigFields(): SomeCompanionConfigField[] {
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
			id: 'version',
			label: 'Version',
			choices: [
				{ id: 'ptpv1', label: 'PTP v1' },
				{ id: 'ptpv2', label: 'PTP v2' },
			],
			default: 'ptpv2',
			width: 4,
		},
		{
			type: 'dropdown',
			id: 'interface',
			label: 'Interface',
			width: 8,
			choices: localNics,
			default: localNics[0].id ?? 'No available NICs',
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
			isVisibleExpression: `$(options:version) == 'ptpv2'`,
		},
		{
			type: 'dropdown',
			id: 'subdomain',
			label: 'Subdomain',
			width: 4,
			choices: [
				{ id: PTP_SUBDOMAIN_DEFAULT, label: PTP_SUBDOMAIN_DEFAULT },
				{ id: PTP_SUBDOMAIN_ALT1, label: PTP_SUBDOMAIN_ALT1 },
				{ id: PTP_SUBDOMAIN_ALT2, label: PTP_SUBDOMAIN_ALT2 },
				{ id: PTP_SUBDOMAIN_ALT3, label: PTP_SUBDOMAIN_ALT3 },
				{ id: PTP_SUBDOMAIN_ALT4, label: PTP_SUBDOMAIN_ALT4 },
			],
			default: PTP_SUBDOMAIN_DEFAULT,
			isVisibleExpression: `$(options:version) == 'ptpv1'`,
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
	]
}
