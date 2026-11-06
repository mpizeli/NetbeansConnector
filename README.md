# NetBeans ZK Refresh Bridge

This is a small Manifest V3 Chrome extension that implements only the reload
part of the NetBeans Connector protocol. It connects to NetBeans at
`ws://127.0.0.1:8008/`, asks the IDE which browser tabs it manages, and reloads
an accepted tab when NetBeans sends a `reload` message.

The manifest includes the original Connector public key so Chrome assigns the
same extension ID that NetBeans checks (`hafdlehgocfcodbgjnpecfajgkeejnaa`).
The extension package itself is still a local Manifest V3 build, version 0.6.

## Install for a local trial

1. Open `chrome://extensions` in the Chrome profile you want NetBeans to use.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this folder.
   Confirm its extension ID is `hafdlehgocfcodbgjnpecfajgkeejnaa`.
4. In NetBeans, choose **Chrome with NetBeans Connector** as the project browser
   and run the ZK project. This is the first path to try because NetBeans must
   start its browser integration and WebSocket listener.

If the old Connector is installed in that same Chrome profile, disable it while
trying this bridge so only one extension connects to the NetBeans socket. Keep
your working Chromium profile unchanged as a fallback. To go back, disable this
bridge and re-enable the old Connector.

If NetBeans stops at the `Could not find chrome extension in installation
directory` error instead of launching Chrome, the IDE's bundled-CRX check is
blocking this route. In that case, keep the current Chromium/Connector setup
working and use it to inspect whether the NetBeans listener stays available
while a regular Chrome window with this bridge is open; the bridge itself does
not start the listener.

## Scope and assumptions

- It sends `init` for HTTP, HTTPS and file tabs, including NetBeans' temporary
  `file://` hand-off page. It refreshes only tabs that NetBeans explicitly
  accepts; it does not refresh unrelated browser tabs.
- Reloads bypass the browser cache, matching the old Connector behavior.
- This first version targets the NetBeans Connector WebSocket protocol on
  loopback port `8008` and Chrome 120 or later.
- It does not debug JavaScript, inspect the DOM, edit files, or hot-swap Java.
- The NetBeans runtime and project combination still needs a local trial. If
  NetBeans does not accept the `ready` or `init` messages, its websocket server
  protocol/version check will need adjustment.

## Troubleshooting

- If the extension reports a connection error, confirm the NetBeans process is
  listening on `127.0.0.1:8008`.
- If saves do not refresh the page, open the extension's service worker console
  from `chrome://extensions` and look for `Connected to NetBeans`, an accepted
  tab, or a reload message.
- The extension needs the NetBeans Connector host to send `reload` after the
  relevant ZK resource is saved or built; it does not watch source files itself.
