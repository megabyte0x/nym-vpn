# NymVPN

Control [NymVPN](https://nym.com) from the Omarchy (Quattro) bar. The widget
shows live tunnel status; clicking it opens a panel to connect/disconnect,
switch between **Anonymous (5-hop mixnet)** and **Fast (2-hop WireGuard)** mode,
and pick the **entry** and **exit** regions from a searchable, flag-labelled
country list — all by driving the official `nym-vpnc` command-line client.

The plugin **only detects and controls an already-configured account**. It never
asks for or handles your recovery phrase — you log in yourself with the official
CLI in a terminal (see [Logging in](#logging-in)).

![status glyph in the bar](preview.png)

## Requirements

This plugin is a front-end for the NymVPN CLI. Install the NymVPN client and a
subscription/account first — see <https://nym.com/download/linux>.

On Arch / Omarchy — the daemon and GUI packages do **not** include the
`nym-vpnc` CLI, so install the CLI package (`nym-vpnc-bin`) explicitly:

```sh
yay -S nym-vpnc-bin nym-vpnd-bin           # CLI + daemon (nym-vpn-app-bin is the optional GUI)
sudo systemctl enable --now nym-vpnd       # start the privileged daemon
nym-vpnc account set <your recovery phrase>   # log in (run in a terminal)
```

The `nym-vpnd` daemon must be running for `nym-vpnc` to work. If the CLI or the
daemon is missing, the panel shows a setup card with the exact commands to run —
click the command box (or its **Copy** button) to copy it to the clipboard.

## Logging in

The plugin **does not accept your recovery phrase** and has no login field. The
official `nym-vpnc account set` takes the mnemonic *only* as a positional
command-line argument (no stdin, file, or environment-variable input), which
would place the phrase in that process's argv (`/proc/<pid>/cmdline`) for the
duration of the call. Rather than take on that credential exposure, the plugin
leaves login entirely to you:

```sh
nym-vpnc account set <your recovery phrase>   # run in your own terminal
```

Running it yourself keeps that brief argv exposure under your direct control and
out of a background GUI process. When no account is configured, the panel simply
shows this command (with a **Copy** button for the `nym-vpnc account set` prefix)
and asks you to complete it in a terminal, then press `r`. Once an account is
configured, the panel detects it and offers **Log out** (`nym-vpnc account
forget`). All panel actions — `status`, `connect`, `disconnect`, `tunnel`,
`gateway`, and `account forget` — carry no secrets.

### Authentication prompts (polkit)

Recent `nym-vpnd` builds gate every daemon call behind a polkit action
(`com.nymvpn.vpnd.unix-access`, `allow_active = auth_self`), so **each**
`status` / `connect` / `disconnect` asks for your password. Because of this the
plugin **never polls in the background** — it only talks to the daemon when you
open the panel, press `r`, or click Connect/Disconnect, so you get at most one
prompt per action. When authentication is needed, the panel asks you to approve
the system prompt; approving per action is the recommended default.

> **Advanced / optional — not a setup step.** If you fully understand the
> trade-off, you *can* allow the active local user to reach the daemon without a
> password prompt by installing a polkit rule. This weakens the daemon's access
> control (any process running as your active local user could then drive the
> VPN without authenticating), so it is **not recommended** and the plugin does
> **not** offer to install it for you. If you choose to, write it yourself:
>
> ```sh
> sudo tee /etc/polkit-1/rules.d/49-nymvpn.rules >/dev/null <<'EOF'
> polkit.addRule(function(action, subject) {
>   if (action.id == "com.nymvpn.vpnd.unix-access" && subject.active && subject.local) {
>     return polkit.Result.YES;
>   }
> });
> EOF
> ```
>
> Then log out/in (or restart your polkit agent). Skip this if you prefer to
> approve each prompt.

## Install

```sh
omarchy plugin add https://github.com/megabyte0x/nym-vpn.git --enable
```

## Usage

- **Left-click** the `nym` widget to open/close the control panel.
- **Middle-click** to force a status refresh.
- **Log in** from a terminal with `nym-vpnc account set <your recovery phrase>`
  (see [Logging in](#logging-in)). The panel does not accept the phrase; it only
  detects a configured account and offers **Log out** to forget it.
- In the panel: **Connect** / **Disconnect** and choose **Mode**.
- Pick your **Entry region** and **Exit region** from the two dropdowns. Each
  opens a searchable list of the countries NymVPN currently has gateways in,
  shown with a flag and full name — just type to filter (by name or code) and
  click to select; the choice is applied immediately. Two smart options lead
  the list: **✨ Auto (recommended)** (let NymVPN choose, excluding your own
  country) and **🎲 Random gateway**. The available countries follow the
  active mode (WireGuard gateways for Fast, mixnet gateways for Anonymous).
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
