// NymVPN plugin model: pure helpers for building nym-vpnc commands and
// parsing their output. No Qt/Quickshell imports here so the same logic can be
// unit-tested under Node (see tests/model-test.js).
//
// IMPORTANT: nym-vpnd gates every RPC connection behind a polkit policy
// (com.nymvpn.vpnd.unix-access, allow_active = auth_self, no caching), so each
// `nym-vpnc status/connect/disconnect/account` call pops a password prompt.
// The plugin therefore NEVER polls on a timer -- it only touches the daemon on
// explicit user action to keep authentication prompts to a minimum.

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

// List the gateways available for a given type so we can offer the user a
// pick-from-list country selector instead of asking them to type ISO codes.
// type is one of "mixnet-entry" | "mixnet-exit" | "wg". Rendered as markdown so
// the Location column ("City [CC]") is easy to scan for country codes.
function gatewayListCommand(type) {
  var t = gatewayType(type)
  return sh(CLI + " gateway list " + t + " --table-style markdown 2>&1")
}

// Which gateway pool backs the entry / exit hop for the current mode.
// Fast (2-hop WireGuard) draws both hops from the "wg" pool; Anonymous
// (5-hop mixnet) uses the dedicated mixnet entry / exit pools.
function entryGatewayType(twoHop) {
  return twoHop === true ? "wg" : "mixnet-entry"
}

function exitGatewayType(twoHop) {
  return twoHop === true ? "wg" : "mixnet-exit"
}

function gatewayType(type) {
  var t = text(type).toLowerCase()
  if (t === "wg" || t === "mixnet-entry" || t === "mixnet-exit") return t
  return "mixnet-entry"
}

function tunnelGetCommand() {
  return sh(CLI + " tunnel get 2>&1")
}

function connectCommand() {
  return sh(CLI + " connect 2>&1")
}

// NOTE: the plugin deliberately provides NO command builder that accepts a
// recovery phrase. The official `nym-vpnc account set` takes the mnemonic ONLY
// as a positional argument (upstream: `Set { secret: String, #[arg(index = 1)] }`
// in nym-vpnc/src/commands/account.rs) -- there is no stdin, file, or env input
// path -- so any client that logs in via the CLI unavoidably places the phrase
// in that process's argv (visible via /proc/<pid>/cmdline). Rather than accept
// that exposure, the plugin does not perform login at all: it only DETECTS and
// CONTROLS an already-configured account (status/connect/disconnect/forget) and
// directs the user to run `nym-vpnc account set <phrase>` themselves in a
// terminal. See accountSetupHint() and the README "Logging in" section.
function accountSetupHint() {
  return CLI + " account set <your recovery phrase>"
}

function accountForgetCommand() {
  return sh(CLI + " account forget 2>&1")
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

// Build a `gateway set` command for ONE hop (entry or exit) from a selector
// value chosen in the picker. Value is a 2-letter ISO country code, or one of
// the special tokens "auto" (let NymVPN choose, excluding your jurisdiction)
// or "random" (pick any gateway). Returns null for an unrecognised value.
function setGatewayCommand(role, value) {
  var r = text(role).toLowerCase()
  if (r !== "entry" && r !== "exit") return null
  var v = text(value)
  var flag
  if (v.toLowerCase() === "auto") {
    flag = "--" + r + "-auto-exclude-jurisdiction on"
  } else if (v.toLowerCase() === "random") {
    flag = "--" + r + "-random"
  } else if (isCountryCode(v)) {
    flag = "--" + r + "-country " + v.toUpperCase()
  } else {
    return null
  }
  return sh(CLI + " gateway set " + flag + " 2>&1")
}

function isCountryCode(value) {
  return typeof value === "string" && COUNTRY_PATTERN.test(value.trim())
}

// ---------------------------------------------------------------------------
// Country helpers (turn bare ISO codes into human-friendly, flagged labels)
// ---------------------------------------------------------------------------

// ISO 3166-1 alpha-2 -> English short name. Covers the gateway countries
// NymVPN exposes plus the common remainder; unknown codes fall back to the
// raw code so the picker never shows a blank row.
var COUNTRY_NAMES = {
  AE: "United Arab Emirates", AL: "Albania", AM: "Armenia", AR: "Argentina",
  AT: "Austria", AU: "Australia", AZ: "Azerbaijan", BA: "Bosnia & Herzegovina",
  BE: "Belgium", BG: "Bulgaria", BO: "Bolivia", BR: "Brazil", CA: "Canada",
  CH: "Switzerland", CL: "Chile", CO: "Colombia", CR: "Costa Rica",
  CY: "Cyprus", CZ: "Czechia", DE: "Germany", DK: "Denmark", EC: "Ecuador",
  EE: "Estonia", ES: "Spain", FI: "Finland", FR: "France",
  GB: "United Kingdom", GE: "Georgia", GR: "Greece", HK: "Hong Kong",
  HR: "Croatia", HU: "Hungary", ID: "Indonesia", IE: "Ireland",
  IL: "Israel", IN: "India", IS: "Iceland", IT: "Italy", JP: "Japan",
  KH: "Cambodia", KR: "South Korea", KZ: "Kazakhstan", LT: "Lithuania",
  LU: "Luxembourg", LV: "Latvia", MA: "Morocco", MX: "Mexico",
  MY: "Malaysia", NG: "Nigeria", NL: "Netherlands", NO: "Norway",
  NZ: "New Zealand", PE: "Peru", PL: "Poland", PR: "Puerto Rico",
  PT: "Portugal", RO: "Romania", RS: "Serbia", RU: "Russia", SE: "Sweden",
  SG: "Singapore", SI: "Slovenia", SK: "Slovakia", TR: "Turkey",
  TW: "Taiwan", UA: "Ukraine", US: "United States", VN: "Vietnam",
  XK: "Kosovo", ZA: "South Africa",
  // Common remainder (not necessarily offered today, but future-proof).
  BD: "Bangladesh", BY: "Belarus", CN: "China", EG: "Egypt", KE: "Kenya",
  LK: "Sri Lanka", MD: "Moldova", ME: "Montenegro", MK: "North Macedonia",
  NP: "Nepal", PA: "Panama", PH: "Philippines", PK: "Pakistan",
  PY: "Paraguay", TH: "Thailand", UY: "Uruguay", UZ: "Uzbekistan",
  VE: "Venezuela"
}

function countryName(code) {
  var c = text(code).toUpperCase()
  if (COUNTRY_NAMES.hasOwnProperty(c)) return COUNTRY_NAMES[c]
  return c
}

// Regional-indicator flag emoji for a 2-letter code (e.g. US -> 🇺🇸).
function countryFlag(code) {
  var c = text(code).toUpperCase()
  if (!/^[A-Z]{2}$/.test(c)) return ""
  var base = 0x1F1E6
  return String.fromCodePoint(base + (c.charCodeAt(0) - 65)) +
         String.fromCodePoint(base + (c.charCodeAt(1) - 65))
}

// Pull the unique set of country codes out of a `gateway list` table. Each
// Location cell looks like "City [CC]"; we grab every [CC] and de-duplicate.
// Returns an array of upper-case codes sorted by their friendly country name.
function parseGatewayCountries(raw) {
  var body = text(raw)
  var re = /\[([A-Za-z]{2})\]/g
  var seen = {}
  var out = []
  var m
  while ((m = re.exec(body)) !== null) {
    var c = m[1].toUpperCase()
    if (!seen[c]) { seen[c] = true; out.push(c) }
  }
  out.sort(function (a, b) {
    return countryName(a).localeCompare(countryName(b))
  })
  return out
}

// Build the option list the SearchableDropdown renders for one hop. Leads with
// the two "smart" choices, then every available country as a flag + name row
// (the bare code is kept as the searchable description so typing "de" or
// "germany" both match). codes is the array from parseGatewayCountries.
function countryOptions(codes) {
  var opts = [
    { value: "auto", label: "✨  Auto (recommended)", description: "Let NymVPN choose, excluding your country" },
    { value: "random", label: "🎲  Random gateway", description: "Pick any available gateway" }
  ]
  var list = Array.isArray(codes) ? codes : []
  for (var i = 0; i < list.length; i++) {
    var c = text(list[i]).toUpperCase()
    if (!/^[A-Z]{2}$/.test(c)) continue
    opts.push({
      value: c,
      label: countryFlag(c) + "  " + countryName(c),
      description: c
    })
  }
  return opts
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

  // Daemon is up but the polkit prompt was dismissed / not authenticated.
  if (lower.indexOf("authentication is required") >= 0 ||
      lower.indexOf("authenticationrequired") >= 0 ||
      lower.indexOf("not authorized") >= 0 ||
      lower.indexOf("permission denied") >= 0) {
    return status("auth-required", "Authentication needed", "approve the system password prompt")
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
                state === "offline" || state === "error" || state === "unknown",
    authRequired: state === "auth-required"
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
    case "auth-required": return "busy"
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
    case "auth-required": return "\u25D1"    // ◑ locked/needs action
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

// Collapse a raw entry/exit point string ("Country(US)", "Location { .. }",
// "Auto { .. }") into the selector value the picker uses: a 2-letter code, or
// "auto" when NymVPN is auto-selecting. Returns "" when nothing is set yet.
function gatewaySelection(pointStr) {
  var s = text(pointStr)
  if (s === "") return ""
  var m = s.match(/\b([A-Z]{2})\b/)
  if (m && countryName(m[1]) !== m[1]) return m[1]
  // Fall back: any 2-letter token in parentheses, e.g. Country(xx).
  var m2 = s.match(/\(([A-Za-z]{2})\)/)
  if (m2) return m2[1].toUpperCase()
  if (/auto/i.test(s)) return "auto"
  return ""
}

// One-line, human summary of the current route for the section header.
function gatewaySummary(gateway) {
  var g = gateway || {}
  var e = gatewaySelection(g.entry)
  var x = gatewaySelection(g.exit)
  function pretty(v) {
    if (v === "" ) return "Auto"
    if (v === "auto") return "Auto"
    return countryFlag(v) + " " + countryName(v)
  }
  return pretty(e) + "  \u2192  " + pretty(x)
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
    gatewayListCommand: gatewayListCommand,
    entryGatewayType: entryGatewayType,
    exitGatewayType: exitGatewayType,
    tunnelGetCommand: tunnelGetCommand,
    connectCommand: connectCommand,
    disconnectCommand: disconnectCommand,
    accountSetupHint: accountSetupHint,
    accountForgetCommand: accountForgetCommand,
    setTwoHopCommand: setTwoHopCommand,
    setCountriesCommand: setCountriesCommand,
    setGatewayCommand: setGatewayCommand,
    isCountryCode: isCountryCode,
    countryName: countryName,
    countryFlag: countryFlag,
    parseGatewayCountries: parseGatewayCountries,
    countryOptions: countryOptions,
    gatewaySelection: gatewaySelection,
    gatewaySummary: gatewaySummary,
    parseStatus: parseStatus,
    stateColorRole: stateColorRole,
    stateGlyph: stateGlyph,
    parseAccount: parseAccount,
    parseTwoHop: parseTwoHop,
    parseGateway: parseGateway,
    modeLabel: modeLabel
  }
}
