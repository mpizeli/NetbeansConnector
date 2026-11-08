# Netbeans ReConnector

An unofficial Manifest V3 beta I vibe-coded after looking for a workaround in [apache/netbeans#6601](https://github.com/apache/netbeans/issues/6601).

- Automatically refreshes the application tab when NetBeans requests a reload.
- Supports Browser DOM and **Inspect in NetBeans Mode**. Open the extension menu to select an element on the page and locate it in NetBeans.

## Installation

1. Get the project files. If using a ZIP from Releases, extract it first and keep the folder structure intact.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the `extbrowser.chrome/plugins/chrome` folder.
4. Run your project with the NetBeans Connector browser option.
