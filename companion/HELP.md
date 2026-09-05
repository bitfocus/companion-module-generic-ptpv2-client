# PTPv2 Client

Utility module for monitoring PTPv2 (IEEE 1588-2008 / IEEE 1588-2019) on a network the Companion instance is connected to. It is a **passive monitor**: it observes the PTP traffic on the selected interface and reports what the grandmaster is advertising. It does **not** discipline the host system clock, and it does not participate in the Best Master Clock Algorithm.

For detailed protocol-level diagnostics consider Meinberg's PTP Track Hound.

## Standards support

Both **IEEE 1588-2008** (PTP v2.0) and **IEEE 1588-2019** (PTP v2.1) masters are supported. The version in use is reported by the `ptpVersion` variable as `2.0` or `2.1`.

The two are wire-compatible for everything this module reads. 2019 redefines several fields that 2008 reserved — the upper nibble of byte 1 became `minorVersionPTP`, the upper nibble of byte 0 became `majorSdoId`, and the flag field gained `synchronizationUncertain` — all of which are handled. The module identifies itself as v2.0 in the Delay Requests it sends, which 2019 masters accept.

> Versions of this module before this change compared the whole of byte 1 against 2, so a 2019 grandmaster, which sends `0x12` there, had all of its traffic discarded and never appeared at all.

## Requirements

The module joins the PTP multicast group 224.0.1.129 and binds to UDP ports **319** (event) and **320** (general). Unless the delay mechanism is set to End to End it also joins the peer delay group 224.0.0.107. Both are privileged ports, so on Linux the Node.js binary needs permission to bind them — grant `CAP_NET_BIND_SERVICE` with `setcap`, use `authbind`, or redirect the ports with `iptables`.

## Configuration

| Setting            | Description                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface          | The local IPv4 interface to monitor. This selects which interface joins the multicast group; the sockets themselves bind to all interfaces, which is required to receive multicast traffic. |
| Domain             | PTP domain to monitor, 0–127. Every domain shares the multicast address 224.0.1.129 and is separated by the domain byte in the packet.                                                      |
| Sync Interval (ms) | How often this module takes a measurement, 125–30000 ms. This is a rate limit on **our own** traffic, not a property of the master, and it does not affect how sync loss is detected.       |
| Delay Mechanism    | How path delay is established: `Auto`, `End to End`, `Peer to Peer`, or `Passive`. See below.                                                                                               |

## Delay mechanism

A Sync message tells you when the master sent it, not when it arrived. Turning that into an offset requires knowing how long it spent on the wire, and PTP defines two entirely different ways of finding out. **The two must not be mixed on one path**, which is why this is a setting rather than something the module simply does.

| Mechanism        | What it does                                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **End to End**   | Exchanges Delay_Req/Delay_Resp with the master to measure the whole path. The IEEE 1588 default, and what **SMPTE ST 2059-2** and **AES67** require.                                                     |
| **Peer to Peer** | Measures only the link to the directly attached switch with a Pdelay exchange; the rest of the path arrives already summed in the `correctionField`. Required by **IEEE 802.1AS / gPTP**, AVB and Milan. |
| **Passive**      | Transmits nothing whatsoever. Takes the path from the `correctionField` and treats the local link as free.                                                                                               |
| **Auto**         | Listens first, then settles on Peer to Peer or End to End. The default.                                                                                                                                  |

The mechanism actually in use is reported by `$(ptp:delayMechanism)` and logged when it is decided.

### Choosing one

If you know what the network runs — from its profile, or from the grandmaster's own configuration — set it explicitly. Otherwise leave it on **Auto**.

**Auto** transmits nothing until it has decided. Peer delay traffic on the domain is conclusive proof of a Peer to Peer network, so hearing any settles the question immediately; hearing none for four seconds is taken as End to End.

That inference is deliberately one-sided, and it is worth understanding why. Peer delay is **link-local** — sent to 224.0.0.107, which no router forwards — so the only device whose peer delay you can ever hear is the one on the other end of your own cable. On a Peer to Peer network where the switch port you are plugged into is not itself a peer delay responder, there is nothing to hear, and Auto will wrongly settle on End to End. **If a Peer to Peer network reports no PTP time, set the mechanism to Peer to Peer or Passive explicitly.**

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

Sync loss follows the receipt timeouts defined by IEEE 1588-2008 §7.7.3.1 rather than a fixed duration. A timeout is a multiple of the interval the **master itself advertises** in its `logMessageInterval` field, so a master sending 8 Sync messages per second is declared lost far sooner than one sending every 2 seconds.

| Timeout                  | Value                                | Effect                                              |
| ------------------------ | ------------------------------------ | --------------------------------------------------- |
| Sync receipt timeout     | 3 × the advertised Sync interval     | Sync is dropped                                     |
| Announce receipt timeout | 3 × the advertised Announce interval | Sync is dropped and the grandmaster data is cleared |

Both multipliers are 3, the IEEE 1588 default for `announceReceiptTimeout` (the standard requires at least 2). With a default master advertising Announce every 2 seconds, loss is reported after 6 seconds.

Until a master has been heard from, the defaults are a 1 second Sync interval and a 2 second Announce interval. An advertised interval is clamped to between ~7.8 ms and 16 seconds so that a malformed value cannot produce an unusable timer.

> Earlier versions reported sync loss after twice the configured Sync Interval. That was a property of this module's own polling rate rather than anything in the protocol, and did not track the master's actual message rate.

## Master versus grandmaster

These are not the same thing, and the module reports both:

- **PTP Master** is the port that sent the Sync message, shown as `clock-identity:portNumber`. Behind a boundary clock this is the boundary clock, not the source of time.
- **Grandmaster** is the actual source of time, taken from Announce messages. **Steps Removed** gives the number of boundary clocks between this host and it — `0` means the grandmaster is being heard directly.

### Identifying a device beyond its clock identity

**MAC address.** A clock identity is usually an EUI-64 derived from the device's MAC by inserting `FF:FE` in the middle (IEEE 1588 §7.5.2.2.2), so the MAC can be recovered from it. Identity `00:1b:19:ff:fe:12:34:56` gives MAC `00:1b:19:12:34:56`. Where a device uses a configured or randomly generated identity there is no `FF:FE` marker and no MAC to recover, and the variable is left empty rather than showing a guess.

**Manufacturer.** The first three bytes are the manufacturer's IEEE-assigned block, reported as hex in `grandmasterOui`, and resolved to a name in `grandmasterVendor` where the block is one the module carries.

The bundled table is filtered from the public OUI Master Database to the vendors plausible on a broadcast, AV, audio, network or data centre PTP network — timing and grandmaster makers, switch and network vendors, broadcast and AV equipment, professional audio, and server and storage hardware. Mass-market consumer blocks are excluded, since a PTP master is never a phone or a television. An unrecognised block leaves the manufacturer empty rather than showing a guess.

Some professional audio and broadcast makers hold only a 28 or 36 bit IEEE assignment rather than a full 24 bit block. Those can only be identified when the clock identity yields a full MAC, so a device using a configured identity may report an OUI without a manufacturer.

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

Variables are referenced as `$(instance-label:variable)`, where the label is whatever this connection is named in Companion. The examples below use `ptp`.

### Time

| Variable           | Description                                            |
| ------------------ | ------------------------------------------------------ |
| `$(ptp:ptpTime)`   | PTP time in nanoseconds.                               |
| `$(ptp:ptpTimeS)`  | PTP time, whole seconds.                               |
| `$(ptp:ptpTimeNS)` | PTP time, nanoseconds within the current second.       |
| `$(ptp:lastSync)`  | Timestamp of the last completed measurement, ISO 8601. |

The PTP Time variables are a snapshot taken at each sync event, not a live clock.

### Measurement quality

| Variable                     | Description                                                                                                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$(ptp:meanPathDelay)`       | Mean path delay to the master, in nanoseconds. A rising value indicates a congested or asymmetric path.                                                                                                                                      |
| `$(ptp:lastCorrection)`      | How far the clock had drifted when the last exchange completed, in nanoseconds. Consistently large values indicate an unstable measurement. Reported as `0` for the first exchange, which carries the initial acquisition rather than drift. |
| `$(ptp:delayMechanism)`      | The delay mechanism in use: `End to End`, `Peer to Peer`, `Passive`, or `Detecting` while Auto is still listening.                                                                                                                           |
| `$(ptp:peerMeanPathDelay)`   | Measured delay of the link to the directly attached neighbour, in nanoseconds. Peer to Peer only, and empty until the neighbour answers. This is one link, not the distance to the grandmaster.                                              |
| `$(ptp:peerDelayResponding)` | Whether the attached neighbour is answering `Pdelay_Req`. False in a Peer to Peer network means the reported time excludes the local link delay.                                                                                             |

### Master

| Variable                  | Description                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `$(ptp:ptpMaster)`        | Clock identity and port number of the port sending Sync.                                       |
| `$(ptp:ptpMasterAddress)` | Source IP address of that port.                                                                |
| `$(ptp:ptpMasterMac)`     | MAC of that port, recovered from its clock identity. Empty if the identity is not MAC-derived. |
| `$(ptp:ptpMasterOui)`     | Manufacturer's IEEE-assigned block for that port, as hex.                                      |
| `$(ptp:ptpMasterVendor)`  | Manufacturer of that port, where its IEEE block is one the module carries.                     |
| `$(ptp:ptpVersion)`       | PTP version in use: `2.0` for IEEE 1588-2008, `2.1` for IEEE 1588-2019.                        |

### Grandmaster

Populated from Announce messages, and cleared if the Announce receipt timeout expires.

| Variable                            | Description                                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `$(ptp:grandmaster)`                | Clock identity of the grandmaster.                                                                                                             |
| `$(ptp:grandmasterMac)`             | MAC of the grandmaster, recovered from its clock identity. Empty if the identity is not MAC-derived.                                           |
| `$(ptp:grandmasterOui)`             | Manufacturer's IEEE-assigned block for the grandmaster, as hex.                                                                                |
| `$(ptp:grandmasterVendor)`          | Manufacturer of the grandmaster, where its IEEE block is one the module carries.                                                               |
| `$(ptp:grandmasterAddress)`         | IP address of the grandmaster. Populated **only** when Steps Removed is 0; see above.                                                          |
| `$(ptp:grandmasterClockClass)`      | Clock class, numeric. Lower is better.                                                                                                         |
| `$(ptp:grandmasterClockClassLabel)` | Clock class as text, e.g. `Locked to primary reference`, `Holdover (was primary reference)`, `Default`.                                        |
| `$(ptp:grandmasterAccuracy)`        | Advertised accuracy, e.g. `100ns`, `1us`, `Unknown`.                                                                                           |
| `$(ptp:grandmasterTimeSource)`      | Time source, e.g. `GNSS`, `Atomic Clock`, `Internal Oscillator`, `NTP`.                                                                        |
| `$(ptp:grandmasterPriority1)`       | Priority 1, as used by the Best Master Clock Algorithm.                                                                                        |
| `$(ptp:grandmasterPriority2)`       | Priority 2.                                                                                                                                    |
| `$(ptp:stepsRemoved)`               | Number of boundary clocks between this host and the grandmaster.                                                                               |
| `$(ptp:announceInterval)`           | The Announce interval the grandmaster advertises, in seconds.                                                                                  |
| `$(ptp:lastAnnounce)`               | Timestamp of the last Announce received, ISO 8601.                                                                                             |
| `$(ptp:pathTrace)`                  | The clock identity chain from the grandmaster to the transmitting clock, joined with `>`. Empty unless the grandmaster emits a PATH_TRACE TLV. |
| `$(ptp:pathTraceHops)`              | Number of clocks in that chain.                                                                                                                |
| `$(ptp:pathTraceLoop)`              | True when an identity repeats in the chain, meaning the Announce went round a loop.                                                            |

### Time properties

Taken from the flag field of Announce messages. Per IEEE 1588-2008 Table 20 these flags are only meaningful in Announce, so they are not affected by Sync messages.

| Variable                    | Description                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `$(ptp:utcOffset)`          | Current TAI to UTC offset in seconds, as advertised by the grandmaster.                                                   |
| `$(ptp:utcOffsetValid)`     | Whether the grandmaster considers that offset valid.                                                                      |
| `$(ptp:leapSecond)`         | `+1`, `-1`, or `none`. A leap second scheduled at the end of the current UTC day.                                         |
| `$(ptp:ptpTimescale)`       | Whether the grandmaster is using the PTP timescale (TAI) rather than an arbitrary one.                                    |
| `$(ptp:timeTraceable)`      | Whether the time is traceable to a primary reference.                                                                     |
| `$(ptp:frequencyTraceable)` | Whether the frequency is traceable to a primary reference.                                                                |
| `$(ptp:syncUncertain)`      | Whether the grandmaster flags its own synchronisation as uncertain. IEEE 1588-2019 only; always false from a 2008 master. |
| `$(ptp:twoStep)`            | Whether the master is two-step, i.e. sends its precise timestamp in a Follow_Up message. Taken from Sync.                 |

## Actions

The module exposes no actions. It only observes.
