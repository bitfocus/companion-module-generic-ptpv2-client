import type { SomeCompanionConfigField, DropdownChoice } from '@companion-module/base'
import os from 'os'
import {
	PTP_SUBDOMAIN_DEFAULT,
	PTP_SUBDOMAIN_ALT1,
	PTP_SUBDOMAIN_ALT2,
	PTP_SUBDOMAIN_ALT3,
	PTP_SUBDOMAIN_ALT4,
	PTP_MULTICAST,
	type PTP_SUBDOMAINS,
} from './ptpv1.js'

import { PTP_PRIMARY_MULTICAST, ptpDedicatedMulticastAddrs } from './ptpv2.js'

export type PtpVersion = 'ptpv1' | 'ptpv2'

export interface ModuleConfig {
	interface: string
	version: PtpVersion
	domain: number
	subdomain: PTP_SUBDOMAINS
	interval: number
}

const ptpv2MulticastFields = (): SomeCompanionConfigField[] => {
	const fields: SomeCompanionConfigField[] = []

	// Dedicated addresses for domains 1, 2, 3
	for (const [domain, address] of Object.entries(ptpDedicatedMulticastAddrs)) {
		if (domain === '0') continue // handled separately below with the 4-127 range
		fields.push({
			type: 'static-text',
			id: `multicast_ptpv2_domain${domain}`,
			label: 'Multicast Group',
			value: address,
			width: 4,
			isVisibleExpression: `$(options:version) == 'ptpv2' && $(options:domain) == ${domain}`,
		})
	}

	// Domain 0 and 4–127 all use 224.0.1.129
	fields.push({
		type: 'static-text',
		id: 'multicast_ptpv2_domain0_or_high',
		label: 'Multicast Group',
		value: PTP_PRIMARY_MULTICAST,
		width: 4,
		isVisibleExpression: `$(options:version) == 'ptpv2' && ($(options:domain) == 0 || $(options:domain) >= 4)`,
	})

	return fields
}

// Generate one static-text field per PTPv1 subdomain from PTP_MULTICAST.
const ptpv1MulticastFields = (): SomeCompanionConfigField[] =>
	(Object.entries(PTP_MULTICAST) as [PTP_SUBDOMAINS, string][]).map(([subdomain, address]) => ({
		type: 'static-text' as const,
		id: `multicast_ptpv1_${subdomain.replace(/[^a-z0-9]/gi, '_')}`,
		label: 'Multicast Group',
		value: address,
		width: 4,
		isVisibleExpression: `$(options:version) == 'ptpv1' && $(options:subdomain) == '${subdomain}'`,
	}))

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
			id: 'interface',
			label: 'Interface',
			width: 8,
			choices: localNics,
			default: localNics[0].id ?? 'No available NICs',
		},
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
			type: 'number',
			id: 'domain',
			label: 'Domain',
			width: 4,
			min: 0,
			max: 127,
			default: 0,
			range: false,
			step: 1,
			isVisibleExpression: `$(options:version) == 'ptpv2'`,
			description: '1 to 127',
		},
		...ptpv2MulticastFields(),
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
		...ptpv1MulticastFields(),
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
