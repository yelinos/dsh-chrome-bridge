/** DSH Chrome Bridge side panel: live bridge status, page context and tab mentions. */
const stateEl = document.getElementById("state");
const browserEl = document.getElementById("browser");
const endpointEl = document.getElementById("endpoint");
const dirEl = document.getElementById("dir");
const browsersEl = document.getElementById("browsers");
const pageTitleEl = document.getElementById("page-title");
const pageUrlEl = document.getElementById("page-url");
const selectionEl = document.getElementById("selection");
const tabsEl = document.getElementById("tabs");

let currentTab = null;

function renderBrowsers(browsers) {
  browsersEl.replaceChildren();
  for (const browser of browsers ?? []) {
    const item = document.createElement("li");
    item.textContent = `${browser.browserName} [${browser.id}]${browser.active ? " (active)" : ""}`;
    browsersEl.appendChild(item);
  }
}

async function refreshStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "status" });
    const connected = response?.connected === true;
    stateEl.textContent = connected ? "Connected to DSH" : "Not connected";
    stateEl.className = "state " + (connected ? "on" : "off");
    endpointEl.textContent = `ws://127.0.0.1:${response?.port ?? 8765}`;
    browserEl.textContent = response?.browserName ?? "—";
    dirEl.textContent = response?.extensionDir ?? "—";
    renderBrowsers(response?.browsers);
  } catch (error) {
    stateEl.textContent = `Status unavailable: ${String(error?.message ?? error)}`;
    stateEl.className = "state off";
  }
}

async function refreshPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab ?? null;
  pageTitleEl.textContent = tab?.title || "(untitled)";
  pageUrlEl.textContent = tab?.url || "—";
  if (tab?.id !== undefined) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => String(window.getSelection?.() ?? "").trim().slice(0, 4000),
      });
      selectionEl.textContent = result || "Select text on the page to include it in a DSH request.";
    } catch {
      selectionEl.textContent = "(selection unavailable on this page)";
    }
  }
}

async function refreshTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  tabsEl.replaceChildren();
  for (const tab of tabs.slice(0, 12)) {
    const item = document.createElement("li");
    item.textContent = `${tab.active ? "* " : ""}${tab.title || tab.url || "(untitled)"}`;
    tabsEl.appendChild(item);
  }
}

document.getElementById("copy-mention").addEventListener("click", async () => {
  if (currentTab?.id === undefined) return;
  const status = await chrome.runtime.sendMessage({ type: "status" });
  const params = new URLSearchParams({
    mention: "tab-v1",
    source: "extension",
    browserId: status?.browserId ?? "",
    tabId: String(currentTab.id),
    title: currentTab.title ?? "",
    url: currentTab.url ?? "",
  });
  await navigator.clipboard.writeText(`plugin://chrome@dsh?${params.toString()}`);
  const button = document.getElementById("copy-mention");
  button.textContent = "Copied";
  setTimeout(() => (button.textContent = "Copy tab mention"), 1200);
});

async function refresh() {
  await Promise.allSettled([refreshStatus(), refreshPage(), refreshTabs()]);
}

refresh();
setInterval(refresh, 3000);
