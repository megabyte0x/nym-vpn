import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

Panel {
  id: root
  moduleName: "io.github.megabyte0x.nym-vpn"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  readonly property color contentForeground: bar ? bar.barForeground : Color.foreground
  readonly property string contentFontFamily: bar ? bar.fontFamily : Style.font.family

  // Live state, parsed from the CLI.
  property var status: Model.parseStatus("", 0)
  property var account: ({ stored: false, identity: "", state: "", mode: "" })
  property bool accountFetched: false
  property var twoHop: null
  property var gateway: ({ entry: "", exit: "" })
  // Available gateway countries per pool ("mixnet-entry"|"mixnet-exit"|"wg"),
  // fetched lazily from `nym-vpnc gateway list` and cached so the pickers open
  // instantly. Shape: { <type>: ["US", "DE", ...] }.
  property var countryCodes: ({})
  // Which pool feeds each hop for the current mode.
  readonly property string entryType: Model.entryGatewayType(root.twoHop)
  readonly property string exitType: Model.exitGatewayType(root.twoHop)
  readonly property var entryOptions: Model.countryOptions(root.countryCodes[root.entryType] || [])
  readonly property var exitOptions: Model.countryOptions(root.countryCodes[root.exitType] || [])
  property string notice: ""
  property bool copied: false
  // Inline login (recovery phrase) state.
  property bool loggingIn: false
  // True once we've seen the daemon answer without an auth prompt (polkit rule
  // installed / socket open). Gates auto account fetch and post-action polling
  // so users WITHOUT the rule are never spammed with prompts.
  property bool authFree: false
  readonly property bool loginBusy: loginProc.running
  readonly property bool loggedIn: accountFetched && account.stored

  // The remediation command shown in the setup card, shared by the label and
  // the copy button so they never drift.
  readonly property string setupCommand: !installed
    ? "yay -S nym-vpnc-bin nym-vpnd-bin\nsudo systemctl enable --now nym-vpnd"
    : (daemonDown
       ? "sudo systemctl enable --now nym-vpnd"
       : (authRequired
          // Optional: allow the active user to reach the daemon without a
          // password prompt on every call.
          ? "sudo tee /etc/polkit-1/rules.d/49-nymvpn.rules >/dev/null <<'EOF'\npolkit.addRule(function(action, subject) {\n  if (action.id == \"com.nymvpn.vpnd.unix-access\" && subject.active && subject.local) {\n    return polkit.Result.YES;\n  }\n});\nEOF"
          : "nym-vpnc account set <your recovery phrase>"))

  // Copy text to the Wayland clipboard via wl-copy, matching the shell's own
  // network/tailscale panels.
  function copyCommand(value) {
    if (!value) return
    Quickshell.execDetached(["bash", "-c", "printf %s " + Util.shellQuote(value) + " | wl-copy"])
    root.copied = true
    copiedTimer.restart()
  }

  readonly property bool installed: status.state !== "not-installed"
  readonly property bool daemonDown: status.state === "daemon-down"
  readonly property bool authRequired: status.state === "auth-required"
  readonly property bool needsSetup: status.state === "not-installed" || status.state === "daemon-down" || status.state === "auth-required"
  readonly property bool actionBusy: actionProc.running || loginProc.running

  function colorForRole(role) {
    if (role === "ok") return Color.accent
    if (role === "bad") return Color.urgent
    if (role === "busy") return Color.accent
    return Color.muted
  }

  function open() {
    root.controller.show()
    root.refreshAll()
  }

  function close() {
    root.loggingIn = false
    phraseField.text = ""
    root.watchTicks = 0
    root.controller.hide()
  }

  function toggle() {
    if (root.opened) root.close()
    else root.open()
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  // One daemon-touching call (status). Config reads (tunnel/gateway) are not
  // polkit-gated, so they don't add prompts. The account is auto-fetched only
  // once we know the daemon answers without a prompt (authFree) so users
  // without the polkit rule aren't spammed; otherwise it's fetched on demand.
  function refreshAll() {
    root.refreshStatus()
    root.refreshConfig()
    root.refreshCountries()
    if (root.authFree) root.refreshAccount()
  }

  function refreshAccount() {
    if (accountProc.running) return
    accountProc.command = Model.accountCommand()
    accountProc.running = true
  }

  function refreshStatus() {
    if (statusProc.running) return
    statusProc.command = Model.statusCommand()
    statusProc.running = true
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
  }

  function runAction(command) {
    if (!command || actionProc.running) return
    root.notice = ""
    actionProc.command = command
    actionProc.running = true
  }

  function doConnect() { root.runAction(Model.connectCommand()); root.startWatch() }
  function doDisconnect() { root.runAction(Model.disconnectCommand()); root.startWatch() }

  // Log in with a recovery phrase entered inline in this panel.
  function doLogin() {
    var phrase = phraseField.text
    if (!Model.looksLikeMnemonic(phrase)) {
      root.notice = "Enter your 12–24 word recovery phrase"
      return
    }
    if (loginProc.running) return
    root.notice = ""
    loginProc.command = Model.accountSetCommand(phrase)
    loginProc.running = true
  }

  function doForget() {
    root.runAction(Model.accountForgetCommand())
    root.accountFetched = false
  }

  // Bounded post-action status polling so Connect visibly reaches Connected.
  // Only runs when authFree (no prompts) to avoid spamming users without the
  // polkit rule.
  property int watchTicks: 0
  function startWatch() { if (root.authFree) root.watchTicks = 8 }
  function setMode(twoHopOn) {
    if (root.twoHop === twoHopOn) return
    root.runAction(Model.setTwoHopCommand(twoHopOn))
  }
  // Apply a single hop's country selection immediately when the user picks it.
  function applyGateway(role, value) {
    var command = Model.setGatewayCommand(role, value)
    if (!command) return
    root.runAction(command)
  }

  // Fetch the country list for a gateway pool once and cache it. Safe to call
  // repeatedly; it no-ops while a fetch is in flight or already cached.
  function ensureCountries(type) {
    if (!type) return
    if (root.countryCodes[type] && root.countryCodes[type].length > 0) return
    if (listProc.running) return
    listProc.pendingType = type
    listProc.command = Model.gatewayListCommand(type)
    listProc.running = true
  }

  // Make sure both hops' pools for the current mode are loaded.
  function refreshCountries() {
    root.ensureCountries(root.entryType)
    if (root.exitType !== root.entryType) root.ensureCountries(root.exitType)
  }

  // --- Processes -----------------------------------------------------------

  Process {
    id: statusProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.status = Model.parseStatus(String(text || ""), 0)
        // Learn whether the daemon answers without a polkit prompt.
        if (root.status.state !== "auth-required" && root.status.state !== "unknown" &&
            root.status.state !== "not-installed") {
          if (!root.authFree) {
            root.authFree = true
            if (root.opened && !root.accountFetched) root.refreshAccount()
          }
        } else if (root.status.state === "auth-required") {
          root.authFree = false
        }
      }
    }
    onExited: function(code) {
      if (code !== 0 && root.status && root.status.state === "unknown")
        root.status = Model.parseStatus("", code)
    }
  }

  Process {
    id: loginProc
    stdout: StdioCollector { id: loginOut; waitForEnd: true }
    stderr: StdioCollector { id: loginErr; waitForEnd: true }
    onExited: function(code) {
      var out = (String(loginOut.text || "") + "\n" + String(loginErr.text || "")).trim()
      var last = out.split("\n").filter(function(l){ return l.trim() !== "" }).slice(-1)[0] || ""
      if (code === 0) {
        root.notice = last !== "" ? last : "Account set. Welcome to NymVPN!"
        phraseField.text = ""
        root.loggingIn = false
        root.accountFetched = false
        settleTimer.restart()
      } else {
        root.notice = last !== "" ? last : "Login failed"
      }
    }
  }

  Process {
    id: accountProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.account = Model.parseAccount(String(text || ""))
        root.accountFetched = true
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
          root.twoHop = v
          // Mode determines which gateway pool feeds each hop; load it.
          root.refreshCountries()
        }
      }
    }
  }

  Process {
    id: gatewayProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.gateway = Model.parseGateway(String(text || ""))
    }
  }

  // Lazy country-list fetch for the pickers. `gateway list` is a config read
  // (not polkit-gated), so it doesn't add password prompts.
  Process {
    id: listProc
    property string pendingType: ""
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var codes = Model.parseGatewayCountries(String(text || ""))
        if (listProc.pendingType !== "" && codes.length > 0) {
          var next = Object.assign({}, root.countryCodes)
          next[listProc.pendingType] = codes
          root.countryCodes = next
        }
      }
    }
    onExited: {
      listProc.pendingType = ""
      // If the other hop's pool is still empty, fetch it now.
      root.refreshCountries()
    }
  }

  Process {
    id: actionProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var out = String(text || "").trim()
        if (out !== "") root.notice = out.split("\n").slice(-1)[0]
      }
    }
    onExited: function(code) {
      // Give the daemon a moment to change state, then re-read everything.
      settleTimer.restart()
    }
  }

  Timer {
    id: copiedTimer
    interval: 1400
    onTriggered: root.copied = false
  }

  Timer {
    id: settleTimer
    interval: 600
    onTriggered: {
      root.refreshStatus()
      root.refreshConfig()
      if (root.authFree) root.refreshAccount()
    }
  }

  // Bounded post-action polling: only active for a few ticks after Connect/
  // Disconnect, and only when authFree (no prompts). Stops early on a terminal
  // state. Users without the polkit rule never poll (watchTicks stays 0).
  Timer {
    id: watchTimer
    interval: 2500
    repeat: true
    running: root.opened && root.authFree && root.watchTicks > 0
    onTriggered: {
      root.watchTicks -= 1
      root.refreshStatus()
      var s = root.status.state
      if (s === "connected" || s === "disconnected" || s === "error")
        root.watchTicks = 0
    }
  }

  // No always-on poll timer: without the polkit rule each status call prompts,
  // so we refresh only on explicit action (open, r, connect/disconnect).
  onOpenedChanged: if (root.opened) root.refreshConfig()

  // --- UI ------------------------------------------------------------------

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: root.loggingIn ? phraseField : keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(320))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // While a region picker (search field + result list) or the inline login
      // field owns the keyboard, suspend the panel's own key handling so typing
      // doesn't leak into shortcuts and Esc closes the popup, not the panel.
      blocked: entryPicker.popupOpen || exitPicker.popupOpen || root.loggingIn
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(key) { if (key === "r") root.refreshAll() }

      Column {
        id: column
        width: parent.width
        spacing: Style.spacing.lg

        // Header: status dot + label
        Row {
          width: parent.width
          spacing: Style.spacing.md

          Text {
            anchors.verticalCenter: parent.verticalCenter
            text: Model.stateGlyph(root.status.state)
            color: root.colorForRole(Model.stateColorRole(root.status.state))
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.displayLarge
          }

          Column {
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.spacing.xxs
            width: parent.width - Style.space(48)

            Text {
              text: "NymVPN"
              color: root.contentForeground
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.title
              font.bold: true
            }

            Text {
              width: parent.width
              elide: Text.ElideRight
              text: root.status.label + (root.status.detail !== "" && root.status.detail.toLowerCase() !== root.status.label.toLowerCase() ? " · " + root.status.detail : "")
              color: root.colorForRole(Model.stateColorRole(root.status.state))
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.bodySmall
            }
          }
        }

        PanelSeparator {}

        // Setup card (missing CLI, daemon down, or authentication needed)
        Column {
          width: parent.width
          spacing: Style.spacing.sm
          visible: root.needsSetup

          Text {
            width: parent.width
            wrapMode: Text.WordWrap
            text: !root.installed
                  ? "NymVPN CLI (nym-vpnc) not found. The daemon/GUI packages don't include it — install the CLI package, then reopen this panel."
                  : (root.daemonDown
                     ? "The nym-vpnd daemon is not running."
                     : "nym-vpnd asks for your password on every action (polkit). Approve the prompt to continue — or install the optional rule below to allow the active user without repeated prompts.")
            color: root.authRequired ? root.contentForeground : Color.urgent
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.bodySmall
          }

          Rectangle {
            width: parent.width
            implicitHeight: setupText.implicitHeight + Style.space(16)
            radius: Style.cornerRadius
            color: copyMouse.containsMouse ? Style.selectedFill : Style.hoverFill

            Text {
              id: setupText
              anchors.left: parent.left
              anchors.right: copyLabel.left
              anchors.top: parent.top
              anchors.margins: Style.space(8)
              wrapMode: Text.WrapAnywhere
              textFormat: Text.PlainText
              color: root.contentForeground
              font.family: "monospace"
              font.pixelSize: Style.font.caption
              text: root.setupCommand
            }

            Text {
              id: copyLabel
              anchors.right: parent.right
              anchors.top: parent.top
              anchors.margins: Style.space(8)
              text: root.copied ? "Copied" : "Copy"
              color: root.copied ? Color.accent : (copyMouse.containsMouse ? root.contentForeground : Color.muted)
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
              font.bold: root.copied
            }

            MouseArea {
              id: copyMouse
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: root.copyCommand(root.setupCommand)
            }
          }

          Text {
            width: parent.width
            wrapMode: Text.WordWrap
            visible: root.authRequired
            text: "Click the command above to copy it, run it once in a terminal, then log out/in (or restart the polkit agent) and press r. This lets the active local user reach the daemon without a password prompt every time."
            color: Color.muted
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
          }
        }

        // Connect / Disconnect controls
        Row {
          width: parent.width
          spacing: Style.spacing.md
          visible: root.installed && !root.daemonDown

          // Connect
          Rectangle {
            width: (parent.width - Style.spacing.md) / 2
            implicitHeight: connectLabel.implicitHeight + Style.space(16)
            radius: Style.cornerRadius
            readonly property bool enabled: !root.actionBusy && root.status.state !== "connected" && root.status.state !== "connecting"
            color: connectMouse.containsMouse && enabled ? Style.selectedFill : Style.hoverFill
            opacity: enabled ? 1 : 0.45

            Text {
              id: connectLabel
              anchors.centerIn: parent
              text: root.status.state === "connecting" ? "Connecting…" : "Connect"
              color: Color.accent
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.body
              font.bold: true
            }

            MouseArea {
              id: connectMouse
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: parent.enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
              onClicked: if (parent.enabled) root.doConnect()
            }
          }

          // Disconnect
          Rectangle {
            width: (parent.width - Style.spacing.md) / 2
            implicitHeight: disconnectLabel.implicitHeight + Style.space(16)
            radius: Style.cornerRadius
            readonly property bool enabled: !root.actionBusy && root.status.state !== "disconnected" && root.status.state !== "disconnecting"
            color: disconnectMouse.containsMouse && enabled ? Style.selectedFill : Style.hoverFill
            opacity: enabled ? 1 : 0.45

            Text {
              id: disconnectLabel
              anchors.centerIn: parent
              text: root.status.state === "disconnecting" ? "Disconnecting…" : "Disconnect"
              color: Color.urgent
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.body
              font.bold: true
            }

            MouseArea {
              id: disconnectMouse
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: parent.enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
              onClicked: if (parent.enabled) root.doDisconnect()
            }
          }
        }

        // Mode toggle: Anonymous (5-hop mixnet) vs Fast (2-hop WireGuard)
        Column {
          width: parent.width
          spacing: Style.spacing.sm
          visible: root.installed && !root.daemonDown

          Text {
            text: "Mode"
            color: Color.muted
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
          }

          Row {
            width: parent.width
            spacing: Style.spacing.sm

            Repeater {
              model: [
                { label: "Anonymous · 5-hop", twoHop: false },
                { label: "Fast · 2-hop", twoHop: true }
              ]

              Rectangle {
                required property var modelData
                readonly property bool selected: root.twoHop === modelData.twoHop
                width: (column.width - Style.spacing.sm) / 2
                implicitHeight: modeLabel.implicitHeight + Style.space(12)
                radius: Style.cornerRadius
                color: selected ? Style.selectedFill : (modeMouse.containsMouse ? Style.hoverFill : "transparent")
                border.width: 1
                border.color: selected ? Color.accent : Style.hoverFill
                opacity: root.actionBusy ? 0.5 : 1

                Text {
                  id: modeLabel
                  anchors.centerIn: parent
                  width: parent.width - Style.space(8)
                  horizontalAlignment: Text.AlignHCenter
                  elide: Text.ElideRight
                  text: modelData.label
                  color: parent.selected ? root.contentForeground : Color.muted
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.bodySmall
                  font.bold: parent.selected
                }

                MouseArea {
                  id: modeMouse
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: if (!root.actionBusy) root.setMode(modelData.twoHop)
                }
              }
            }
          }
        }

        // Entry / exit region selection. Instead of typing a country code, the
        // user picks a region from a searchable, flagged list for each hop.
        Column {
          width: parent.width
          spacing: Style.spacing.sm
          visible: root.installed && !root.daemonDown
          opacity: root.actionBusy ? 0.55 : 1

          Text {
            width: parent.width
            elide: Text.ElideRight
            text: "Servers  ·  " + Model.gatewaySummary(root.gateway)
            color: Color.muted
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
          }

          // Entry (where your traffic enters the network)
          SearchableDropdown {
            id: entryPicker
            width: parent.width
            label: "Entry region"
            placeholderText: "Search a country…"
            emptyText: root.entryOptions.length <= 2 ? "Loading regions…" : "No matches"
            triggerLabel: "Auto (recommended)"
            options: root.entryOptions
            value: Model.gatewaySelection(root.gateway.entry)
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            onChanged: function(v) { root.applyGateway("entry", v) }
          }

          // Exit (the region your traffic appears to come from)
          SearchableDropdown {
            id: exitPicker
            width: parent.width
            label: "Exit region"
            placeholderText: "Search a country…"
            emptyText: root.exitOptions.length <= 2 ? "Loading regions…" : "No matches"
            triggerLabel: "Auto (recommended)"
            options: root.exitOptions
            value: Model.gatewaySelection(root.gateway.exit)
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            onChanged: function(v) { root.applyGateway("exit", v) }
          }
        }

        PanelSeparator { visible: root.installed && !root.daemonDown }

        // Account + Login. The recovery phrase is entered INLINE here (masked),
        // never in a screen-grabbing system dialog.
        Column {
          width: parent.width
          spacing: Style.spacing.sm
          visible: root.installed && !root.daemonDown

          // Summary row: account state (left) + Log in / Log out action (right)
          Item {
            width: parent.width
            implicitHeight: acctLabel.implicitHeight

            Text {
              id: acctLabel
              anchors.left: parent.left
              anchors.right: acctAction.left
              anchors.rightMargin: Style.spacing.sm
              anchors.verticalCenter: parent.verticalCenter
              elide: Text.ElideRight
              text: {
                var acct = root.accountFetched
                  ? (root.account.stored ? "Account: " + (root.account.state !== "" ? root.account.state : "active") : "Account: not logged in")
                  : "Account: tap to check"
                return acct + "  ·  " + Model.modeLabel(root.twoHop)
              }
              color: acctMouse.containsMouse ? root.contentForeground : Color.muted
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption

              MouseArea {
                id: acctMouse
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.refreshAccount()
              }
            }

            Text {
              id: acctAction
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              text: root.loggedIn ? "Log out" : (root.loggingIn ? "Cancel" : "Log in")
              color: acctActionMouse.containsMouse ? root.contentForeground : Color.accent
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
              font.bold: true

              MouseArea {
                id: acctActionMouse
                anchors.fill: parent
                anchors.margins: -Style.space(6)
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                  if (root.loggedIn) root.doForget()
                  else root.loggingIn = !root.loggingIn
                }
              }
            }
          }

          // Inline recovery-phrase entry (masked). Focus stays in this panel.
          Column {
            width: parent.width
            spacing: Style.spacing.sm
            visible: root.loggingIn && !root.loggedIn

            TextField {
              id: phraseField
              width: parent.width
              password: true
              placeholderText: "12–24 word recovery phrase"
              foreground: root.contentForeground
              font.family: root.contentFontFamily
              onAccepted: root.doLogin()
            }

            Row {
              width: parent.width
              spacing: Style.spacing.sm

              Rectangle {
                width: (parent.width - Style.spacing.sm) / 2
                implicitHeight: loginLabel.implicitHeight + Style.space(14)
                radius: Style.cornerRadius
                readonly property bool enabled: !root.loginBusy && Model.looksLikeMnemonic(phraseField.text)
                color: loginMouse.containsMouse && enabled ? Style.selectedFill : Style.hoverFill
                opacity: enabled ? 1 : 0.45

                Text {
                  id: loginLabel
                  anchors.centerIn: parent
                  text: root.loginBusy ? "Logging in…" : "Log in"
                  color: Color.accent
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.body
                  font.bold: true
                }

                MouseArea {
                  id: loginMouse
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: parent.enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                  onClicked: if (parent.enabled) root.doLogin()
                }
              }

              Rectangle {
                width: (parent.width - Style.spacing.sm) / 2
                implicitHeight: cancelLabel.implicitHeight + Style.space(14)
                radius: Style.cornerRadius
                color: cancelMouse.containsMouse ? Style.selectedFill : Style.hoverFill

                Text {
                  id: cancelLabel
                  anchors.centerIn: parent
                  text: "Cancel"
                  color: root.contentForeground
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.body
                }

                MouseArea {
                  id: cancelMouse
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: { phraseField.text = ""; root.loggingIn = false }
                }
              }
            }

            Text {
              width: parent.width
              wrapMode: Text.WordWrap
              text: "Entered here and passed straight to nym-vpnd via the nym-vpnc CLI, which stores it locally. It never leaves your machine, touches the clipboard, or hits a log. The CLI only accepts the phrase as a command argument, so it is briefly visible to other processes on this machine (same user or root) while login runs."
              color: Color.muted
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
            }
          }
        }

        // Notice / last command output
        Text {
          width: parent.width
          wrapMode: Text.WordWrap
          visible: root.notice !== ""
          text: root.notice
          color: Color.muted
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
        }

        // Footer hint
        Text {
          width: parent.width
          horizontalAlignment: Text.AlignHCenter
          text: "r to refresh · Esc to close"
          color: Color.muted
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }
  }
}
