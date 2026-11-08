const button = document.querySelector("#inspect");
const status = document.querySelector("#status");

function showUnavailable() {
  button.disabled = true;
  status.textContent = "Open a page with Browser DOM connected in NetBeans.";
}

async function initialize() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!Number.isInteger(tab?.id)) {
    showUnavailable();
    return;
  }

  const tabId = tab.id;
  const state = await chrome.runtime.sendMessage({ type: "inspection-state", tabId });
  if (!state?.available) {
    showUnavailable();
    return;
  }

  button.textContent = state.enabled ? "Stop Inspect in NetBeans Mode" : "Inspect in NetBeans Mode";
  button.disabled = false;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const updated = await chrome.runtime.sendMessage({
        type: "inspection-set",
        tabId,
        enabled: !state.enabled
      });
      if (updated?.available) window.close();
      else showUnavailable();
    } catch {
      showUnavailable();
    }
  });
}

initialize().catch(showUnavailable);
