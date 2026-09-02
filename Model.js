// NymVPN plugin model: pure helpers for building nym-vpnc commands and
// parsing their output. No Qt/Quickshell imports here so the same logic can be
// unit-tested under Node (see tests/model-test.js).
//
// State + polling live in NymService.qml (a process-wide Quickshell Singleton),
// which shares one source of truth across every per-monitor bar instance. On
// current nym-vpnd builds the read-only `status` call is ungated, so the service
// polls it (~10s) to keep the bar live. Privileged calls (connect/disconnect)
// may still be polkit-gated; if a `status` ever returns auth-required the
// service stops background polling and falls back to on-demand refresh so users
// are never spammed with prompts. These helpers stay pure (no Qt) for testing.

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

// Re-establish the tunnel against the currently configured constraints. Used
// after a "Fastest" gateway change so the new entry/exit take effect without
// making the user manually disconnect and reconnect.
function reconnectCommand() {
  return sh(CLI + " reconnect 2>&1")
}

// ---------------------------------------------------------------------------
// Local network (LAN) policy
// ---------------------------------------------------------------------------
// nym-vpnd defaults to blocking local network access, which breaks printers,
// casting, file sharing and clipboard-continuity tools on your own LAN while
// the tunnel is up. The daemon exposes this as a first-class setting, so the
// panel just surfaces it rather than touching the firewall itself.

function lanGetCommand() {
  return sh(CLI + " lan get 2>&1")
}

function setLanCommand(allow) {
  return sh(CLI + " lan set " + (allow ? "allow" : "block") + " 2>&1")
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
  // "fastest" is NOT a daemon-side constraint: it is resolved client-side by
  // probing gateway latency and then applied as a concrete --entry/exit-country.
  // Refuse it here so a caller can never build a bogus flag from it.
  if (isFastest(v)) return null
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

function isFastest(value) {
  return text(value).toLowerCase() === "fastest"
}

// NymVPN gateway identities are base58 (no 0, O, I, l) public keys.
function isGatewayId(value) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(text(value))
}

// Build a `gateway set` that pins EXACT gateways when we measured them, and
// falls back to a country constraint otherwise.
//
// Pinning matters: a country constraint still lets the daemon choose any node
// inside that country by its own (latency-blind) score. Measured live -- after
// narrowing to entry IN / exit SG, the daemon picked an SG node that delivered
// 390ms / 2.5 MB/s, while a gateway we had actually probed in the same country
// answered in 43ms. Selecting the region is not enough; we pin the winner.
function setGatewaysCommand(sel) {
  var s = sel || {}
  var parts = [CLI, "gateway", "set"]
  var used = false
  if (isGatewayId(s.entryId)) {
    parts.push("--entry-id", text(s.entryId)); used = true
  } else if (isCountryCode(s.entry)) {
    parts.push("--entry-country", text(s.entry).toUpperCase()); used = true
  }
  if (isGatewayId(s.exitId)) {
    parts.push("--exit-id", text(s.exitId)); used = true
  } else if (isCountryCode(s.exit)) {
    parts.push("--exit-country", text(s.exit).toUpperCase()); used = true
  }
  if (!used) return null
  return sh(parts.join(" ") + " 2>&1")
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
  // Auto stays first: it is the privacy default (your own jurisdiction is
  // excluded). Fastest deliberately trades that away for latency, so it is
  // offered as an explicit, clearly-labelled choice rather than a silent
  // redefinition of Auto.
  var opts = [
    { value: "auto", label: "✨  Auto (recommended)", description: "Let NymVPN choose, excluding your country" },
    { value: "fastest", label: "⚡  Fastest (measured)", description: "Ping nearby regions and pick the lowest latency" },
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

// Parse `nym-vpnc lan get` output ("Local network policy: allow|block").
// Returns true (allow), false (block), or null when the answer was not a
// policy line at all (daemon error, empty output, older CLI without `lan`).
function parseLan(raw) {
  var body = text(raw).toLowerCase()
  var m = body.match(/local\s+network\s+policy\s*:\s*(allow|block)/)
  if (!m) return null
  return m[1] === "allow"
}

function lanLabel(allow) {
  if (allow === true) return "Allowed"
  if (allow === false) return "Blocked"
  return "Unknown"
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

// ---------------------------------------------------------------------------
// Fastest gateway selection (client-side latency probing)
// ---------------------------------------------------------------------------
// WHY THIS EXISTS: nym-vpnd's `Auto` picks gateways by score (load/uptime) from
// the whole worldwide pool and additionally excludes your own jurisdiction. It
// is latency- and geography-blind, so from India it will happily choose
// entry AE (Dubai) -> exit AZ (Baku): measured 474 ms RTT / 3.0 MB/s, while
// IN -> SG measured 82 ms / 13.1 MB/s on the same connection. Latency throttles
// single-stream TCP, so this is the dominant cause of "NymVPN is slow".
//
// We cannot fix the daemon's chooser, but we can measure and then constrain it:
//   1. work out roughly where the user is (timezone, then locale),
//   2. shortlist a handful of nearby countries that actually have gateways,
//   3. ping a couple of gateways per country concurrently,
//   4. apply the winners with `gateway set --entry-country/--exit-country`.
//
// PRIVACY NOTE: the fastest entry is often in the user's own country, which is
// exactly what `Auto`'s exclude_user_country default avoids. That is why this
// is a separate, explicitly-labelled "Fastest" option and never a redefinition
// of Auto -- the user opts into the tradeoff.

// Probe fan-out limits. Six countries x two hosts keeps a resolve under a few
// seconds and well inside a sane process/packet budget.
var PROBE_MAX_COUNTRIES = 6
var PROBE_PER_COUNTRY = 2
// Quality floor for a gateway to be worth probing at all.
var PROBE_MIN_UPTIME = 95

// --- where is the user? ----------------------------------------------------

// Ask the system for the two offline signals of physical location. The
// timezone is asked for first because it is the reliable one: a user in India
// very commonly runs an en_US locale (this machine does), but their timezone is
// still Asia/Kolkata.
function localCountryCommand() {
  return sh("printf 'TZ=%s\\n' \"$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null)\"; " +
            "printf 'LOCALE=%s\\n' \"${LC_ALL:-${LC_MESSAGES:-$LANG}}\"")
}

// IANA timezone -> ISO country. Only the zones that matter for picking a
// *region* are listed; anything unknown falls through to the locale.
var TZ_COUNTRIES = {
  "Asia/Kolkata": "IN", "Asia/Calcutta": "IN", "Asia/Colombo": "LK",
  "Asia/Karachi": "PK", "Asia/Dhaka": "BD", "Asia/Kathmandu": "NP",
  "Asia/Singapore": "SG", "Asia/Kuala_Lumpur": "MY", "Asia/Bangkok": "TH",
  "Asia/Jakarta": "ID", "Asia/Manila": "PH", "Asia/Ho_Chi_Minh": "VN",
  "Asia/Saigon": "VN", "Asia/Phnom_Penh": "KH",
  "Asia/Hong_Kong": "HK", "Asia/Tokyo": "JP", "Asia/Seoul": "KR",
  "Asia/Taipei": "TW", "Asia/Shanghai": "CN", "Asia/Chongqing": "CN",
  "Asia/Dubai": "AE", "Asia/Jerusalem": "IL", "Asia/Tel_Aviv": "IL",
  "Europe/Istanbul": "TR", "Asia/Istanbul": "TR", "Africa/Cairo": "EG",
  "Asia/Yerevan": "AM", "Asia/Baku": "AZ", "Asia/Tbilisi": "GE",
  "Asia/Almaty": "KZ", "Asia/Tashkent": "UZ",
  "Europe/Moscow": "RU", "Europe/Kiev": "UA", "Europe/Kyiv": "UA",
  "Europe/Minsk": "BY", "Europe/Chisinau": "MD", "Europe/Warsaw": "PL",
  "Europe/Bucharest": "RO", "Europe/Sofia": "BG", "Europe/Belgrade": "RS",
  "Europe/Zagreb": "HR", "Europe/Ljubljana": "SI", "Europe/Bratislava": "SK",
  "Europe/Prague": "CZ", "Europe/Budapest": "HU", "Europe/Sarajevo": "BA",
  "Europe/Podgorica": "ME", "Europe/Skopje": "MK", "Europe/Tirane": "AL",
  "Europe/Stockholm": "SE", "Europe/Oslo": "NO", "Europe/Helsinki": "FI",
  "Europe/Copenhagen": "DK", "Atlantic/Reykjavik": "IS",
  "Europe/Tallinn": "EE", "Europe/Riga": "LV", "Europe/Vilnius": "LT",
  "Europe/Berlin": "DE", "Europe/Paris": "FR", "Europe/Amsterdam": "NL",
  "Europe/Brussels": "BE", "Europe/Luxembourg": "LU", "Europe/Zurich": "CH",
  "Europe/Vienna": "AT", "Europe/Dublin": "IE", "Europe/London": "GB",
  "Europe/Madrid": "ES", "Europe/Lisbon": "PT", "Europe/Rome": "IT",
  "Europe/Athens": "GR", "Asia/Nicosia": "CY", "Europe/Nicosia": "CY",
  "Africa/Johannesburg": "ZA", "Africa/Lagos": "NG", "Africa/Nairobi": "KE",
  "Africa/Casablanca": "MA",
  "America/New_York": "US", "America/Chicago": "US", "America/Denver": "US",
  "America/Los_Angeles": "US", "America/Phoenix": "US", "America/Anchorage": "US",
  "Pacific/Honolulu": "US", "America/Detroit": "US",
  "America/Toronto": "CA", "America/Vancouver": "CA", "America/Edmonton": "CA",
  "America/Winnipeg": "CA", "America/Halifax": "CA",
  "America/Mexico_City": "MX", "America/Puerto_Rico": "PR",
  "America/Costa_Rica": "CR", "America/Panama": "PA",
  "America/Sao_Paulo": "BR", "America/Bogota": "CO", "America/Lima": "PE",
  "America/Santiago": "CL", "America/Argentina/Buenos_Aires": "AR",
  "America/Montevideo": "UY", "America/Asuncion": "PY", "America/Caracas": "VE",
  "America/La_Paz": "BO", "America/Guayaquil": "EC",
  "Australia/Sydney": "AU", "Australia/Melbourne": "AU", "Australia/Brisbane": "AU",
  "Australia/Perth": "AU", "Australia/Adelaide": "AU", "Pacific/Auckland": "NZ"
}

// Read the country out of `localCountryCommand` output. Timezone wins over
// locale; returns "" when neither is conclusive (callers then use a global
// spread instead of guessing).
function parseLocalCountry(raw) {
  var body = text(raw)
  var tz = matchLine(body, /^TZ=(.*)$/m)
  if (tz !== "" && TZ_COUNTRIES.hasOwnProperty(tz)) return TZ_COUNTRIES[tz]

  var loc = matchLine(body, /^LOCALE=(.*)$/m)
  // e.g. en_IN.UTF-8 / de_DE@euro -> IN / DE. "C" and "POSIX" carry no country.
  var m = loc.match(/^[A-Za-z]{2,3}_([A-Za-z]{2})\b/)
  if (m) {
    var cc = m[1].toUpperCase()
    if (COUNTRY_NAMES.hasOwnProperty(cc)) return cc
  }
  return ""
}

// --- coarse geography ------------------------------------------------------
// Approximate country centroids (degrees). Physical distance is the dominant
// term in internet RTT, so ordering candidates by great-circle distance is a
// far better shortlist than any hand-written "region" adjacency: an earlier
// region/round-robin version picked Indonesia over Singapore for an Indian user
// purely because of alphabetical order inside the region bucket. Precision does
// not matter much -- the ping probe does the real ranking -- but ORDER does.
var COUNTRY_COORDS = {
  AE: [24.0, 54.0], AL: [41.0, 20.0], AM: [40.2, 45.0], AR: [-34.0, -64.0],
  AT: [47.5, 14.0], AU: [-25.0, 134.0], AZ: [40.4, 47.9], BA: [44.0, 18.0],
  BE: [50.8, 4.5], BG: [42.7, 25.5], BO: [-17.0, -65.0], BR: [-10.0, -52.0],
  CA: [56.0, -106.0], CH: [46.8, 8.2], CL: [-33.0, -71.0], CO: [4.6, -74.1],
  CR: [9.9, -84.1], CY: [35.1, 33.4], CZ: [49.8, 15.5], DE: [51.0, 10.0],
  DK: [56.0, 10.0], EC: [-1.8, -78.2], EE: [58.6, 25.0], ES: [40.0, -4.0],
  FI: [62.0, 26.0], FR: [46.6, 2.4], GB: [54.0, -2.0], GE: [42.0, 43.5],
  GR: [39.0, 22.0], HK: [22.3, 114.2], HR: [45.1, 15.5], HU: [47.2, 19.5],
  ID: [-2.5, 118.0], IE: [53.4, -8.0], IL: [31.5, 34.8], IN: [22.0, 79.0],
  IS: [65.0, -18.0], IT: [42.8, 12.6], JP: [36.2, 138.3], KH: [12.6, 104.9],
  KR: [36.5, 127.9], KZ: [48.0, 68.0], LT: [55.2, 23.9], LU: [49.8, 6.1],
  LV: [56.9, 24.6], MA: [31.8, -7.1], MX: [23.6, -102.6], MY: [4.2, 102.0],
  NG: [9.1, 8.7], NL: [52.1, 5.3], NO: [61.0, 9.0], NZ: [-41.0, 174.0],
  PE: [-9.2, -75.0], PL: [52.0, 19.4], PR: [18.2, -66.5], PT: [39.4, -8.2],
  RO: [45.9, 25.0], RS: [44.0, 20.9], RU: [60.0, 90.0], SE: [62.0, 15.0],
  SG: [1.35, 103.8], SI: [46.1, 14.8], SK: [48.7, 19.7], TR: [39.0, 35.2],
  TW: [23.7, 121.0], UA: [48.4, 31.2], US: [39.8, -98.6], VN: [14.1, 108.3],
  XK: [42.6, 20.9], ZA: [-29.0, 24.7], BD: [23.7, 90.4], BY: [53.7, 27.9],
  CN: [35.0, 105.0], EG: [26.8, 30.8], KE: [0.2, 37.9], LK: [7.9, 80.8],
  MD: [47.4, 28.4], ME: [42.7, 19.4], MK: [41.6, 21.7], NP: [28.4, 84.1],
  PA: [8.5, -80.8], PH: [12.9, 121.8], PK: [30.4, 69.3], PY: [-23.4, -58.4],
  TH: [15.9, 101.0], UY: [-32.5, -55.8], UZ: [41.4, 64.6], VE: [6.4, -66.6]
}

// Used when we cannot tell where the user is: a deliberately spread-out set so
// the probe still samples every continent instead of guessing one.
var WORLD_BEACONS = ["DE", "GB", "US", "SG", "JP", "AE", "IN", "AU", "BR", "ZA"]

// Great-circle distance in km; Infinity when either country is off the map.
function countryDistanceKm(a, b) {
  var p = COUNTRY_COORDS[text(a).toUpperCase()]
  var q = COUNTRY_COORDS[text(b).toUpperCase()]
  if (!p || !q) return Infinity
  var toRad = Math.PI / 180
  var lat1 = p[0] * toRad, lat2 = q[0] * toRad
  var dLat = (q[0] - p[0]) * toRad
  var dLon = (q[1] - p[1]) * toRad
  var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

// Order the AVAILABLE countries by physical closeness to the user, nearest
// first. The user's own country leads (distance 0 anyway, but made explicit).
// When we cannot tell where the user is, lead with globally-spread beacons so
// the probe still samples every continent, then everything else.
function nearestCountries(userCc, available) {
  var list = (Array.isArray(available) ? available : [])
    .map(function (c) { return text(c).toUpperCase() })
    .filter(function (c) { return /^[A-Z]{2}$/.test(c) })
  // De-duplicate while preserving the caller's order.
  var uniq = []
  var seen = {}
  for (var i = 0; i < list.length; i++) {
    if (!seen[list[i]]) { seen[list[i]] = true; uniq.push(list[i]) }
  }

  var home = text(userCc).toUpperCase()
  var out = []
  var taken = {}
  function take(cc) {
    if (!cc || taken[cc]) return
    taken[cc] = true
    out.push(cc)
  }

  if (COUNTRY_COORDS.hasOwnProperty(home)) {
    if (uniq.indexOf(home) >= 0) take(home)
    var rest = uniq.filter(function (cc) { return !taken[cc] })
    // Stable sort: distance first, then a deterministic tiebreak so the same
    // pool always produces the same plan.
    rest.sort(function (a, b) {
      var da = countryDistanceKm(home, a)
      var db = countryDistanceKm(home, b)
      if (da === db) return a.localeCompare(b)
      return da - db
    })
    rest.forEach(take)
  } else {
    WORLD_BEACONS.forEach(function (cc) { if (uniq.indexOf(cc) >= 0) take(cc) })
    uniq.forEach(take)
  }
  return out
}

// --- gateway rows ----------------------------------------------------------

// Pull probeable gateways out of a `gateway list` table.
//
// Parsing is regex-based on purpose: real gateway NAMES contain "|"
// ("super6 Australia | AU1"), so splitting the markdown row on the column
// separator mis-aligns the fields. Instead we pick the country out of the
// "City [CC]" location cell, the IPv4 out of the Exit IPv4 cell, and the
// performance/uptime out of "High (load: Low, uptime: 97%)" -- all of which are
// unambiguous wherever they land in the row. Rows without an IPv4 (IPv6-only /
// header / separator) are skipped.
function parseGatewayHosts(raw) {
  var lines = String(raw === undefined || raw === null ? "" : raw).split("\n")
  var out = []
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    var cc = line.match(/\[([A-Za-z]{2})\]/)
    if (!cc) continue
    var ip = line.match(/\b((?:\d{1,3}\.){3}\d{1,3})\b/)
    if (!ip || !isIpv4(ip[1])) continue
    var perf = line.match(/\b(High|Medium|Low)\s*\(\s*load:\s*\w+,\s*uptime:\s*(\d+)\s*%/i)
    // The identity is the first cell; base58 keys cannot be confused with the
    // IPs or the build version, and no name has reached 32 base58-only chars.
    var id = line.match(/(?:^|\|)\s*([1-9A-HJ-NP-Za-km-z]{32,50})\s*(?:\||\s{2})/)
    if (!id) continue
    out.push({
      id: id[1],
      cc: cc[1].toUpperCase(),
      ip: ip[1],
      performance: perf ? (perf[1].charAt(0).toUpperCase() + perf[1].slice(1).toLowerCase()) : "",
      uptime: perf ? parseInt(perf[2], 10) : 0
    })
  }
  return out
}

function isIpv4(value) {
  var v = text(value)
  var parts = v.split(".")
  if (parts.length !== 4) return false
  for (var i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return false
    var n = parseInt(parts[i], 10)
    if (n < 0 || n > 255) return false
  }
  return true
}

// --- probe plan ------------------------------------------------------------

// Decide who to ping: a bounded shortlist of nearby countries, and a couple of
// healthy gateways in each. Prefers High-performance, >=95% uptime gateways but
// RELAXES that filter rather than returning an empty plan -- an empty plan would
// silently strand the user on the slow Auto pick.
function probePlan(userCc, hosts, opts) {
  var o = opts || {}
  var maxCountries = typeof o.maxCountries === "number" ? o.maxCountries : PROBE_MAX_COUNTRIES
  var perCountry = typeof o.perCountry === "number" ? o.perCountry : PROBE_PER_COUNTRY
  var minUptime = typeof o.minUptime === "number" ? o.minUptime : PROBE_MIN_UPTIME
  var list = Array.isArray(hosts) ? hosts : []
  if (list.length === 0) return { countries: [], hosts: [] }

  var byCountry = {}
  var available = []
  list.forEach(function (h) {
    var cc = text(h && h.cc).toUpperCase()
    if (!/^[A-Z]{2}$/.test(cc) || !isIpv4(h && h.ip)) return
    if (!byCountry[cc]) { byCountry[cc] = []; available.push(cc) }
    byCountry[cc].push(h)
  })
  if (available.length === 0) return { countries: [], hosts: [] }

  var ordered = nearestCountries(userCc, available)
  var countries = ordered.slice(0, maxCountries)

  var chosen = []
  countries.forEach(function (cc) {
    var pool = byCountry[cc] || []
    var good = pool.filter(function (h) {
      return h.performance === "High" && h.uptime >= minUptime
    })
    // Relax in two steps: healthy-uptime first, then anything at all.
    if (good.length === 0) good = pool.filter(function (h) { return h.uptime >= minUptime })
    if (good.length === 0) good = pool
    good.slice(0, perCountry).forEach(function (h) {
      chosen.push({ cc: cc, ip: h.ip, id: h.id })
    })
  })
  return { countries: countries, hosts: chosen }
}

// --- probe execution -------------------------------------------------------

// Build ONE shell command that pings every planned host concurrently and prints
// a single short line per host.
//
// Design notes:
//  * One process, not N QML Processes: the shell fans out with `&` + `wait`, so
//    a six-country probe finishes in about the time of the slowest single ping.
//  * Each worker reduces its ping to "RTT <CC> <IP> <avg|fail>" BEFORE echoing.
//    A short single write stays under PIPE_BUF, so concurrent writers cannot
//    interleave and corrupt each other's lines.
//  * `-w 3` bounds the whole thing; a dead gateway costs 3s, not a hang.
//  * cc/ip are re-validated here: they come from CLI output (untrusted input)
//    and are interpolated into a shell script.
function probeCommand(plan) {
  var p = plan || {}
  var hosts = Array.isArray(p.hosts) ? p.hosts : []
  var parts = []
  for (var i = 0; i < hosts.length; i++) {
    var cc = text(hosts[i] && hosts[i].cc).toUpperCase()
    var ip = text(hosts[i] && hosts[i].ip)
    if (!/^[A-Z]{2}$/.test(cc)) continue
    if (!isIpv4(ip)) continue
    parts.push("p " + cc + " " + ip + " &")
  }
  if (parts.length === 0) return null
  var fn = "p(){ a=$(ping -n -c 2 -W 1 -w 3 \"$2\" 2>/dev/null | " +
           "awk -F'/' '/^(rtt|round-trip)/{print $5}'); " +
           "echo \"RTT $1 $2 ${a:-fail}\"; }; "
  return sh(fn + parts.join(" ") + " wait")
}

// Is a latency probe meaningful right now?
//
// While the tunnel is up, nym's killswitch policy-routes EVERY packet into the
// tunnel interface (ip rule -> table 333); a plain `ping` to a gateway IP is
// therefore answered via entry -> exit -> target, and `ping -I <wifi>` is
// dropped outright. Measured on a live IN -> SG tunnel: Cambodia 275ms and
// Malaysia 268ms "beat" gateways in the user's own country at 443ms, purely
// because the packets left from Singapore. Those numbers rank distance from the
// EXIT, not from the user, so we refuse to probe and fall back to geography.
function canProbe(state) {
  var s = text(state).toLowerCase()
  return !(s === "connected" || s === "connecting" || s === "disconnecting")
}

function probeSkipReason(state) {
  if (canProbe(state)) return ""
  // We deliberately do NOT apply an unmeasured guess here: the user asked for
  // the MEASURED fastest route, and applying a guess would both rebuild the
  // tunnel and potentially replace an already-measured, better selection.
  return "Disconnect first to measure real latency \u2014 while the tunnel is up every probe is routed through it, so the result would rank the exit's neighbours, not yours. Nothing was changed."
}

// Parse the probe output. Unreachable hosts come back as rtt null -- never 0,
// which would otherwise make a dead gateway look like the fastest one.
//
// Pass the plan to rejoin each result with its gateway identity: the probe
// script deliberately echoes only "RTT <CC> <IP> <ms>" so that every concurrent
// writer's line stays short enough to be atomic on the pipe, so the id has to
// come back from the plan we started with.
function parseProbeResults(raw, plan) {
  var body = String(raw === undefined || raw === null ? "" : raw)
  var ids = {}
  var planHosts = (plan && Array.isArray(plan.hosts)) ? plan.hosts : []
  planHosts.forEach(function (h) {
    if (h && isIpv4(h.ip) && isGatewayId(h.id)) ids[text(h.ip)] = text(h.id)
  })
  var re = /^RTT\s+([A-Za-z]{2})\s+((?:\d{1,3}\.){3}\d{1,3})\s+(\S+)\s*$/gm
  var out = []
  var m
  while ((m = re.exec(body)) !== null) {
    var value = parseFloat(m[3])
    out.push({
      cc: m[1].toUpperCase(),
      ip: m[2],
      id: ids.hasOwnProperty(m[2]) ? ids[m[2]] : "",
      rtt: (isFinite(value) && value > 0) ? value : null
    })
  }
  return out
}

// --- choosing ---------------------------------------------------------------

// Rank the probe results and pick an entry and an exit.
//
// The best-measured country becomes the entry hop (it is the one your packets
// must reach directly, so its RTT dominates). The exit defaults to the next
// best DISTINCT country, matching NymVPN's own "entry and exit should differ"
// posture; pass distinctCountries:false to allow both hops in one country.
//
// When nothing answered (killswitch, ICMP filtered, offline) we fall back to the
// geographic order instead of giving up -- still far better than a worldwide
// random pick -- and report measured:false so the UI can say so honestly.
function pickFastest(results, opts) {
  var o = opts || {}
  var distinct = o.distinctCountries !== false
  var list = Array.isArray(results) ? results : []

  var best = {}
  var bestId = {}
  var order = []
  list.forEach(function (r) {
    var cc = text(r && r.cc).toUpperCase()
    if (!/^[A-Z]{2}$/.test(cc)) return
    if (order.indexOf(cc) < 0) order.push(cc)
    var rtt = (r && typeof r.rtt === "number" && isFinite(r.rtt)) ? r.rtt : null
    if (rtt === null) return
    if (!best.hasOwnProperty(cc) || rtt < best[cc]) {
      best[cc] = rtt
      // Remember WHICH node won, so the caller can pin it instead of letting
      // the daemon re-roll inside the country.
      bestId[cc] = isGatewayId(r && r.id) ? text(r.id) : ""
    }
  })

  var ranked = Object.keys(best).sort(function (a, b) { return best[a] - best[b] })

  if (ranked.length > 0) {
    var entry = ranked[0]
    var exit = entry
    if (distinct && ranked.length > 1) exit = ranked[1]
    return {
      entry: entry,
      exit: exit,
      entryId: bestId[entry] || "",
      exitId: bestId[exit] || "",
      entryRtt: best[entry],
      exitRtt: best[exit],
      measured: true,
      ranked: ranked.map(function (cc) {
        return { cc: cc, rtt: best[cc], id: bestId[cc] || "" }
      })
    }
  }

  var fallback = Array.isArray(o.fallbackOrder) && o.fallbackOrder.length > 0
    ? o.fallbackOrder.map(function (c) { return text(c).toUpperCase() })
    : order
  if (fallback.length === 0) {
    return { entry: "", exit: "", entryId: "", exitId: "", entryRtt: null, exitRtt: null, measured: false, ranked: [] }
  }
  var fEntry = fallback[0]
  var fExit = (distinct && fallback.length > 1) ? fallback[1] : fEntry
  return {
    entry: fEntry, exit: fExit,
    // Nothing was measured, so there is no evidence for pinning a single node;
    // fall back to the country constraint, which is the robust choice.
    entryId: "", exitId: "",
    entryRtt: null, exitRtt: null,
    measured: false,
    // Still ranked (by geography), so callers can pick "the next best one that
    // isn't the other hop's country" exactly as they do for measured results.
    ranked: fallback.map(function (cc) { return { cc: cc, rtt: null, id: "" } })
  }
}

// One-line description of a resolved Fastest route for the panel.
function fastestSummary(result) {
  var r = result || {}
  var e = text(r.entry).toUpperCase()
  var x = text(r.exit).toUpperCase()
  if (e === "" && x === "") return ""
  function pretty(v) {
    if (v === "") return "?"
    return countryFlag(v) + " " + countryName(v)
  }
  var line = pretty(e) + "  \u2192  " + pretty(x)
  if (r.measured === true && typeof r.entryRtt === "number") {
    line += "  \u00b7  " + Math.round(r.entryRtt) + " ms"
  }
  return line
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
    reconnectCommand: reconnectCommand,
    accountSetupHint: accountSetupHint,
    accountForgetCommand: accountForgetCommand,
    setTwoHopCommand: setTwoHopCommand,
    setCountriesCommand: setCountriesCommand,
    setGatewaysCommand: setGatewaysCommand,
    isGatewayId: isGatewayId,
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
    modeLabel: modeLabel,
    lanGetCommand: lanGetCommand,
    setLanCommand: setLanCommand,
    parseLan: parseLan,
    lanLabel: lanLabel,
    isFastest: isFastest,
    localCountryCommand: localCountryCommand,
    parseLocalCountry: parseLocalCountry,
    parseGatewayHosts: parseGatewayHosts,
    nearestCountries: nearestCountries,
    probePlan: probePlan,
    probeCommand: probeCommand,
    parseProbeResults: parseProbeResults,
    pickFastest: pickFastest,
    canProbe: canProbe,
    probeSkipReason: probeSkipReason,
    countryDistanceKm: countryDistanceKm,
    fastestSummary: fastestSummary
  }
}
