# NymVPN

Control [NymVPN](https://nym.com) from the Omarchy (Quattro) bar. The widget
shows live tunnel status; clicking it opens a panel to connect/disconnect,
switch between **Anonymous (5-hop mixnet)** and **Fast (2-hop WireGuard)** mode,
and pick entry/exit gateway countries — all by driving the official
`nym-vpnc` command-line client.

![status glyph in the bar](preview.png)

## Requirements

This plugin is a front-end for the NymVPN CLI. Install the NymVPN client and a
subscription/account first — see <https://nym.com/download/linux>.

On Arch / Omarchy:

```sh
yay -S nym-vpnd-bin nym-vpn-app-bin
sudo systemctl enable --now nym-vpnd     # start the privileged daemon
nym-vpnc account set <your recovery phrase>   # log in (run in a terminal)
```

The `nym-vpnd` daemon must be running for `nym-vpnc` to work. If the CLI or the
daemon is missing, the panel shows a setup card with the exact commands to run.

> Security: the plugin never asks for your recovery phrase inside the shell.
> Log in once from a terminal with `nym-vpnc account set`; the plugin only
> issues `status`, `connect`, `disconnect`, `tunnel`, and `gateway` commands.

## Install

```sh
omarchy plugin add https://github.com/megabyte0x/nym-vpn.git --enable
```

## Usage

- **Left-click** the `nym` widget to open/close the control panel.
- **Middle-click** to force a status refresh.
- In the panel: **Connect** / **Disconnect**, choose **Mode**, and set an
  **Entry**/**Exit** country (two-letter ISO code, e.g. `US`, `DE`).
- Press **r** to refresh, **Esc** to close.

The bar dot reflects the tunnel state: filled = connected, half = connecting /
disconnecting, hollow = disconnected / error. Colour follows your theme accent
(connected) or urgent (error).

## Configure

```sh
omarchy bar move io.github.megabyte0x.nym-vpn --section right
```

## Remove

```sh
omarchy plugin remove io.github.megabyte0x.nym-vpn
```

## Develop

Pure command-building and output-parsing logic lives in `Model.js` and is unit
tested without Qt:

```sh
node tests/model-test.js
omarchy plugin validate .
qmllint -I "$OMARCHY_PATH/shell" BarWidget.qml Panel.qml
```

## License

MIT — see [LICENSE](LICENSE).
