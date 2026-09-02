# Why NYM feels slow on "Auto" + plan for a "Fastest" selection mode

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
- All model tests pass (currently 37; expect ~50).
- Manual: from Auto→Fastest, verify `gateway get` shows chosen countries, RTT and
  cloudflare speed test improve vs Auto baseline, and public IP = exit country.
- Reconnect churn check: toggling panel open/closed does not re-trigger probing.

### Out of scope
- Changing daemon Auto behaviour (upstream nym-vpnd feature request material:
  latency-aware auto selection; consider filing on nymtech/nym-vpn-client).
- Continuous background re-probing (battery + reconnect churn).

## Current live state (left in place)

`gateway set --entry-country IN --exit-country SG` is now active and connected
(82 ms / 13 MB/s). To restore the previous privacy-default:
`nym-vpnc gateway set --entry-auto-exclude-jurisdiction on --exit-auto-exclude-jurisdiction on`
