# NymVPN Omarchy Plugin — Design

## Goal
An Omarchy (Quattro shell) plugin that lets a user operate NymVPN directly from
the bar, using the official `nym-vpnc` CLI as the control surface.

References:
- NymVPN Linux: https://nym.com/download/linux
- Omarchy plugin development: https://omarchyplugins.com/develop.html

## Plugin kind
`bar-widget` (id `io.github.megabyte0x.nym-vpn`). One QML entry point
(`BarWidget.qml`) that owns a nested `Panel.qml`, matching the built-in clock /
crypto-watch pattern. No second Quickshell process; runs unsandboxed with user
permissions (documented).

## Control surface: nym-vpnc
NymVPN ships a privileged daemon `nym-vpnd` (systemd) and a stateless CLI
`nym-vpnc` that talks to it over a local RPC socket. Verified commands used:

| Action | Command |
|--------|---------|
| Status | `nym-vpnc status` → prints `State: <TunnelState>` |
| Connect | `nym-vpnc connect` |
| Disconnect | `nym-vpnc disconnect` |
| Mode (2-hop WG vs 5-hop mixnet) | `nym-vpnc tunnel set --two-hop on|off` |
| Mode readback | `nym-vpnc tunnel get` |
| Entry/exit country | `nym-vpnc gateway set --entry-country XX --exit-country YY` |
| Gateway readback | `nym-vpnc gateway get` |
| Account state | `nym-vpnc account get` |
| Login (terminal only) | `nym-vpnc account set <recovery phrase>` |

All commands run via `sh -c "<cmd> 2>&1"` so daemon/RPC errors on stderr are
captured and classified.

## State model
`parseStatus` collapses combined output into one of: `connected`, `connecting`,
`disconnecting`, `disconnected`, `offline`, `error`, `daemon-down`,
`not-installed`, `unknown`. Ordering guards the `disconnected`⊃`connected` and
`disconnecting`⊃`connecting` substring traps. State maps to a colour role
(ok/busy/bad/idle) and a bar glyph (● / ◐ / ○).

## UI
- Bar: `<glyph> nym`, coloured by state; left-click toggles panel, middle-click
  refreshes, tooltip shows the human label.
- Panel: header (glyph + state), a setup card when CLI/daemon/account is
  missing (with the exact remediation commands), Connect/Disconnect buttons
  (disabled per state), Mode selector, Entry/Exit country fields + Set, an
  account/mode summary line, last-command notice, and key hints.
- Polls `status` every 3s while open, and the bar polls every 8s while closed.

## Security
The recovery phrase is never entered in the shell. Login is delegated to a
terminal (`nym-vpnc account set`). The plugin only issues status/connect/
disconnect/tunnel/gateway commands. Country input is validated to two ASCII
letters before being placed on the command line.

## Testing
- `Model.js` is pure (no Qt imports) and unit-tested under Node
  (`tests/model-test.js`, 19 cases): command building, ISO validation, and all
  status/account/tunnel/gateway parsing branches.
- `omarchy plugin validate .` passes.
- Loaded live into the running shell: discovered + enabled, panel summon/hide
  produce no QML errors, and the not-installed setup card renders (screenshot).
- `qmllint` in this environment is a legacy 1.0 stub that returns non-zero for
  all inputs (including shipped plugins), so live shell loading is the gate.
