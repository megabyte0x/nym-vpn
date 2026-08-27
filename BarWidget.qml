import QtQuick
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

BarWidget {
  id: root
  moduleName: "io.github.megabyte0x.nym-vpn"

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  // Mirror of the panel's current status so the bar can render without the
  // panel being open.
  property var status: Model.parseStatus("", 0)

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  function open() {
    if (panelLoader.item) panelLoader.item.open()
  }

  function close() {
    if (panelLoader.item) panelLoader.item.close()
  }

  function togglePanel() {
    if (panelLoader.item) panelLoader.item.toggle()
  }

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  // Refresh delegates to the panel so we make exactly ONE daemon call per user
  // action. The daemon is polkit-gated (a password prompt per call), so we must
  // never poll on a timer or fan out multiple status calls.
  function refresh() {
    if (panelLoader.item) panelLoader.item.refreshAll()
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  function colorForRole(role) {
    if (role === "ok") return Color.accent
    if (role === "bad") return Color.urgent
    if (role === "busy") return Color.accent
    return Color.muted
  }

  // No background polling: nym-vpnd is polkit-gated, so a timer would pop a
  // password prompt every few seconds. The bar reflects the last status the
  // panel fetched (on open / refresh / after an action); until then it shows a
  // neutral "unknown" dot.
  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  // Let the panel publish its freshly-parsed status up to the bar.
  Connections {
    target: panelLoader.item
    ignoreUnknownSignals: true
    function onStatusChanged() {
      if (panelLoader.item && panelLoader.item.status)
        root.status = panelLoader.item.status
    }
  }

  IpcHandler {
    target: "io.github.megabyte0x.nym-vpn"

    function refresh(): void { root.refresh() }
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.togglePanel() }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    hasVisualContent: true
    labelVisible: true
    text: Model.stateGlyph(root.status ? root.status.state : "unknown") + " nym"
    foreground: root.colorForRole(Model.stateColorRole(root.status ? root.status.state : "unknown"))
    tooltipText: root.opened ? "" : ("NymVPN — " + (root.status ? root.status.label : "Unknown"))

    onPressed: function(b) {
      if (b === Qt.MiddleButton) root.refresh()
      else if (b !== Qt.RightButton) root.togglePanel()
    }
  }
}
