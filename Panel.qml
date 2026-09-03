import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model
import "." as Nym

Panel {
  id: root
  moduleName: "io.github.megabyte0x.nym-vpn"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  // Panel content sits on the opaque popup surface, so it must track the THEME
  // foreground (bar.foreground / Color.bar.text), not bar.barForeground.
  // barForeground is the wallpaper-contrast color the transparent bar computes
  // via omarchy-bar-text-color; over a light wallpaper it flips to the dark
  // contrast color and would render panel text invisible against the dark
  // popup background. Use it for bar chrome only.
  readonly property color contentForeground: bar ? bar.foreground : Color.foreground
  readonly property string contentFontFamily: bar ? bar.fontFamily : Style.font.family

  // All live state + CLI interaction lives in the process-wide NymService
  // singleton, so every monitor's bar and every open panel share ONE source of
  // truth (fixes per-screen divergence) and reflect the background status poll.
  // These are thin read-only projections of that shared state.
  readonly property var status: Nym.NymService.status
  readonly property var account: Nym.NymService.account
  readonly property bool accountFetched: Nym.NymService.accountFetched
  readonly property var twoHop: Nym.NymService.twoHop
  readonly property var gateway: Nym.NymService.gateway
  readonly property var lanAllow: Nym.NymService.lanAllow
  readonly property var entryOptions: Nym.NymService.entryOptions
  readonly property var exitOptions: Nym.NymService.exitOptions
  readonly property string notice: Nym.NymService.notice
  readonly property bool loggedIn: Nym.NymService.loggedIn
  // "Fastest" (measured) region selection state.
  readonly property bool fastestBusy: Nym.NymService.fastestBusy
  readonly property var fastestResult: Nym.NymService.fastestResult
  readonly property string fastestNotice: Nym.NymService.fastestNotice
  property bool copied: false

  // The remediation command shown in the setup card (install / start daemon).
  // Auth-required is NOT a copyable command here: we tell the user to approve
  // the password prompt rather than presenting a broad passwordless polkit rule
  // as a default step. Account login is likewise never a copy-and-run secret
  // command driven by the panel -- see the account section, which points the
  // user to run `nym-vpnc account set` themselves in a terminal.
  readonly property string setupCommand: !installed
    ? "yay -S nym-vpnc-bin nym-vpnd-bin\nsudo systemctl enable --now nym-vpnd"
    : (daemonDown ? "sudo systemctl enable --now nym-vpnd" : "")

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
  readonly property bool actionBusy: Nym.NymService.actionBusy

  function colorForRole(role) {
    if (role === "ok") return Color.accent
    if (role === "bad") return Color.urgent
    if (role === "busy") return Color.accent
    return Color.muted
  }

  function open() {
    root.controller.show()
    Nym.NymService.refreshAll()
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

  // Thin delegators to the shared NymService singleton, which owns all CLI
  // interaction, parsed state and the background status poll.
  function refreshAll() { Nym.NymService.refreshAll() }
  function refreshAccount() { Nym.NymService.refreshAccount() }
  function doConnect() { Nym.NymService.connect() }
  function doDisconnect() { Nym.NymService.disconnect() }
  function doForget() { Nym.NymService.forget() }
  function setMode(twoHopOn) { Nym.NymService.setMode(twoHopOn) }
  function setLan(allow) { Nym.NymService.setLan(allow) }
  function applyGateway(role, value) { Nym.NymService.applyGateway(role, value) }
  function resolveFastest(role) { Nym.NymService.resolveFastest(role) }

  Timer {
    id: copiedTimer
    interval: 1400
    onTriggered: root.copied = false
  }

  // Live status now comes from NymService's background poll; the panel just
  // asks for an immediate refresh when it opens.
  onOpenedChanged: if (root.opened) Nym.NymService.refreshAll()

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
      // While a region picker (search field + result list) owns the keyboard,
      // suspend the panel's own key handling so typing doesn't leak into
      // shortcuts and Esc closes the popup, not the panel.
      blocked: entryPicker.popupOpen || exitPicker.popupOpen
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
              text: root.status.label
              color: root.colorForRole(Model.stateColorRole(root.status.state))
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.bodySmall
            }
          }
        }

        // Why it failed, and what to do about it. The daemon's reason was
        // parsed all along but never shown, so the panel could only say
        // "Error" -- unreadable and unactionable.
        Column {
          width: parent.width
          spacing: Style.spacing.xxs
          visible: root.status.state === "error" && root.status.detail !== ""

          Text {
            width: parent.width
            wrapMode: Text.WordWrap
            text: root.status.detail
            color: Color.urgent
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
          }

          Text {
            width: parent.width
            wrapMode: Text.WordWrap
            visible: text !== ""
            text: Model.errorHint(root.status.detail)
            color: Color.muted
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
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
                     : "nym-vpnd asks for your password (polkit) on each action. Approve the system prompt to continue, then press r.")
            color: root.authRequired ? root.contentForeground : Color.urgent
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.bodySmall
          }

          Rectangle {
            width: parent.width
            visible: root.setupCommand !== ""
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
            text: "Prefer approving the prompt per action. Advanced users can optionally allow the active local user without a prompt via a polkit rule — see the README; this trades security for convenience and is not required."
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

        // Local network access. nym-vpnd blocks LAN traffic by default, which
        // breaks printers, casting, file sharing and clipboard-continuity tools
        // on your own network while the tunnel is up.
        Column {
          width: parent.width
          spacing: Style.spacing.sm
          visible: root.installed && !root.daemonDown

          Text {
            text: "Local network"
            color: Color.muted
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
          }

          Row {
            width: parent.width
            spacing: Style.spacing.sm

            Repeater {
              model: [
                { label: "Allow LAN", allow: true },
                { label: "Block LAN", allow: false }
              ]

              Rectangle {
                required property var modelData
                readonly property bool selected: root.lanAllow === modelData.allow
                width: (column.width - Style.spacing.sm) / 2
                implicitHeight: lanOptionLabel.implicitHeight + Style.space(12)
                radius: Style.cornerRadius
                color: selected ? Style.selectedFill : (lanMouse.containsMouse ? Style.hoverFill : "transparent")
                border.width: 1
                border.color: selected ? Color.accent : Style.hoverFill
                opacity: root.actionBusy ? 0.5 : 1

                Text {
                  id: lanOptionLabel
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
                  id: lanMouse
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: if (!root.actionBusy) root.setLan(modelData.allow)
                }
              }
            }
          }

          Text {
            width: parent.width
            wrapMode: Text.WordWrap
            visible: root.lanAllow === true
            text: "Devices on your own network (printers, shared drives, clipboard sync) stay reachable. Everything else still goes through the tunnel."
            color: Color.muted
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
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
            text: "Servers  ·  " + Nym.NymService.routeSummary
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
            emptyText: root.entryOptions.length <= 3 ? "Loading regions…" : "No matches"
            // NOT "Auto": the dropdown falls back to this whenever the current
            // value is unknown (e.g. a pinned gateway before the pool list has
            // loaded). Labelling that state "Auto" told users their entry was
            // Auto while the tunnel was pinned to a gateway in their own
            // country. A neutral placeholder cannot lie.
            triggerLabel: "Select a region…"
            options: root.entryOptions
            // Show the MODE the user chose (Fastest) rather than the country it
            // resolved to, which looked like a manual pick.
            value: Nym.NymService.entryDisplay
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
            emptyText: root.exitOptions.length <= 3 ? "Loading regions…" : "No matches"
            triggerLabel: "Select a region…"
            options: root.exitOptions
            value: Nym.NymService.exitDisplay
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            onChanged: function(v) { root.applyGateway("exit", v) }
          }

          // Result of a "Fastest" resolve: what was measured and chosen. The
          // daemon's own Auto is latency-blind (it will happily route a user in
          // India through Dubai to Baku), so this line exists to make the
          // measured alternative visible and repeatable.
          Item {
            width: parent.width
            visible: root.fastestBusy || root.fastestResult !== null
            implicitHeight: Math.max(fastestLine.implicitHeight, retestLabel.implicitHeight)

            Text {
              id: fastestLine
              anchors.left: parent.left
              anchors.right: retestLabel.left
              anchors.rightMargin: Style.spacing.sm
              anchors.verticalCenter: parent.verticalCenter
              elide: Text.ElideRight
              text: root.fastestBusy
                    ? "⚡  " + (Model.fastestPhaseLabel(Nym.NymService.fastestPhase)
                                 || "Measuring latency…")
                    : "⚡  " + Model.fastestSummary(root.fastestResult,
                                                    Nym.NymService.lastFastestRole)
              color: root.fastestBusy ? Color.muted : root.contentForeground
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
            }

            Text {
              id: retestLabel
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              visible: !root.fastestBusy
              text: "Re-test"
              color: retestMouse.containsMouse ? root.contentForeground : Color.accent
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
              font.bold: true

              MouseArea {
                id: retestMouse
                anchors.fill: parent
                anchors.margins: -Style.space(6)
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                // Repeat whatever the last resolve applied -- re-testing an
                // exit-only Fastest must not overwrite the entry selection.
                onClicked: root.resolveFastest("repeat")
              }
            }
          }

          // The tunnel is not on the selected region. Shown so a silent
          // fallback or an accidental change can never masquerade as the
          // configured route.
          Text {
            width: parent.width
            wrapMode: Text.WordWrap
            visible: Nym.NymService.routeMismatch !== ""
            text: "⚠  " + Nym.NymService.routeMismatch
            color: Color.urgent
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
          }

          // Why a measurement could not be taken (tunnel up => every probe is
          // routed through the exit gateway, so it would rank the exit's
          // neighbourhood, not yours).
          Text {
            width: parent.width
            wrapMode: Text.WordWrap
            visible: root.fastestNotice !== ""
            text: root.fastestNotice
            color: Color.muted
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
          }
        }

        PanelSeparator { visible: root.installed && !root.daemonDown }

        // Account. The plugin only DETECTS and CONTROLS an already-configured
        // account: it never accepts a recovery phrase (that would place the
        // mnemonic in nym-vpnc's argv). Login is done by the user in a terminal.
        Column {
          width: parent.width
          spacing: Style.spacing.sm
          visible: root.installed && !root.daemonDown

          // Log out action (right-aligned, only when an account is
          // configured). The redundant account-state / mode summary line was
          // removed -- connection state lives in the header and mode in the
          // Mode toggle above.
          Item {
            width: parent.width
            implicitHeight: root.loggedIn ? acctAction.implicitHeight : 0
            visible: root.loggedIn

            Text {
              id: acctAction
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              visible: root.loggedIn
              text: "Log out"
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
                onClicked: root.doForget()
              }
            }
          }

          // Not-configured: point the user to the terminal login flow. The
          // plugin never takes the phrase itself, because the official CLI only
          // accepts it as an argv positional (visible in /proc); running it in
          // your own terminal keeps that exposure under your direct control.
          Column {
            width: parent.width
            spacing: Style.spacing.sm
            visible: root.accountFetched && !root.account.stored

            Text {
              width: parent.width
              wrapMode: Text.WordWrap
              text: "No account configured. Log in from a terminal with the official CLI, then press r:"
              color: root.contentForeground
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
            }

            Rectangle {
              width: parent.width
              implicitHeight: acctSetupText.implicitHeight + Style.space(16)
              radius: Style.cornerRadius
              color: acctCopyMouse.containsMouse ? Style.selectedFill : Style.hoverFill

              Text {
                id: acctSetupText
                anchors.left: parent.left
                anchors.right: acctCopyLabel.left
                anchors.top: parent.top
                anchors.margins: Style.space(8)
                wrapMode: Text.WrapAnywhere
                textFormat: Text.PlainText
                color: root.contentForeground
                font.family: "monospace"
                font.pixelSize: Style.font.caption
                text: Model.accountSetupHint()
              }

              Text {
                id: acctCopyLabel
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.margins: Style.space(8)
                text: root.copied ? "Copied" : "Copy"
                color: root.copied ? Color.accent : (acctCopyMouse.containsMouse ? root.contentForeground : Color.muted)
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                font.bold: root.copied
              }

              MouseArea {
                id: acctCopyMouse
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.copyCommand(Model.accountSetupHint())
              }
            }

            Text {
              width: parent.width
              wrapMode: Text.WordWrap
              text: "Replace <your recovery phrase> with your 12–24 word phrase. The plugin never handles the phrase itself — the CLI accepts it only as a command argument, so entering it in your own terminal keeps that brief exposure under your control."
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

      }
    }
  }
}
