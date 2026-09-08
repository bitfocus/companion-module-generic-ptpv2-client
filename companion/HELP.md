# PTP Client

Utility module for monitoring PTPv1 (IEEE 1588-2002) or PTPv2 (IEEE 1588-2008 / IEEE 1588-2019) on a network the Companion instance is connected to. It is a **passive monitor**: it observes the PTP traffic on the selected interface and reports what the grandmaster is advertising. It does not discipline the host system clock, and it does not participate in the Best Master Clock Algorithm.

For detailed protocol-level diagnostics consider Meinberg's PTP Track Hound.

## Protocols

PTPv1 and PTPv2 are incompatible protocols. Operating the module in one mode will give no visibility of traffic for the other protocol.

### PTPv1 — IEEE 1588-2002 (Dante)

PTPv1 is what **Dante** uses by default. It selects a clock domain by a 16-byte **subdomain name** carried in every packet. Dante runs a separate subdomain per pull-up/pull-down rate so that devices at different rates cannot disturb one another. The addresses below are from Audinate's published [PTP IP addresses used by Dante](https://support.getdante.com/hc/en-gb/articles/5508292415903-PTP-IP-addresses-used-by-Dante):

| Subdomain | Multicast   | Dante clock configuration |
| --------- | ----------- | ------------------------- |
| `_DFLT`   | 224.0.1.129 | AES67 / Default           |
| `_ALT1`   | 224.0.1.130 | Pull-up/down +4.1667%     |
| `_ALT2`   | 224.0.1.131 | Pull-up/down +0.1%        |
| `_ALT3`   | 224.0.1.132 | Pull-up/down −0.1%        |
| `_ALT4`   | 224.0.1.131 | Pull-up/down −4%          |

Subdomains observed are recorded even when the connection is not listening to them.

PTPv1 reports less than PTPv2, and the module publishes only those variables it can populate.

### PTPv2 — IEEE 1588-2008 / 2019

Both **IEEE 1588-2008** (PTP v2.0) and **IEEE 1588-2019** (PTP v2.1) are supported. The version in use is reported by the `ptpVersion` variable as `2.0` or `2.1`.

The two are wire-compatible for everything this module reads. 2019 redefines several fields that 2008 reserved — the upper nibble of byte 1 became `minorVersionPTP`, the upper nibble of byte 0 became `majorSdoId`, and the flag field gained `synchronizationUncertain` — all of which are handled. The module identifies itself as v2.0 in the Delay Requests it sends, which 2019 masters accept.

## Requirements

### Ports and multicast groups

The module joins the PTP multicast group and binds to UDP ports **319** (event) and **320** (general). Unless the delay mechanism is set to End to End it also joins the peer delay group 224.0.0.107.

### Linux privileges

Both are privileged ports: on Linux the Node.js binary needs permission to bind them — grant `CAP_NET_BIND_SERVICE` with `setcap`, or use `authbind`. Companion installs multiple Node.js binaries, make sure to grant the permissions to the `v26` binary used by modules.

## Configuration

### Settings

| Setting                | Description                                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PTP Version            | `PTPv2` (IEEE 1588-2008/2019) or `PTPv1` (IEEE 1588-2002, Dante). Changing this changes which of the settings below apply, and which variables and feedbacks exist.                                  |
| Interface              | The local IPv4 interface to monitor. This selects which interface joins the multicast group; the sockets themselves bind to all interfaces, which is required to receive multicast traffic.          |
| Domain                 | **PTPv2 only.** PTP domain to monitor, 0–255. Every domain shares the multicast address 224.0.1.129 and is separated by the domain byte in the packet. Above 127 is IEEE 1588-2019 only — see below. |
| Unicast Delay Requests | Send `Delay_Req` straight to the master rather than to the multicast group, so it is not delivered to every other device. See below.                                                                 |
| Sync Interval (ms)     | How often this module takes a measurement, 125–30000 ms. This is a rate limit on **our own** traffic, not a property of the master, and it does not affect how sync loss is detected.                |
| Subdomain              | **PTPv1 only.** The subdomain name to listen on. See the table above for which Dante sample rate family each one carries.                                                                            |
| Delay Mechanism        | **PTPv2 only.** How path delay is established: `Auto`, `End to End`, `Peer to Peer`, or `Passive`. See below. PTPv1 has only the end to end exchange.                                                |

### Domains above 127 (PTPv2)

IEEE 1588-2008 defines domains 0–127 and reserves 128–255. IEEE 1588-2019 revised the domain specification — a domain is identified by `domainNumber` together with `sdoId` — and permits the full 0–255.

The module accepts the whole range, because a domain it cannot select is a domain it cannot monitor. Selecting one above 127 asserts that the network is 1588-2019: a 1588-2008 grandmaster will never send on it, and nothing will be heard. A warning appears in the connection settings when one is selected.

In practice this rarely matters — the common profiles sit well below the boundary. SMPTE ST 2059-2 uses domain 127, AES67 and gPTP use 0.

### Custom subdomains (PTPv1)

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

### Delay mechanism (PTPv2)

> Applies to **PTPv2 only**. IEEE 1588-2002 defines only the end to end exchange, so a PTPv1 connection always uses it and the setting is hidden.

A Sync message tells you when the master sent it, not when it arrived. Turning that into an offset requires knowing how long it spent on the wire, and PTP defines two entirely different ways of finding out. **The two must not be mixed on one path**, which is why this is a setting rather than something the module simply does.

| Mechanism        | What it does                                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **End to End**   | Exchanges Delay_Req/Delay_Resp with the master to measure the whole path. The IEEE 1588 default, and what **SMPTE ST 2059-2** and **AES67** require.                                                     |
| **Peer to Peer** | Measures only the link to the directly attached switch with a Pdelay exchange; the rest of the path arrives already summed in the `correctionField`. Required by **IEEE 802.1AS / gPTP**, AVB and Milan. |
| **Passive**      | Transmits nothing whatsoever. Takes the path from the `correctionField` and treats the local link as free.                                                                                               |
| **Auto**         | Listens first, then settles on Peer to Peer or End to End. The default.                                                                                                                                  |

The mechanism actually in use is reported by `$(ptp:delayMechanism)` and logged when it is decided.

#### Choosing one

If you know what the network runs set it explicitly. Otherwise leave it on **Auto**.

**Auto** transmits nothing until it has decided. Peer delay traffic on the domain is conclusive proof of a Peer to Peer network, so hearing any settles the question immediately; hearing none for four seconds is taken as End to End.

That inference is one-sided. Peer delay is **link-local** — sent to 224.0.0.107, which no router forwards — so the only device whose peer delay you can ever hear is the one on the other end of your own cable. On a Peer to Peer network where the switch port you are plugged into is not itself a peer delay responder, there is nothing to hear, and Auto will wrongly settle on End to End. **If a Peer to Peer network reports no PTP time, set the mechanism to Peer to Peer or Passive explicitly.**

## Understanding the output

### Master versus grandmaster

- **PTP Master** is the port that sent the Sync message, shown as `clock-identity:portNumber`. Behind a boundary clock this is the boundary clock, not the source of time.
- **Grandmaster** is the actual source of time, taken from Announce messages. **Steps Removed** gives the number of boundary clocks between this host and it — `0` means the grandmaster is being heard directly.

### Running more than one connection on the same interface

Several connections can watch one interface at once — PTPv1 and PTPv2 together, two PTPv2 domains, or two PTPv1 subdomains. The sockets are shared, multicast is delivered to every connection bound to them, and each one filters the traffic down to its own protocol, domain or subdomain.

Each connection identifies itself to the master by a clock identity and a port number. The clock identity comes from the interface, so connections watching the same one share it; the port number is picked per connection so that their Delay Requests stay distinguishable. Without that they would accept each other's replies and each report a time built from another connection's timestamps.

> **Do not enable Unicast Delay Requests on more than one connection per interface.** Multicast is delivered to every connection sharing a socket, but a unicast reply is delivered to only one of them. The others never see their Delay Response and never lock. Leave it off where several connections share an interface, or enable it on one of them only.

Note also that each connection runs its own delay exchange, so two connections send twice the requests of one.

### Path delay steps

A route change, or a path that becomes asymmetric, moves the measured delay to a different plateau. That is an event rather than a state — afterwards there is no threshold it sits above or below — so it is logged at warning level rather than offered as a feedback. `$(ptp:meanPathDelay)` continues to report the value itself.

A move is reported when the median of the last 8 measurements changes by **more than half**, **and** by at least **1 ms**. The median is what makes it a step rather than an outlier: one wild measurement cannot move it, eight consistent ones will. Reports are held to one every 30 seconds, and the window has to settle on a single value before it counts, so a move is named by its two plateaus rather than by some value in between.

The 1 ms floor is a limit of this module rather than of PTP. Timestamps here are taken in userspace, so two of the four terms behind a path delay carry whatever scheduling delay the host added — measured at a median of 35 µs and a maximum of 545 µs on an idle machine, and worse on a busy one. **A path delay step smaller than 1 ms is therefore not detectable here.** Seeing one needs hardware timestamping. The same caveat applies to the _Mean Path Delay Above_ feedback: on a quiet LAN the absolute figure carries tens of microseconds of this host's own overhead.

### When the master does not answer

The end to end exchange needs the master to answer a Delay_Req. If it never does, the clock never locks, and nothing else says why — there is no error and no timeout, just a connection that stays unsynced.

After three unanswered requests `$(ptp:delayResponding)` goes false and the condition is logged as a warning. Three, rather than one, so a single dropped packet does not raise it; requests are already paced by the Sync Interval setting, so this is a count rather than a timer.

Peer to peer has always reported the equivalent through `$(ptp:peerDelayResponding)`; this is its end to end counterpart. Passive never transmits, so nothing is outstanding and the variable stays true.

### Unicast Delay Requests

By default a Delay_Req goes to the multicast group, which means every device on the network receives this module's requests. Enabling **Unicast Delay Requests** sends them straight to the master instead, and the master answers the same way. Dante offers the same setting per device and Audinate recommends it on larger networks, for the same reason.

`$(ptp:delayReqDestination)` reports where requests are actually going. Multicast is used until the first Sync arrives, because until then there is no master address to send to.

It is also a diagnostic. If multicast requests go unanswered but unicast ones succeed, the master is fine and the group is being filtered somewhere in between — a different fault, and a different fix, from a master that is ignoring the module.

Only one connection per interface may use it — see above.

### Measuring what arrives

A master advertises how often it intends to send Sync. `$(ptp:syncRate)` reports how often one actually arrives, and the two are not the same number when packets are being dropped.

Loss is counted from the sequence number every Sync carries. A hole in the numbering is the only evidence a passive observer has that a message was sent at all, so `$(ptp:syncLossPercent)` and `$(ptp:syncLost)` count what the master sent and this host never saw. A repeat, a message that arrives out of order, and a jump too large to be anything but a master restart are all excluded rather than counted as loss.

This is worth watching because nothing else reveals it. Moderate loss leaves sync up and the offset plausible, and only shows as a slightly noisier correction — but it is the condition that lets a PTP domain split in the first place. Both protocols report it. The count restarts whenever the master changes, since sequence numbers are per port and mean nothing across two clocks.

### When two clocks both claim to be master

A PTP domain is meant to have one grandmaster. Two clocks sending Sync on the same domain — or, in PTPv1, the same subdomain — means it has **split**: each side of the network has run its own election and neither can see the other's result. The usual cause is multicast being dropped somewhere between them, so it shows up on links between sites far more often than within one.

The module handles this in two parts.

**It follows exactly one master.** The first clock heard sending Sync is the one used, and it keeps being used while it keeps transmitting. A second clock is recorded but nothing it sends is allowed near the measurement — not its timestamps, not the sequence numbers a Follow_Up is matched against, not its advertised interval. Without that a split domain produces no usable time at all: each Sync from the other side would displace the last, and the reported offset would be built from two clocks that disagree.

This is deliberately not an election. The module is a passive monitor and does not run the Best Master Clock Algorithm, so it reports which clock it is following rather than deciding which one ought to win. PTPv1 could not do so in any case — IEEE 1588-2002 has no Announce message, and so nothing to compare two clocks by.

**Handover is by silence, not by preference.** Another clock takes over only once the one being followed has stopped transmitting for longer than its own sync receipt timeout. A grandmaster failover therefore proceeds normally, and is not reported as contention, because only one clock is transmitting at a time.

**It reports the contention.** `$(ptp:masterContention)` is true while more than one clock is transmitting, `$(ptp:mastersLive)` lists them, and `$(ptp:mastersFound)` keeps every clock seen since the connection started. The _Multiple PTP Masters Detected_ feedback follows the same condition, and the split is logged as an error when it starts and cleared when it ends.

### Identifying a device beyond its clock identity

**MAC address.** A PTPv2 clock identity is usually an EUI-64 derived from the device's MAC by inserting `FF:FE` in the middle (IEEE 1588 §7.5.2.2.2), so the MAC can be recovered from it. Identity `00:1b:19:ff:fe:12:34:56` gives MAC `00:1b:19:12:34:56`. Where a device uses a configured or randomly generated identity there is no `FF:FE` marker and no MAC to recover, and the variable is left empty.

In **PTPv1** there is nothing to recover: a `sourceUuid` is an EUI-48 outright (IEEE 1588-2002 §6.2.2.5), so `ptpMasterMac` is always populated once a Sync has been heard.

**Manufacturer.** The first three bytes are the manufacturer's IEEE-assigned block, reported as hex in `grandmasterOui`, and resolved to a name in `grandmasterVendor` where the block is one the module carries.

The bundled table is built from the IEEE public registries (MA-L, MA-M and MA-S), filtered to the vendors plausible on a broadcast, AV, audio, network or data centre PTP network.

An OUI alone is often not enough to name a maker. IEEE subdivides some 24-bit blocks into 28-bit (MA-M) and 36-bit (MA-S) assignments, and many professional audio and broadcast vendors hold only one of those — the 24-bit block is then registered to the IEEE Registration Authority rather than to anyone you could name. The lookup is therefore given the whole MAC and matches the longest assignment first. A master at `18:66:96:11:0b:52` resolves to _Turtle AV_ through the 28-bit block `1866961`; its OUI `186696` on its own belongs to no vendor at all.

**Path trace.** Where the grandmaster emits a `PATH_TRACE` TLV (IEEE 1588-2019 §16.2), the Announce carries the clock identity of every clock it passed through, grandmaster first and the transmitting clock last. This gives the exact chain of boundary clocks between the source of time and this host, which `Steps Removed` only counts. Path trace is optional and disabled by default on many grandmasters, so `pathTrace` is often empty; when it is, `Steps Removed` remains the best available measure of distance.

A clock identity appearing twice in the chain means the Announce travelled a loop, which `pathTraceLoop` reports and the _Path Trace Loop Detected_ feedback flags.

**IP address.** PTP carries no field for the grandmaster's address. All that is ever available is the source address of the packet that arrived, which is the grandmaster only when it sent the Announce itself. `grandmasterAddress` is therefore populated only when **Steps Removed is 0**, and is empty otherwise; behind a boundary clock the address you can see belongs to that boundary clock and is reported as `ptpMasterAddress`.

### How synchronisation is measured

From the timestamps of an exchange the module derives:

- **Offset** — how far the local clock is from the master, used to produce the PTP Time variables.
- **Mean path delay** — the network transit time to the master. **End to End only**; the other mechanisms never measure it and leave the variable empty rather than reporting a zero that would read as a perfect path.

The `correctionField` of every Sync, Follow_Up and Delay_Response is applied, so residence time accumulated by transparent clocks (most PTP-aware switches) is accounted for rather than appearing as offset error. In a Peer to Peer network that same field is where the entire path delay arrives.

Each Delay Response and Pdelay Response is matched against this client's own clock identity, so responses addressed to other slaves on the network are ignored. A peer delay measurement that comes out negative, or larger than 100 ms, is discarded rather than folded into the offset.

### Loss of sync

Sync loss follows the receipt timeouts defined by IEEE 1588-2008 §7.7.3.1. A timeout is a multiple of the interval the master advertises in its `logMessageInterval` field, so a master sending 8 Sync messages per second is declared lost far sooner than one sending every 2 seconds.

| Timeout                  | Value                                | Effect                                              |
| ------------------------ | ------------------------------------ | --------------------------------------------------- |
| Sync receipt timeout     | 3 × the advertised Sync interval     | Sync is dropped                                     |
| Announce receipt timeout | 3 × the advertised Announce interval | Sync is dropped and the grandmaster data is cleared |

Both multipliers are 3, the IEEE 1588 default for `announceReceiptTimeout` (the standard requires at least 2).

Until a master has been heard from, the defaults are a 1 second Sync interval and a 2 second Announce interval. An advertised interval is clamped to between ~7.8 ms and 16 seconds so that a malformed value cannot produce an unusable timer.

## Troubleshooting

### Peer to peer with no responding neighbour

A neighbour that does not answer `Pdelay_Req` is not a failure. The module still syncs, using the `correctionField` exactly as Passive does, and simply leaves the local link unaccounted for — the reported time is then behind by one link delay, normally well under a microsecond on copper. `$(ptp:peerDelayResponding)` reports whether the neighbour is answering, and the condition is logged once as a warning.

Note that `$(ptp:peerMeanPathDelay)` is the delay of **your own link only**, not the distance to the grandmaster. In a Peer to Peer network there is no single figure for the latter — that is precisely what the `correctionField` accumulates on the way.

### The manufacturer is empty

Not every device can be named, and on a Dante network many cannot. A large share of Dante-enabled brands hold no IEEE assignment of their own — their hardware carries the MAC of the audio module or the contract manufacturer that built it, not of the brand on the front panel. Where that is so, no OUI table can identify the brand, and `ptpMasterVendor` remains+ empty.

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
| Multiple PTP Masters Detected      | True while more than one clock is sending Sync on this domain. Available in both protocols.                                      |

## Variables

**A PTPv1 connection publishes only the Time and Master variables, plus the two subdomain variables below.** Everything else on this page depends on data IEEE 1588-2002 does not carry, and is left out of the definitions. The same applies to feedbacks: PTPv1 offers _PTP Synced_ and _Multiple PTP Masters Detected_, both of which need only Sync messages.

| Variable                 | Type       | Description                                                                                                    |
| ------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------- |
| `$(ptp:subdomain)`       | `string`   | **PTPv1 only.** The subdomain name this connection listens on.                                                 |
| `$(ptp:subdomainsFound)` | `string[]` | **PTPv1 only.** An array of every subdomain name heard on the joined multicast group, in the order first seen. |

### Time

| Variable                 | Type     | Description                                                                                                        |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `$(ptp:ptpTime)`         | `string` | PTP time in nanoseconds.                                                                                           |
| `$(ptp:ptpTimeS)`        | `number` | PTP time, whole seconds.                                                                                           |
| `$(ptp:ptpTimeNS)`       | `number` | PTP time, nanoseconds within the current second.                                                                   |
| `$(ptp:lastSync)`        | `string` | Timestamp of the last completed measurement, ISO 8601.                                                             |
| `$(ptp:syncRate)`        | `number` | Sync messages arriving per second, averaged over the last 10 seconds. Compare with the rate the master advertises. |
| `$(ptp:syncLossPercent)` | `number` | Percentage of the master's Sync messages missed, over the same window.                                             |
| `$(ptp:syncLost)`        | `number` | Sync messages missed since the current master was adopted.                                                         |

The PTP Time variables are a snapshot taken at each sync event, not a live clock.

### Measurement quality

| Variable                     | Type      | Description                                                                                                                                                                                                                                  |
| ---------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$(ptp:meanPathDelay)`       | `number`  | Mean path delay to the master, in nanoseconds. A rising value indicates a congested or asymmetric path.                                                                                                                                      |
| `$(ptp:lastCorrection)`      | `number`  | How far the clock had drifted when the last exchange completed, in nanoseconds. Consistently large values indicate an unstable measurement. Reported as `0` for the first exchange, which carries the initial acquisition rather than drift. |
| `$(ptp:delayMechanism)`      | `string`  | The delay mechanism in use: `End to End`, `Peer to Peer`, `Passive`, or `Detecting` while Auto is still listening.                                                                                                                           |
| `$(ptp:peerMeanPathDelay)`   | `number`  | Measured delay of the link to the directly attached neighbour, in nanoseconds. Peer to Peer only, and empty until the neighbour answers. This is one link, not the distance to the grandmaster.                                              |
| `$(ptp:peerDelayResponding)` | `boolean` | Whether the attached neighbour is answering `Pdelay_Req`. False in a Peer to Peer network means the reported time excludes the local link delay.                                                                                             |
| `$(ptp:delayResponding)`     | `boolean` | Whether the master is answering this module's `Delay_Req`. False after three go unanswered. Always true where none are sent.                                                                                                                 |
| `$(ptp:delayReqDestination)` | `string`  | Where `Delay_Req` is being sent: the master's address when unicast is enabled, otherwise the multicast group.                                                                                                                                |

### Master

| Variable                  | Type       | Description                                                                                                                                                                              |
| ------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$(ptp:ptpMaster)`        | `string`   | Clock identity and port number of the port sending Sync.                                                                                                                                 |
| `$(ptp:ptpMasterAddress)` | `string`   | Source IP address of that port.                                                                                                                                                          |
| `$(ptp:ptpMasterMac)`     | `string`   | MAC of that port. Recovered from the clock identity in PTPv2, and empty if that identity is not MAC-derived; read directly from the `sourceUuid` in PTPv1, where it is always available. |
| `$(ptp:ptpMasterOui)`     | `string`   | Manufacturer's IEEE-assigned block for that port, as hex.                                                                                                                                |
| `$(ptp:ptpMasterVendor)`  | `string`   | Manufacturer of that port, where its IEEE block is one the module carries.                                                                                                               |
| `$(ptp:mastersFound)`     | `string[]` | Every clock heard sending Sync on this domain since the connection started, in the order first seen.                                                                                     |
| `$(ptp:mastersLive)`      | `string[]` | The clocks sending Sync now. More than one means the domain is split.                                                                                                                    |
| `$(ptp:masterContention)` | `boolean`  | True while more than one clock is sending Sync. See above.                                                                                                                               |
| `$(ptp:ptpVersion)`       | `string`   | PTP version in use: `2.0` for IEEE 1588-2008, `2.1` for IEEE 1588-2019.                                                                                                                  |

### Grandmaster

Populated from Announce messages, and cleared if the Announce receipt timeout expires.

| Variable                            | Type       | Description                                                                                                                                                       |
| ----------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$(ptp:grandmaster)`                | `string`   | Clock identity of the grandmaster.                                                                                                                                |
| `$(ptp:grandmasterMac)`             | `string`   | MAC of the grandmaster, recovered from its clock identity. Empty if the identity is not MAC-derived.                                                              |
| `$(ptp:grandmasterOui)`             | `string`   | Manufacturer's IEEE-assigned block for the grandmaster, as hex.                                                                                                   |
| `$(ptp:grandmasterVendor)`          | `string`   | Manufacturer of the grandmaster, where its IEEE block is one the module carries.                                                                                  |
| `$(ptp:grandmasterAddress)`         | `string`   | IP address of the grandmaster. Populated **only** when Steps Removed is 0; see above.                                                                             |
| `$(ptp:grandmasterClockClass)`      | `number`   | Clock class, numeric. Lower is better.                                                                                                                            |
| `$(ptp:grandmasterClockClassLabel)` | `string`   | Clock class as text, e.g. `Locked to primary reference`, `Holdover (was primary reference)`, `Default`.                                                           |
| `$(ptp:grandmasterAccuracy)`        | `string`   | Advertised accuracy, e.g. `100ns`, `1us`, `Unknown`.                                                                                                              |
| `$(ptp:grandmasterTimeSource)`      | `string`   | Time source, e.g. `GNSS`, `Atomic Clock`, `Internal Oscillator`, `NTP`.                                                                                           |
| `$(ptp:grandmasterPriority1)`       | `number`   | Priority 1, as used by the Best Master Clock Algorithm.                                                                                                           |
| `$(ptp:grandmasterPriority2)`       | `number`   | Priority 2.                                                                                                                                                       |
| `$(ptp:stepsRemoved)`               | `number`   | Number of boundary clocks between this host and the grandmaster.                                                                                                  |
| `$(ptp:announceInterval)`           | `number`   | The Announce interval the grandmaster advertises, in seconds.                                                                                                     |
| `$(ptp:announceRate)`               | `number`   | Announce messages arriving per second, averaged over the last 10 seconds. Compare with the interval above.                                                        |
| `$(ptp:domainsFound)`               | `number[]` | Every PTP domain heard on the wire, including ones this connection is not listening to. Traffic on another domain is the usual reason for hearing nothing at all. |
| `$(ptp:lastAnnounce)`               | `string`   | Timestamp of the last Announce received, ISO 8601.                                                                                                                |
| `$(ptp:pathTrace)`                  | `string`   | The clock identity chain from the grandmaster to the transmitting clock, joined with `>`. Empty unless the grandmaster emits a PATH_TRACE TLV.                    |
| `$(ptp:pathTraceHops)`              | `number`   | Number of clocks in that chain.                                                                                                                                   |
| `$(ptp:pathTraceLoop)`              | `boolean`  | True when an identity repeats in the chain, meaning the Announce went round a loop.                                                                               |

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
