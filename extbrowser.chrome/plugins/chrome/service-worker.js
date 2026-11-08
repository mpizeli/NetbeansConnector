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
let inspectionTabId = null;
let selectionMode = false;
const tabsById = new Map();
const debuggerTabs = new Set();
const debuggerAttaching = new Set();
const queuedDebuggerCommands = new Map();

function log(...args) {
  console.info(`[${new Date().toISOString()}] [NetBeans]`, ...args);
}

function updateToolbarAction(tabId) {
  if (typeof tabId !== "number") return;
  const managed = socket?.readyState === WebSocket.OPEN &&
    tabsById.get(tabId)?.status === "managed";
  const update = managed ? chrome.action.enable(tabId) : chrome.action.disable(tabId);
  update.catch(error => log(`Could not update toolbar icon for tab ${tabId}`, error));
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
    for (const tab of tabs) {
      updateToolbarAction(tab.id);
      sendInit(tab);
    }
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
    url: message.url,
    command: message.command
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
    updateToolbarAction(tabId);
    return;
  }

  if (message.message === "debugger_command") {
    const tabId = Number(message.tabId);
    const command = message.command;
    if (!Number.isFinite(tabId) || !command || command.id === undefined) {
      log("Cannot reply to malformed debugger_command", message);
      return;
    }
    if (tabsById.get(tabId)?.status !== "managed") {
      sendDebuggerError(tabId, command.id, "Tab is not managed by NetBeans.");
      return;
    }
    if (!debuggerTabs.has(tabId)) {
      const queued = queuedDebuggerCommands.get(tabId) || [];
      queued.push(command);
      queuedDebuggerCommands.set(tabId, queued);
      log(`Queued debugger command ${command.method} (${command.id}) until tab ${tabId} is attached`);
      return;
    }
    executeDebuggerCommand(tabId, command);
    return;
  }

  if (message.message === "attach_debugger") {
    const tabId = Number(message.tabId);
    if (tabsById.get(tabId)?.status === "managed") {
      // The NetBeans page inspector has one active tab per connection.
      inspectionTabId = tabId;
      selectionMode = false;
    }
    attachDebugger(tabId);
    return;
  }

  if (message.message === "pageInspectionPropertyChange") {
    if (message.propertyName === "selectionMode" && typeof message.propertyValue === "boolean") {
      selectionMode = message.propertyValue;
    }
    return;
  }

  if (message.message === "detach_debugger") {
    detachDebugger(Number(message.tabId));
    return;
  }

  if (message.message === "reload") {
    const tabId = Number(message.tabId);
    log(`Received reload for tab ${tabId}:`, { url: message.url });
    if (tabsById.get(tabId)?.status !== "managed") {
      log(`Ignored reload for unmanaged tab ${tabId}`);
      return;
    }

    chrome.tabs.get(tabId).then(tab => {
      if (message.url && tab.url !== message.url) {
        log(`Navigating tab ${tabId} from ${tab.url} to ${message.url}`);
        return chrome.tabs.update(tabId, { url: message.url }).then(updatedTab => {
          log(`Navigation started for tab ${tabId}:`, updatedTab.url);
        });
      }
      log(`Reloading tab ${tabId} at ${tab.url}`);
      return chrome.tabs.reload(tabId, { bypassCache: true }).then(() => {
        log(`Reload triggered for tab ${tabId}`);
      });
    }).catch(error => log(`Could not apply reload to IDE tab ${tabId}`, error));
  }
}

function sendDebuggerError(tabId, id, message) {
  send({
    message: "debugger_command_response",
    tabId,
    response: { id, error: JSON.stringify({ message }) }
  });
}

function executeDebuggerCommand(tabId, command) {
  chrome.debugger.sendCommand(
    { tabId },
    command.method,
    command.params || {},
    result => {
      const error = chrome.runtime.lastError;
      if (error) {
        sendDebuggerError(tabId, command.id, error.message);
        log(`Debugger command failed (${command.method}):`, error.message);
        return;
      }
      send({
        message: "debugger_command_response",
        tabId,
        response: { id: command.id, result: result || {} }
      });
    }
  );
}

function attachDebugger(tabId) {
  if (!Number.isFinite(tabId) || tabsById.get(tabId)?.status !== "managed") {
    log(`Cannot attach debugger to unmanaged tab ${tabId}`);
    return;
  }
  if (debuggerTabs.has(tabId) || debuggerAttaching.has(tabId)) return;

  debuggerAttaching.add(tabId);
  chrome.debugger.attach({ tabId }, "1.0", () => {
    debuggerAttaching.delete(tabId);
    const error = chrome.runtime.lastError;
    if (error) {
      log(`Could not attach debugger to tab ${tabId}:`, error.message);
      const queued = queuedDebuggerCommands.get(tabId) || [];
      queuedDebuggerCommands.delete(tabId);
      for (const command of queued) sendDebuggerError(tabId, command.id, error.message);
      return;
    }

    debuggerTabs.add(tabId);
    updateToolbarAction(tabId);
    log(`Attached Chrome debugger to tab ${tabId}`);
    const queued = queuedDebuggerCommands.get(tabId) || [];
    queuedDebuggerCommands.delete(tabId);
    for (const command of queued) executeDebuggerCommand(tabId, command);
  });
}

function detachDebugger(tabId) {
  if (!debuggerTabs.has(tabId)) return;
  chrome.debugger.detach({ tabId }, () => {
    const error = chrome.runtime.lastError;
    if (error) log(`Could not detach debugger from tab ${tabId}:`, error.message);
  });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (typeof source.tabId !== "number") return;
  if (method === "Page.loadEventFired") updateToolbarAction(source.tabId);
  send({
    message: "debugger_command_response",
    tabId: source.tabId,
    response: { method, params }
  });
});

chrome.debugger.onDetach.addListener(source => {
  const tabId = source.tabId;
  if (typeof tabId !== "number") return;
  debuggerTabs.delete(tabId);
  debuggerAttaching.delete(tabId);
  queuedDebuggerCommands.delete(tabId);
  if (inspectionTabId === tabId) {
    inspectionTabId = null;
    selectionMode = false;
  }
  send({ message: "debugger_detached", tabId });
  log(`Chrome debugger detached from tab ${tabId}`);
});

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
    inspectionTabId = null;
    selectionMode = false;
    clearInterval(heartbeatTimer);
    for (const [tabId, state] of tabsById) {
      if (state.status === "managed") updateToolbarAction(tabId);
    }
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

chrome.tabs.onActivated.addListener(({ tabId }) => {
  updateToolbarAction(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" && !changeInfo.url) return;
  const state = tabsById.get(tabId);
  if (state?.status === "managed") {
    if (tab.url && state.url !== tab.url) {
      state.url = tab.url;
      tabsById.set(tabId, state);
      log(`Managed tab ${tabId} navigated to ${tab.url}`);
      send({ message: "urlchange", tabId, url: tab.url });
    }
    // Chrome clears tab-specific action state when the tab navigates.
    updateToolbarAction(tabId);
    return;
  }
  sendInit(tab);
});

chrome.tabs.onRemoved.addListener(tabId => {
  const state = tabsById.get(tabId);
  if (state?.status === "managed") send({ message: "close", tabId });
  tabsById.delete(tabId);
  debuggerTabs.delete(tabId);
  debuggerAttaching.delete(tabId);
  queuedDebuggerCommands.delete(tabId);
  if (inspectionTabId === tabId) {
    inspectionTabId = null;
    selectionMode = false;
  }
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== "inspection-state" && message?.type !== "inspection-set") return;

  const { tabId } = message;
  const available = Number.isInteger(tabId) && tabId === inspectionTabId &&
    socket?.readyState === WebSocket.OPEN && debuggerTabs.has(tabId) &&
    tabsById.get(tabId)?.status === "managed";
  if (!available) {
    respond({ available: false });
    return;
  }

  if (message.type === "inspection-set" && typeof message.enabled === "boolean") {
    // NetBeans routes this message to its current inspector through the socket.
    if (!send({ message: "selection_mode", selectionMode: message.enabled })) {
      respond({ available: false });
      return;
    }
    selectionMode = message.enabled;
  }
  respond({ available: true, enabled: selectionMode });
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
