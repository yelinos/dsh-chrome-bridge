/**
 * DSH Chrome Bridge — extension service worker.
 *
 * Connects out to the DSH bridge plugin's WebSocket server on 127.0.0.1 and
 * executes its commands against Chrome: tabs, tab groups, and per-page CDP
 * through chrome.debugger (the same "page debugger access" the Codex Chrome
 * extension uses). Nothing listens on a port; nothing is exposed to web pages.
 */

const DEFAULT_PORT = 8765;
const KEEPALIVE_ALARM = "dsh-chrome-bridge-keepalive";
const PROTOCOL_VERSION = 1;

/** @type {WebSocket | null} */
let ws = null;
let reconnectTimer = null;
let backoffMs = 500;

/** Tab ids this worker has chrome.debugger attached to. */
const attached = new Set();

function send(value) {
  if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
}

function setBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? "\u25CF" : "\u25CB" });
  chrome.action.setBadgeBackgroundColor({ color: connected ? "#1a73e8" : "#9aa0a6" });
}

async function getConfig() {
  try {
    const stored = await chrome.storage.local.get(["port", "token"]);
    return {
      port: Number.isInteger(stored.port) && stored.port > 0 ? stored.port : DEFAULT_PORT,
      token: typeof stored.token === "string" ? stored.token : "",
    };
  } catch {
    return { port: DEFAULT_PORT, token: "" };
  }
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  backoffMs = Math.min(backoffMs * 2, 10000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoffMs);
}

async function connect() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws !== null) {
    try {
      ws.onclose = null;
      ws.close();
    } catch {
      /* already closed */
    }
    ws = null;
  }
  const { port, token } = await getConfig();
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch {
    setBadge(false);
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    backoffMs = 500;
    send({
      type: "hello",
      name: "DSH Chrome Bridge",
      version: chrome.runtime.getManifest().version,
      userAgent: navigator.userAgent,
      ...(token ? { token } : {}),
    });
  };
  ws.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message === null || typeof message !== "object") return;
    if (message.type === "ping") {
      send({ type: "pong" });
      return;
    }
    if (message.type === "welcome") {
      setBadge(message.ok === true);
      return;
    }
    if (Number.isInteger(message.id) && typeof message.cmd === "string") {
      const { id, cmd, ...params } = message;
      dispatch(cmd, params).then(
        (result) => send({ id, ok: true, result }),
        (error) => send({ id, ok: false, error: String((error && error.message) || error) })
      );
    }
  };
  ws.onclose = () => {
    ws = null;
    setBadge(false);
    scheduleReconnect();
  };
  ws.onerror = () => {
    /* onclose follows */
  };
}

function tabInfo(tab, groupTitle) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    active: tab.active === true,
    url: tab.url ?? "",
    title: tab.title ?? "",
    groupId: tab.groupId ?? -1,
    ...(groupTitle !== undefined ? { groupTitle } : {}),
  };
}

async function groupTitles() {
  const groups = await chrome.tabGroups.query({});
  return new Map(groups.map((group) => [group.id, group.title]));
}

async function addToGroup(tab, title) {
  try {
    const existing = (await chrome.tabGroups.query({ title })).filter(
      (group) => group.windowId === tab.windowId
    );
    const known = existing.length > 0 ? existing[0].id : undefined;
    const groupId = await chrome.tabs.group(
      known === undefined
        ? { tabIds: [tab.id], createProperties: { windowId: tab.windowId } }
        : { tabIds: [tab.id], groupId: known }
    );
    if (known === undefined) await chrome.tabGroups.update(groupId, { title, color: "blue" });
  } catch {
    /* grouping is a convenience; never fail the command for it */
  }
}

async function ensureDebugger(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    if (!/already attached/i.test(String(error && error.message))) throw error;
  }
  attached.add(tabId);
}

async function cdp(tabId, method, params = {}) {
  await ensureDebugger(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

function waitForLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") finish();
      })
      .catch(finish);
  });
}


/** Virtual key table for CDP Input.dispatchKeyEvent. */
const KEY_TABLE = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Space: { code: "Space", keyCode: 32, text: " " },
};

/** Modifier name → CDP bitmask. */
function modifierMask(modifiers) {
  let mask = 0;
  for (const name of modifiers ?? []) {
    if (name === "alt") mask |= 1;
    else if (name === "control" || name === "ctrl") mask |= 2;
    else if (name === "meta" || name === "command") mask |= 4;
    else if (name === "shift") mask |= 8;
  }
  return mask;
}

/** Center of an element plus a scroll into view, for a real mouse click. */
async function elementCenter(tabId, selector) {
  const expression =
    "(() => { const el = document.querySelector(" + JSON.stringify(selector) + ");" +
    " if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' });" +
    " const r = el.getBoundingClientRect();" +
    " return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName, text: (el.innerText || el.value || '').slice(0, 80) }; })()";
  const result = await cdp(tabId, "Runtime.evaluate", { expression, returnByValue: true });
  return result.result?.value ?? null;
}

/** Dispatch one real mouse click at viewport coordinates. */
async function clickAt(tabId, x, y, button = "left", clickCount = 1) {
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount });
}

async function dispatch(cmd, params) {
  switch (cmd) {
    case "ext.ping":
      return { version: chrome.runtime.getManifest().version, protocol: PROTOCOL_VERSION };

    case "tabs.list": {
      const [tabs, titles] = await Promise.all([chrome.tabs.query({}), groupTitles()]);
      return tabs.map((tab) =>
        tabInfo(tab, tab.groupId && tab.groupId !== -1 ? titles.get(tab.groupId) ?? "" : "")
      );
    }

    case "tabs.get": {
      const [tab, titles] = await Promise.all([chrome.tabs.get(params.tabId), groupTitles()]);
      return tabInfo(tab, tab.groupId && tab.groupId !== -1 ? titles.get(tab.groupId) ?? "" : "");
    }

    case "tabs.active": {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab === undefined) throw new Error("no active tab in the focused window");
      const titles = await groupTitles();
      return tabInfo(tab, tab.groupId && tab.groupId !== -1 ? titles.get(tab.groupId) ?? "" : "");
    }

    case "tabs.open": {
      const created = await chrome.tabs.create({ url: params.url, active: params.active !== false });
      if (params.groupTitle) await addToGroup(created, params.groupTitle);
      return tabInfo(await chrome.tabs.get(created.id));
    }

    case "tabs.close": {
      const tab = await chrome.tabs.get(params.tabId);
      if (params.groupTitle) {
        const titles = await groupTitles();
        const groupTitle = tab.groupId && tab.groupId !== -1 ? titles.get(tab.groupId) ?? "" : "";
        if (groupTitle !== params.groupTitle) {
          throw new Error(`refusing to close tab ${params.tabId}: it is not in the ${params.groupTitle} tab group`);
        }
      }
      await chrome.tabs.remove(params.tabId);
      attached.delete(params.tabId);
      return { closed: params.tabId };
    }

    case "page.navigate": {
      const tab = await chrome.tabs.update(params.tabId, { url: params.url });
      await waitForLoad(tab.id, 20000);
      return tabInfo(await chrome.tabs.get(tab.id));
    }

    case "page.eval": {
      const result = await cdp(params.tabId, "Runtime.evaluate", {
        expression: params.expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      if (result.exceptionDetails) {
        const details = result.exceptionDetails;
        throw new Error(details.exception?.description || details.text || "evaluation failed");
      }
      return { value: result.result?.value ?? null, type: result.result?.type ?? "undefined" };
    }

    case "page.read": {
      const expression =
        "JSON.stringify({url: location.href, title: document.title, " +
        "text: (document.body && document.body.innerText) || ''})";
      const result = await cdp(params.tabId, "Runtime.evaluate", {
        expression,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        const details = result.exceptionDetails;
        throw new Error(details.exception?.description || details.text || "failed to read the page");
      }
      return JSON.parse(result.result.value);
    }

    case "input.click": {
      await clickAt(params.tabId, params.x, params.y, params.button ?? "left", params.clickCount ?? 1);
      return { x: params.x, y: params.y };
    }

    case "input.clickSelector": {
      const center = await elementCenter(params.tabId, params.selector);
      if (center === null) throw new Error(`no element matches selector ${JSON.stringify(params.selector)}`);
      await clickAt(params.tabId, center.x, center.y, params.button ?? "left", params.clickCount ?? 1);
      return center;
    }

    case "input.type": {
      await cdp(params.tabId, "Input.insertText", { text: params.text });
      return { typed: params.text.length };
    }

    case "input.key": {
      const oneChar = params.key.length === 1;
      const spec = KEY_TABLE[params.key] ?? {
        code: oneChar
          ? (/[a-zA-Z]/.test(params.key) ? `Key${params.key.toUpperCase()}` : /[0-9]/.test(params.key) ? `Digit${params.key}` : params.key)
          : params.key,
        keyCode: oneChar ? params.key.toUpperCase().charCodeAt(0) : 0,
        text: oneChar ? params.key : undefined,
      };
      const modifiers = modifierMask(params.modifiers);
      const hasModifiers = modifiers !== 0;
      const base = {
        key: oneChar && hasModifiers ? params.key.toUpperCase() : params.key,
        code: spec.code,
        windowsVirtualKeyCode: spec.keyCode,
        nativeVirtualKeyCode: spec.keyCode,
        modifiers,
      };
      // Modifier combinations are shortcuts: raw key events without text, so
      // the page sees Ctrl+A rather than an inserted "a".
      await cdp(params.tabId, "Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        ...base,
        ...(hasModifiers || spec.text === undefined ? {} : { text: spec.text }),
      });
      await cdp(params.tabId, "Input.dispatchKeyEvent", {
        type: "keyUp",
        ...base,
      });
      return { key: params.key, modifiers: params.modifiers ?? [] };
    }

    case "page.screenshot": {
      await cdp(params.tabId, "Page.enable");
      const shot = await cdp(params.tabId, "Page.captureScreenshot", {
        format: "png",
      });
      return { dataBase64: shot.data };
    }

    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  connect();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  connect();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM && (ws === null || ws.readyState !== WebSocket.OPEN)) {
    connect();
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) attached.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message === null || typeof message !== "object" || message.type !== "status") return false;
  getConfig().then(({ port }) => {
    sendResponse({
      connected: ws !== null && ws.readyState === WebSocket.OPEN,
      port,
    });
  });
  return true;
});

/* The DSH host pings every 20s and this worker's pong keeps it alive; the
   alarm covers cold starts while the host is down. */
connect();
