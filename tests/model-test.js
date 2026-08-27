"use strict"

// Pure-logic tests for Model.js. Run with: node tests/model-test.js
const assert = require("assert")
const path = require("path")
const M = require(path.join(__dirname, "..", "Model.js"))

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

test("accountSetCommand is argv (no shell) and never interpolates the phrase", () => {
  const c = M.accountSetCommand("  word1   word2  word3 ")
  assert.deepStrictEqual(c, ["nym-vpnc", "account", "set", "word1 word2 word3"])
  // must NOT be a shell string that could leak the phrase into a log/clipboard
  assert.notStrictEqual(c[0], "sh")
  // Exactly one argv slot carries the secret (the trailing positional), and no
  // element is a shell wrapper. nym-vpnc offers no stdin/file/env input, so argv
  // is the only channel; keep it tight so nothing else can smuggle the phrase.
  assert.strictEqual(c.length, 4)
  assert.ok(!c.slice(0, 3).some((a) => /word1|word2|word3/.test(a)))
  assert.ok(!c.some((a) => a === "sh" || a === "-c" || a === "bash"))
})

test("accountForgetCommand", () => {
  assert.ok(M.accountForgetCommand()[2].includes("account forget"))
})

test("looksLikeMnemonic validates BIP39 word counts", () => {
  const w12 = Array(12).fill("abandon").join(" ")
  const w24 = Array(24).fill("abandon").join(" ")
  assert.ok(M.looksLikeMnemonic(w12))
  assert.ok(M.looksLikeMnemonic(w24))
  assert.ok(M.looksLikeMnemonic("  " + w12 + "  "))
  assert.ok(!M.looksLikeMnemonic(Array(11).fill("abandon").join(" ")))
  assert.ok(!M.looksLikeMnemonic(Array(13).fill("abandon").join(" ")))
  assert.ok(!M.looksLikeMnemonic("abandon abandon 1nvalid " + Array(9).fill("abandon").join(" ")))
  assert.ok(!M.looksLikeMnemonic(""))
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

test("countryOptions leads with auto+random then flagged countries", () => {
  const opts = M.countryOptions(["US", "DE"])
  assert.strictEqual(opts[0].value, "auto")
  assert.strictEqual(opts[1].value, "random")
  assert.strictEqual(opts[2].value, "US")
  assert.ok(opts[2].label.includes("United States"))
  assert.strictEqual(opts[2].description, "US") // searchable by bare code
})

test("gatewaySelection collapses raw points to selector values", () => {
  assert.strictEqual(M.gatewaySelection("Country(US)"), "US")
  assert.strictEqual(M.gatewaySelection("Auto { exclude_user_country: true }"), "auto")
  assert.strictEqual(M.gatewaySelection(""), "")
})

test("gatewaySummary renders a friendly route line", () => {
  const s = M.gatewaySummary({ entry: "Country(US)", exit: "Country(DE)" })
  assert.ok(s.includes("United States"))
  assert.ok(s.includes("Germany"))
  assert.ok(s.includes("\u2192"))
  assert.ok(M.gatewaySummary({ entry: "Auto { }", exit: "Auto { }" }).includes("Auto"))
})

console.log("\n" + passed + " tests passed")
