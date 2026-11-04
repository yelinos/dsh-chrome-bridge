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

function tabInfo(tab, group = {}) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    active: tab.active === true,
    url: tab.url ?? "",
    title: tab.title ?? "",
    groupId: tab.groupId ?? -1,
    ...(group.title !== undefined ? { groupTitle: group.title } : { groupTitle: "" }),
    ...(group.color !== undefined ? { groupColor: group.color } : {}),
  };
}

async function groupInfo() {
  const groups = await chrome.tabGroups.query({});
  return new Map(groups.map((group) => [group.id, { title: group.title, color: group.color }]));
}

/** Resolve one tab's group display facts. */
function groupOf(tab, groups) {
  if (!tab.groupId || tab.groupId === -1) return {};
  return groups.get(tab.groupId) ?? {};
}

async function addToGroup(tab, title, color, groupId) {
  try {
    // Join the session's known group when it still exists.
    if (typeof groupId === "number" && groupId >= 0) {
      try {
        await chrome.tabs.group({ tabIds: [tab.id], groupId });
        return;
      } catch {
        /* the group is gone: fall through and create a fresh one */
      }
    }
    const newGroupId = await chrome.tabs.group({
      tabIds: [tab.id],
      createProperties: { windowId: tab.windowId },
    });
    await chrome.tabGroups.update(newGroupId, { title, ...(color ? { color } : {}) });
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
  await showCursor(tabId, x, y, "click");
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount });
}


/** Per-tab maps from snapshot refs ("e1") to CDP backend node ids. */
const refMaps = new Map();

/** Roles worth showing an agent in a compact accessibility snapshot. */
const SNAPSHOT_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox",
  "listbox", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch",
  "slider", "spinbutton", "heading", "img", "option", "treeitem",
]);

/** Build a compact accessibility-tree snapshot with stable refs. */
async function accessibilitySnapshot(tabId, maxElements) {
  await cdp(tabId, "Accessibility.enable");
  const page = await cdp(tabId, "Runtime.evaluate", {
    expression: "JSON.stringify({url: location.href, title: document.title})",
    returnByValue: true,
  });
  const identity = JSON.parse(page.result.value);
  const { nodes } = await cdp(tabId, "Accessibility.getFullAXTree");
  const map = new Map();
  const elements = [];
  let index = 0;
  for (const node of nodes) {
    if (node.ignored === true) continue;
    const role = node.role?.value;
    if (!SNAPSHOT_ROLES.has(role)) continue;
    const name = String(node.name?.value ?? "").trim();
    if (name.length === 0 && role !== "textbox" && role !== "searchbox") continue;
    index += 1;
    if (index > maxElements) break;
    const ref = `e${index}`;
    map.set(ref, node.backendDOMNodeId);
    const value = node.value?.value;
    elements.push({
      ref,
      role,
      name: name.slice(0, 80),
      ...(typeof value === "string" && value.length > 0 ? { value: value.slice(0, 80) } : {}),
    });
  }
  refMaps.set(tabId, map);
  return { ...identity, elements, truncated: index > maxElements };
}

/** Center of an element referenced by a snapshot ref. */
async function refCenter(tabId, ref) {
  const map = refMaps.get(tabId);
  const backendNodeId = map?.get(ref);
  if (backendNodeId === undefined) throw new Error(`unknown ref ${JSON.stringify(ref)}; take a fresh chrome_snapshot`);
  const resolved = await cdp(tabId, "DOM.resolveNode", { backendNodeId });
  const box = await cdp(tabId, "Runtime.callFunctionOn", {
    objectId: resolved.object.objectId,
    functionDeclaration:
      "function(){const r=this.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2, tag:this.tagName};}",
    returnByValue: true,
  });
  const value = box.result?.value;
  if (!value || typeof value.x !== "number") throw new Error(`ref ${ref} has no layout box (not visible?)`);
  return value;
}


/** Inject or move a visible virtual cursor inside the page. */
async function showCursor(tabId, x, y, kind = "move") {
  const expression = `(() => {
    const ID = '__dsh_cursor__';
    let el = document.getElementById(ID);
    if (!el) {
      el = document.createElement('div');
      el.id = ID;
      el.style.cssText = 'position:fixed;left:0;top:0;width:28px;height:28px;z-index:2147483647;pointer-events:none;transition:transform 120ms ease-out,opacity 200ms;will-change:transform;opacity:0;';
      el.innerHTML =
        '<span style="position:absolute;left:-6px;top:-6px;width:36px;height:36px;border-radius:50%;background:rgba(37,99,235,.16);border:1.5px solid rgba(37,99,235,.6);"></span>' +
        '<svg width="26" height="26" viewBox="0 0 24 24" style="position:relative;filter:drop-shadow(0 0 4px rgba(37,99,235,.85)) drop-shadow(0 1px 2px rgba(0,0,0,.45))">' +
        '<path d="M4 2 L4 19 L9 14 L12 21 L15 20 L12 13 L19 13 Z" fill="#ffffff" stroke="#111827" stroke-width="1.2"/></svg>' +
        '<span class="dsh-r" style="position:absolute;left:0;top:0;width:16px;height:16px;border-radius:50%;background:rgba(59,130,246,.55);transform:scale(0);opacity:0;"></span>';
      const style = document.createElement('style');
      style.textContent = '@keyframes dshRipple{0%{transform:scale(.2);opacity:.9}100%{transform:scale(2.6);opacity:0}}.dsh-r.dsh-run{animation:dshRipple .7s ease-out forwards}';
      el.appendChild(style);
      document.documentElement.appendChild(el);
    }
    el.style.transform = 'translate3d(${x}px, ${y}px, 0)';
    el.style.opacity = '1';
    if ('${kind}' === 'click') {
      const ripple = el.querySelector('.dsh-r');
      if (ripple) { ripple.classList.remove('dsh-run'); void ripple.offsetWidth; ripple.classList.add('dsh-run'); }
    }
    clearTimeout(window.__dshCursorTimer);
    window.__dshCursorTimer = setTimeout(() => { const node = document.getElementById(ID); if (node) node.style.opacity = '0'; }, 12000);
    return true;
  })()`;
  await cdp(tabId, "Runtime.evaluate", { expression });
}

/** Viewport center, for wheel scrolling without an explicit point. */
async function viewportCenter(tabId) {
  const result = await cdp(tabId, "Runtime.evaluate", {
    expression: "({x: innerWidth/2, y: innerHeight/2})",
    returnByValue: true,
  });
  return result.result.value;
}

/** Scroll an element (by ref) into view and show the cursor there. */
async function scrollRef(tabId, ref) {
  const map = refMaps.get(tabId);
  const backendNodeId = map?.get(ref);
  if (backendNodeId === undefined) throw new Error(`unknown ref ${JSON.stringify(ref)}; take a fresh chrome_snapshot`);
  const resolved = await cdp(tabId, "DOM.resolveNode", { backendNodeId });
  const box = await cdp(tabId, "Runtime.callFunctionOn", {
    objectId: resolved.object.objectId,
    functionDeclaration:
      "function(){this.scrollIntoView({block:'center',inline:'center'});const r=this.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};}",
    returnByValue: true,
  });
  const value = box.result?.value ?? await viewportCenter(tabId);
  await showCursor(tabId, value.x, value.y, "scroll");
  return value;
}

async function dispatch(cmd, params) {
  switch (cmd) {
    case "ext.ping":
      return { version: chrome.runtime.getManifest().version, protocol: PROTOCOL_VERSION };

    case "tabs.list": {
      const [tabs, groups] = await Promise.all([chrome.tabs.query({}), groupInfo()]);
      return tabs.map((tab) => tabInfo(tab, groupOf(tab, groups)));
    }

    case "tabs.get": {
      const [tab, groups] = await Promise.all([chrome.tabs.get(params.tabId), groupInfo()]);
      return tabInfo(tab, groupOf(tab, groups));
    }

    case "tabs.active": {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab === undefined) throw new Error("no active tab in the focused window");
      const groups = await groupInfo();
      return tabInfo(tab, groupOf(tab, groups));
    }

    case "tabs.open": {
      const created = await chrome.tabs.create({ url: params.url, active: params.active !== false });
      if (params.groupTitle) await addToGroup(created, params.groupTitle, params.groupColor, params.groupId);
      await waitForLoad(created.id, 15000);
      const [tab, groups] = await Promise.all([chrome.tabs.get(created.id), groupInfo()]);
      return tabInfo(tab, groupOf(tab, groups));
    }

    case "tabs.setGroup": {
      const tab = await chrome.tabs.get(params.tabId);
      if (!tab.groupId || tab.groupId === -1) throw new Error("tab is not in a tab group");
      const patch = {};
      if (typeof params.title === "string" && params.title.length > 0) patch.title = params.title;
      if (typeof params.color === "string" && params.color.length > 0) patch.color = params.color;
      await chrome.tabGroups.update(tab.groupId, patch);
      const groups = await groupInfo();
      return { groupId: tab.groupId, ...(groups.get(tab.groupId) ?? {}) };
    }

    case "tabs.close": {
      const tab = await chrome.tabs.get(params.tabId);
      if (params.groupTitle) {
        const groups = await groupInfo();
        const groupTitle = groupOf(tab, groups).title ?? "";
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

    case "input.move": {
      const center = params.ref !== undefined
        ? await (async () => {
            const map = refMaps.get(params.tabId);
            const backendNodeId = map?.get(params.ref);
            if (backendNodeId === undefined) throw new Error(`unknown ref ${JSON.stringify(params.ref)}`);
            const resolved = await cdp(params.tabId, "DOM.resolveNode", { backendNodeId });
            const box = await cdp(params.tabId, "Runtime.callFunctionOn", {
              objectId: resolved.object.objectId,
              functionDeclaration: "function(){const r=this.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};}",
              returnByValue: true,
            });
            return box.result.value;
          })()
        : typeof params.selector === "string"
          ? await elementCenter(params.tabId, params.selector)
          : { x: params.x, y: params.y };
      if (!center || typeof center.x !== "number") throw new Error("input.move needs a ref, selector, or x/y");
      await showCursor(params.tabId, center.x, center.y, "move");
      await cdp(params.tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: center.x, y: center.y });
      return center;
    }

    case "page.scroll": {
      const center = await viewportCenter(params.tabId);
      const x = typeof params.x === "number" ? params.x : center.x;
      const y = typeof params.y === "number" ? params.y : center.y;
      await showCursor(params.tabId, x, y, "scroll");
      await cdp(params.tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: params.deltaX ?? 0,
        deltaY: params.deltaY ?? 0,
      });
      return { deltaX: params.deltaX ?? 0, deltaY: params.deltaY ?? 0 };
    }

    case "page.scrollRef": {
      return scrollRef(params.tabId, params.ref);
    }

    case "page.snapshot": {
      return accessibilitySnapshot(params.tabId, params.maxElements ?? 120);
    }

    case "input.clickRef": {
      const center = await refCenter(params.tabId, params.ref);
      await clickAt(params.tabId, center.x, center.y, params.button ?? "left", params.clickCount ?? 1);
      return { ref: params.ref, x: center.x, y: center.y, tag: center.tag };
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
