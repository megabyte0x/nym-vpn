# Why NYM feels slow on "Auto" + the "Fastest" selection mode

> **Status: implemented and verified.** Four assumptions in this plan turned out
> to be wrong and were corrected on evidence — see **Corrections** below.

## Root-cause analysis (verified 2026-09-02, from India / Asia-Kolkata)

### Evidence

- Mode: WireGuard two-hop (`tunnel get` → Two-hop: on). Not the mixnet 5-hop path, so
  mode is **not** the cause.
- Gateway constraints were `Auto { exclude_user_country: true }` for entry and
  `Auto { exclude_entry_point_country, exclude_user_country }` for exit.
- Daemon's Auto picked: **entry Dubai [AE] (M247) → exit Baku [AZ] (G-Core)** — for a
  user in **India**, even though Mumbai/Chennai [IN] and Singapore [SG] gateways with
  High performance scores exist in the wg pool (605 gateways total).
- Measured through-tunnel: **RTT 474 ms to 1.1.1.1, download 3.0 MB/s (~24 Mbps)**.
- Kill switch note: while connected, *all* traffic (incl. pings to gateway IPs) is
  policy-routed into `tun1` (rule pref 5209 → table 333); direct probes out `wld0`
  are dropped. Any in-tunnel latency probe carries a constant tunnel offset.

### Hypothesis test (minimal change, one variable)

`nym-vpnc gateway set --entry-country IN --exit-country SG` + `reconnect`:

| Metric            | Auto (AE→AZ) | IN→SG        | Improvement |
|-------------------|--------------|--------------|-------------|
| RTT to 1.1.1.1    | 474 ms       | 82 ms        | 5.8×        |
| Download          | 3.0 MB/s     | 13.1 MB/s    | 4.3×        |

### Root cause

**`nym-vpnd`'s Auto selection is score-weighted (load/uptime) but latency- and
geography-blind.** It draws from the whole worldwide pool, and
`exclude_user_country: true` additionally bans the (often nearest) home-country
gateways. High RTT then throttles single-stream TCP throughput. This is daemon
behaviour, not a plugin bug — but the plugin can compensate client-side.

### Privacy caveat

`exclude_user_country` is a deliberate privacy default. A "fastest" mode that picks
the entry in the user's own country trades that away. Therefore: **do not silently
change Auto's semantics** — add an explicit, clearly-labelled *Fastest* option.

## Plan: "Fastest" entry/exit selection in the plugin

### Design decisions

1. New selection value `fastest` alongside existing `auto` / country codes in the
   entry & exit dropdowns (Panel.qml). Auto keeps daemon semantics untouched.
2. Selection algorithm (client-side, no root, no nft):
   - **Candidate shortlist (geo heuristic):** derive user country (from
     `Intl`/locale or `timedatectl`-style TZ mapping baked into Model.js), map to a
     static nearest-region preference table (e.g. IN → [IN, SG, AE, HK, JP, ...]),
     intersect with available countries from `gateway list <pool>` (already parsed
     by `parseGatewayCountries`). Cap at ~6 candidate countries.
   - **Latency probe:** for each candidate country pick 1–2 High-performance
     gateway exit IPs from `gateway list` and `ping -c 2 -W 1` them concurrently
     (Implemented as ONE `sh` process that fans out with `&`/`wait` and reduces
     each ping to a short, pipe-atomic `RTT <CC> <IP> <ms>` line — simpler and
     cheaper than N Quickshell Processes; ~1.5 s for ten hosts.)
     ~~Through-tunnel offset is constant, so relative ordering is valid even
     while connected~~ — **false, see Corrections.**
   - **Apply:** best country → `gateway set --entry-country <best>`; exit = best
     country whose probe is fastest excluding (configurably) the entry country →
     `gateway set --exit-country <bestExit>`; then `reconnect` if connected.
   - Fallback: if all probes fail (offline/killswitch edge), fall back to pure geo
     ordering (first available candidate).
3. Show the resolved choice in the panel ("Fastest → IN / SG, 82 ms") so the user
   sees what was picked; re-resolve on demand (button) rather than on every
   connect, to avoid reconnect churn.

### Implementation phases (TDD — model-test.js first per phase)

**Phase 1 — Model.js pure logic (testable, no I/O)**
- `nearestCountries(userCc)`: static preference table + fallback ordering. Tests:
  IN, US, DE, unknown cc.
- `parseGatewayHosts(raw, opts)`: extract `{cc, ip, perf}` rows from
  `gateway list` output; filter perf=High, uptime ≥ 95%, cap 2 per country.
  Fixture: real `gateway list wg` output in tests/fixtures.
- `probePlan(userCc, availableHosts)`: shortlist ≤6 countries, ≤2 IPs each.
- `parsePingRtt(raw)`: extract avg RTT; null on loss. Tests: success, 100% loss,
  `Operation not permitted`.
- `pickFastest(results, {excludeEntry})`: order by RTT, tie-break by perf; returns
  `{entry, exit}`. Tests: normal, all-failed → geo fallback, single-country pool.
- `setCountriesCommand(entry, exit)` already exists — reuse.

**Phase 2 — NymService.qml orchestration**
- `resolveFastest()` state machine: list pools (reuse `listProc` flow) → spawn N
  ping Processes (bounded, 1 per host, 3 s hard timeout) → collect → apply via
  `setGatewayCommand`-style action → `reconnect` when status is Connected.
- Guard: single in-flight resolution; `resolving` property for UI spinner.

**Phase 3 — Panel.qml UI**
- Add "Fastest" item to entry/exit selectors; when active show resolved countries
  + measured RTT; "Re-test" affordance.
- Keep 0 qmllint errors; theme-role colors only (matches existing conventions).

**Phase 4 — Verification (superpowers:verification-before-completion)**
- All model tests pass — **89** (was 37).
- Manual: from Auto→Fastest, `gateway get` shows the chosen nodes, RTT and the
  Cloudflare speed test improve vs the Auto baseline, and the public IP is the
  exit country. ✅ (see the table below)
- Reconnect churn: opening/closing the panel only calls `refreshAll()`; probing
  runs solely from an explicit Fastest selection or **Re-test**. Verified by
  opening the panel repeatedly with the tunnel up — no probe, no gateway change.
- Live panel screenshot shows `Servers · 🇮🇳 India → 🇲🇾 Malaysia` with both
  pickers naming the pinned regions; the live service exposes the
  `⚡ Fastest (measured)` row in both dropdowns (72 options).

### Out of scope
- Changing daemon Auto behaviour (upstream nym-vpnd feature request material:
  latency-aware auto selection; consider filing on nymtech/nym-vpn-client).
- Continuous background re-probing (battery + reconnect churn).

## Corrections forced by evidence during implementation

**1. "Relative ordering is valid even while connected" — FALSE.**
With the killswitch up, every probe egresses from the *exit* gateway, so the
offset is not constant, it is path-dependent. Measured on a live IN→SG tunnel:
Cambodia 275 ms and Malaysia 268 ms "beat" gateways in the user's own country at
443–588 ms — the ranking described Singapore's neighbourhood, not India's, and
acting on it would have picked a Cambodian entry for a user in Mumbai.
→ `canProbe(state)` refuses to measure while connected/connecting. Rather than
apply an unmeasured geographic guess (which would rebuild the tunnel and could
replace an already-measured, better selection), the resolve is a **no-op** and
the panel explains why.

**2. Country-level selection is NOT enough.**
The plan assumed picking the best *region* was the fix. After constraining to
entry IN / exit SG, the daemon re-rolled inside SG and chose a node delivering
**390 ms / 2.5 MB/s**, while a gateway probed in that same country answered in
**43 ms**. Region selection merely narrows the daemon's blind pick.
→ Measured winners are pinned exactly with `--entry-id` / `--exit-id`
(`setGatewaysCommand`); a country constraint remains the fallback when nothing
was measured, because then there is no evidence to pin.

**3. Pinning broke the region display.**
Once a node is pinned, `gateway get` reports
`Gateway { identity: NodeIdentity { key: ... } }`. `gatewaySelection` had no
branch for that shape, so both pickers showed **"Auto (recommended)"** for a
route pinned to two specific nodes — the opposite of the truth. Found by
screenshotting the live panel, not by any test. Pinned keys are now resolved
back to their country through the pool table the service already keeps.

**4. Hand-written region adjacency was biased.**
The first implementation bucketed countries into regions and round-robined them;
within a bucket the order was effectively alphabetical, which shortlisted
*Indonesia* over *Singapore* for an Indian user. Replaced with true great-circle
distance over a country-centroid table.

## Verification (evidence)

| Route | How chosen | RTT | Download |
|---|---|---|---|
| AE → AZ | daemon `Auto` | 474 ms | 3.0 MB/s |
| IN → SG (country only) | measured region, node re-rolled by daemon | 255–390 ms | 2.5–6.1 MB/s |
| IN → SG (pinned) | measured + `--entry-id/--exit-id` | **75 ms** | **10.9 MB/s** |
| IN → MY (pinned) | measured + `--entry-id/--exit-id` | 86–252 ms | **13.2–16.0 MB/s** |

The real `NymService.qml` was driven in a standalone Quickshell harness (not a
Node mirror): disconnected → detects `IN`, probes in ~1.3 s, resolves
`IN → SG/MY` with `measured=true`, and writes the pinned IDs to the daemon;
connected → refuses, sets the notice, and leaves `gateway get` byte-identical.
`qmllint` reports 0 errors and `omarchy plugin validate .` passes.

## Current live state

The daemon is pinned to the measured winners (`IN → MY`) and connected; the
public IP resolves to the pinned exit's country, so the tunnel is intact and not
leaking. To restore the stock privacy default at any time:
`nym-vpnc gateway set --entry-auto-exclude-jurisdiction on --exit-auto-exclude-jurisdiction on`
