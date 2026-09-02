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
  readonly property string entryType: Model.entryGatewayType(svc.twoHop)
  readonly property string exitType: Model.exitGatewayType(svc.twoHop)
  readonly property var entryOptions: Model.countryOptions(svc.countryCodes[svc.entryType] || [])
  readonly property var exitOptions: Model.countryOptions(svc.countryCodes[svc.exitType] || [])
  property string notice: ""

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
    var command = Model.setGatewayCommand(role, value)
    if (!command) return
    svc.runAction(command)
  }

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
        svc.status = Model.parseStatus(String(text || ""), 0)
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
        var codes = Model.parseGatewayCountries(String(text || ""))
        if (listProc.pendingType !== "" && codes.length > 0) {
          var next = Object.assign({}, svc.countryCodes)
          next[listProc.pendingType] = codes
          svc.countryCodes = next
        }
      }
    }
    onExited: {
      listProc.pendingType = ""
      svc.refreshCountries()
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
    onExited: function(code) { settleTimer.restart() }
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
