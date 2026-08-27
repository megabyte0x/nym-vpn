import QtQuick
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
  property var twoHop: null
  property var gateway: ({ entry: "", exit: "" })
  property string notice: ""

  readonly property bool installed: status.state !== "not-installed"
  readonly property bool daemonDown: status.state === "daemon-down"
  readonly property bool needsSetup: status.state === "not-installed" || status.state === "daemon-down" || !account.stored
  readonly property bool actionBusy: actionProc.running

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

  function refreshAll() {
    root.refreshStatus()
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

  function doConnect() { root.runAction(Model.connectCommand()) }
  function doDisconnect() { root.runAction(Model.disconnectCommand()) }
  function setMode(twoHopOn) {
    if (root.twoHop === twoHopOn) return
    root.runAction(Model.setTwoHopCommand(twoHopOn))
  }
  function applyCountries() {
    var command = Model.setCountriesCommand(entryField.text, exitField.text)
    if (!command) {
      root.notice = "Enter a 2-letter country code (e.g. US, DE)"
      return
    }
    root.runAction(command)
  }

  // --- Processes -----------------------------------------------------------

  Process {
    id: statusProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.status = Model.parseStatus(String(text || ""), 0)
    }
    onExited: function(code) {
      if (code !== 0 && root.status && root.status.state === "unknown")
        root.status = Model.parseStatus("", code)
    }
  }

  Process {
    id: accountProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.account = Model.parseAccount(String(text || ""))
    }
  }

  Process {
    id: tunnelProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var v = Model.parseTwoHop(String(text || ""))
        if (v !== null) root.twoHop = v
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
    id: settleTimer
    interval: 600
    onTriggered: {
      root.refreshStatus()
      root.refreshConfig()
    }
  }

  Timer {
    interval: Model.POLL_INTERVAL_MS
    repeat: true
    running: root.opened
    triggeredOnStart: false
    onTriggered: root.refreshStatus()
  }

  Component.onCompleted: root.refreshConfig()
  onOpenedChanged: if (root.opened) root.refreshConfig()

  // --- UI ------------------------------------------------------------------

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(320))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
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

        // Setup card (missing CLI, daemon down, or no account stored)
        Column {
          width: parent.width
          spacing: Style.spacing.sm
          visible: root.needsSetup

          Text {
            width: parent.width
            wrapMode: Text.WordWrap
            text: !root.installed
                  ? "NymVPN CLI not found. Install it, then reopen this panel."
                  : (root.daemonDown
                     ? "The nym-vpnd daemon is not running."
                     : "No account stored. Log in with your recovery phrase.")
            color: Color.urgent
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.bodySmall
          }

          Rectangle {
            width: parent.width
            implicitHeight: setupText.implicitHeight + Style.space(16)
            radius: Style.cornerRadius
            color: Style.hoverFill

            Text {
              id: setupText
              anchors.fill: parent
              anchors.margins: Style.space(8)
              wrapMode: Text.WrapAnywhere
              textFormat: Text.PlainText
              color: root.contentForeground
              font.family: "monospace"
              font.pixelSize: Style.font.caption
              text: !root.installed
                    ? "yay -S nym-vpnd-bin nym-vpn-app-bin\nsudo systemctl enable --now nym-vpnd"
                    : (root.daemonDown
                       ? "sudo systemctl enable --now nym-vpnd"
                       : "nym-vpnc account set <your recovery phrase>")
            }
          }

          Text {
            width: parent.width
            wrapMode: Text.WordWrap
            visible: root.installed && !root.daemonDown && !root.account.stored
            text: "Run the command above in a terminal (never paste your recovery phrase here), then press r to refresh."
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

        // Entry / exit country selection
        Column {
          width: parent.width
          spacing: Style.spacing.sm
          visible: root.installed && !root.daemonDown

          Text {
            text: "Gateways" + (root.gateway.entry !== "" || root.gateway.exit !== "" ? "  ·  " + root.gateway.entry + " → " + root.gateway.exit : "")
            width: parent.width
            elide: Text.ElideRight
            color: Color.muted
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
          }

          Row {
            width: parent.width
            spacing: Style.spacing.sm

            TextField {
              id: entryField
              width: (column.width - Style.spacing.sm * 2 - applyBtn.width) / 2
              placeholderText: "Entry (US)"
              foreground: root.contentForeground
              font.family: root.contentFontFamily
              Keys.onPressed: function(e) {
                if (e.key === Qt.Key_Return || e.key === Qt.Key_Enter) { root.applyCountries(); e.accepted = true }
              }
            }

            TextField {
              id: exitField
              width: (column.width - Style.spacing.sm * 2 - applyBtn.width) / 2
              placeholderText: "Exit (DE)"
              foreground: root.contentForeground
              font.family: root.contentFontFamily
              Keys.onPressed: function(e) {
                if (e.key === Qt.Key_Return || e.key === Qt.Key_Enter) { root.applyCountries(); e.accepted = true }
              }
            }

            Rectangle {
              id: applyBtn
              anchors.verticalCenter: parent.verticalCenter
              width: applyLabel.implicitWidth + Style.space(16)
              implicitHeight: applyLabel.implicitHeight + Style.space(12)
              radius: Style.cornerRadius
              color: applyMouse.containsMouse ? Style.selectedFill : Style.hoverFill
              opacity: root.actionBusy ? 0.5 : 1

              Text {
                id: applyLabel
                anchors.centerIn: parent
                text: "Set"
                color: root.contentForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.bodySmall
              }

              MouseArea {
                id: applyMouse
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: if (!root.actionBusy) root.applyCountries()
              }
            }
          }
        }

        PanelSeparator { visible: root.installed && !root.daemonDown }

        // Account + mode summary line
        Text {
          width: parent.width
          wrapMode: Text.WordWrap
          visible: root.installed && !root.daemonDown
          text: (root.account.stored ? "Account: " + (root.account.state !== "" ? root.account.state : "active") : "Account: not logged in")
                + "  ·  " + Model.modeLabel(root.twoHop)
          color: Color.muted
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
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
          text: "Press r to refresh · Esc to close"
          color: Color.muted
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }
  }
}
