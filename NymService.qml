pragma Singleton

import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// Process-wide shared state for the NymVPN plugin.
//
// The Omarchy bar is instantiated per monitor (Variants over Quickshell.screens),
// so every screen gets its own BarWidget + Panel. Without a shared owner each
// screen would hold independent, diverging status. This Singleton is created
// once per Quickshell process, so every bar dot and every open panel bind to
// the SAME live state.
//
// Live updates: `nym-vpnc status` is an ungated read on current nym-vpnd builds,
// so we poll it on a timer to keep the bar in sync with the real tunnel. If a
// status call ever comes back auth-required (a daemon that DOES gate reads
// behind polkit), we set `polkitGated` and stop the background poll so users
// are never spammed with password prompts -- falling back to on-demand refresh
// on panel open / action, exactly like the original design.
Singleton {
  id: svc

  // Poll cadence for the ungated `status` read.
  readonly property int pollIntervalMs: 10000

  // --- shared live state (bind the bar + panels to these) ------------------
  property var status: Model.parseStatus("", 0)
  property var account: ({ stored: false, identity: "", state: "", mode: "" })
  property bool accountFetched: false
  property var twoHop: null
  property var gateway: ({ entry: "", exit: "" })
  // Local network policy from `nym-vpnc lan get`: true=allow, false=block,
  // null=not yet known (or a daemon/CLI too old to answer).
  property var lanAllow: null
  // Available gateway countries per pool ("mixnet-entry"|"mixnet-exit"|"wg").
  property var countryCodes: ({})
  // Raw `gateway list` output per pool, kept so the Fastest resolver can read
  // per-gateway exit IPs (the country list alone is not enough to ping).
  property var gatewayRaw: ({})
  readonly property string entryType: Model.entryGatewayType(svc.twoHop)
  readonly property string exitType: Model.exitGatewayType(svc.twoHop)
  readonly property var entryOptions: Model.countryOptions(svc.countryCodes[svc.entryType] || [])
  readonly property var exitOptions: Model.countryOptions(svc.countryCodes[svc.exitType] || [])
  // Gateway tables for the active pools, used to resolve a PINNED gateway key
  // back to its country: `gateway get` reports an opaque identity once a node
  // has been pinned, which would otherwise render as "Auto" in the pickers.
  readonly property var entryHosts: Model.parseGatewayHosts(svc.gatewayRaw[svc.entryType] || "")
  readonly property var exitHosts: Model.parseGatewayHosts(svc.gatewayRaw[svc.exitType] || "")
  readonly property string entrySelection: Model.gatewaySelection(svc.gateway.entry, svc.entryHosts)
  readonly property string exitSelection: Model.gatewaySelection(svc.gateway.exit, svc.exitHosts)
  // Raw `status` text, kept so we can read the gateways the tunnel is ACTUALLY
  // using rather than only the constraint the daemon has stored.
  property string statusRaw: ""
  readonly property string liveSummary: Model.liveRouteSummary(svc.statusRaw, svc.entryHosts)
  // Prefer the live route: a constraint that has not been applied to a tunnel
  // yet must never be presented as if it were in force.
  readonly property string routeSummary: svc.liveSummary !== ""
    ? svc.liveSummary
    : Model.gatewaySummary(svc.gateway, svc.entryHosts, svc.exitHosts)
  property string notice: ""

  // --- Fastest (measured) gateway selection --------------------------------
  // The daemon's own Auto is latency-blind, so "Fastest" resolves a concrete
  // country client-side: detect roughly where the user is, shortlist the
  // nearest countries that actually have gateways, ping a couple in each, then
  // apply the winners as --entry-country/--exit-country. See Model.js.
  property bool fastestBusy: false
  // "entry" | "exit" | "both" -- which hop(s) the in-flight resolve will apply.
  property string fastestRole: ""
  // Last resolved route: { entry, exit, entryRtt, exitRtt, measured, ranked }.
  property var fastestResult: null
  // Set when the tunnel was up and a real measurement was impossible.
  property string fastestNotice: ""
  // Cached local country ("IN"), "" when undetectable. Detected once.
  property string localCountry: ""
  property bool localCountryFetched: false

  // True once the daemon answered `status` without a polkit prompt. When true
  // we may auto-fetch the account and poll in the background.
  property bool authFree: false
  // True once a `status` call returned auth-required: the daemon gates reads
  // behind polkit, so we suspend background polling to avoid prompt spam.
  property bool polkitGated: false

  readonly property bool loggedIn: accountFetched && account.stored
  readonly property bool installed: status.state !== "not-installed"
  readonly property bool daemonDown: status.state === "daemon-down"
  readonly property bool actionBusy: actionProc.running

  // --- refresh orchestration ----------------------------------------------

  function refreshAll() {
    svc.refreshStatus()
    svc.refreshConfig()
    svc.refreshCountries()
    if (svc.authFree) svc.refreshAccount()
  }

  function refreshStatus() {
    if (statusProc.running) return
    statusProc.command = Model.statusCommand()
    statusProc.running = true
  }

  function refreshAccount() {
    if (accountProc.running) return
    accountProc.command = Model.accountCommand()
    accountProc.running = true
  }

  function refreshConfig() {
    if (!tunnelProc.running) {
      tunnelProc.command = Model.tunnelGetCommand()
      tunnelProc.running = true
    }
    if (!gatewayProc.running) {
      gatewayProc.command = Model.gatewayGetCommand()
      gatewayProc.running = true
    }
    if (!lanProc.running) {
      lanProc.command = Model.lanGetCommand()
      lanProc.running = true
    }
  }

  function ensureCountries(type) {
    if (!type) return
    if (svc.countryCodes[type] && svc.countryCodes[type].length > 0) return
    if (listProc.running) return
    listProc.pendingType = type
    listProc.command = Model.gatewayListCommand(type)
    listProc.running = true
  }

  function refreshCountries() {
    svc.ensureCountries(svc.entryType)
    if (svc.exitType !== svc.entryType) svc.ensureCountries(svc.exitType)
  }

  // --- actions -------------------------------------------------------------

  function runAction(command) {
    if (!command || actionProc.running) return
    svc.notice = ""
    actionProc.command = command
    actionProc.running = true
  }

  function connect() { svc.runAction(Model.connectCommand()) }
  function disconnect() { svc.runAction(Model.disconnectCommand()) }

  function setMode(twoHopOn) {
    if (svc.twoHop === twoHopOn) return
    svc.runAction(Model.setTwoHopCommand(twoHopOn))
  }

  function setLan(allow) {
    if (svc.lanAllow === allow) return
    svc.runAction(Model.setLanCommand(allow))
  }

  function applyGateway(role, value) {
    // "Fastest" is not a daemon constraint: resolve it by measurement first.
    if (Model.isFastest(value)) {
      svc.resolveFastest(role)
      return
    }
    // Re-picking the row that is already active must not rebuild the tunnel.
    var current = role === "exit" ? svc.exitSelection : svc.entrySelection
    if (Model.sameSelection(value, current)) return

    var command = Model.setGatewayCommand(role, value)
    if (!command) return
    // A gateway constraint only binds a NEWLY built tunnel. Without this the
    // daemon keeps routing over the old gateways, so the panel would report the
    // new selection (e.g. "Auto, excluding your country") while the user is
    // still connected through the previous one -- possibly in their own
    // country. Rebuild the tunnel so the selection is actually true.
    svc.pendingReconnect = svc.status.state === "connected"
    svc.runAction(command)
  }

  // Kick off a Fastest resolve for one hop ("entry"/"exit") or both.
  // Idempotent while one is already in flight.
  function resolveFastest(role) {
    if (svc.fastestBusy || svc.actionBusy) return
    var r = String(role || "both")
    if (r !== "entry" && r !== "exit") r = "both"
    svc.fastestRole = r
    svc.fastestBusy = true
    svc.fastestNotice = ""
    svc.notice = ""
    svc.fastestStep()
  }

  // Drive the resolve forward. Called again as each dependency lands, so the
  // whole thing is a small state machine rather than nested callbacks.
  function fastestStep() {
    if (!svc.fastestBusy) return

    // 1. Where is the user? (timezone, then locale -- both offline.)
    if (!svc.localCountryFetched) {
      if (!localeProc.running) {
        localeProc.command = Model.localCountryCommand()
        localeProc.running = true
      }
      return
    }

    // 2. Which gateways exist for the pool backing this hop?
    var type = svc.fastestRole === "exit" ? svc.exitType : svc.entryType
    var raw = svc.gatewayRaw[type]
    if (!raw) {
      svc.ensureCountries(type)   // also stores the raw table
      if (!listProc.running) svc.fastestFail("Could not read the gateway list.")
      return
    }

    // 3. Plan the probe.
    var hosts = Model.parseGatewayHosts(raw)
    var plan = Model.probePlan(svc.localCountry, hosts)
    if (!plan.hosts || plan.hosts.length === 0) {
      svc.fastestFail("No gateways available to measure.")
      return
    }
    svc.fastestPlan = plan

    // 4. Measure -- but only when the answer would mean anything. With the
    // tunnel up, every probe egresses from the exit gateway, so the ranking
    // would describe the exit's neighbourhood, not the user's.
    //
    // In that case we STOP rather than apply a geographic guess: the user asked
    // for the measured route, and applying an unmeasured one would rebuild the
    // tunnel and could downgrade an already-measured selection. Explain instead.
    if (!Model.canProbe(svc.status.state)) {
      svc.fastestNotice = Model.probeSkipReason(svc.status.state)
      svc.fastestBusy = false
      svc.fastestRole = ""
      svc.fastestPlan = null
      return
    }
    var cmd = Model.probeCommand(plan)
    if (!cmd) {
      svc.fastestApply(Model.pickFastest([], { fallbackOrder: plan.countries }))
      return
    }
    if (!probeProc.running) {
      probeProc.command = cmd
      probeProc.running = true
    }
  }

  property var fastestPlan: null

  function fastestFail(message) {
    svc.fastestBusy = false
    svc.fastestRole = ""
    svc.fastestPlan = null
    svc.notice = message
  }

  // Apply a resolved route to the hop(s) the user asked for, then reconnect if
  // a tunnel is already up so the change actually takes effect.
  function fastestApply(pick) {
    svc.fastestResult = pick
    // Be explicit when the measured winner is the user's own country: that is
    // precisely the privacy default Auto provides and Fastest gives up.
    svc.fastestNotice = Model.homeCountryNotice(pick, svc.localCountry)
    var role = svc.fastestRole
    svc.fastestBusy = false
    svc.fastestRole = ""
    svc.fastestPlan = null

    if (!pick || (pick.entry === "" && pick.exit === "")) {
      svc.notice = "Could not work out a fastest region."
      return
    }

    // Pin the exact measured gateway when we have one; a bare country lets the
    // daemon re-roll inside that country by its own latency-blind score (which
    // measured 390ms / 2.5 MB/s on an SG node while a probed SG node answered
    // in 43ms). Without a measurement there is no evidence to pin, so we set
    // the more robust country constraint instead.
    var command = null
    if (role === "entry") {
      command = Model.setGatewaysCommand({ entry: pick.entry, entryId: pick.entryId })
    } else if (role === "exit") {
      // Keep the hops in different countries when we can: take the best
      // measured country that is not already the entry.
      var entryCc = svc.entrySelection
      var exitCc = pick.exit
      var exitId = pick.exitId
      var ranked = pick.ranked || []
      for (var i = 0; i < ranked.length; i++) {
        if (ranked[i].cc !== entryCc) {
          exitCc = ranked[i].cc
          exitId = ranked[i].id || ""
          break
        }
      }
      command = Model.setGatewaysCommand({ exit: exitCc, exitId: exitId })
    } else {
      command = Model.setGatewaysCommand({
        entry: pick.entry, entryId: pick.entryId,
        exit: pick.exit, exitId: pick.exitId
      })
    }
    if (!command) {
      svc.notice = "Could not apply the fastest region."
      return
    }
    svc.pendingReconnect = svc.status.state === "connected"
    svc.runAction(command)
  }

  // Set when a gateway change needs the tunnel rebuilt to take effect.
  property bool pendingReconnect: false

  function forget() {
    svc.runAction(Model.accountForgetCommand())
    svc.accountFetched = false
  }

  // --- processes -----------------------------------------------------------

  Process {
    id: statusProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        svc.statusRaw = String(text || "")
        svc.status = Model.parseStatus(svc.statusRaw, 0)
        if (svc.status.state === "auth-required") {
          svc.authFree = false
          svc.polkitGated = true      // stop background polling; on-demand only
        } else if (svc.status.state !== "unknown" && svc.status.state !== "not-installed") {
          svc.polkitGated = false
          if (!svc.authFree) {
            svc.authFree = true
            if (!svc.accountFetched) svc.refreshAccount()
          }
        }
      }
    }
    onExited: function(code) {
      if (code !== 0 && svc.status && svc.status.state === "unknown")
        svc.status = Model.parseStatus("", code)
    }
  }

  Process {
    id: accountProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        svc.account = Model.parseAccount(String(text || ""))
        svc.accountFetched = true
      }
    }
  }

  Process {
    id: tunnelProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var v = Model.parseTwoHop(String(text || ""))
        if (v !== null) {
          svc.twoHop = v
          svc.refreshCountries()
        }
      }
    }
  }

  Process {
    id: gatewayProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: svc.gateway = Model.parseGateway(String(text || ""))
    }
  }

  Process {
    id: lanProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var v = Model.parseLan(String(text || ""))
        if (v !== null) svc.lanAllow = v
      }
    }
  }

  Process {
    id: listProc
    property string pendingType: ""
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var body = String(text || "")
        var codes = Model.parseGatewayCountries(body)
        if (listProc.pendingType !== "" && codes.length > 0) {
          var next = Object.assign({}, svc.countryCodes)
          next[listProc.pendingType] = codes
          svc.countryCodes = next
          // Keep the raw table too: the Fastest resolver needs the per-gateway
          // exit IPs, which the country list throws away.
          var raws = Object.assign({}, svc.gatewayRaw)
          raws[listProc.pendingType] = body
          svc.gatewayRaw = raws
        }
      }
    }
    onExited: {
      listProc.pendingType = ""
      svc.refreshCountries()
      if (svc.fastestBusy) svc.fastestStep()
    }
  }

  // One-shot local-country detection (timezone, then locale).
  Process {
    id: localeProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: svc.localCountry = Model.parseLocalCountry(String(text || ""))
    }
    onExited: {
      svc.localCountryFetched = true
      if (svc.fastestBusy) svc.fastestStep()
    }
  }

  // Concurrent latency probe. One process; the script fans out with `&`/`wait`
  // and reduces each ping to a single short line, so a six-country probe costs
  // about one ping round (measured ~1.6s for ten hosts).
  Process {
    id: probeProc
    property string collected: ""
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: probeProc.collected = String(text || "")
    }
    onExited: {
      if (!svc.fastestBusy) return
      // Pass the plan so each result is rejoined with its gateway identity and
      // the winner can be pinned by --entry-id/--exit-id.
      var results = Model.parseProbeResults(probeProc.collected, svc.fastestPlan)
      var fallback = svc.fastestPlan ? svc.fastestPlan.countries : []
      probeProc.collected = ""
      svc.fastestApply(Model.pickFastest(results, { fallbackOrder: fallback }))
    }
  }

  Process {
    id: actionProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var out = String(text || "").trim()
        if (out !== "") svc.notice = out.split("\n").slice(-1)[0]
      }
    }
    onExited: function(code) {
      // A gateway constraint only takes effect on a fresh tunnel, so rebuild it
      // when we changed one while connected.
      if (svc.pendingReconnect) {
        svc.pendingReconnect = false
        reconnectTimer.restart()
      }
      settleTimer.restart()
    }
  }

  // Small gap so the daemon has committed the new constraint before we ask it
  // to rebuild the tunnel.
  Timer {
    id: reconnectTimer
    interval: 400
    onTriggered: svc.runAction(Model.reconnectCommand())
  }

  // Re-read state shortly after an action so Connect/Disconnect visibly settle.
  Timer {
    id: settleTimer
    interval: 600
    onTriggered: {
      svc.refreshStatus()
      svc.refreshConfig()
      if (svc.authFree) svc.refreshAccount()
    }
  }

  // Background live poll of the ungated `status` read. Suspended the moment a
  // daemon proves it gates reads behind polkit (polkitGated), so prompt-gated
  // setups keep the original on-demand-only behavior.
  Timer {
    id: pollTimer
    interval: svc.pollIntervalMs
    repeat: true
    running: !svc.polkitGated
    onTriggered: svc.refreshStatus()
  }

  Component.onCompleted: svc.refreshAll()
}
