// NymVPN plugin model: pure helpers for building nym-vpnc commands and
// parsing their output. No Qt/Quickshell imports here so the same logic can be
// unit-tested under Node (see tests/model-test.js).

var CLI = "nym-vpnc"

// How often the panel/bar re-polls `nym-vpnc status` while the panel is open,
// and the slower background cadence used for the bar label.
var POLL_INTERVAL_MS = 3000
var BAR_POLL_INTERVAL_MS = 8000

// Two-letter ISO country codes (entry/exit gateway selection).
var COUNTRY_PATTERN = /^[A-Za-z]{2}$/

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------
// Every command is run through `sh -c "<cli> ... 2>&1"` so that daemon/RPC
// errors printed to stderr are captured on stdout and can be classified.

function sh(script) {
  return ["sh", "-c", script]
}

function cliInstalledCommand() {
  return sh("command -v " + CLI + " >/dev/null 2>&1 && echo yes || echo no")
}

function statusCommand() {
  return sh(CLI + " status 2>&1")
}

function accountCommand() {
  return sh(CLI + " account get 2>&1")
}

function gatewayGetCommand() {
  return sh(CLI + " gateway get 2>&1")
}

function tunnelGetCommand() {
  return sh(CLI + " tunnel get 2>&1")
}

function connectCommand() {
  return sh(CLI + " connect 2>&1")
}

function disconnectCommand() {
  return sh(CLI + " disconnect 2>&1")
}

// Enable/disable two-hop WireGuard mode. on -> 2-hop WireGuard ("Fast"),
// off -> 5-hop mixnet ("Anonymous").
function setTwoHopCommand(on) {
  return sh(CLI + " tunnel set --two-hop " + (on ? "on" : "off") + " 2>&1")
}

// Build a `gateway set` command from optional entry/exit country codes.
// Returns null when neither code is a valid two-letter ISO code.
function setCountriesCommand(entry, exit) {
  var parts = [CLI, "gateway", "set"]
  var used = false
  if (isCountryCode(entry)) {
    parts.push("--entry-country", entry.toUpperCase())
    used = true
  }
  if (isCountryCode(exit)) {
    parts.push("--exit-country", exit.toUpperCase())
    used = true
  }
  if (!used) return null
  return sh(parts.join(" ") + " 2>&1")
}

function isCountryCode(value) {
  return typeof value === "string" && COUNTRY_PATTERN.test(value.trim())
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

function text(value) {
  return String(value === undefined || value === null ? "" : value).trim()
}

// Classify combined stdout+stderr of `nym-vpnc status`.
// Returns { state, label, detail, ok } where state is one of:
//   connected | connecting | disconnecting | disconnected | offline |
//   error | daemon-down | not-installed | unknown
function parseStatus(raw, exitCode) {
  var body = text(raw)
  var lower = body.toLowerCase()

  if (lower.indexOf("command not found") >= 0 ||
      lower.indexOf("not found") >= 0 && lower.indexOf(CLI) >= 0) {
    return status("not-installed", "Not installed", "nym-vpnc is not on PATH")
  }

  // Daemon / RPC transport problems (nym-vpnd not running or not reachable).
  if (lower.indexOf("connection refused") >= 0 ||
      lower.indexOf("no such file or directory") >= 0 ||
      lower.indexOf("transport error") >= 0 ||
      lower.indexOf("failed to connect") >= 0 ||
      lower.indexOf("failed to create rpc") >= 0 ||
      lower.indexOf("error creating rpc client") >= 0 ||
      lower.indexOf("tonic") >= 0) {
    return status("daemon-down", "Daemon offline", "nym-vpnd is not running")
  }

  // Extract the state token after "State:" when present.
  var detail = ""
  var m = body.match(/state:\s*(.+)/i)
  if (m) detail = text(m[1])

  // Order matters: "disconnected" contains "connected", "disconnecting"
  // contains "connecting", so check the longer/negative forms first.
  if (lower.indexOf("disconnecting") >= 0) return status("disconnecting", "Disconnecting", detail)
  if (lower.indexOf("connecting") >= 0) return status("connecting", "Connecting", detail)
  if (lower.indexOf("disconnected") >= 0) return status("disconnected", "Disconnected", detail)
  if (lower.indexOf("offline") >= 0) return status("offline", "Offline", detail)
  if (lower.indexOf("error") >= 0) return status("error", "Error", detail || body)
  if (lower.indexOf("connected") >= 0) return status("connected", "Connected", detail)

  if (typeof exitCode === "number" && exitCode !== 0 && body === "")
    return status("daemon-down", "Daemon offline", "no response from nym-vpnd")

  return status("unknown", "Unknown", detail || body)
}

function status(state, label, detail) {
  return {
    state: state,
    label: label,
    detail: text(detail),
    connected: state === "connected",
    busy: state === "connecting" || state === "disconnecting",
    actionable: state === "connected" || state === "disconnected" ||
                state === "offline" || state === "error" || state === "unknown"
  }
}

// Map a state to a semantic colour role the QML side understands.
function stateColorRole(state) {
  switch (state) {
    case "connected": return "ok"
    case "connecting":
    case "disconnecting": return "busy"
    case "error":
    case "daemon-down":
    case "not-installed": return "bad"
    default: return "idle"
  }
}

// Short glyph shown in the bar for a given state.
function stateGlyph(state) {
  switch (state) {
    case "connected": return "\u25CF"      // ● filled
    case "connecting":
    case "disconnecting": return "\u25D0"   // ◐ half
    case "error":
    case "daemon-down":
    case "not-installed": return "\u25CB"   // ○ hollow
    default: return "\u25CB"                 // ○ hollow
  }
}

// Parse `nym-vpnc account get` output into a small summary.
function parseAccount(raw) {
  var body = text(raw)
  var identity = matchLine(body, /account identity:\s*(.+)/i)
  var state = matchLine(body, /account state:\s*(.+)/i)
  var mode = matchLine(body, /account mode:\s*(.+)/i)
  var stored = identity !== "" && identity.toLowerCase() !== "unset"
  return {
    stored: stored,
    identity: identity,
    state: state,
    mode: mode
  }
}

// Parse `nym-vpnc tunnel get` output for the two-hop toggle.
function parseTwoHop(raw) {
  var body = text(raw).toLowerCase()
  var m = body.match(/two[\s_-]?hop[^\n]*?:\s*(on|off|true|false|enabled|disabled)/)
  if (!m) return null
  var v = m[1]
  return v === "on" || v === "true" || v === "enabled"
}

// Parse `nym-vpnc gateway get` for entry/exit summaries.
function parseGateway(raw) {
  var body = text(raw)
  return {
    entry: matchLine(body, /entry point:\s*(.+)/i),
    exit: matchLine(body, /exit point:\s*(.+)/i)
  }
}

function matchLine(body, re) {
  var m = String(body).match(re)
  return m ? text(m[1]) : ""
}

function modeLabel(twoHop) {
  if (twoHop === true) return "Fast (2-hop WireGuard)"
  if (twoHop === false) return "Anonymous (5-hop mixnet)"
  return "Mode: unknown"
}

// ---------------------------------------------------------------------------

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CLI: CLI,
    POLL_INTERVAL_MS: POLL_INTERVAL_MS,
    BAR_POLL_INTERVAL_MS: BAR_POLL_INTERVAL_MS,
    cliInstalledCommand: cliInstalledCommand,
    statusCommand: statusCommand,
    accountCommand: accountCommand,
    gatewayGetCommand: gatewayGetCommand,
    tunnelGetCommand: tunnelGetCommand,
    connectCommand: connectCommand,
    disconnectCommand: disconnectCommand,
    setTwoHopCommand: setTwoHopCommand,
    setCountriesCommand: setCountriesCommand,
    isCountryCode: isCountryCode,
    parseStatus: parseStatus,
    stateColorRole: stateColorRole,
    stateGlyph: stateGlyph,
    parseAccount: parseAccount,
    parseTwoHop: parseTwoHop,
    parseGateway: parseGateway,
    modeLabel: modeLabel
  }
}
