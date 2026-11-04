/** DSH Chrome Bridge popup: connection status and bridge settings. */
const statusEl = document.getElementById("status");
const portEl = document.getElementById("port");
const tokenEl = document.getElementById("token");
const saveEl = document.getElementById("save");

function render(status) {
  statusEl.textContent = status.connected ? "Connected to DSH" : "Not connected";
  statusEl.className = "status " + (status.connected ? "on" : "off");
  if (Number.isInteger(status.port) && status.port > 0) portEl.value = String(status.port);
}

chrome.runtime.sendMessage({ type: "status" }, (response) => {
  if (chrome.runtime.lastError || response === undefined) {
    render({ connected: false, port: Number(portEl.value) });
    return;
  }
  render(response);
});

saveEl.addEventListener("click", async () => {
  const port = Number(portEl.value);
  const token = tokenEl.value;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    statusEl.textContent = "Invalid port";
    statusEl.className = "status off";
    return;
  }
  await chrome.storage.local.set({ port, token });
  statusEl.textContent = "Saved. Reconnecting…";
  statusEl.className = "status off";
  // Reaching the service worker wakes it, and it reconnects with the new settings.
  chrome.runtime.sendMessage({ type: "status" }, (response) => {
    if (chrome.runtime.lastError || response === undefined) return;
    render(response);
  });
});
