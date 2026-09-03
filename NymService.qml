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
  // What the daemon is actually constrained to.
  readonly property string entrySelection: Model.gatewaySelection(svc.gateway.entry, svc.entryHosts)
  readonly property string exitSelection: Model.gatewaySelection(svc.gateway.exit, svc.exitHosts)
  // "Fastest" is a sticky per-hop MODE. The daemon only ever stores the
  // resolved gateway, so the mode is tracked here (and persisted) -- otherwise
  // the picker shows the country it resolved to and looks as though the user
  // hand-picked it.
  property bool fastestModeEntry: false
  property bool fastestModeExit: false
  readonly property string entryDisplay: Model.displaySelection(svc.entrySelection, svc.fastestModeEntry)
  readonly property string exitDisplay: Model.displaySelection(svc.exitSelection, svc.fastestModeExit)
  // Raw `status` text, kept so we can read the gateways the tunnel is ACTUALLY
  // using rather than only the constraint the daemon has stored.
  property string statusRaw: ""
  readonly property string liveSummary: Model.liveRouteSummary(svc.statusRaw, svc.entryHosts)
  // Prefer the live route: a constraint that has not been applied to a tunnel
  // yet must never be presented as if it were in force.
  readonly property string routeSummary: svc.liveSummary !== ""
    ? svc.liveSummary
    : Model.gatewaySummary(svc.gateway, svc.entryHosts, svc.exitHosts)
  // Non-empty when the tunnel is NOT on the selected region, whatever the
  // cause (constraint not yet applied, daemon fallback, a stray selection).
  readonly property string routeMismatch: Model.routeMismatchNotice(
    { entry: svc.entrySelection, exit: svc.exitSelection },
    Model.liveRoute(svc.statusRaw, svc.entryHosts),
    svc.localCountry)
  property string notice: ""

  // --- Fastest (measured) gateway selection --------------------------------
  // The daemon's own Auto is latency-blind, so "Fastest" resolves a concrete
  // country client-side: detect roughly where the user is, shortlist the
  // nearest countries that actually have gateways, ping a couple in each, then
  // apply the winners as --entry-country/--exit-country. See Model.js.
  property bool fastestBusy: false
  // "entry" | "exit" | "both" -- which hop(s) the in-flight resolve will apply.
  property string fastestRole: ""
  // The hop(s) the LAST resolve applied. "Re-test" repeats exactly that, so it
  // cannot silently overwrite a hop the user set to something else (a Re-test
  // that always did "both" replaced an explicit Auto entry with a pinned one).
  property string lastFastestRole: ""
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
    svc.ensureLocalCountry()
    if (svc.authFree) svc.refreshAccount()
  }

  // Detect the home country once, up front: the route-mismatch check needs it to
  // judge an "Auto" selection (Auto excludes the user's own jurisdiction), not
  // just the Fastest resolver. Offline and cheap -- timezone, then locale.
  function ensureLocalCountry() {
    if (svc.localCountryFetched || localeProc.running) return
    localeProc.command = Model.localCountryCommand()
    localeProc.running = true
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
      svc.setFastestMode(role, true)
      svc.resolveFastest(role)
      return
    }
    // Any other explicit pick leaves fastest mode for that hop.
    svc.setFastestMode(role, false)
    // Re-picking the row that is already active must not rebuild the tunnel.
    var current = role === "exit" ? svc.exitSelection : svc.entrySelection
    if (Model.sameSelection(value, current)) return

    var command = Model.setGatewayCommand(role, value)
    if (!command) return
    // Re-picking "Random" is an explicit request for a fresh roll, which no
    // mismatch check can detect (any gateway satisfies random).
    svc.forceReconnect = String(value).toLowerCase() === "random"
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
  function setFastestMode(role, on) {
    if (role === "entry") svc.fastestModeEntry = on
    else if (role === "exit") svc.fastestModeExit = on
    else { svc.fastestModeEntry = on; svc.fastestModeExit = on }
    svc.saveFastestModes()
  }

  function resolveFastest(role) {
    if (svc.fastestBusy || svc.actionBusy) return
    var r = String(role || "both")
    // "repeat" = redo exactly the hop(s) that are in Fastest mode (the Re-test
    // button), so re-testing an exit-only Fastest never touches the entry --
    // including after a restart, when there is no in-session role left.
    if (r === "repeat") {
      r = Model.repeatRole({ entry: svc.fastestModeEntry, exit: svc.fastestModeExit },
                           svc.lastFastestRole)
    }
    if (r !== "entry" && r !== "exit") r = "both"
    svc.fastestRole = r
    svc.fastestBusy = true
    svc.fastestNotice = ""
    svc.notice = ""

    // Latency cannot be measured through the tunnel (every probe would leave
    // from the exit gateway). Rather than making the user disconnect, measure
    // and reconnect by hand, run the whole cycle here: drop the tunnel,
    // measure, apply, and restore the connection automatically.
    if (!Model.canProbe(svc.status.state)) {
      svc.resumeAfterResolve = true
      svc.fastestPhase = "disconnecting"
      svc.fastestNotice = Model.measureCycleNotice()
      svc.runAction(Model.disconnectCommand())
      disconnectWaitTimer.restart()
      return
    }

    svc.fastestPhase = "measuring"
    svc.fastestStep()
  }

  // Drive the resolve forward. Called again as each dependency lands, so the
  // whole thing is a small state machine rather than nested callbacks.
  function fastestStep() {
    if (!svc.fastestBusy) return

    // 1. Where is the user? (timezone, then locale -- both offline.)
    if (!svc.localCountryFetched) {
      svc.ensureLocalCountry()
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
    svc.fastestPhase = ""
    svc.notice = message
    // We took the tunnel down to measure; put it back even on failure so the
    // user is never silently left unprotected.
    if (svc.resumeAfterResolve) {
      svc.resumeAfterResolve = false
      svc.pendingConnect = true
      connectTimer.restart()
    }
  }

  // Apply a resolved route to the hop(s) the user asked for, then reconnect if
  // a tunnel is already up so the change actually takes effect.
  function fastestApply(pick) {
    var role = svc.fastestRole
    svc.lastFastestRole = role
    svc.fastestBusy = false
    svc.fastestRole = ""
    svc.fastestPlan = null

    if (!pick || (pick.entry === "" && pick.exit === "")) {
      svc.notice = "Could not work out a fastest region."
      return
    }

    // Build EXACTLY what will be applied, then report that. Previously the
    // panel described the raw pick while a different route was applied (it
    // announced "Exit Malaysia" while pinning an Indian exit).
    var home = svc.localCountry
    var entryCc = svc.entrySelection      // "auto"/"random"/"IN"/""
    var applied = {
      entry: "", exit: "", entryId: "", exitId: "",
      entryRtt: null, exitRtt: null,
      measured: pick.measured, ranked: pick.ranked || []
    }

    if (role === "entry" || role === "both") {
      applied.entry = pick.entry
      applied.entryId = pick.entryId
      applied.entryRtt = pick.entryRtt
    }
    if (role === "exit" || role === "both") {
      // Keep the exit out of the entry's country and out of the user's own
      // country -- an exit in your own jurisdiction defeats the tunnel.
      var avoid = [home]
      avoid.push(role === "both" ? applied.entry : entryCc)
      var chosen = Model.chooseFastestExit(pick, avoid)
      applied.exit = chosen.cc
      applied.exitId = chosen.id
      applied.exitRtt = chosen.rtt
    }

    svc.fastestResult = applied
    svc.fastestNotice = Model.homeCountryNotice(applied, home, role)

    // Pin the exact measured gateway when we have one; a bare country lets the
    // daemon re-roll inside that country by its own latency-blind score (which
    // measured 390ms / 2.5 MB/s on an SG node while a probed SG node answered
    // in 43ms). Without a measurement there is no evidence to pin, so we set
    // the more robust country constraint instead.
    var command = null
    if (role === "entry") {
      command = Model.setGatewaysCommand({ entry: applied.entry, entryId: applied.entryId })
    } else if (role === "exit") {
      command = Model.setGatewaysCommand({ exit: applied.exit, exitId: applied.exitId })
    } else {
      command = Model.setGatewaysCommand({
        entry: applied.entry, entryId: applied.entryId,
        exit: applied.exit, exitId: applied.exitId
      })
    }
    if (!command) {
      svc.notice = "Could not apply the fastest region."
      return
    }
    // Restore the tunnel we dropped in order to measure.
    if (svc.resumeAfterResolve) {
      svc.resumeAfterResolve = false
      svc.pendingConnect = true
    } else {
      svc.pendingReconnect = svc.status.state === "connected"
    }
    svc.runAction(command)
  }

  // Set when a gateway change needs the tunnel rebuilt to take effect.
  property bool pendingReconnect: false

  // --- automatic measure-and-switch cycle ----------------------------------
  // Latency cannot be measured through the tunnel, so choosing Fastest while
  // connected runs disconnect -> measure -> apply -> reconnect on its own.
  // Which step we are on ("" when idle), for the panel to narrate.
  property string fastestPhase: ""
  // The tunnel was up when the resolve started, so restore it afterwards.
  property bool resumeAfterResolve: false
  property bool pendingConnect: false
  // Rebuild even when the live route already satisfies the selection.
  property bool forceReconnect: false

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
      // Finish the automatic measure-and-switch cycle by reconnecting.
      if (svc.pendingConnect) {
        svc.pendingConnect = false
        connectTimer.restart()
      } else if (svc.pendingReconnect) {
        // A gateway constraint only takes effect on a fresh tunnel, so rebuild
        // it when we changed one while connected.
        svc.pendingReconnect = false
        reconnectTimer.restart()
      }
      settleTimer.restart()
    }
  }

  // Rebuild the tunnel after a gateway change -- but only if it is actually
  // needed. nym-vpnd already re-applies a constraint when the CURRENT gateway
  // violates it (verified: switching entry country while connected moved the
  // tunnel on its own), so reconnecting unconditionally would rebuild a tunnel
  // that is already correct. The interval also lets settleTimer refresh status
  // and config first, so the check below sees fresh state.
  Timer {
    id: reconnectTimer
    interval: 1500
    onTriggered: {
      if (svc.status.state !== "connected") {
        svc.forceReconnect = false
        return
      }
      var force = svc.forceReconnect
      svc.forceReconnect = false
      // Rebuild when the live route does not satisfy the selection. Note that
      // "Auto" is NOT satisfied by a gateway in the user's own country, so
      // switching to Auto while connected does rebuild -- without that, the
      // panel showed Auto while the tunnel stayed on the previous gateway.
      if (!force && svc.routeMismatch === "") return
      svc.runAction(Model.reconnectCommand())
    }
  }

  // Wait for the tunnel to actually go down before probing. Without this the
  // probe would run against a still-open tunnel and measure the exit's
  // neighbourhood instead of ours.
  Timer {
    id: disconnectWaitTimer
    interval: 1200
    repeat: true
    property int ticks: 0
    onRunningChanged: if (running) ticks = 0
    onTriggered: {
      disconnectWaitTimer.ticks++
      svc.refreshStatus()
      if (svc.actionBusy) return
      if (Model.canProbe(svc.status.state)) {
        disconnectWaitTimer.stop()
        svc.fastestPhase = "measuring"
        svc.fastestStep()
        return
      }
      // ~25s: give up, restore the tunnel rather than leaving it down.
      if (disconnectWaitTimer.ticks > 20) {
        disconnectWaitTimer.stop()
        svc.fastestFail("Could not disconnect to measure. Reconnecting.")
      }
    }
  }

  // Reconnect after the fastest route has been applied.
  Timer {
    id: connectTimer
    interval: 700
    onTriggered: {
      svc.fastestPhase = "reconnecting"
      svc.runAction(Model.connectCommand())
      cycleDoneTimer.restart()
    }
  }

  // Clear the cycle indicator once the tunnel has had time to come back.
  Timer {
    id: cycleDoneTimer
    interval: 4000
    onTriggered: {
      svc.fastestPhase = ""
      svc.refreshStatus()
      svc.refreshConfig()
    }
  }

  // --- persisted per-hop "Fastest" mode ------------------------------------
  readonly property string statePath: Quickshell.env("HOME") + "/.local/state/omarchy/nym-vpn.json"

  function saveFastestModes() {
    modesFile.setText(Model.serializeFastestModes({
      entry: svc.fastestModeEntry, exit: svc.fastestModeExit
    }))
  }

  function loadFastestModes(raw) {
    var m = Model.parseFastestModes(raw)
    svc.fastestModeEntry = m.entry
    svc.fastestModeExit = m.exit
  }

  FileView {
    id: modesFile
    path: svc.statePath
    watchChanges: false
    atomicWrites: true
    printErrors: false
    onLoaded: svc.loadFastestModes(text())
    // First run: no file yet, which is simply "no hop is in fastest mode".
    onLoadFailed: svc.loadFastestModes("")
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
