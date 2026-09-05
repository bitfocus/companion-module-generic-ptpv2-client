# PTPv2 Client

Utility module for monitoring PTPv2 (IEEE 1588-2008 / IEEE 1588-2019) or PTPv1 (IEEE 1588-2002) on a network the Companion instance is connected to. It is a **passive monitor**: it observes the PTP traffic on the selected interface and reports what the grandmaster is advertising. It does **not** discipline the host system clock, and it does not participate in the Best Master Clock Algorithm.

For detailed protocol-level diagnostics consider Meinberg's PTP Track Hound.

## Standards support

Both **IEEE 1588-2008** (PTP v2.0) and **IEEE 1588-2019** (PTP v2.1) masters are supported. The version in use is reported by the `ptpVersion` variable as `2.0` or `2.1`.

The two are wire-compatible for everything this module reads. 2019 redefines several fields that 2008 reserved — the upper nibble of byte 1 became `minorVersionPTP`, the upper nibble of byte 0 became `majorSdoId`, and the flag field gained `synchronizationUncertain` — all of which are handled. The module identifies itself as v2.0 in the Delay Requests it sends, which 2019 masters accept.

### PTPv1

**PTPv1 and PTPv2 are different protocols** The packet layouts differ, the message type numbering differs, and neither can see the other's traffic.

PTPv1 is what **Dante** uses by default. It has no domain number; it selects a clock domain by a 16-byte **subdomain name** carried in every packet. Dante runs a separate subdomain per pull-up/pull-down rate so that devices at different rates cannot disturb one another. The addresses below are from Audinate's published [PTP IP addresses used by Dante](https://support.getdante.com/hc/en-gb/articles/5508292415903-PTP-IP-addresses-used-by-Dante):

| Subdomain | Multicast   | Dante clock configuration |
| --------- | ----------- | ------------------------- |
| `_DFLT`   | 224.0.1.129 | AES67 / Default           |
| `_ALT1`   | 224.0.1.130 | Pull-up/down +4.1667%     |
| `_ALT2`   | 224.0.1.131 | Pull-up/down +0.1%        |
| `_ALT3`   | 224.0.1.132 | Pull-up/down −0.1%        |
| `_ALT4`   | 224.0.1.131 | Pull-up/down −4%          |

Subdomains seen on the wire are recorded even when the connection is not listening to them.

### Custom subdomains

**Dante Domain Manager** networks can be given any subdomain name, for example `H~O$L`. Audinate maps such a name onto 224.0.1.130, .131 or .132 by a rule it does not publish, so the group cannot be worked out from the name.

Selecting **Custom…** in the Subdomain dropdown reveals two further settings:

| Setting                          | Description                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Custom Subdomain Name            | Up to 15 printable ASCII characters, matched exactly and case sensitively against the name field in every packet. |
| Custom Subdomain Multicast Group | Which of the four PTPv1 groups the devices actually send on.                                                      |

`$(ptp:subdomainsFound)` lists every subdomain name heard on the group the connection has joined, **including domains it is not listening to**, so the module will tell you the name itself:

1. Select **Custom…**, set the group to 224.0.1.130 and leave any name in the name field.
2. Read `$(ptp:subdomainsFound)`. If it stays empty, nothing on that group is transmitting — try 224.0.1.131, then .132.
3. Once a name appears, copy it into **Custom Subdomain Name** exactly as shown. The match is case sensitive.

The two failure modes look quite different, which makes them easy to tell apart. **Wrong group:** nothing arrives at all and `subdomainsFound` stays empty. **Wrong name:** the traffic arrives and is discarded, so the connection stays unsynced but the real name is listed in `subdomainsFound` — copy it from there.

PTPv1 reports less than PTPv2, and the module publishes only what it can populate.

## Requirements

The module joins the PTP multicast group and binds to UDP ports **319** (event) and **320** (general). Unless the delay mechanism is set to End to End it also joins the peer delay group 224.0.0.107. Both are privileged ports: on Linux the Node.js binary needs permission to bind them — grant `CAP_NET_BIND_SERVICE` with `setcap`, or use `authbind`. Companion installs multiple Node.js binaries, make sure to grant the permissions to the `v26` binary used by modules.

## Configuration

| Setting            | Description                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PTP Version        | `PTPv2` (IEEE 1588-2008/2019) or `PTPv1` (IEEE 1588-2002, Dante). Changing this changes which of the settings below apply, and which variables and feedbacks exist.                         |
| Interface          | The local IPv4 interface to monitor. This selects which interface joins the multicast group; the sockets themselves bind to all interfaces, which is required to receive multicast traffic. |
| Domain             | PTP domain to monitor, 0–127. Every domain shares the multicast address 224.0.1.129 and is separated by the domain byte in the packet.                                                      |
| Sync Interval (ms) | How often this module takes a measurement, 125–30000 ms. This is a rate limit on **our own** traffic, not a property of the master, and it does not affect how sync loss is detected.       |
| Subdomain          | **PTPv1 only.** The subdomain name to listen on. See the table above for which Dante sample rate family each one carries.                                                                   |
| Delay Mechanism    | **PTPv2 only.** How path delay is established: `Auto`, `End to End`, `Peer to Peer`, or `Passive`. See below. PTPv1 has only the end to end exchange.                                       |

## Delay mechanism

> Applies to **PTPv2 only**. IEEE 1588-2002 defines only the end to end exchange, so a PTPv1 connection always uses it and the setting is hidden.

A Sync message tells you when the master sent it, not when it arrived. Turning that into an offset requires knowing how long it spent on the wire, and PTP defines two entirely different ways of finding out. **The two must not be mixed on one path**, which is why this is a setting rather than something the module simply does.

| Mechanism        | What it does                                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **End to End**   | Exchanges Delay_Req/Delay_Resp with the master to measure the whole path. The IEEE 1588 default, and what **SMPTE ST 2059-2** and **AES67** require.                                                     |
| **Peer to Peer** | Measures only the link to the directly attached switch with a Pdelay exchange; the rest of the path arrives already summed in the `correctionField`. Required by **IEEE 802.1AS / gPTP**, AVB and Milan. |
| **Passive**      | Transmits nothing whatsoever. Takes the path from the `correctionField` and treats the local link as free.                                                                                               |
| **Auto**         | Listens first, then settles on Peer to Peer or End to End. The default.                                                                                                                                  |

The mechanism actually in use is reported by `$(ptp:delayMechanism)` and logged when it is decided.

### Choosing one

If you know what the network runs set it explicitly. Otherwise leave it on **Auto**.

**Auto** transmits nothing until it has decided. Peer delay traffic on the domain is conclusive proof of a Peer to Peer network, so hearing any settles the question immediately; hearing none for four seconds is taken as End to End.

That inference is one-sided. Peer delay is **link-local** — sent to 224.0.0.107, which no router forwards — so the only device whose peer delay you can ever hear is the one on the other end of your own cable. On a Peer to Peer network where the switch port you are plugged into is not itself a peer delay responder, there is nothing to hear, and Auto will wrongly settle on End to End. **If a Peer to Peer network reports no PTP time, set the mechanism to Peer to Peer or Passive explicitly.**

### Peer to Peer without a responding neighbour

A neighbour that does not answer `Pdelay_Req` is not a failure. The module still syncs, using the `correctionField` exactly as Passive does, and simply leaves the local link unaccounted for — the reported time is then behind by one link delay, normally well under a microsecond on copper. `$(ptp:peerDelayResponding)` reports whether the neighbour is answering, and the condition is logged once as a warning.

Note that `$(ptp:peerMeanPathDelay)` is the delay of **your own link only**, not the distance to the grandmaster. In a Peer to Peer network there is no single figure for the latter — that is precisely what the `correctionField` accumulates on the way.

## How synchronisation is measured

From the timestamps of an exchange the module derives:

- **Offset** — how far the local clock is from the master, used to produce the PTP Time variables.
- **Mean path delay** — the network transit time to the master. **End to End only**; the other mechanisms never measure it and leave the variable empty rather than reporting a zero that would read as a perfect path.

The `correctionField` of every Sync, Follow_Up and Delay_Response is applied, so residence time accumulated by transparent clocks (most PTP-aware switches) is accounted for rather than appearing as offset error. In a Peer to Peer network that same field is where the entire path delay arrives.

Each Delay Response and Pdelay Response is matched against this client's own clock identity, so responses addressed to other slaves on the network are ignored. A peer delay measurement that comes out negative, or larger than 100 ms, is discarded rather than folded into the offset.

## Loss of sync

Sync loss follows the receipt timeouts defined by IEEE 1588-2008 §7.7.3.1. A timeout is a multiple of the interval the master advertises in its `logMessageInterval` field, so a master sending 8 Sync messages per second is declared lost far sooner than one sending every 2 seconds.

| Timeout                  | Value                                | Effect                                              |
| ------------------------ | ------------------------------------ | --------------------------------------------------- |
| Sync receipt timeout     | 3 × the advertised Sync interval     | Sync is dropped                                     |
| Announce receipt timeout | 3 × the advertised Announce interval | Sync is dropped and the grandmaster data is cleared |

Both multipliers are 3, the IEEE 1588 default for `announceReceiptTimeout` (the standard requires at least 2).

Until a master has been heard from, the defaults are a 1 second Sync interval and a 2 second Announce interval. An advertised interval is clamped to between ~7.8 ms and 16 seconds so that a malformed value cannot produce an unusable timer.

## Master versus grandmaster

- **PTP Master** is the port that sent the Sync message, shown as `clock-identity:portNumber`. Behind a boundary clock this is the boundary clock, not the source of time.
- **Grandmaster** is the actual source of time, taken from Announce messages. **Steps Removed** gives the number of boundary clocks between this host and it — `0` means the grandmaster is being heard directly.

### Identifying a device beyond its clock identity

**MAC address.** A clock identity is usually an EUI-64 derived from the device's MAC by inserting `FF:FE` in the middle (IEEE 1588 §7.5.2.2.2), so the MAC can be recovered from it. Identity `00:1b:19:ff:fe:12:34:56` gives MAC `00:1b:19:12:34:56`. Where a device uses a configured or randomly generated identity there is no `FF:FE` marker and no MAC to recover, and the variable is left empty.

**Manufacturer.** The first three bytes are the manufacturer's IEEE-assigned block, reported as hex in `grandmasterOui`, and resolved to a name in `grandmasterVendor` where the block is one the module carries.

The bundled table is filtered from the public OUI Master Database to the vendors plausible on a broadcast, AV, audio, network or data centre PTP network.

**Path trace.** Where the grandmaster emits a `PATH_TRACE` TLV (IEEE 1588-2019 §16.2), the Announce carries the clock identity of every clock it passed through, grandmaster first and the transmitting clock last. This gives the exact chain of boundary clocks between the source of time and this host, which `Steps Removed` only counts. Path trace is optional and disabled by default on many grandmasters, so `pathTrace` is often empty; when it is, `Steps Removed` remains the best available measure of distance.

A clock identity appearing twice in the chain means the Announce travelled a loop, which `pathTraceLoop` reports and the _Path Trace Loop Detected_ feedback flags.

**IP address.** PTP carries no field for the grandmaster's address. All that is ever available is the source address of the packet that arrived, which is the grandmaster only when it sent the Announce itself. `grandmasterAddress` is therefore populated only when **Steps Removed is 0**, and is empty otherwise; behind a boundary clock the address you can see belongs to that boundary clock and is reported as `ptpMasterAddress`.

## Feedbacks

| Feedback                           | Description                                                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| PTP Synced                         | True while a measurement has completed and Sync messages are still arriving.                                                     |
| Time Traceable                     | True while the grandmaster reports its time as traceable to a primary reference.                                                 |
| Leap Second Pending                | True when the grandmaster announces a leap second at the end of the current UTC day.                                             |
| Grandmaster Clock Class Worse Than | True when the grandmaster clock class exceeds the configured threshold. Lower is better.                                         |
| Steps Removed Above                | True when there are more boundary clocks between this host and the grandmaster than the threshold.                               |
| Mean Path Delay Above              | True when the measured mean path delay exceeds the threshold, in nanoseconds. End to End only.                                   |
| Path Trace Loop Detected           | True when a clock identity appears more than once in the PATH_TRACE of an Announce. Requires the grandmaster to emit path trace. |

## Variables

**A PTPv1 connection publishes only the Time and Master variables, plus the two subdomain variables below.** Everything else on this page depends on data IEEE 1588-2002 does not carry, and is left out of the definitions. The same applies to feedbacks: PTPv1 offers only _PTP Synced_.

| Variable                 | Type       | Description                                                                                                    |
| ------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------- |
| `$(ptp:subdomain)`       | `string`   | **PTPv1 only.** The subdomain name this connection listens on.                                                 |
| `$(ptp:subdomainsFound)` | `string[]` | **PTPv1 only.** An array of every subdomain name heard on the joined multicast group, in the order first seen. |

### Time

| Variable           | Type     | Description                                            |
| ------------------ | -------- | ------------------------------------------------------ |
| `$(ptp:ptpTime)`   | `string` | PTP time in nanoseconds.                               |
| `$(ptp:ptpTimeS)`  | `number` | PTP time, whole seconds.                               |
| `$(ptp:ptpTimeNS)` | `number` | PTP time, nanoseconds within the current second.       |
| `$(ptp:lastSync)`  | `string` | Timestamp of the last completed measurement, ISO 8601. |

The PTP Time variables are a snapshot taken at each sync event, not a live clock.

### Measurement quality

| Variable                     | Type      | Description                                                                                                                                                                                                                                  |
| ---------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$(ptp:meanPathDelay)`       | `number`  | Mean path delay to the master, in nanoseconds. A rising value indicates a congested or asymmetric path.                                                                                                                                      |
| `$(ptp:lastCorrection)`      | `number`  | How far the clock had drifted when the last exchange completed, in nanoseconds. Consistently large values indicate an unstable measurement. Reported as `0` for the first exchange, which carries the initial acquisition rather than drift. |
| `$(ptp:delayMechanism)`      | `string`  | The delay mechanism in use: `End to End`, `Peer to Peer`, `Passive`, or `Detecting` while Auto is still listening.                                                                                                                           |
| `$(ptp:peerMeanPathDelay)`   | `number`  | Measured delay of the link to the directly attached neighbour, in nanoseconds. Peer to Peer only, and empty until the neighbour answers. This is one link, not the distance to the grandmaster.                                              |
| `$(ptp:peerDelayResponding)` | `boolean` | Whether the attached neighbour is answering `Pdelay_Req`. False in a Peer to Peer network means the reported time excludes the local link delay.                                                                                             |

### Master

| Variable                  | Type     | Description                                                                                    |
| ------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `$(ptp:ptpMaster)`        | `string` | Clock identity and port number of the port sending Sync.                                       |
| `$(ptp:ptpMasterAddress)` | `string` | Source IP address of that port.                                                                |
| `$(ptp:ptpMasterMac)`     | `string` | MAC of that port, recovered from its clock identity. Empty if the identity is not MAC-derived. |
| `$(ptp:ptpMasterOui)`     | `string` | Manufacturer's IEEE-assigned block for that port, as hex.                                      |
| `$(ptp:ptpMasterVendor)`  | `string` | Manufacturer of that port, where its IEEE block is one the module carries.                     |
| `$(ptp:ptpVersion)`       | `string` | PTP version in use: `2.0` for IEEE 1588-2008, `2.1` for IEEE 1588-2019.                        |

### Grandmaster

Populated from Announce messages, and cleared if the Announce receipt timeout expires.

| Variable                            | Type      | Description                                                                                                                                    |
| ----------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `$(ptp:grandmaster)`                | `string`  | Clock identity of the grandmaster.                                                                                                             |
| `$(ptp:grandmasterMac)`             | `string`  | MAC of the grandmaster, recovered from its clock identity. Empty if the identity is not MAC-derived.                                           |
| `$(ptp:grandmasterOui)`             | `string`  | Manufacturer's IEEE-assigned block for the grandmaster, as hex.                                                                                |
| `$(ptp:grandmasterVendor)`          | `string`  | Manufacturer of the grandmaster, where its IEEE block is one the module carries.                                                               |
| `$(ptp:grandmasterAddress)`         | `string`  | IP address of the grandmaster. Populated **only** when Steps Removed is 0; see above.                                                          |
| `$(ptp:grandmasterClockClass)`      | `number`  | Clock class, numeric. Lower is better.                                                                                                         |
| `$(ptp:grandmasterClockClassLabel)` | `string`  | Clock class as text, e.g. `Locked to primary reference`, `Holdover (was primary reference)`, `Default`.                                        |
| `$(ptp:grandmasterAccuracy)`        | `string`  | Advertised accuracy, e.g. `100ns`, `1us`, `Unknown`.                                                                                           |
| `$(ptp:grandmasterTimeSource)`      | `string`  | Time source, e.g. `GNSS`, `Atomic Clock`, `Internal Oscillator`, `NTP`.                                                                        |
| `$(ptp:grandmasterPriority1)`       | `number`  | Priority 1, as used by the Best Master Clock Algorithm.                                                                                        |
| `$(ptp:grandmasterPriority2)`       | `number`  | Priority 2.                                                                                                                                    |
| `$(ptp:stepsRemoved)`               | `number`  | Number of boundary clocks between this host and the grandmaster.                                                                               |
| `$(ptp:announceInterval)`           | `number`  | The Announce interval the grandmaster advertises, in seconds.                                                                                  |
| `$(ptp:lastAnnounce)`               | `string`  | Timestamp of the last Announce received, ISO 8601.                                                                                             |
| `$(ptp:pathTrace)`                  | `string`  | The clock identity chain from the grandmaster to the transmitting clock, joined with `>`. Empty unless the grandmaster emits a PATH_TRACE TLV. |
| `$(ptp:pathTraceHops)`              | `number`  | Number of clocks in that chain.                                                                                                                |
| `$(ptp:pathTraceLoop)`              | `boolean` | True when an identity repeats in the chain, meaning the Announce went round a loop.                                                            |

### Time properties

Taken from the flag field of Announce messages. Per IEEE 1588-2008 Table 20 these flags are only meaningful in Announce, so they are not affected by Sync messages.

| Variable                    | Type      | Description                                                                                                               |
| --------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------- |
| `$(ptp:utcOffset)`          | `number`  | Current TAI to UTC offset in seconds, as advertised by the grandmaster.                                                   |
| `$(ptp:utcOffsetValid)`     | `boolean` | Whether the grandmaster considers that offset valid.                                                                      |
| `$(ptp:leapSecond)`         | `string`  | `+1`, `-1`, or `none`. A leap second scheduled at the end of the current UTC day.                                         |
| `$(ptp:ptpTimescale)`       | `boolean` | Whether the grandmaster is using the PTP timescale (TAI) rather than an arbitrary one.                                    |
| `$(ptp:timeTraceable)`      | `boolean` | Whether the time is traceable to a primary reference.                                                                     |
| `$(ptp:frequencyTraceable)` | `boolean` | Whether the frequency is traceable to a primary reference.                                                                |
| `$(ptp:syncUncertain)`      | `boolean` | Whether the grandmaster flags its own synchronisation as uncertain. IEEE 1588-2019 only; always false from a 2008 master. |
| `$(ptp:twoStep)`            | `boolean` | Whether the master is two-step, i.e. sends its precise timestamp in a Follow_Up message. Taken from Sync.                 |
