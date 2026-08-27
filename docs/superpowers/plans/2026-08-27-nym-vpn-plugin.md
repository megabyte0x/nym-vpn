# NymVPN Plugin — Build Plan

1. Research (done)
   - Fetch NymVPN Linux page + omarchyplugins.com/develop.html.
   - Reverse the `nym-vpnc` clap CLI (main.rs, account.rs, gateway.rs,
     tunnel.rs) for exact subcommands/flags and status output.
   - Study a known-good community bar-widget (crypto-watch) for the shell's
     Process/Panel/WidgetButton/KeyboardPanel API on this version (4.0.1).

2. Implement (done)
   - manifest.json (bar-widget, id io.github.megabyte0x.nym-vpn).
   - Model.js: pure command builders + output parsers, Node-exported.
   - BarWidget.qml: status glyph + background polling + IPC + panel loader.
   - Panel.qml: status header, setup card, connect/disconnect, mode selector,
     country selection, summary/notice, key hints.
   - README.md, LICENSE, preview.png.

3. Verify (done)
   - node tests/model-test.js → 19 passing.
   - omarchy plugin validate . → exit 0.
   - Install into ~/.config/omarchy/plugins, rescan, enable.
   - Confirm discovery/enabled via `omarchy plugin list --json`.
   - Summon/hide panel; grep shell log → no QML errors (only the benign
     duplicate-IpcHandler warning shared by shipped plugins).
   - Screenshot the rendered not-installed setup card.

4. Publish (done)
   - Commit and push to https://github.com/megabyte0x/nym-vpn so
     `omarchy plugin add https://github.com/megabyte0x/nym-vpn.git --enable`
     works as documented.

## Future / not in scope
- Live connect/disconnect round-trip requires an installed NymVPN client and a
  paid account; the plugin is validated against the not-installed/daemon-down
  paths on this machine. The connected-state rendering is covered by unit tests
  over real `State:` output shapes.
