// Minimal Manifest V3 bridge for the NetBeans Connector reload protocol.
// The IDE decides which tabs it manages; this extension only reloads tabs
// after NetBeans has accepted their `init` message.

const NB_SOCKET_URL = "ws://127.0.0.1:8008/";
const NB_CONNECTOR_API_VERSION = "1.8.1";
const HEARTBEAT_MS = 20_000;
const RECONNECT_MS = 3_000;

let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
const tabsById = new Map();

function log(...args) {
  console.info("[NetBeans ZK Refresh]", ...args);
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

function sendInit(tab) {
  // NetBeans may first open a temporary file:// blank page as a hand-off tab.
  // The original Connector sends `init` for that tab too; a later `reload`
  // message may carry the actual project URL.
  if (!tab || typeof tab.id !== "number" || !/^(https?:|file:)/.test(tab.url || "")) return;
  const state = tabsById.get(tab.id);
  if (state?.status === "pending" || state?.status === "managed") return;

  tabsById.set(tab.id, { status: "pending", url: tab.url });
  if (!send({
    message: "init",
    url: tab.url,
    tabId: tab.id,
    version: NB_CONNECTOR_API_VERSION
  })) {
    tabsById.delete(tab.id);
  }
}

async function initializeExistingTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) sendInit(tab);
  } catch (error) {
    log("Could not inspect open tabs", error);
  }
}

function handleMessage(data) {
  let message;
  try {
    message = JSON.parse(data);
  } catch {
    log("Ignored non-JSON message from NetBeans");
    return;
  }

  log("Message from NetBeans:", message.message, {
    tabId: message.tabId,
    status: message.status,
    url: message.url
  });

  if (message.message === "init") {
    const tabId = Number(message.tabId);
    const state = tabsById.get(tabId);
    if (!state) return;
    if (message.status === "accepted") {
      state.status = "managed";
      state.url = message.url || state.url;
      tabsById.set(tabId, state);
      log(`NetBeans accepted tab ${tabId}:`, state.url);
    } else {
      log(`NetBeans did not manage tab ${tabId}:`, state.url);
      tabsById.delete(tabId);
    }
    return;
  }

  if (message.message === "reload") {
    const tabId = Number(message.tabId);
    if (tabsById.get(tabId)?.status !== "managed") {
      log(`Ignored reload for unmanaged tab ${tabId}`);
      return;
    }
    log(`Refreshing NetBeans-managed tab ${tabId}`);

    chrome.tabs.get(tabId).then(tab => {
      if (message.url && tab.url !== message.url) {
        return chrome.tabs.update(tabId, { url: message.url });
      }
      return chrome.tabs.reload(tabId, { bypassCache: true });
    }).catch(error => log(`Could not refresh IDE tab ${tabId}`, error));
  }
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  clearTimeout(reconnectTimer);
  try {
    socket = new WebSocket(NB_SOCKET_URL);
  } catch (error) {
    log("WebSocket construction failed", error);
    scheduleReconnect();
    return;
  }

  socket.addEventListener("open", () => {
    log("Connected to NetBeans at", NB_SOCKET_URL);
    // A dropped WebSocket may have made the IDE forget its managed tabs.
    // Re-negotiate all open tabs on every fresh connection.
    tabsById.clear();
    // The old Connector sends `ready` after installation; repeat it when the
    // bridge reconnects so a restarted IDE can discover it too.
    send({ message: "ready", version: chrome.runtime.getManifest().version });
    initializeExistingTabs();

    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      // This is a supported Connector request and keeps MV3's worker alive
      // while the local WebSocket is idle. It only refreshes device presets.
      send({ message: "load_resize_options" });
    }, HEARTBEAT_MS);
  });

  socket.addEventListener("message", event => handleMessage(event.data));
  socket.addEventListener("error", () => log("WebSocket error; waiting to reconnect"));
  socket.addEventListener("close", () => {
    socket = null;
    clearInterval(heartbeatTimer);
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, RECONNECT_MS);
}

chrome.tabs.onCreated.addListener(tab => {
  tabsById.set(tab.id, { status: "new", url: tab.url || "" });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" && !changeInfo.url) return;
  const state = tabsById.get(tabId);
  if (state?.status === "managed") {
    if (tab.url && state.url !== tab.url) {
      state.url = tab.url;
      tabsById.set(tabId, state);
      send({ message: "urlchange", tabId, url: tab.url });
    }
    return;
  }
  sendInit(tab);
});

chrome.tabs.onRemoved.addListener(tabId => {
  const state = tabsById.get(tabId);
  if (state?.status === "managed") send({ message: "close", tabId });
  tabsById.delete(tabId);
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "netbeans-bridge-reconnect") connect();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("netbeans-bridge-reconnect", { periodInMinutes: 1 });
  connect();
});

chrome.runtime.onStartup.addListener(connect);

// A service worker can be started again after browser events while the
// NetBeans IDE is already running.
connect();
