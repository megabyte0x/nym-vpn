"use strict"

// Pure-logic tests for Model.js. Run with: node tests/model-test.js
const assert = require("assert")
const fs = require("fs")
const path = require("path")
const M = require(path.join(__dirname, "..", "Model.js"))

const WG_LIST = fs.readFileSync(
  path.join(__dirname, "fixtures", "gateway-list-wg.md"), "utf8")

let passed = 0
function test(name, fn) {
  fn()
  passed++
  console.log("ok - " + name)
}

// --- command builders ---
test("statusCommand shells nym-vpnc status with stderr capture", () => {
  const c = M.statusCommand()
  assert.deepStrictEqual(c.slice(0, 2), ["sh", "-c"])
  assert.ok(c[2].includes("nym-vpnc status"))
  assert.ok(c[2].includes("2>&1"))
})

test("connect/disconnect commands", () => {
  assert.ok(M.connectCommand()[2].includes("nym-vpnc connect"))
  assert.ok(M.disconnectCommand()[2].includes("nym-vpnc disconnect"))
})

test("the model exposes NO command builder that accepts a recovery phrase", () => {
  // Security contract: the plugin must never place the mnemonic in nym-vpnc's
  // argv. Login is delegated to the user's own terminal, so these builders
  // must not exist on the module surface.
  assert.strictEqual(M.accountSetCommand, undefined)
  assert.strictEqual(M.looksLikeMnemonic, undefined)
  assert.strictEqual(M.normalizePhrase, undefined)
})

test("accountSetupHint is a phrase-free instruction, not a runnable secret", () => {
  const hint = M.accountSetupHint()
  assert.strictEqual(typeof hint, "string")
  assert.ok(hint.includes("nym-vpnc account set"))
  // It is a placeholder the user completes themselves, never an actual phrase
  // or a shell-executable argv the panel runs.
  assert.ok(hint.includes("<your recovery phrase>"))
  assert.ok(!Array.isArray(hint))
})

test("accountForgetCommand", () => {
  assert.ok(M.accountForgetCommand()[2].includes("account forget"))
})

test("setTwoHopCommand toggles on/off", () => {
  assert.ok(M.setTwoHopCommand(true)[2].includes("tunnel set --two-hop on"))
  assert.ok(M.setTwoHopCommand(false)[2].includes("tunnel set --two-hop off"))
})

test("setCountriesCommand builds entry/exit and rejects junk", () => {
  assert.strictEqual(M.setCountriesCommand("", ""), null)
  assert.strictEqual(M.setCountriesCommand("USA", ""), null)
  assert.ok(M.setCountriesCommand("us", "")[2].includes("--entry-country US"))
  const both = M.setCountriesCommand("us", "de")[2]
  assert.ok(both.includes("--entry-country US"))
  assert.ok(both.includes("--exit-country DE"))
})

test("isCountryCode validates two-letter codes", () => {
  assert.ok(M.isCountryCode("US"))
  assert.ok(M.isCountryCode("de"))
  assert.ok(!M.isCountryCode("USA"))
  assert.ok(!M.isCountryCode("1"))
  assert.ok(!M.isCountryCode(""))
})

// --- status parsing ---
test("parseStatus connected", () => {
  const s = M.parseStatus("State: Connected", 0)
  assert.strictEqual(s.state, "connected")
  assert.strictEqual(s.connected, true)
})

test("parseStatus disconnected is not confused with connected", () => {
  const s = M.parseStatus("State: Disconnected", 0)
  assert.strictEqual(s.state, "disconnected")
  assert.strictEqual(s.connected, false)
})

test("parseStatus disconnecting vs connecting ordering", () => {
  assert.strictEqual(M.parseStatus("State: Disconnecting", 0).state, "disconnecting")
  assert.strictEqual(M.parseStatus("State: Connecting", 0).state, "connecting")
  assert.strictEqual(M.parseStatus("State: Connecting", 0).busy, true)
})

test("parseStatus offline and error", () => {
  assert.strictEqual(M.parseStatus("State: Offline { reconnect: true }", 0).state, "offline")
  assert.strictEqual(M.parseStatus("State: Error( Api )", 0).state, "error")
})

test("parseStatus detects missing CLI", () => {
  const s = M.parseStatus("sh: line 1: nym-vpnc: command not found", 127)
  assert.strictEqual(s.state, "not-installed")
})

test("parseStatus detects daemon down", () => {
  const s = M.parseStatus("Failed to create RPC client: transport error: Connection refused", 1)
  assert.strictEqual(s.state, "daemon-down")
})

test("parseStatus detects authentication required (not daemon-down)", () => {
  const raw = "Error: Failed to create RPC client\n\nCaused by:\n    Authentication is required to access the daemon"
  const s = M.parseStatus(raw, 1)
  assert.strictEqual(s.state, "auth-required")
  assert.strictEqual(s.authRequired, true)
})

test("parseStatus empty non-zero exit -> daemon-down", () => {
  assert.strictEqual(M.parseStatus("", 1).state, "daemon-down")
})

test("parseStatus keeps a readable reason for an error state", () => {
  // The panel showed a bare "Error" with no reason and no next step; the cause
  // was parsed all along but never surfaced.
  const s = M.parseStatus("State: Error state: ConnectionAttemptsExceeded", 0)
  assert.strictEqual(s.state, "error")
  assert.ok(/ConnectionAttemptsExceeded/.test(s.detail), s.detail)
})

test("errorHint explains the common failures and what to do", () => {
  const h = M.errorHint("Error state: ConnectionAttemptsExceeded")
  assert.ok(/gateway|network/i.test(h), h)
  assert.ok(/connect/i.test(h), h)          // tells the user how to recover
  // A pinned gateway that has gone away is worth calling out specifically,
  // because the fix is to change region rather than to retry forever.
  assert.ok(/region|gateway/i.test(M.errorHint("Error state: NoMatchingGateway")))
  // Unknown errors get no invented advice.
  assert.strictEqual(M.errorHint("Error state: SomethingBrandNew"), "")
  assert.strictEqual(M.errorHint(""), "")
})

// --- colour + glyph mapping ---
test("stateColorRole mapping", () => {
  assert.strictEqual(M.stateColorRole("connected"), "ok")
  assert.strictEqual(M.stateColorRole("connecting"), "busy")
  assert.strictEqual(M.stateColorRole("error"), "bad")
  assert.strictEqual(M.stateColorRole("daemon-down"), "bad")
  assert.strictEqual(M.stateColorRole("auth-required"), "busy")
  assert.strictEqual(M.stateColorRole("disconnected"), "idle")
})

test("stateGlyph returns a non-empty glyph", () => {
  assert.ok(M.stateGlyph("connected").length >= 1)
  assert.ok(M.stateGlyph("disconnected").length >= 1)
})

// --- account parsing ---
test("parseAccount stored", () => {
  const raw = [
    "Account identity: nym1abcdef",
    "Canonical Account identity: nym1abcdef",
    "Account mode: Vpn",
    "Account state: Active"
  ].join("\n")
  const a = M.parseAccount(raw)
  assert.strictEqual(a.stored, true)
  assert.strictEqual(a.identity, "nym1abcdef")
  assert.strictEqual(a.state, "Active")
  assert.strictEqual(a.mode, "Vpn")
})

test("parseAccount unset -> not stored", () => {
  const a = M.parseAccount("Account identity: unset\nAccount state: NotRegistered")
  assert.strictEqual(a.stored, false)
})

// --- tunnel + gateway parsing ---
test("parseTwoHop reads on/off", () => {
  assert.strictEqual(M.parseTwoHop("two-hop: on"), true)
  assert.strictEqual(M.parseTwoHop("Two Hop: off"), false)
  assert.strictEqual(M.parseTwoHop("ipv6: on"), null)
})

test("parseGateway reads entry/exit points", () => {
  const g = M.parseGateway("Entry point: Country(US)\nExit point: Country(DE)\nResidential exit: off")
  assert.strictEqual(g.entry, "Country(US)")
  assert.strictEqual(g.exit, "Country(DE)")
})

test("modeLabel", () => {
  assert.strictEqual(M.modeLabel(true), "Fast (2-hop WireGuard)")
  assert.strictEqual(M.modeLabel(false), "Anonymous (5-hop mixnet)")
  assert.ok(M.modeLabel(null).toLowerCase().includes("unknown"))
})

// --- country picker helpers ---
test("gatewayListCommand picks the right pool and captures stderr", () => {
  assert.ok(M.gatewayListCommand("wg")[2].includes("gateway list wg"))
  assert.ok(M.gatewayListCommand("mixnet-entry")[2].includes("gateway list mixnet-entry"))
  assert.ok(M.gatewayListCommand("mixnet-exit")[2].includes("gateway list mixnet-exit"))
  // Unknown type falls back to a safe default rather than injecting junk.
  assert.ok(M.gatewayListCommand("bogus")[2].includes("gateway list mixnet-entry"))
  assert.ok(M.gatewayListCommand("wg")[2].includes("2>&1"))
})

test("entry/exit gateway types follow the mode", () => {
  assert.strictEqual(M.entryGatewayType(true), "wg")
  assert.strictEqual(M.exitGatewayType(true), "wg")
  assert.strictEqual(M.entryGatewayType(false), "mixnet-entry")
  assert.strictEqual(M.exitGatewayType(false), "mixnet-exit")
})

test("setGatewayCommand handles country / auto / random per hop", () => {
  assert.ok(M.setGatewayCommand("entry", "us")[2].includes("--entry-country US"))
  assert.ok(M.setGatewayCommand("exit", "DE")[2].includes("--exit-country DE"))
  assert.ok(M.setGatewayCommand("entry", "auto")[2].includes("--entry-auto-exclude-jurisdiction on"))
  assert.ok(M.setGatewayCommand("exit", "random")[2].includes("--exit-random"))
  assert.strictEqual(M.setGatewayCommand("entry", "nonsense"), null)
  assert.strictEqual(M.setGatewayCommand("middle", "us"), null)
})

test("countryName maps codes and falls back to the raw code", () => {
  assert.strictEqual(M.countryName("us"), "United States")
  assert.strictEqual(M.countryName("DE"), "Germany")
  assert.strictEqual(M.countryName("ZZ"), "ZZ")
})

test("countryFlag builds regional-indicator emoji", () => {
  assert.strictEqual(M.countryFlag("US"), "\uD83C\uDDFA\uD83C\uDDF8")
  assert.strictEqual(M.countryFlag("de"), "\uD83C\uDDE9\uD83C\uDDEA")
  assert.strictEqual(M.countryFlag("1"), "")
})

test("parseGatewayCountries extracts unique codes sorted by name", () => {
  const raw = [
    "| ID | Name | Location |",
    "| a | x | Dubai [AE] |",
    "| b | y | Vienna [AT] |",
    "| c | z | Berlin [DE] |",
    "| d | w | Munich [DE] |"
  ].join("\n")
  const codes = M.parseGatewayCountries(raw)
  assert.deepStrictEqual(codes, ["AT", "DE", "AE"]) // Austria, Germany, United Arab Emirates
})

test("countryOptions leads with the smart choices then flagged countries", () => {
  const opts = M.countryOptions(["US", "DE"])
  assert.strictEqual(opts[0].value, "auto")
  assert.strictEqual(opts[1].value, "fastest")
  assert.strictEqual(opts[2].value, "random")
  assert.strictEqual(opts[3].value, "US")
  assert.ok(opts[3].label.includes("United States"))
  assert.strictEqual(opts[3].description, "US") // searchable by bare code
})

test("gatewaySelection collapses raw points to selector values", () => {
  assert.strictEqual(M.gatewaySelection("Country(US)"), "US")
  assert.strictEqual(M.gatewaySelection("Auto { exclude_user_country: true }"), "auto")
  assert.strictEqual(M.gatewaySelection(""), "")
})

test("parseStatusGateways reads the gateways the tunnel is ACTUALLY using", () => {
  // A gateway constraint only takes effect on a NEW tunnel. Reading the live
  // route from `status` is what stops the panel claiming "Auto (excluding your
  // country)" while the user is still connected through their own country.
  const raw = "State: Connected wg to 217.217.251.116:51822 " +
    "[528Ui84hipYbnFA4ZBJqcex99kT6pgkRxs5jpEczcbHa] \u2192 160.30.5.58:51822 " +
    "[BKch6LUUTR9nU7AZZgGwiukasfJ4pFMuPJL95exCMpCR]"
  assert.deepStrictEqual(M.parseStatusGateways(raw), {
    entry: "528Ui84hipYbnFA4ZBJqcex99kT6pgkRxs5jpEczcbHa",
    exit: "BKch6LUUTR9nU7AZZgGwiukasfJ4pFMuPJL95exCMpCR"
  })
  assert.deepStrictEqual(M.parseStatusGateways("State: Disconnected"), { entry: "", exit: "" })
  assert.deepStrictEqual(M.parseStatusGateways(""), { entry: "", exit: "" })
})

test("liveRouteSummary names the countries actually in use", () => {
  const hosts = M.parseGatewayHosts(WG_LIST)
  const raw = "State: Connected wg to 1.2.3.4:51822 " +
    "[528Ui84hipYbnFA4ZBJqcex99kT6pgkRxs5jpEczcbHa] \u2192 5.6.7.8:51822 " +
    "[2BDCzDG2ykdykTKRB8XVsEekHftv7oQ3TUrzsDxTWaxs]"
  const s = M.liveRouteSummary(raw, hosts)
  assert.ok(s.includes("India"), s)
  assert.ok(s.includes("Singapore"), s)
  // Nothing to report when no tunnel is up: caller falls back to the config.
  assert.strictEqual(M.liveRouteSummary("State: Disconnected", hosts), "")
  // Unknown gateways must not be invented.
  assert.strictEqual(M.liveRouteSummary(raw, []), "")
})

test("selectionSatisfied knows that Auto EXCLUDES your own country", () => {
  // The bug this encodes: "auto" was treated as "anything satisfies it", so
  // switching the entry to Auto while connected never rebuilt the tunnel and
  // the user stayed on the previously pinned gateway in their own country --
  // the panel said Auto, the traffic said India.
  assert.strictEqual(M.selectionSatisfied("auto", "KH", "IN"), true)
  assert.strictEqual(M.selectionSatisfied("auto", "IN", "IN"), false)
  // Explicit country: only that country satisfies it.
  assert.strictEqual(M.selectionSatisfied("SG", "SG", "IN"), true)
  assert.strictEqual(M.selectionSatisfied("SG", "MY", "IN"), false)
  // Random accepts any gateway, so it is always satisfied. Re-rolling when the
  // user re-picks Random is a reconnect decision, not a mismatch.
  assert.strictEqual(M.selectionSatisfied("random", "SG", "IN"), true)
  // Nothing selected, or nothing live to compare against.
  assert.strictEqual(M.selectionSatisfied("", "SG", "IN"), true)
  assert.strictEqual(M.selectionSatisfied("SG", "", "IN"), true)
  // Unknown home country: Auto cannot be judged, so do not cry wolf.
  assert.strictEqual(M.selectionSatisfied("auto", "IN", ""), true)
})

test("routeMismatchNotice flags an Auto entry sitting in your own country", () => {
  const n = M.routeMismatchNotice({ entry: "auto", exit: "auto" }, { entry: "IN", exit: "MY" }, "IN")
  assert.ok(/India/.test(n), n)
  assert.ok(/auto/i.test(n), n)
  // Auto satisfied by a foreign gateway -> silent.
  assert.strictEqual(M.routeMismatchNotice({ entry: "auto", exit: "auto" }, { entry: "KH", exit: "MY" }, "IN"), "")
})

test("routeMismatchNotice reports when the tunnel is not on the selected region", () => {
  // Defence in depth: if anything (a stray selection, a daemon fallback) leaves
  // the tunnel on a different region than the one selected, the user must be
  // told rather than left to discover it. This is the exact failure that made
  // the panel claim "Auto, excluding your country" while routing through India.
  const n = M.routeMismatchNotice({ entry: "IN", exit: "SG" }, { entry: "MY", exit: "SG" })
  assert.ok(/India/.test(n) && /Malaysia/.test(n), n)
  assert.ok(/reconnect/i.test(n), n)
})

test("routeMismatchNotice stays quiet when there is nothing to report", () => {
  // Matching route.
  assert.strictEqual(M.routeMismatchNotice({ entry: "IN", exit: "SG" }, { entry: "IN", exit: "SG" }), "")
  // "auto"/"random" mean "anything", so any live country satisfies them.
  assert.strictEqual(M.routeMismatchNotice({ entry: "auto", exit: "auto" }, { entry: "KH", exit: "MY" }), "")
  assert.strictEqual(M.routeMismatchNotice({ entry: "random", exit: "auto" }, { entry: "KH", exit: "MY" }), "")
  // No tunnel up / unknown live route -> nothing to compare.
  assert.strictEqual(M.routeMismatchNotice({ entry: "IN", exit: "SG" }, { entry: "", exit: "" }), "")
  assert.strictEqual(M.routeMismatchNotice({ entry: "", exit: "" }, { entry: "IN", exit: "SG" }), "")
})

test("parseGatewayIdentity reads a pinned gateway key", () => {
  const raw = 'Gateway { identity: NodeIdentity { key: "2BDCzDG2ykdykTKRB8XVsEekHftv7oQ3TUrzsDxTWaxs" } }'
  assert.strictEqual(M.parseGatewayIdentity(raw), "2BDCzDG2ykdykTKRB8XVsEekHftv7oQ3TUrzsDxTWaxs")
  assert.strictEqual(M.parseGatewayIdentity("Country(US)"), "")
  assert.strictEqual(M.parseGatewayIdentity(""), "")
})

test("gatewaySelection resolves a pinned gateway back to its country", () => {
  // Pinning by --entry-id makes `gateway get` report an opaque key. Without
  // resolving it the picker would show "Auto (recommended)" for a route that is
  // in fact pinned to a specific node -- actively misleading.
  const hosts = M.parseGatewayHosts(WG_LIST)
  const pinned = 'Gateway { identity: NodeIdentity { key: "2BDCzDG2ykdykTKRB8XVsEekHftv7oQ3TUrzsDxTWaxs" } }'
  assert.strictEqual(M.gatewaySelection(pinned, hosts), "SG")
  // Unknown key (gateway left the pool) must not masquerade as Auto.
  const unknown = 'Gateway { identity: NodeIdentity { key: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" } }'
  assert.strictEqual(M.gatewaySelection(unknown, hosts), "")
  // Existing behaviour is unchanged when no host table is supplied.
  assert.strictEqual(M.gatewaySelection("Country(US)"), "US")
  assert.strictEqual(M.gatewaySelection("Auto { }"), "auto")
})

test("gatewaySummary names the pinned countries", () => {
  const hosts = M.parseGatewayHosts(WG_LIST)
  const s = M.gatewaySummary({
    entry: 'Gateway { identity: NodeIdentity { key: "528Ui84hipYbnFA4ZBJqcex99kT6pgkRxs5jpEczcbHa" } }',
    exit: 'Gateway { identity: NodeIdentity { key: "2BDCzDG2ykdykTKRB8XVsEekHftv7oQ3TUrzsDxTWaxs" } }'
  }, hosts, hosts)
  assert.ok(s.includes("India"), s)
  assert.ok(s.includes("Singapore"), s)
  assert.ok(!s.includes("Auto"), s)
})

test("gatewaySummary renders a friendly route line", () => {
  const s = M.gatewaySummary({ entry: "Country(US)", exit: "Country(DE)" })
  assert.ok(s.includes("United States"))
  assert.ok(s.includes("Germany"))
  assert.ok(s.includes("\u2192"))
  assert.ok(M.gatewaySummary({ entry: "Auto { }", exit: "Auto { }" }).includes("Auto"))
})

// --- local network policy (LAN) ---

test("lanGetCommand reads the daemon's local network policy", () => {
  const c = M.lanGetCommand()
  assert.deepStrictEqual(c.slice(0, 2), ["sh", "-c"])
  assert.ok(c[2].includes("nym-vpnc lan get"))
  assert.ok(c[2].includes("2>&1"))
})

test("setLanCommand maps a boolean onto the allow/block argument", () => {
  assert.ok(M.setLanCommand(true)[2].includes("nym-vpnc lan set allow"))
  assert.ok(M.setLanCommand(false)[2].includes("nym-vpnc lan set block"))
})

test("parseLan reads 'Local network policy: allow|block'", () => {
  assert.strictEqual(M.parseLan("Local network policy: allow"), true)
  assert.strictEqual(M.parseLan("Local network policy: block"), false)
  assert.strictEqual(M.parseLan("Local Network Policy:  BLOCK \n"), false)
})

test("parseLan returns null when the answer is not a policy line", () => {
  assert.strictEqual(M.parseLan(""), null)
  assert.strictEqual(M.parseLan("error: transport error"), null)
})

test("lanLabel describes the policy for the panel", () => {
  assert.ok(M.lanLabel(true).toLowerCase().includes("allow"))
  assert.ok(M.lanLabel(false).toLowerCase().includes("block"))
  assert.ok(M.lanLabel(null).toLowerCase().includes("unknown"))
})

// ---------------------------------------------------------------------------
// Fastest-gateway selection
// ---------------------------------------------------------------------------
// nym-vpnd's Auto is score-weighted (load/uptime) but latency- and geography-
// blind: from India it happily picks entry AE -> exit AZ (measured 474ms RTT,
// 3.0 MB/s) while Mumbai/Singapore gateways sit idle (82ms, 13.1 MB/s). These
// helpers implement a client-side latency probe so "Fastest" can pick for real.

// --- local country detection ---

test("localCountryCommand asks for the timezone and the locale", () => {
  const c = M.localCountryCommand()
  assert.deepStrictEqual(c.slice(0, 2), ["sh", "-c"])
  assert.ok(c[2].includes("timedatectl"))
  assert.ok(c[2].includes("TZ="))
  assert.ok(c[2].includes("LOCALE="))
})

test("parseLocalCountry prefers the timezone over the locale", () => {
  // Real case on this machine: locale says en_US, timezone says Asia/Kolkata.
  // The timezone is where the user physically is, so it must win.
  assert.strictEqual(M.parseLocalCountry("TZ=Asia/Kolkata\nLOCALE=en_US.UTF-8"), "IN")
  assert.strictEqual(M.parseLocalCountry("TZ=Europe/Berlin\nLOCALE="), "DE")
  assert.strictEqual(M.parseLocalCountry("TZ=America/New_York\nLOCALE="), "US")
})

test("parseLocalCountry falls back to the locale territory", () => {
  assert.strictEqual(M.parseLocalCountry("TZ=\nLOCALE=en_IN.UTF-8"), "IN")
  assert.strictEqual(M.parseLocalCountry("TZ=Etc/UTC\nLOCALE=de_DE.UTF-8"), "DE")
})

test("parseLocalCountry returns empty when nothing is knowable", () => {
  assert.strictEqual(M.parseLocalCountry(""), "")
  assert.strictEqual(M.parseLocalCountry("TZ=Etc/UTC\nLOCALE=C"), "")
  assert.strictEqual(M.parseLocalCountry("TZ=Mars/Olympus\nLOCALE=POSIX"), "")
})

// --- gateway host parsing ---

test("parseGatewayHosts extracts country, IP, performance and uptime", () => {
  const hosts = M.parseGatewayHosts(WG_LIST)
  assert.ok(hosts.length >= 20, "expected the fixture's gateway rows")
  const first = hosts[0]
  assert.ok(/^[A-Z]{2}$/.test(first.cc))
  assert.ok(/^\d+\.\d+\.\d+\.\d+$/.test(first.ip))
  assert.ok(["High", "Medium", "Low"].includes(first.performance))
  assert.strictEqual(typeof first.uptime, "number")
})

test("parseGatewayHosts captures the gateway ID so a winner can be pinned", () => {
  // Selecting only a COUNTRY leaves the daemon free to pick any gateway inside
  // it -- measured live: entry IN / exit SG landed on a Contabo SG box at
  // 390ms / 2.5 MB/s while a probed SG gateway answered in 43ms. To actually
  // deliver the measured speed we must be able to pin the exact node.
  const hosts = M.parseGatewayHosts(WG_LIST)
  const known = hosts.find(h => h.ip === "103.167.151.155")
  assert.ok(known, "fixture host present")
  assert.strictEqual(known.id, "2BDCzDG2ykdykTKRB8XVsEekHftv7oQ3TUrzsDxTWaxs")
  hosts.forEach(h => assert.ok(M.isGatewayId(h.id), h.ip + " -> " + h.id))
})

test("isGatewayId accepts base58 identities and rejects junk", () => {
  assert.ok(M.isGatewayId("2BDCzDG2ykdykTKRB8XVsEekHftv7oQ3TUrzsDxTWaxs"))
  assert.ok(!M.isGatewayId(""))
  assert.ok(!M.isGatewayId("short"))
  assert.ok(!M.isGatewayId("has spaces in it aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
  assert.ok(!M.isGatewayId("0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl")) // not base58
})

test("parseGatewayHosts survives '|' inside the Name column", () => {
  // Real gateway names contain pipes ("super6 Australia | AU1"), so column
  // splitting is unsafe; parsing must be regex/positional-independent.
  const hosts = M.parseGatewayHosts(WG_LIST)
  const au = hosts.filter(h => h.cc === "AU")
  assert.ok(au.length >= 3)
  au.forEach(h => assert.ok(/^\d+\.\d+\.\d+\.\d+$/.test(h.ip)))
})

test("parseGatewayHosts ignores the header and version-like numbers", () => {
  const hosts = M.parseGatewayHosts(WG_LIST)
  // The header row has no base58 identity, so it must not become a host.
  assert.ok(!hosts.some(h => h.ip === "" || h.id === ""))
  hosts.forEach(h => assert.notStrictEqual(h.ip, "1.38.0"))
  assert.ok(!hosts.some(h => h.cc === "ID")) // "| ID |" header cell is not a country
})

test("parseGatewayHosts tolerates junk and empty input", () => {
  assert.deepStrictEqual(M.parseGatewayHosts(""), [])
  assert.deepStrictEqual(M.parseGatewayHosts("error: transport error"), [])
})

// --- geographic shortlist ---

test("nearestCountries puts the user's own country first", () => {
  const near = M.nearestCountries("IN", ["US", "DE", "IN", "SG", "AE"])
  assert.strictEqual(near[0], "IN")
})

test("nearestCountries orders by physical distance, nearest first", () => {
  const avail = ["IN", "SG", "AE", "HK", "JP", "AU", "DE", "US", "AZ"]
  const near = M.nearestCountries("IN", avail)
  const head = near.slice(0, 5)
  assert.ok(head.includes("IN"))
  assert.ok(head.includes("SG"), "Singapore is a near neighbour of India")
  assert.ok(head.includes("AE"), "the UAE is a near neighbour of India")
  assert.ok(near.indexOf("IN") < near.indexOf("US"))
  assert.ok(near.indexOf("SG") < near.indexOf("US"))
  assert.ok(near.indexOf("AE") < near.indexOf("US"))
})

test("nearestCountries only ever returns available countries, without repeats", () => {
  const avail = ["DE", "FR", "US"]
  const near = M.nearestCountries("DE", avail)
  near.forEach(c => assert.ok(avail.includes(c)))
  assert.strictEqual(new Set(near).size, near.length)
  assert.strictEqual(near.length, avail.length)
})

test("nearestCountries falls back to a global spread for an unknown country", () => {
  const avail = ["IN", "SG", "DE", "US", "BR", "ZA", "AU", "JP"]
  const near = M.nearestCountries("", avail)
  assert.ok(near.length > 0)
  near.forEach(c => assert.ok(avail.includes(c)))
  assert.strictEqual(new Set(near).size, near.length)
})

// --- probe planning ---

test("probePlan shortlists nearby countries and a couple of hosts each", () => {
  const hosts = M.parseGatewayHosts(WG_LIST)
  const plan = M.probePlan("IN", hosts)
  assert.ok(plan.countries.length > 0 && plan.countries.length <= 6)
  assert.ok(plan.hosts.length <= 12)
  assert.strictEqual(plan.countries[0], "IN")
  // No more than two probes per country keeps the fan-out bounded.
  const perCountry = {}
  plan.hosts.forEach(h => { perCountry[h.cc] = (perCountry[h.cc] || 0) + 1 })
  Object.keys(perCountry).forEach(cc => assert.ok(perCountry[cc] <= 2))
  plan.hosts.forEach(h => assert.ok(plan.countries.includes(h.cc)))
})

test("probePlan prefers High performance, healthy-uptime gateways", () => {
  const hosts = M.parseGatewayHosts(WG_LIST)
  const plan = M.probePlan("IN", hosts)
  const byIp = {}
  hosts.forEach(h => { byIp[h.ip] = h })
  plan.hosts.forEach(h => {
    const full = byIp[h.ip]
    assert.strictEqual(full.performance, "High")
    assert.ok(full.uptime >= 95, h.ip + " uptime " + full.uptime)
  })
})

test("probePlan relaxes the quality filter rather than returning nothing", () => {
  // A pool where every gateway is Low/among unhealthy uptimes must still yield
  // something to probe -- an empty plan would strand the user on Auto.
  const raw = [
    "| 3ts3snXyuyJLw9vCMXfQQ4BWV8nqPzPuVpQFHw1jnAaF | n | Oslo [NO] | Low (load: High, uptime: 60%) | 9.9.9.9 | | 1.38.0 |"
  ].join("\n")
  const plan = M.probePlan("NO", M.parseGatewayHosts(raw))
  assert.strictEqual(plan.hosts.length, 1)
  assert.strictEqual(plan.hosts[0].ip, "9.9.9.9")
})

test("probePlan honours explicit caps", () => {
  const hosts = M.parseGatewayHosts(WG_LIST)
  const plan = M.probePlan("IN", hosts, { maxCountries: 3, perCountry: 1 })
  assert.strictEqual(plan.countries.length, 3)
  assert.ok(plan.hosts.length <= 3)
})

test("probePlan on an empty pool is empty, not a crash", () => {
  const plan = M.probePlan("IN", [])
  assert.deepStrictEqual(plan.countries, [])
  assert.deepStrictEqual(plan.hosts, [])
})

// --- probe execution + parsing ---

test("probeCommand pings every planned host in parallel and tags the country", () => {
  const cmd = M.probeCommand({ countries: ["IN", "SG"], hosts: [
    { cc: "IN", ip: "217.217.251.116" },
    { cc: "SG", ip: "103.167.151.155" }
  ]})
  assert.deepStrictEqual(cmd.slice(0, 2), ["sh", "-c"])
  const script = cmd[2]
  assert.ok(script.includes("ping"))
  assert.ok(script.includes("217.217.251.116"))
  assert.ok(script.includes("103.167.151.155"))
  assert.ok(script.includes("IN"))
  assert.ok(script.includes("SG"))
  assert.ok(script.includes("&"), "probes must run concurrently")
  assert.ok(script.includes("wait"))
})

test("probePlan carries the gateway ID through to the probe", () => {
  const plan = M.probePlan("IN", M.parseGatewayHosts(WG_LIST))
  plan.hosts.forEach(h => assert.ok(M.isGatewayId(h.id), JSON.stringify(h)))
})

test("probeCommand refuses to interpolate anything that is not an IP/ISO pair", () => {
  // Injection guard: values come from CLI output, so they are untrusted input.
  const cmd = M.probeCommand({ countries: ["IN"], hosts: [
    { cc: "IN", ip: "1.2.3.4; rm -rf ~" },
    { cc: "; reboot", ip: "1.2.3.5" },
    { cc: "IN", ip: "1.2.3.6" }
  ]})
  assert.ok(!cmd[2].includes("rm -rf"))
  assert.ok(!cmd[2].includes("reboot"))
  assert.ok(cmd[2].includes("1.2.3.6"))
})

test("probeCommand returns null when there is nothing to probe", () => {
  assert.strictEqual(M.probeCommand({ countries: [], hosts: [] }), null)
  assert.strictEqual(M.probeCommand(null), null)
})

test("parseProbeResults reads the RTT lines", () => {
  const raw = ["RTT IN 217.217.251.116 81.942", "RTT SG 103.167.151.155 12.5"].join("\n")
  const res = M.parseProbeResults(raw)
  assert.deepStrictEqual(res, [
    { cc: "IN", ip: "217.217.251.116", id: "", rtt: 81.942 },
    { cc: "SG", ip: "103.167.151.155", id: "", rtt: 12.5 }
  ])
})

test("parseProbeResults marks unreachable hosts as failed, not fast", () => {
  // A host that does not answer must never be treated as 0ms.
  const res = M.parseProbeResults("RTT IN 1.2.3.4 fail\nRTT SG 5.6.7.8 20.1")
  assert.strictEqual(res[0].rtt, null)
  assert.strictEqual(res[1].rtt, 20.1)
})

test("parseProbeResults rejoins the gateway id from the plan", () => {
  // The probe script only echoes CC/IP/RTT (short lines stay atomic across the
  // concurrent writers), so the identity has to come back from the plan --
  // without this the winner cannot be pinned and the daemon re-rolls the node.
  const plan = { countries: ["IN"], hosts: [
    { cc: "IN", ip: "2.2.2.2", id: "JNbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
  ]}
  const res = M.parseProbeResults("RTT IN 2.2.2.2 30", plan)
  assert.strictEqual(res[0].id, "JNbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
  // Unknown IPs simply have no id rather than borrowing someone else's.
  assert.strictEqual(M.parseProbeResults("RTT IN 9.9.9.9 30", plan)[0].id, "")
  assert.strictEqual(M.parseProbeResults("RTT IN 2.2.2.2 30")[0].id, "")
})

test("parseProbeResults ignores noise around the markers", () => {
  const res = M.parseProbeResults("ping: socket: Operation not permitted\nRTT DE 1.1.1.1 5\n")
  assert.deepStrictEqual(res, [{ cc: "DE", ip: "1.1.1.1", id: "", rtt: 5 }])
  assert.deepStrictEqual(M.parseProbeResults(""), [])
})

// --- when is a probe meaningful? ---

test("canProbe is false while the tunnel is up", () => {
  // Measured on a live tunnel: with entry IN / exit SG, probing Cambodia and
  // Malaysia returned ~270ms while gateways in the user's OWN country returned
  // ~440-590ms -- because every probe actually leaves from the exit gateway in
  // Singapore. Ranking those numbers would pick a gateway for the exit's
  // location, not the user's, so we must not.
  assert.strictEqual(M.canProbe("connected"), false)
  assert.strictEqual(M.canProbe("connecting"), false)
  assert.strictEqual(M.canProbe("disconnecting"), false)
})

test("canProbe is true when traffic still leaves the real interface", () => {
  assert.strictEqual(M.canProbe("disconnected"), true)
  assert.strictEqual(M.canProbe("offline"), true)
  assert.strictEqual(M.canProbe("unknown"), true)
})

test("fastestPhaseLabel narrates the automatic measure-and-switch cycle", () => {
  // Measuring requires the tunnel down, so choosing Fastest while connected
  // runs disconnect -> measure -> apply -> reconnect on its own. Each step is
  // named so the user understands why their tunnel just dropped.
  assert.ok(/disconnect/i.test(M.fastestPhaseLabel("disconnecting")))
  assert.ok(/measur/i.test(M.fastestPhaseLabel("measuring")))
  assert.ok(/apply/i.test(M.fastestPhaseLabel("applying")))
  assert.ok(/reconnect/i.test(M.fastestPhaseLabel("reconnecting")))
  assert.strictEqual(M.fastestPhaseLabel(""), "")
  assert.strictEqual(M.fastestPhaseLabel("bogus"), "")
})

test("measureCycleNotice warns that the tunnel drops briefly", () => {
  const n = M.measureCycleNotice()
  assert.ok(/reconnect/i.test(n), n)
  // Dropping a live tunnel is a privacy event, so it must be stated plainly.
  assert.ok(/disconnect|unprotected|briefly/i.test(n), n)
})

test("probeSkipReason explains the refusal and promises no change", () => {
  const why = M.probeSkipReason("connected")
  assert.ok(/disconnect/i.test(why), why)
  // The user asked for the MEASURED fastest route. Applying an unmeasured
  // guess would rebuild the tunnel and could replace an already-measured,
  // better selection, so the resolve must be a no-op and say so.
  assert.ok(/nothing was changed/i.test(why), why)
  assert.strictEqual(M.probeSkipReason("disconnected"), "")
})

// --- choosing the winners ---

test("pickFastest takes the lowest-latency country for each hop", () => {
  const res = [
    { cc: "AE", ip: "1.1.1.1", rtt: 220 },
    { cc: "IN", ip: "2.2.2.2", rtt: 30 },
    { cc: "IN", ip: "2.2.2.3", rtt: 45 },
    { cc: "SG", ip: "3.3.3.3", rtt: 80 }
  ]
  const pick = M.pickFastest(res)
  assert.strictEqual(pick.entry, "IN")
  assert.strictEqual(pick.entryRtt, 30) // best host of that country, not the worst
  assert.strictEqual(pick.exit, "SG")   // second-best country: hops stay distinct
  assert.strictEqual(pick.exitRtt, 80)
  assert.strictEqual(pick.measured, true)
})

test("pickFastest reports the exact winning gateway, not just its country", () => {
  const res = [
    { cc: "SG", ip: "3.3.3.3", id: "SGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", rtt: 80 },
    { cc: "IN", ip: "2.2.2.2", id: "JNbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", rtt: 45 },
    { cc: "IN", ip: "2.2.2.3", id: "JNccccccccccccccccccccccccccccccccccccccccc", rtt: 30 }
  ]
  const pick = M.pickFastest(res)
  assert.strictEqual(pick.entry, "IN")
  assert.strictEqual(pick.entryId, "JNccccccccccccccccccccccccccccccccccccccccc") // the 30ms one
  assert.strictEqual(pick.exit, "SG")
  assert.strictEqual(pick.exitId, "SGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
})

test("pickFastest has no gateway IDs to pin when nothing was measured", () => {
  const pick = M.pickFastest([], { fallbackOrder: ["IN", "SG"] })
  assert.strictEqual(pick.entryId, "")
  assert.strictEqual(pick.exitId, "")
})

test("pickFastest can keep both hops in the same country when asked", () => {
  const res = [{ cc: "IN", ip: "2.2.2.2", rtt: 30 }, { cc: "SG", ip: "3.3.3.3", rtt: 80 }]
  const pick = M.pickFastest(res, { distinctCountries: false })
  assert.strictEqual(pick.entry, "IN")
  assert.strictEqual(pick.exit, "IN")
})

test("pickFastest skips unreachable countries entirely", () => {
  const res = [
    { cc: "IN", ip: "2.2.2.2", rtt: null },
    { cc: "SG", ip: "3.3.3.3", rtt: 80 },
    { cc: "JP", ip: "4.4.4.4", rtt: 120 }
  ]
  const pick = M.pickFastest(res)
  assert.strictEqual(pick.entry, "SG")
  assert.strictEqual(pick.exit, "JP")
})

test("pickFastest falls back to geographic order when every probe fails", () => {
  // Killswitch/offline edge: we must still improve on a worldwide random pick.
  const res = [{ cc: "IN", ip: "2.2.2.2", rtt: null }, { cc: "SG", ip: "3.3.3.3", rtt: null }]
  const pick = M.pickFastest(res, { fallbackOrder: ["IN", "SG", "AE"] })
  assert.strictEqual(pick.entry, "IN")
  assert.strictEqual(pick.exit, "SG")
  assert.strictEqual(pick.measured, false)
  assert.strictEqual(pick.entryRtt, null)
  // Still ranked geographically so the caller can pick an alternative country
  // for the other hop.
  assert.deepStrictEqual(pick.ranked.map(r => r.cc), ["IN", "SG", "AE"])
})

test("pickFastest ranks every measured country for the caller", () => {
  const pick = M.pickFastest([
    { cc: "AE", ip: "1.1.1.1", rtt: 220 },
    { cc: "IN", ip: "2.2.2.2", rtt: 30 },
    { cc: "SG", ip: "3.3.3.3", rtt: 80 }
  ])
  assert.deepStrictEqual(pick.ranked.map(r => r.cc), ["IN", "SG", "AE"])
})

test("each ranked country carries its own winning gateway id", () => {
  // The exit hop may have to skip the best country (it is already the entry),
  // so every rank must be pinnable on its own.
  const pick = M.pickFastest([
    { cc: "SG", ip: "3.3.3.3", id: "SGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", rtt: 80 },
    { cc: "JP", ip: "4.4.4.4", id: "JPaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", rtt: 120 }
  ])
  assert.deepStrictEqual(pick.ranked.map(r => r.id), [
    "SGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "JPaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  ])
  assert.deepStrictEqual(M.pickFastest([], { fallbackOrder: ["IN"] }).ranked,
                         [{ cc: "IN", rtt: null, id: "" }])
})

test("pickFastest with a single reachable country still yields both hops", () => {
  const pick = M.pickFastest([{ cc: "IN", ip: "2.2.2.2", rtt: 30 }])
  assert.strictEqual(pick.entry, "IN")
  assert.strictEqual(pick.exit, "IN")
})

test("pickFastest with nothing at all returns an empty, non-crashing result", () => {
  const pick = M.pickFastest([])
  assert.strictEqual(pick.entry, "")
  assert.strictEqual(pick.exit, "")
  assert.strictEqual(pick.measured, false)
})

// --- wiring into the existing command/UI surface ---

test("setGatewaysCommand pins exact gateways by ID", () => {
  const c = M.setGatewaysCommand({
    entryId: "2BDCzDG2ykdykTKRB8XVsEekHftv7oQ3TUrzsDxTWaxs",
    exitId: "5ZWdDN9pQ18vYkYYs5ZERh4P4JLtMiijscZ6FvwSfVxR"
  })
  assert.ok(c[2].includes("--entry-id 2BDCzDG2ykdykTKRB8XVsEekHftv7oQ3TUrzsDxTWaxs"))
  assert.ok(c[2].includes("--exit-id 5ZWdDN9pQ18vYkYYs5ZERh4P4JLtMiijscZ6FvwSfVxR"))
  assert.ok(c[2].includes("2>&1"))
})

test("setGatewaysCommand falls back to countries and rejects junk IDs", () => {
  const c = M.setGatewaysCommand({ entryId: "nope; rm -rf ~", entry: "IN", exit: "sg" })
  assert.ok(!c[2].includes("rm -rf"))
  assert.ok(c[2].includes("--entry-country IN"))
  assert.ok(c[2].includes("--exit-country SG"))
  assert.strictEqual(M.setGatewaysCommand({}), null)
  assert.strictEqual(M.setGatewaysCommand(null), null)
})

test("setGatewaysCommand can set a single hop", () => {
  const c = M.setGatewaysCommand({ entry: "IN" })
  assert.ok(c[2].includes("--entry-country IN"))
  assert.ok(!c[2].includes("--exit"))
})

test("reconnectCommand re-establishes the tunnel after a gateway change", () => {
  const c = M.reconnectCommand()
  assert.ok(c[2].includes("nym-vpnc reconnect"))
  assert.ok(c[2].includes("2>&1"))
})

test("countryOptions offers Fastest alongside Auto and Random", () => {
  const opts = M.countryOptions(["US", "DE"])
  const values = opts.map(o => o.value)
  assert.ok(values.includes("fastest"))
  assert.ok(values.includes("auto"))
  assert.ok(values.includes("random"))
  // Auto stays the first/recommended entry: Fastest trades the
  // exclude-your-country privacy default for speed, so it must not be silently
  // promoted above it.
  assert.strictEqual(opts[0].value, "auto")
  const fastest = opts.find(o => o.value === "fastest")
  assert.ok(/speed|fast|latency/i.test(fastest.description + fastest.label))
})

test("sameSelection spots a redundant pick so the tunnel is not rebuilt for nothing", () => {
  // Selecting a region while connected now rebuilds the tunnel, so re-picking
  // what is already active must be a no-op -- otherwise merely reopening the
  // dropdown and confirming the current row would drop the user's connection.
  assert.strictEqual(M.sameSelection("auto", "auto"), true)
  assert.strictEqual(M.sameSelection("IN", "in"), true)
  assert.strictEqual(M.sameSelection("IN", "SG"), false)
  assert.strictEqual(M.sameSelection("auto", "IN"), false)
  // "Random" means "roll again", so it is never redundant.
  assert.strictEqual(M.sameSelection("random", "random"), false)
  // Unknown current selection (nothing configured yet) must still apply.
  assert.strictEqual(M.sameSelection("IN", ""), false)
})

test("setGatewayCommand refuses 'fastest' because it must be resolved first", () => {
  // "fastest" is not a daemon-side constraint; it is resolved by probing and
  // then applied as a concrete country. Building a bogus flag would silently
  // break the tunnel.
  assert.strictEqual(M.setGatewayCommand("entry", "fastest"), null)
  assert.strictEqual(M.setGatewayCommand("exit", "fastest"), null)
})

test("fastest is a sticky MODE, so the picker keeps showing it", () => {
  // Choosing "Fastest" resolves to a concrete gateway, but the user chose a
  // MODE. Reflecting the resolved country back into the picker made it look
  // like they had hand-picked Malaysia. displaySelection keeps the mode.
  assert.strictEqual(M.displaySelection("MY", true), "fastest")
  assert.strictEqual(M.displaySelection("MY", false), "MY")
  assert.strictEqual(M.displaySelection("auto", false), "auto")
  // Mode on but nothing resolved yet still shows the mode.
  assert.strictEqual(M.displaySelection("", true), "fastest")
})

test("parseFastestModes round-trips the persisted per-hop modes", () => {
  // The mode must survive a shell restart, otherwise the picker silently
  // reverts to showing a country the user never chose.
  assert.deepStrictEqual(M.parseFastestModes('{"entry":false,"exit":true}'),
                         { entry: false, exit: true })
  assert.deepStrictEqual(M.parseFastestModes(""), { entry: false, exit: false })
  assert.deepStrictEqual(M.parseFastestModes("not json"), { entry: false, exit: false })
  assert.deepStrictEqual(M.parseFastestModes('{"entry":"yes"}'), { entry: false, exit: false })
  const json = M.serializeFastestModes({ entry: true, exit: false })
  assert.deepStrictEqual(M.parseFastestModes(json), { entry: true, exit: false })
})

test("isFastest recognises the selector token", () => {
  assert.strictEqual(M.isFastest("fastest"), true)
  assert.strictEqual(M.isFastest("FASTEST"), true)
  assert.strictEqual(M.isFastest("auto"), false)
  assert.strictEqual(M.isFastest(""), false)
})

test("chooseFastestExit never returns an excluded country", () => {
  // An exit-only resolve used to take the single fastest country overall, which
  // is typically the user's OWN country -- so "Fastest exit" pinned an Indian
  // exit for a user in India, defeating the point of the VPN. The exit must
  // skip the entry's country and the user's own country.
  const pick = {
    entry: "IN", exit: "MY",
    ranked: [
      { cc: "IN", rtt: 20, id: "JNaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { cc: "MY", rtt: 42, id: "MYaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { cc: "SG", rtt: 45, id: "SGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
    ]
  }
  assert.deepStrictEqual(M.chooseFastestExit(pick, ["IN"]),
    { cc: "MY", id: "MYaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", rtt: 42 })
  assert.deepStrictEqual(M.chooseFastestExit(pick, ["IN", "MY"]),
    { cc: "SG", id: "SGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", rtt: 45 })
  // Excluding everything must still yield a usable exit rather than nothing.
  const all = M.chooseFastestExit(pick, ["IN", "MY", "SG"])
  assert.strictEqual(all.cc, "MY")   // falls back to the pick's own exit
  // Empty/awkward inputs do not crash.
  assert.strictEqual(M.chooseFastestExit({ exit: "SG" }, []).cc, "SG")
  assert.strictEqual(M.chooseFastestExit(null, []).cc, "")
})

test("fastestSummary only describes the hop(s) that were actually resolved", () => {
  const pick = { entry: "IN", exit: "MY", entryRtt: 22, exitRtt: 41, measured: true }
  // Resolving ONLY the exit must not claim an entry: the entry may well be Auto,
  // and reporting "India -> Malaysia" told the user their entry was India when
  // nothing had touched it.
  const exitOnly = M.fastestSummary(pick, "exit")
  assert.ok(/Malaysia/.test(exitOnly), exitOnly)
  assert.ok(!/India/.test(exitOnly), exitOnly)
  const entryOnly = M.fastestSummary(pick, "entry")
  assert.ok(/India/.test(entryOnly), entryOnly)
  assert.ok(!/Malaysia/.test(entryOnly), entryOnly)
  // Both hops -> the full route, as before.
  const both = M.fastestSummary(pick, "both")
  assert.ok(/India/.test(both) && /Malaysia/.test(both), both)
  assert.ok(/India/.test(M.fastestSummary(pick)), "no role behaves like both")
})

test("homeCountryNotice only fires when the ENTRY hop was actually applied", () => {
  const pick = { entry: "IN", exit: "MY", measured: true }
  // Exit-only resolve never touched the entry, so warning about a home-country
  // entry is simply false.
  assert.strictEqual(M.homeCountryNotice(pick, "IN", "exit"), "")
  assert.ok(/India/.test(M.homeCountryNotice(pick, "IN", "entry")))
  assert.ok(/India/.test(M.homeCountryNotice(pick, "IN", "both")))
})

test("homeCountryNotice warns when the fastest entry is your own country", () => {
  // Auto's whole privacy promise is "excluding your country". Fastest can and
  // often does pick your own country as the entry, because that is genuinely
  // the lowest latency -- so it must say so plainly instead of leaving the user
  // to notice their own country sitting in the entry slot.
  const n = M.homeCountryNotice({ entry: "IN", exit: "SG", measured: true }, "IN")
  assert.ok(/India/.test(n), n)
  assert.ok(/auto/i.test(n), n)
  // No warning when the entry is elsewhere, or when we do not know where you are.
  assert.strictEqual(M.homeCountryNotice({ entry: "SG", exit: "MY" }, "IN"), "")
  assert.strictEqual(M.homeCountryNotice({ entry: "IN", exit: "SG" }, ""), "")
  assert.strictEqual(M.homeCountryNotice(null, "IN"), "")
})

test("fastestSummary describes the measured route for the panel", () => {
  const s = M.fastestSummary({ entry: "IN", exit: "SG", entryRtt: 81.9, exitRtt: 95, measured: true })
  assert.ok(s.includes("India"))
  assert.ok(s.includes("Singapore"))
  assert.ok(s.includes("82 ms"), "rounds the measured latency: " + s)
})

test("fastestSummary says so when the pick was not measured", () => {
  const s = M.fastestSummary({ entry: "IN", exit: "SG", entryRtt: null, exitRtt: null, measured: false })
  assert.ok(s.includes("India"))
  assert.ok(!s.includes("ms"))
  assert.strictEqual(M.fastestSummary(null), "")
})

console.log("\n" + passed + " tests passed")
