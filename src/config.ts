import type { SomeCompanionConfigField, DropdownChoice } from '@companion-module/base'
import os from 'os'
import type { DelayMechanism } from './ptpv2.js'
import { PTP_MULTICAST_GROUPS, type PTP_SUBDOMAINS, type PtpMulticastGroup } from './ptpv1.js'

/** A well-known Dante subdomain, or the sentinel that reveals the custom name fields */
export type SubdomainChoice = PTP_SUBDOMAINS | 'custom'

/** Length and character set of a PTPv1 subdomain name, per IEEE 1588-2002 */
export const SUBDOMAIN_REGEX = '/^[\\x20-\\x7E]{1,15}$/'

export type PtpVersion = 'v2' | 'v1'

export type ModuleConfig = {
	ptpVersion: PtpVersion
	interface: string
	/** PTPv2 only */
	domain: number
	/** PTPv1 only */
	subdomain: SubdomainChoice
	/** PTPv1 only, and only when subdomain is 'custom' */
	customSubdomain: string
	customSubdomainGroup: PtpMulticastGroup
	interval: number
	/** PTPv2 only */
	delayMechanism: DelayMechanism
}

/** Referenced by the isVisibleExpression of every version-specific field below */
const isV2 = `$(options:ptpVersion) == 'v2'`
const isV1 = `$(options:ptpVersion) == 'v1'`
const isV1Custom = `${isV1} && $(options:subdomain) == 'custom'`

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
			id: 'ptpVersion',
			label: 'PTP Version',
			width: 12,
			default: 'v2',
			disableAutoExpression: true,
			choices: [
				{ id: 'v2', label: 'PTPv2 — IEEE 1588-2008 / 2019 (SMPTE ST 2059-2, AES67, gPTP)' },
				{ id: 'v1', label: 'PTPv1 — IEEE 1588-2002 (Dante)' },
			],
		},
		{
			type: 'static-text',
			id: 'ptpVersionHelp',
			label: '',
			value:
				`PTPv1 and PTPv2 are different protocols. A PTPv1 clock is invisible to a PTPv2 client and the reverse. ` +
				`Choose <strong>PTPv1</strong> for a Dante network, which uses it with a separate subdomain per sample rate family. ` +
				`Everything else in broadcast and AV is PTPv2.`,
			width: 12,
		},
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
			isVisibleExpression: isV2,
		},
		{
			type: 'dropdown',
			id: 'subdomain',
			label: 'Subdomain',
			width: 4,
			default: '_DFLT',
			isVisibleExpression: isV1,
			// Referenced by the isVisibleExpression of the custom fields below
			disableAutoExpression: true,
			// Names and addresses follow Audinate's published PTP address table.
			choices: [
				{ id: '_DFLT', label: '_DFLT — AES67 / Default (224.0.1.129)' },
				{ id: '_ALT1', label: '_ALT1 — Pull-up/down +4.1667% (224.0.1.130)' },
				{ id: '_ALT2', label: '_ALT2 — Pull-up/down +0.1% (224.0.1.131)' },
				{ id: '_ALT3', label: '_ALT3 — Pull-up/down −0.1% (224.0.1.132)' },
				{ id: '_ALT4', label: '_ALT4 — Pull-up/down −4% (224.0.1.131)' },
				{ id: 'custom', label: 'Custom…' },
			],
		},
		{
			type: 'textinput',
			id: 'customSubdomain',
			label: 'Custom Subdomain Name',
			width: 6,
			default: '',
			isVisibleExpression: isV1Custom,
			regex: SUBDOMAIN_REGEX,
			tooltip: 'Up to 15 printable ASCII characters, exactly as the devices send it — the match is case sensitive.',
		},
		{
			type: 'dropdown',
			id: 'customSubdomainGroup',
			label: 'Custom Subdomain Multicast Group',
			width: 6,
			default: '224.0.1.130',
			isVisibleExpression: isV1Custom,
			choices: PTP_MULTICAST_GROUPS.map((group) => ({ id: group, label: group })),
			tooltip: 'Which group the devices send on. Audinate maps custom names onto one of the three alternates.',
		},
		{
			type: 'static-text',
			id: 'customSubdomainHelp',
			label: '',
			isVisibleExpression: isV1Custom,
			value:
				`A Dante Domain Manager network can be given any subdomain name, and Audinate maps it onto 224.0.1.130, .131 or .132 by a rule it does not publish — ` +
				`so the group cannot be worked out from the name and has to be set here. ` +
				`Read both off a packet capture: the name is the 16-byte field at offset 4 of any PTPv1 packet, and the group is the destination address it was sent to. ` +
				`Getting the group wrong means hearing nothing at all; getting the name wrong means hearing the traffic and discarding it.`,
			width: 12,
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
			isVisibleExpression: isV2,
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
			isVisibleExpression: isV2,
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
