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
// tabId → { owners: Map<turn token, origin>, origin, point }.
const cursors = new Map();

/** @type {WebSocket | null} */
let ws = null;
let reconnectTimer = null;
let backoffMs = 500;

/** Tab ids this worker has chrome.debugger attached to. */
const attached = new Set();
/** Pending file chooser requests from input.upload (tabId → waiter). */
const fileChooserWaiters = new Map();
/** Open JavaScript dialogs per tab, populated by chrome.debugger events. */
const openDialogs = new Map();
/** Console/log entries per tab, populated by chrome.debugger events. */
const logEntriesByTab = new Map();
const MAX_LOG_ENTRIES = 500;
/** Raw CDP events per tab, for chrome_cdp action=events. */
const cdpEventsByTab = new Map();
let cdpEventSequence = 0;
const MAX_CDP_EVENTS = 1000;
/** Per-tab navigation/network state used by load-state and navigation waits. */
const pageStates = new Map();
function pageState(tabId) {
  let state = pageStates.get(tabId);
  if (state === undefined) {
    state = {
      inflight: new Set(),
      navigationCount: 0,
      loadCount: 0,
      domContentLoadedCount: 0,
      lastNetworkActivity: Date.now(),
      lastLoadAt: 0,
      documentKey: 0,
    };
    pageStates.set(tabId, state);
  }
  return state;
}

function send(value) {
  if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
}

function setBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? "\u25CF" : "\u25CB" });
  chrome.action.setBadgeBackgroundColor({ color: connected ? "#1a73e8" : "#9aa0a6" });
}

async function getConfig() {
  try {
    const stored = await chrome.storage.local.get(["port", "token", "browserId"]);
    let browserId = typeof stored.browserId === "string" && stored.browserId.length > 0 ? stored.browserId : "";
    if (browserId.length === 0) {
      browserId = crypto.randomUUID();
      await chrome.storage.local.set({ browserId });
    }
    return {
      port: Number.isInteger(stored.port) && stored.port > 0 ? stored.port : DEFAULT_PORT,
      token: typeof stored.token === "string" ? stored.token : "",
      browserId,
    };
  } catch {
    return { port: DEFAULT_PORT, token: "", browserId: "default" };
  }
}

function browserLabel() {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return "Microsoft Edge";
  if (/Brave/i.test(ua)) return "Brave";
  if (/OPR\//.test(ua)) return "Opera";
  if (/Vivaldi/i.test(ua)) return "Vivaldi";
  if (/Chromium/i.test(ua) && !/Chrome\//.test(ua)) return "Chromium";
  if (/Chrome\//.test(ua)) return "Google Chrome";
  return "Chromium";
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
  const { port, token, browserId } = await getConfig();
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
      browserId,
      browserName: browserLabel(),
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
    void endCursor();
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
    pinned: tab.pinned === true,
    status: tab.status ?? "",
    incognito: tab.incognito === true,
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
  // Page events are needed for file chooser, JavaScript dialogs, navigation,
  // load state, and network-idle detection.
  await chrome.debugger.sendCommand({ tabId }, "Page.enable").catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, "Page.setLifecycleEventsEnabled", { enabled: true }).catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable").catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, "Log.enable").catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, "Network.enable").catch(() => {});
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


/** Virtual key table for CDP Input.dispatchKeyEvent (xdotool-style names supported). */
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
  Insert: { code: "Insert", keyCode: 45 },
  ContextMenu: { code: "ContextMenu", keyCode: 93 },
};

const KEY_ALIASES = {
  Return: "Enter",
  Esc: "Escape",
  BS: "Backspace",
  BackSpace: "Backspace",
  Del: "Delete",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Page_Up: "PageUp",
  Page_Down: "PageDown",
  Prior: "PageUp",
  Next: "PageDown",
  space: "Space",
  spacebar: "Space",
};

const MODIFIER_ALIASES = {
  ctrl: "control",
  control: "control",
  alt: "alt",
  option: "alt",
  shift: "shift",
  meta: "meta",
  super: "meta",
  command: "meta",
  cmd: "meta",
  win: "meta",
};

/** Modifier name → CDP bitmask. */
function modifierMask(modifiers) {
  let mask = 0;
  for (const raw of modifiers ?? []) {
    const name = MODIFIER_ALIASES[String(raw).toLowerCase()] ?? String(raw).toLowerCase();
    if (name === "alt") mask |= 1;
    else if (name === "control") mask |= 2;
    else if (name === "meta") mask |= 4;
    else if (name === "shift") mask |= 8;
  }
  return mask;
}

function normalizeKeyName(raw) {
  const name = String(raw);
  if (KEY_TABLE[name] !== undefined) return name;
  const alias = KEY_ALIASES[name] ?? KEY_ALIASES[name.toLowerCase()];
  if (alias !== undefined) return alias;
  if (/^f([1-9]|1[0-2])$/i.test(name)) return name.toUpperCase();
  if (/^kp_[0-9]$/i.test(name)) return `Numpad${name.slice(3)}`;
  if (name.length === 1) return name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function keySpecFor(key) {
  const normalized = normalizeKeyName(key);
  if (KEY_TABLE[normalized] !== undefined) return { key: normalized, ...KEY_TABLE[normalized] };
  if (/^F([1-9]|1[0-2])$/.test(normalized)) {
    const number = Number(normalized.slice(1));
    return { key: normalized, code: normalized, keyCode: 111 + number };
  }
  if (/^Numpad[0-9]$/.test(normalized)) {
    const digit = normalized.slice(-1);
    return { key: digit, code: `Numpad${digit}`, keyCode: 96 + Number(digit), text: digit };
  }
  const oneChar = normalized.length === 1;
  return {
    key: normalized,
    code: oneChar
      ? /[a-zA-Z]/.test(normalized)
        ? `Key${normalized.toUpperCase()}`
        : /[0-9]/.test(normalized)
          ? `Digit${normalized}`
          : normalized
      : normalized,
    keyCode: oneChar ? normalized.toUpperCase().charCodeAt(0) : 0,
    text: oneChar ? normalized : undefined,
  };
}

/** Split "super+c" / "ctrl+shift+Enter" into a key + modifier list. */
function parseKeyChord(chord, extraModifiers = []) {
  const parts = String(chord).split("+").map((part) => part.trim()).filter((part) => part.length > 0);
  const modifiers = [];
  let key = null;
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (modifier !== undefined) modifiers.push(modifier);
    else key = part;
  }
  for (const modifier of extraModifiers) {
    const normalized = MODIFIER_ALIASES[String(modifier).toLowerCase()] ?? String(modifier).toLowerCase();
    if (!modifiers.includes(normalized)) modifiers.push(normalized);
  }
  if (key === null && modifiers.length === 1) key = modifiers.pop();
  if (key === null) throw new Error(`key chord ${JSON.stringify(chord)} has no key`);
  return { key, modifiers };
}

/** Dispatch one key combination through CDP, optionally held for durationMs. */
async function dispatchKeyChord(tabId, chord, extraModifiers = [], durationMs = 0) {
  const parsed = parseKeyChord(chord, extraModifiers);
  const spec = keySpecFor(parsed.key);
  const modifiers = modifierMask(parsed.modifiers);
  const hasModifiers = modifiers !== 0;
  const base = {
    key: parsed.modifiers.includes("shift") && spec.text !== undefined ? spec.text.toUpperCase() : (hasModifiers ? spec.key : spec.key),
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
    modifiers,
  };
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    ...base,
    ...(hasModifiers || spec.text === undefined ? {} : { text: spec.text }),
  });
  if (durationMs > 0) await sleep(Math.min(30000, Math.max(0, durationMs)));
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  return { key: parsed.key, modifiers: parsed.modifiers };
}

/** Type a string character by character with real key events. */
async function pressSequentially(tabId, text, delayMs = 0) {
  const characters = [...String(text)];
  const wait = Math.min(1000, Math.max(0, Number(delayMs) || 0));
  for (const character of characters) {
    if (character === "\n") {
      await dispatchKeyChord(tabId, "Enter");
    } else if (character === "\t") {
      await dispatchKeyChord(tabId, "Tab");
    } else if (/^[\x20-\x7e]$/.test(character)) {
      await dispatchKeyChord(tabId, character === " " ? "Space" : character);
    } else {
      await cdp(tabId, "Input.insertText", { text: character });
    }
    if (wait > 0) await sleep(wait);
  }
  return { typed: characters.length, text: String(text) };
}

/** Center of an element plus a scroll into view, for a real mouse click. */
async function elementCenter(tabId, selector, timeoutMs = 3000) {
  const expression =
    "(() => { const el = document.querySelector(" + JSON.stringify(selector) + ");" +
    " if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' });" +
    " const r = el.getBoundingClientRect(); const style = getComputedStyle(el);" +
    " return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName, text: (el.innerText || el.value || '').slice(0, 80)," +
    " visible: r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'," +
    " disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' }; })()";
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const result = await cdp(tabId, "Runtime.evaluate", { expression, returnByValue: true });
    const value = result.result?.value;
    if (value && value.visible !== false && value.disabled !== true) return value;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for visible, enabled selector ${JSON.stringify(selector)}`);
    }
    await sleep(50);
  }
}

/** Dispatch one real mouse click at viewport coordinates. */
async function clickAt(tabId, x, y, button = "left", clickCount = 1, durationMs = 0, modifiers = []) {
  const mask = modifierMask(modifiers);
  await showCursor(tabId, x, y, "move");
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers: mask });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount, modifiers: mask });
  if (durationMs > 0) await sleep(durationMs);
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount, modifiers: mask });
  await showCursor(tabId, x, y, "click");
}

/** Run a click action and optionally wait for a download it triggers. */
async function clickMaybeDownload(params, action) {
  const waiter = params.waitForDownload === true ? createDownloadWaiter(params.downloadTimeoutMs ?? 30000) : null;
  try {
    const result = await action();
    if (waiter === null) return result;
    const download = await waiter.promise;
    return download === null ? result : { ...result, download: { id: download.id, filename: download.filename ?? null, state: download.state ?? "in_progress", bytesReceived: download.bytesReceived ?? 0, totalBytes: download.totalBytes ?? 0 } };
  } finally {
    waiter?.cancel();
  }
}

/** Set files on a native <input type="file"> through the DOM domain. */
async function setFileInputFiles(tabId, selector, files) {
  await cdp(tabId, "DOM.enable");
  const document = await cdp(tabId, "DOM.getDocument", { depth: 0 });
  const query = await cdp(tabId, "DOM.querySelector", { nodeId: document.root.nodeId, selector });
  if (!query.nodeId) throw new Error(`no element matches file input selector ${JSON.stringify(selector)}`);
  await cdp(tabId, "DOM.setFileInputFiles", { files, nodeId: query.nodeId });
  return { selector, files, count: files.length };
}

/** Wait for a Page.fileChooserOpened event after a click. */
function waitForFileChooser(tabId, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      fileChooserWaiters.delete(tabId);
      reject(new Error("timed out waiting for the file chooser"));
    }, Math.max(1000, timeoutMs));
    fileChooserWaiters.set(tabId, {
      resolve: (value) => {
        clearTimeout(timer);
        fileChooserWaiters.delete(tabId);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        fileChooserWaiters.delete(tabId);
        reject(error);
      },
    });
  });
}


/** Per-tab AX state: stable refs, backend identity, document key and diff history. */
const refMaps = new Map();
const axStates = new Map();
let axSnapshotSequence = 0;

const SKIP_AX_ROLES = new Set(["none", "presentation", "InlineTextBox", "LineBreak"]);
const TEXTUAL_AX_ROLES = new Set(["StaticText", "text", "paragraph", "LabelText", "listmarker", "RootWebArea"]);

function axState(tabId) {
  let state = axStates.get(tabId);
  if (state === undefined) {
    state = { refs: new Map(), byBackend: new Map(), nextRef: 1, documentKey: null, previous: null };
    axStates.set(tabId, state);
  }
  if (refMaps.get(tabId) !== state.refs) refMaps.set(tabId, state.refs);
  return state;
}

/** Backend node ids that currently have a non-empty layout box. */
async function visibleBackendNodes(tabId) {
  try {
    const { documents } = await cdp(tabId, "DOMSnapshot.captureSnapshot", {
      computedStyles: [],
      includePaintOrder: false,
      includeDOMRects: false,
    });
    const visible = new Set();
    for (const document of documents ?? []) {
      const backends = document.nodes?.backendNodeId ?? [];
      const indexes = document.layout?.nodeIndex ?? [];
      const bounds = document.layout?.bounds ?? [];
      for (let index = 0; index < indexes.length; index += 1) {
        const nodeIndex = indexes[index];
        const box = bounds[index];
        if (box !== undefined && box.length >= 4 && box[2] > 0 && box[3] > 0 && backends[nodeIndex] != null) {
          visible.add(backends[nodeIndex]);
        }
      }
    }
    return visible;
  } catch {
    return null;
  }
}

/** Format one AX node as a tree line. */
function axLine(element, indent) {
  const flags = [];
  if (element.disabled === true) flags.push("disabled");
  if (element.checked !== undefined) flags.push(`checked=${JSON.stringify(element.checked)}`);
  if (element.selected === true) flags.push("selected");
  if (element.expanded !== undefined) flags.push(`expanded=${element.expanded}`);
  if (element.pressed !== undefined) flags.push(`pressed=${JSON.stringify(element.pressed)}`);
  if (element.level !== undefined) flags.push(`level=${element.level}`);
  if (element.visible === false) flags.push("invisible");
  if (element.shadow === true) flags.push("shadow");
  return (
    `${"  ".repeat(Math.max(0, indent))}- ${element.role} ${JSON.stringify(element.name ?? "")}` +
    (element.ref ? ` [${element.ref}]` : "") +
    (element.description ? ` — ${JSON.stringify(element.description)}` : "") +
    (element.value !== undefined && element.value !== "" ? ` = ${JSON.stringify(element.value)}` : "") +
    (flags.length > 0 ? ` (${flags.join(", ")})` : "")
  );
}

function axHeader(tabId, identity) {
  return `Browser tab: ${tabId}, Title: ${JSON.stringify(identity.title ?? "")}, URL: ${JSON.stringify(identity.url ?? "")}`;
}

/** Build an AX state with stable refs, hierarchy, visibility and rich diffs. */
async function accessibilitySnapshot(tabId, maxElements, options = {}) {
  await cdp(tabId, "Accessibility.enable");
  const page = await cdp(tabId, "Runtime.evaluate", {
    expression: "JSON.stringify({url: location.href, title: document.title})",
    returnByValue: true,
  });
  const identity = JSON.parse(page.result.value);
  const state = axState(tabId);
  let documentKey = null;
  try {
    const { frameTree } = await cdp(tabId, "Page.getFrameTree");
    documentKey = frameTree?.frame?.loaderId ?? frameTree?.frame?.id ?? null;
  } catch {
    documentKey = null;
  }
  const navigated = documentKey !== null && state.documentKey !== null && documentKey !== state.documentKey;
  if (navigated) {
    state.refs.clear();
    state.byBackend.clear();
    state.nextRef = 1;
    state.previous = null;
  }
  if (documentKey !== null) state.documentKey = documentKey;

  await ensureShadowPatch(tabId);
  const [{ nodes }, visibleBackends] = await Promise.all([
    cdp(tabId, "Accessibility.getFullAXTree"),
    visibleBackendNodes(tabId),
  ]);
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const includedDepth = new Map();
  const depthOf = (node) => {
    let depth = 0;
    let parent = byId.get(node.parentId);
    const seen = new Set();
    while (parent !== undefined && !seen.has(parent.nodeId)) {
      seen.add(parent.nodeId);
      if (includedDepth.has(parent.nodeId)) {
        depth = includedDepth.get(parent.nodeId) + 1;
        break;
      }
      parent = byId.get(parent.parentId);
    }
    return depth;
  };
  const elements = [];
  let included = 0;
  let truncated = false;
  for (const node of nodes) {
    if (node.ignored === true) continue;
    const role = String(node.role?.value ?? "");
    if (role.length === 0 || SKIP_AX_ROLES.has(role)) continue;
    const name = String(node.name?.value ?? "").trim();
    const value = node.value?.value;
    if (name.length === 0 && (value === undefined || String(value).length === 0) && !["textbox", "searchbox", "region", "main", "RootWebArea"].includes(role)) {
      continue;
    }
    if (included >= maxElements) {
      truncated = true;
      break;
    }
    included += 1;
    const backendNodeId = node.backendDOMNodeId;
    let ref = null;
    const textual = TEXTUAL_AX_ROLES.has(role);
    if (backendNodeId != null && !textual) {
      ref = state.byBackend.get(backendNodeId);
      if (ref === undefined) {
        ref = `e${state.nextRef++}`;
        state.byBackend.set(backendNodeId, ref);
      }
      state.refs.set(ref, backendNodeId);
    }
    const props = new Map((node.properties ?? []).map((prop) => [prop.name, prop.value?.value]));
    const description = String(node.description?.value ?? "").trim();
    const depth = depthOf(node);
    includedDepth.set(node.nodeId, depth);
    elements.push({
      ...(ref !== null ? { ref } : {}),
      ...(backendNodeId != null ? { backendNodeId } : {}),
      role,
      name: name.slice(0, 120),
      depth,
      ...(description.length > 0 ? { description: description.slice(0, 160) } : {}),
      ...(typeof value === "string" && value.length > 0 ? { value: value.slice(0, 120) } : {}),
      ...(props.has("disabled") ? { disabled: props.get("disabled") === true } : {}),
      ...(props.has("checked") ? { checked: props.get("checked") } : {}),
      ...(props.has("selected") ? { selected: props.get("selected") === true } : {}),
      ...(props.has("expanded") ? { expanded: props.get("expanded") === true } : {}),
      ...(props.has("pressed") ? { pressed: props.get("pressed") } : {}),
      ...(props.has("level") ? { level: props.get("level") } : {}),
      visible: visibleBackends === null ? true : visibleBackends.has(backendNodeId),
    });
  }
  const shadowElements = await closedShadowElements(tabId, state.nextRef - 1);
  for (const element of shadowElements) {
    const number = Number(String(element.ref).replace(/^e/, ""));
    if (Number.isFinite(number) && number >= state.nextRef) state.nextRef = number + 1;
    elements.push({ ...element, depth: 0, visible: true });
  }

  const minDepth = elements.reduce((min, element) => Math.min(min, element.depth ?? 0), 0);
  const fullLines = elements.map((element) => axLine(element, (element.depth ?? 0) - minDepth));
  const elementKey = (element, index) =>
    element.backendNodeId !== undefined ? `b:${element.backendNodeId}` : `${element.role}|${element.name}|${index}`;
  const previous = state.previous;
  let changed = true;
  let diff = null;
  let text = `${axHeader(tabId, identity)}\n${fullLines.join("\n")}`;
  const signature = JSON.stringify(elements.map((element) => [
    element.role, element.name, element.value ?? null, element.description ?? null,
    element.disabled ?? null, element.checked ?? null, element.selected ?? null,
    element.expanded ?? null, element.pressed ?? null, element.visible, element.depth ?? 0,
  ]));
  if (previous !== null && previous.signature === signature && options.disableDiffing !== true) {
    changed = false;
    diff = { added: [], removed: [], changed: [], unchanged: true };
    text = `${axHeader(tabId, identity)}\n(no accessibility changes)`;
  } else if (previous !== null && options.disableDiffing !== true) {
    const before = new Map(previous.elements.map((element, index) => [elementKey(element, index), element]));
    const after = new Map(elements.map((element, index) => [elementKey(element, index), element]));
    const added = elements.filter((element, index) => !before.has(elementKey(element, index)));
    const removed = previous.elements.filter((element, index) => !after.has(elementKey(element, index)));
    const changedEntries = [];
    elements.forEach((element, index) => {
      const key = elementKey(element, index);
      const old = before.get(key);
      if (old === undefined) return;
      const fields = ["value", "description", "disabled", "checked", "selected", "expanded", "pressed", "visible", "depth"];
      const changes = {};
      for (const field of fields) {
        if (JSON.stringify(old[field] ?? null) !== JSON.stringify(element[field] ?? null)) {
          changes[field] = { from: old[field] ?? null, to: element[field] ?? null };
        }
      }
      if (Object.keys(changes).length > 0) changedEntries.push({ ref: element.ref ?? null, role: element.role, name: element.name, changes });
    });
    diff = { added, removed, changed: changedEntries, unchanged: false };
    const lines = [axHeader(tabId, identity), "Accessibility changes since previous snapshot:"];
    for (const element of added) lines.push(`+ ${axLine(element, 0)}`);
    for (const element of removed) lines.push(`- ${axLine(element, 0)}`);
    for (const entry of changedEntries) {
      const parts = Object.entries(entry.changes).map(([field, change]) => `${field}: ${JSON.stringify(change.from)} -> ${JSON.stringify(change.to)}`);
      lines.push(`~ [${entry.ref ?? "?"}] ${entry.role} ${JSON.stringify(entry.name)} — ${parts.join(", ")}`);
    }
    text = lines.join("\n");
  }
  const snapshotId = `ax-${++axSnapshotSequence}`;
  state.previous = { signature, elements: elements.map((element) => ({ ...element })) };
  return {
    ...identity,
    elements,
    truncated,
    snapshotId,
    changed,
    text,
    ...(diff !== null ? { diff } : {}),
  };
}

/** Resolve a snapshot ref to a Runtime objectId (supports closed shadow refs). */
async function refObjectId(tabId, ref) {
  const backendNodeId = refMaps.get(tabId)?.get(ref);
  if (backendNodeId !== undefined) {
    const resolved = await cdp(tabId, "DOM.resolveNode", { backendNodeId });
    if (resolved?.object?.objectId) return resolved.object.objectId;
  }
  const result = await cdp(tabId, "Runtime.evaluate", {
    expression: `(window.__dshShadowRefs && window.__dshShadowRefs[${JSON.stringify(ref)}]) || (window.__dshLocatorRefs && window.__dshLocatorRefs[${JSON.stringify(ref)}])`,
  });
  if (result?.result?.objectId) return result.result.objectId;
  throw new Error(`unknown ref ${JSON.stringify(ref)}; take a fresh chrome_snapshot`);
}

/** Center of an element referenced by a snapshot ref. */
async function refCenter(tabId, ref) {
  const map = refMaps.get(tabId);
  const backendNodeId = map?.get(ref);
  if (backendNodeId === undefined) {
    const result = await cdp(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const el = (window.__dshShadowRefs && window.__dshShadowRefs[${JSON.stringify(ref)}]) ||
          (window.__dshLocatorRefs && window.__dshLocatorRefs[${JSON.stringify(ref)}]);
        if (!el) return null;
        const before = el.getBoundingClientRect();
        const view = el.ownerDocument.defaultView;
        if (before.bottom <= 0 || before.right <= 0 || before.top >= view.innerHeight || before.left >= view.innerWidth) {
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        }
        const r = el.getBoundingClientRect();
        let left = r.left, top = r.top;
        let win = el.ownerDocument && el.ownerDocument.defaultView;
        while (win && win.frameElement) {
          try {
            const frameRect = win.frameElement.getBoundingClientRect();
            left += frameRect.left; top += frameRect.top;
            win = win.parent;
          } catch { break; }
        }
        return { x: left + r.width / 2, y: top + r.height / 2, width: r.width, height: r.height, tag: el.tagName };
      })()`,
      returnByValue: true,
    });
    const value = result.result?.value;
    if (value && typeof value.x === "number") return value;
    const coords = await cdp(tabId, "Runtime.evaluate", {
      expression: `(window.__dshLocatorCoords && window.__dshLocatorCoords[${JSON.stringify(ref)}]) || null`,
      returnByValue: true,
    });
    if (coords.result?.value && typeof coords.result.value.x === "number") {
      return { ...coords.result.value, tag: "iframe" };
    }
    throw new Error(`unknown ref ${JSON.stringify(ref)}; take a fresh chrome_snapshot`);
  }
  await cdp(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
  try {
    const { quads } = await cdp(tabId, "DOM.getContentQuads", { backendNodeId });
    if (Array.isArray(quads?.[0]) && quads[0].length === 8) {
      const [x1, y1, x2, y2, x3, y3, x4, y4] = quads[0];
      return {
        x: (x1 + x2 + x3 + x4) / 4, y: (y1 + y2 + y3 + y4) / 4,
        width: Math.max(x1, x2, x3, x4) - Math.min(x1, x2, x3, x4),
        height: Math.max(y1, y2, y3, y4) - Math.min(y1, y2, y3, y4),
        tag: "element",
      };
    }
  } catch {
    /* fall back to the bounding box */
  }
  const resolved = await cdp(tabId, "DOM.resolveNode", { backendNodeId });
  const box = await cdp(tabId, "Runtime.callFunctionOn", {
    objectId: resolved.object.objectId,
    functionDeclaration:
      "function(){const r=this.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,width:r.width,height:r.height,tag:this.tagName};}",
    returnByValue: true,
  });
  const value = box.result?.value;
  if (!value || typeof value.x !== "number") throw new Error(`ref ${ref} has no layout box (not visible?)`);
  return value;
}


/** Call a function on a DOM node identified by a snapshot/locator ref. */
async function callOnRef(tabId, ref, functionDeclaration, args = [], userGesture = true) {
  const objectId = await refObjectId(tabId, ref);
  try {
    const result = await cdp(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      userGesture,
    });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(details.exception?.description || details.text || "element action failed");
    }
    return result.result?.value;
  } finally {
    await cdp(tabId, "Runtime.releaseObject", { objectId }).catch(() => {});
  }
}

/** Focus a node without clicking it. */
async function focusRef(tabId, ref) {
  return callOnRef(
    tabId,
    ref,
    "function(){ if (this.scrollIntoView) this.scrollIntoView({block:'center',inline:'center',behavior:'instant'}); if (typeof this.focus === 'function') this.focus({preventScroll:true}); const root = this.getRootNode ? this.getRootNode() : document; const active = root.activeElement || document.activeElement; return { focused: active === this || (active && active.contains && active.contains(this)) || false, tag: this.tagName }; }"
  );
}

/** Select text (or place the cursor) inside an editable element. */
async function selectTextRef(tabId, ref, text, options = {}) {
  const selectionType = String(options.selectionType ?? "text");
  if (!["text", "cursor_before", "cursor_after"].includes(selectionType)) {
    throw new Error('selectionType must be "text", "cursor_before", or "cursor_after"');
  }
  return callOnRef(
    tabId,
    ref,
    `function(text, prefix, suffix, selectionType) {
      const needle = String(text);
      const value = typeof this.value === 'string' ? this.value : (this.innerText || this.textContent || '');
      let index = -1;
      if (prefix != null || suffix != null) {
        const pattern = String(prefix ?? '') + needle + String(suffix ?? '');
        const at = value.indexOf(pattern);
        if (at >= 0) index = at + String(prefix ?? '').length;
      } else {
        index = value.indexOf(needle);
      }
      if (index < 0) throw new Error('text not found in target element');
      const start = selectionType === 'cursor_after' ? index + needle.length : index;
      const end = selectionType === 'cursor_before' ? index : index + needle.length;
      if (typeof this.setSelectionRange === 'function' && typeof this.value === 'string') {
        if (typeof this.focus === 'function') this.focus({preventScroll:true});
        this.setSelectionRange(start, end);
      } else {
        const walker = document.createTreeWalker(this, NodeFilter.SHOW_TEXT);
        let offset = 0;
        let startNode = null;
        let endNode = null;
        let startOffset = 0;
        let endOffset = 0;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const length = node.nodeValue ? node.nodeValue.length : 0;
          if (startNode === null && start <= offset + length) { startNode = node; startOffset = Math.max(0, start - offset); }
          if (endNode === null && end <= offset + length) { endNode = node; endOffset = Math.max(0, end - offset); break; }
          offset += length;
        }
        if (startNode === null || endNode === null) throw new Error('text range is not selectable');
        const range = document.createRange();
        range.setStart(startNode, startOffset);
        range.setEnd(endNode, endOffset);
        const selection = this.ownerDocument.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return { text: needle, start, end, selectionType };
    }`,
    [String(text), options.prefix ?? null, options.suffix ?? null, selectionType]
  );
}

/** Invoke an accessibility secondary action (Expand/Collapse). */
async function secondaryActionRef(tabId, ref, action) {
  const result = await callOnRef(
    tabId,
    ref,
    `function(action) {
      const expanded = this.getAttribute ? this.getAttribute('aria-expanded') : null;
      const supported = expanded === 'true' ? ['Collapse'] : expanded === 'false' ? ['Expand'] : [];
      if (!supported.includes(action)) {
        throw new Error('element does not support secondary action ' + JSON.stringify(action) + (supported.length ? '; supported: ' + supported.join(', ') : ''));
      }
      if (typeof this.scrollIntoView === 'function') this.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
      if (typeof this.click === 'function') this.click(); else throw new Error('element is not clickable');
      return { action, supported };
    }`,
    [String(action)]
  );
  return { ref, ...result };
}

/** Write text to the page clipboard. */
async function writeClipboardText(tabId, text) {
  const value = String(text ?? "");
  const result = await cdp(tabId, "Runtime.evaluate", {
    expression: `(async () => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try { await navigator.clipboard.writeText(${JSON.stringify(value)}); return true; } catch (e) {}
      }
      const el = document.createElement('textarea');
      el.value = ${JSON.stringify(value)};
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand('copy');
      el.remove();
      return ok;
    })()`,
    awaitPromise: true,
    userGesture: true,
    returnByValue: true,
  });
  return { written: result.result?.value === true, chars: value.length };
}

function cursorState(tabId, origin, kind = "begin") {
  const tab = cursors.get(tabId);
  if (!tab || ![...tab.owners.values()].includes(origin)) return null;
  return {
    origin,
    point: origin === tab.origin ? tab.point : null,
    kind,
    moveSequence: tab.sequence ?? 0,
    visible: true,
  };
}

async function publishCursor(tabId, kind = "begin") {
  const deliver = () => {
    const tab = cursors.get(tabId);
    const state = tab ? cursorState(tabId, tab.origin, kind) : null;
    return chrome.tabs.sendMessage(tabId, { type: "dsh.cursor.state", state }, { frameId: 0 });
  };
  try {
    await deliver();
  } catch {
    // An already open page may predate the installation / extension reload.
    if (!cursors.has(tabId)) return;
    await chrome.scripting.executeScript({ target: { tabId }, files: ["cursor.js"] });
    await deliver();
  }
}

async function endCursor(owner, onlyTabId) {
  const updates = [];
  for (const [tabId, tab] of cursors) {
    if (onlyTabId !== undefined && onlyTabId !== tabId) continue;
    if (owner !== undefined && !tab.owners.delete(owner)) continue;
    if (owner === undefined || !tab.owners.size) {
      cursors.delete(tabId);
    }
    updates.push(publishCursor(tabId));
  }
  await Promise.allSettled(updates);
}

async function showCursor(tabId, x, y, kind = "move") {
  const tab = cursors.get(tabId);
  if (!tab) return;
  tab.point = { x, y };
  tab.sequence = (tab.sequence ?? 0) + 1;
  await publishCursor(tabId, kind).catch(() => {});
}

/** Viewport center, for wheel scrolling without an explicit point. */
async function viewportCenter(tabId) {
  const result = await cdp(tabId, "Runtime.evaluate", {
    expression: "({x: innerWidth/2, y: innerHeight/2, width: innerWidth, height: innerHeight})",
    returnByValue: true,
  });
  return result.result.value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for the next download started after the watcher is created. */
function createDownloadWaiter(timeoutMs = 30000) {
  let settled = false;
  let timer = null;
  let created = null;
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  const cleanup = () => {
    if (timer !== null) clearTimeout(timer);
    chrome.downloads.onCreated.removeListener(onCreated);
    chrome.downloads.onChanged.removeListener(onChanged);
  };
  const finish = (value) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolvePromise(value);
  };
  const onCreated = (item) => {
    created = item;
  };
  const onChanged = (delta) => {
    if (created === null || delta.id !== created.id) return;
    if (delta.state?.current === "complete") {
      chrome.downloads.search({ id: created.id }).then((items) => finish(items[0] ?? created)).catch(() => finish(created));
    } else if (delta.state?.current === "interrupted") {
      finish({ ...created, state: "interrupted" });
    }
  };
  chrome.downloads.onCreated.addListener(onCreated);
  chrome.downloads.onChanged.addListener(onChanged);
  timer = setTimeout(() => finish(null), Math.max(1000, timeoutMs));
  return { promise, cancel: () => finish(null) };
}

/** Scroll an element (by ref) into view and show the cursor there. */
async function scrollRef(tabId, ref) {
  const point = await refCenter(tabId, ref);
  await showCursor(tabId, point.x, point.y, "scroll");
  return point;
}


/** Install (once per tab) a patch that records closed shadow roots. */
async function ensureShadowPatch(tabId) {
  await cdp(tabId, "Page.enable").catch(() => {});
  const expression = `(() => {
    if (window.__dshShadowPatched) return true;
    window.__dshShadowPatched = true;
    window.__dshClosedRoots = [];
    const original = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const root = original.call(this, init);
      if (init && init.mode === 'closed') {
        try { this.__dshClosedRoot = root; window.__dshClosedRoots.push(this); } catch (e) {}
      }
      return root;
    };
    return true;
  })()`;
  await cdp(tabId, "Runtime.evaluate", { expression });
}

/** Interactive elements inside closed shadow roots, with page-side refs. */
async function closedShadowElements(tabId, startIndex) {
  const expression = `(() => {
    const out = [];
    window.__dshShadowRefs = window.__dshShadowRefs || {};
    const SELECTOR = 'button,a[href],input,select,textarea,[role=button],[role=link],[role=textbox],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[tabindex]';
    const roleOf = (el) => {
      const explicit = el.getAttribute && el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'button') return 'button';
      if (tag === 'a') return 'link';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'submit' || type === 'button') return 'button';
        return 'textbox';
      }
      return 'generic';
    };
    const nameOf = (el) => {
      const aria = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'));
      if (aria) return aria.trim();
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return (el.getAttribute('placeholder') || el.value || '').trim();
      return (el.innerText || el.textContent || '').trim();
    };
    let index = ${startIndex};
    const walk = (root) => {
      let nodes;
      try { nodes = root.querySelectorAll('*'); } catch (e) { return; }
      for (const el of nodes) {
        try {
          if (el.matches(SELECTOR)) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              index += 1;
              const ref = 'e' + index;
              window.__dshShadowRefs[ref] = el;
              out.push({ ref, role: roleOf(el), name: nameOf(el).slice(0, 80), shadow: true });
            }
          }
          if (el.__dshClosedRoot) walk(el.__dshClosedRoot);
        } catch (e) {}
      }
    };
    for (const host of window.__dshClosedRoots || []) {
      if (host.__dshClosedRoot) walk(host.__dshClosedRoot);
    }
    return out;
  })()`;
  const result = await cdp(tabId, "Runtime.evaluate", { expression, returnByValue: true });
  return result.result?.value ?? [];
}

async function dispatch(cmd, params) {
  switch (cmd) {
    case "cursor.begin": {
      const { tabId, origin, owner } = params;
      let tab = cursors.get(tabId);
      if (!tab) {
        tab = { owners: new Map(), origin, point: null, sequence: 0 };
        cursors.set(tabId, tab);
      }
      const changed = tab.owners.get(owner) !== origin;
      tab.owners.set(owner, origin);
      if (origin !== tab.origin) tab.point = null;
      tab.origin = origin;
      await publishCursor(tabId, changed ? "begin" : "observe");
      return {};
    }
    case "cursor.end":
      await endCursor(params.owner, params.tabId);
      return {};

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

    case "tabs.new": {
      const created = await chrome.tabs.create({ url: params.url ?? "about:blank", active: params.active !== false });
      if (params.groupTitle) await addToGroup(created, params.groupTitle, params.groupColor, params.groupId);
      await waitForLoad(created.id, 15000);
      const [tab, groups] = await Promise.all([chrome.tabs.get(created.id), groupInfo()]);
      return tabInfo(tab, groupOf(tab, groups));
    }

    case "page.back": {
      await cdp(params.tabId, "Runtime.evaluate", { expression: "history.back()" });
      await waitForLoad(params.tabId, params.timeoutMs ?? 10000);
      return tabInfo(await chrome.tabs.get(params.tabId));
    }

    case "page.forward": {
      await cdp(params.tabId, "Runtime.evaluate", { expression: "history.forward()" });
      await waitForLoad(params.tabId, params.timeoutMs ?? 10000);
      return tabInfo(await chrome.tabs.get(params.tabId));
    }

    case "page.reload": {
      await chrome.tabs.reload(params.tabId, { bypassCache: params.bypassCache === true });
      await waitForLoad(params.tabId, params.timeoutMs ?? 20000);
      return tabInfo(await chrome.tabs.get(params.tabId));
    }

    case "page.waitForLoad": {
      await waitForLoad(params.tabId, params.timeoutMs ?? 20000);
      return tabInfo(await chrome.tabs.get(params.tabId));
    }

    case "page.waitForLoadState": {
      const state = String(params.state ?? "load").toLowerCase();
      if (!["load", "complete", "domcontentloaded", "networkidle"].includes(state)) {
        throw new Error("load state must be load, domcontentloaded, networkidle, or complete");
      }
      const timeoutMs = Math.max(1000, Number(params.timeoutMs) || 20000);
      const deadline = Date.now() + timeoutMs;
      if (state === "load" || state === "complete") {
        await waitForLoad(params.tabId, timeoutMs);
      } else if (state === "domcontentloaded") {
        for (;;) {
          const result = await cdp(params.tabId, "Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
          const ready = String(result.result?.value ?? "");
          if (ready === "interactive" || ready === "complete") break;
          if (Date.now() >= deadline) throw new Error(`timed out waiting for load state ${state}`);
          await sleep(25);
        }
      } else {
        await ensureDebugger(params.tabId);
        // Network idle: document complete plus no in-flight requests for a
        // quiet window. Long-lived sockets and polling requests keep this
        // from resolving, which is the Playwright-compatible behavior.
        let quietSince = null;
        for (;;) {
          const tab = await chrome.tabs.get(params.tabId);
          const current = pageState(params.tabId);
          if (tab.status === "complete" && current.inflight.size === 0) {
            if (quietSince === null) quietSince = Date.now();
            if (Date.now() - quietSince >= 500) break;
          } else {
            quietSince = null;
          }
          if (Date.now() >= deadline) {
            const detail = current.inflight.size > 0 ? `${current.inflight.size} request(s) still in flight` : `document status ${tab.status}`;
            throw new Error(`timed out waiting for networkidle after ${timeoutMs}ms (${detail})`);
          }
          await sleep(50);
        }
      }
      return tabInfo(await chrome.tabs.get(params.tabId));
    }

    case "page.expectNavigation": {
      await ensureDebugger(params.tabId);
      // Registered before the triggering action. Resolve on the next
      // main-frame navigation/load, closing the fast-navigation race.
      const start = pageState(params.tabId);
      const startUrl = (await chrome.tabs.get(params.tabId)).url;
      const startNavigationCount = start.navigationCount;
      const startLoadCount = start.loadCount;
      const timeoutMs = Math.max(1000, Number(params.timeoutMs) || 20000);
      const deadline = Date.now() + timeoutMs;
      const expected = typeof params.url === "string" && params.url.length > 0 ? params.url : null;
      for (;;) {
        const tab = await chrome.tabs.get(params.tabId);
        const current = pageState(params.tabId);
        const navigated =
          current.navigationCount > startNavigationCount ||
          current.loadCount > startLoadCount ||
          (startUrl.length > 0 && tab.url !== startUrl && tab.status === "complete");
        if (navigated) {
          if (expected !== null) {
            const matches = tab.url === expected || (expected.endsWith("*") && tab.url.startsWith(expected.slice(0, -1)));
            if (!matches && Date.now() < deadline) {
              await sleep(50);
              continue;
            }
            if (!matches) throw new Error(`navigation reached ${tab.url}, expected ${expected}`);
          }
          const waitUntil = String(params.waitUntil ?? "load").toLowerCase();
          if (waitUntil !== "commit") {
            await dispatch("page.waitForLoadState", { tabId: params.tabId, state: waitUntil, timeoutMs: Math.max(1000, deadline - Date.now()) });
          }
          return tabInfo(await chrome.tabs.get(params.tabId));
        }
        if (Date.now() >= deadline) throw new Error(`timed out waiting for navigation after ${timeoutMs}ms`);
        await sleep(25);
      }
    }

    case "page.waitForURL": {
      const expected = String(params.url ?? "");
      const deadline = Date.now() + Math.max(1000, Number(params.timeoutMs) || 20000);
      for (;;) {
        const tab = await chrome.tabs.get(params.tabId);
        if (tab.url === expected || (expected.endsWith("*") && tab.url.startsWith(expected.slice(0, -1)))) return tabInfo(tab);
        if (Date.now() >= deadline) throw new Error(`timed out waiting for URL ${expected}`);
        await sleep(100);
      }
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

    case "page.evaluateOnRef": {
      const refs = Array.isArray(params.refs) ? params.refs : params.ref !== undefined ? [params.ref] : [];
      if (refs.length === 0) throw new Error("page.evaluateOnRef needs ref or refs");
      const source = String(params.source ?? "");
      if (source.length === 0) throw new Error("page.evaluateOnRef needs source");
      if (params.all === true) {
        const result = await cdp(params.tabId, "Runtime.evaluate", {
          expression: `(() => {
            const refs = ${JSON.stringify(refs)};
            const locatorRefs = window.__dshLocatorRefs || {};
            const shadowRefs = window.__dshShadowRefs || {};
            const elements = refs.map((ref) => locatorRefs[ref] || shadowRefs[ref]).filter(Boolean);
            const fn = (${source});
            return fn.call(null, elements, ${JSON.stringify(params.arg ?? null)});
          })()`,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        });
        if (result.exceptionDetails) {
          const details = result.exceptionDetails;
          throw new Error(details.exception?.description || details.text || "evaluateAll failed");
        }
        return { value: result.result?.value ?? null };
      }
      const value = await callOnRef(
        params.tabId,
        refs[0],
        `function(__arg) { const __fn = (${source}); return __fn.call(this, this, __arg); }`,
        [params.arg ?? null],
        true
      );
      return { value };
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

    case "input.drag": {
      const from = params.fromRef !== undefined ? await refCenter(params.tabId, params.fromRef) : { x: params.fromX, y: params.fromY };
      const to = params.toRef !== undefined ? await refCenter(params.tabId, params.toRef) : { x: params.toX, y: params.toY };
      if (typeof from.x !== "number" || typeof to.x !== "number") throw new Error("input.drag needs from/to refs or coordinates");
      await showCursor(params.tabId, from.x, from.y, "move");
      await cdp(params.tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y, button: "none", buttons: 0 });
      await cdp(params.tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
      const steps = 12;
      for (let step = 1; step <= steps; step += 1) {
        const x = from.x + ((to.x - from.x) * step) / steps;
        const y = from.y + ((to.y - from.y) * step) / steps;
        await showCursor(params.tabId, x, y, "move");
        await cdp(params.tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
      }
      await cdp(params.tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
      return { from, to };
    }

    case "input.click": {
      return clickMaybeDownload(params, async () => {
        await clickAt(
          params.tabId,
          params.x,
          params.y,
          params.button ?? "left",
          params.clickCount ?? 1,
          Math.min(30000, Math.max(0, Number(params.duration ?? 0) * 1000)),
          params.modifiers ?? []
        );
        return { x: params.x, y: params.y };
      });
    }

    case "input.clickSelector": {
      const center = await elementCenter(params.tabId, params.selector, params.timeoutMs ?? 3000);
      if (center === null) throw new Error(`no element matches selector ${JSON.stringify(params.selector)}`);
      return clickMaybeDownload(params, async () => {
        await clickAt(
          params.tabId,
          center.x,
          center.y,
          params.button ?? "left",
          params.clickCount ?? 1,
          Math.min(30000, Math.max(0, Number(params.duration ?? 0) * 1000)),
          params.modifiers ?? []
        );
        return center;
      });
    }

    case "input.type": {
      await cdp(params.tabId, "Input.insertText", { text: params.text });
      return { typed: params.text.length };
    }

    case "input.key": {
      const durationMs = Math.min(30000, Math.max(0, Number(params.duration ?? 0) * 1000));
      const result = await dispatchKeyChord(params.tabId, params.key, params.modifiers ?? [], durationMs);
      return { ...result, duration: Number(params.duration ?? 0) };
    }

    case "input.pressSequentially": {
      const result = await pressSequentially(params.tabId, params.text, params.delayMs ?? 0);
      return { ...result, delayMs: Number(params.delayMs ?? 0) };
    }

    case "input.focusRef": {
      const result = await focusRef(params.tabId, params.ref);
      return { ref: params.ref, ...result };
    }

    case "input.focusSelector": {
      const result = await cdp(params.tabId, "Runtime.evaluate", {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(String(params.selector ?? ""))});
          if (!el) return null;
          el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
          if (typeof el.focus === 'function') el.focus({preventScroll:true});
          return { focused: document.activeElement === el || (document.activeElement && document.activeElement.contains && document.activeElement.contains(el)), tag: el.tagName };
        })()`,
        returnByValue: true,
        userGesture: true,
      });
      if (!result.result?.value) throw new Error(`no focusable element matches selector ${JSON.stringify(params.selector)}`);
      return { selector: params.selector, ...result.result.value };
    }

    case "input.selectTextRef": {
      const selection = await selectTextRef(params.tabId, params.ref, params.text, params);
      return { ref: params.ref, selection };
    }

    case "input.secondaryAction": {
      return secondaryActionRef(params.tabId, params.ref, params.action);
    }

    case "input.move": {
      const center = params.ref !== undefined
        ? await refCenter(params.tabId, params.ref)
        : typeof params.selector === "string"
          ? await elementCenter(params.tabId, params.selector)
          : { x: params.x, y: params.y };
      if (!center || typeof center.x !== "number") throw new Error("input.move needs a ref, selector, or x/y");
      await showCursor(params.tabId, center.x, center.y, "move");
      await cdp(params.tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: center.x, y: center.y });
      return center;
    }

    case "page.scroll": {
      const viewport = await viewportCenter(params.tabId);
      const target = params.ref === undefined
        ? { ...viewport, x: params.x ?? viewport.x, y: params.y ?? viewport.y }
        : await refCenter(params.tabId, params.ref);
      const { x, y } = target;
      if (!Number.isFinite(x) || !Number.isFinite(y) ||
          x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
        throw new Error("Scroll point is outside the active tab viewport");
      }
      let deltaX = params.deltaX ?? 0;
      let deltaY = params.deltaY ?? 0;
      const pageScroll = params.pages !== undefined || params.direction !== undefined;
      if (pageScroll) {
        const direction = params.direction ?? "down";
        if (!["up", "down", "left", "right", "u", "d", "l", "r"].includes(direction)) {
          throw new Error("Scroll direction must be up, down, left or right");
        }
        const horizontal = ["left", "right", "l", "r"].includes(direction);
        const sign = ["up", "left", "u", "l"].includes(direction) ? -1 : 1;
        const distance = sign * Math.max(horizontal ? target.width : target.height, 100) * (params.pages ?? 1);
        deltaX = horizontal ? distance : 0;
        deltaY = horizontal ? 0 : distance;
      }
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) throw new Error("Scroll distance must be finite");
      await showCursor(params.tabId, x, y, "scroll");
      const modifiers = modifierMask(params.modifiers);
      await cdp(params.tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
      if (pageScroll) {
        // Official AX scroll uses one wheel event and the target's dimensions.
        await cdp(params.tabId, "Input.dispatchMouseEvent", {
          type: "mouseWheel", x, y, deltaX, deltaY, modifiers,
        });
      } else {
        // Official Chrome CUA uses a native gesture for pixel scrolling.
        await cdp(params.tabId, "Input.synthesizeScrollGesture", {
          x, y, xDistance: -deltaX, yDistance: -deltaY,
          gestureSourceType: "mouse", preventFling: true, speed: 8000,
        });
      }
      return { deltaX, deltaY, pages: pageScroll ? (params.pages ?? 1) : 0 };
    }

    case "page.scrollRef": {
      return scrollRef(params.tabId, params.ref);
    }

    case "page.locate": {
      const opts = JSON.stringify({
        selector: typeof params.selector === "string" && params.selector.length > 0 ? params.selector : null,
        role: typeof params.role === "string" && params.role.length > 0 ? params.role : null,
        name: typeof params.name === "string" && params.name.length > 0 ? params.name : null,
        text: typeof params.text === "string" && params.text.length > 0 ? params.text : null,
        label: typeof params.label === "string" && params.label.length > 0 ? params.label : null,
        placeholder: typeof params.placeholder === "string" && params.placeholder.length > 0 ? params.placeholder : null,
        testId: typeof params.testId === "string" && params.testId.length > 0 ? params.testId : null,
        alt: typeof params.alt === "string" && params.alt.length > 0 ? params.alt : null,
        title: typeof params.title === "string" && params.title.length > 0 ? params.title : null,
        hasText: typeof params.hasText === "string" && params.hasText.length > 0 ? params.hasText : null,
        hasNotText: typeof params.hasNotText === "string" && params.hasNotText.length > 0 ? params.hasNotText : null,
        frame: Array.isArray(params.frame) ? params.frame.map(String).filter((value) => value.length > 0) : [],
        scope: Array.isArray(params.scope) ? params.scope.map(String).filter((value) => value.length > 0) : [],
        has: params.has !== undefined && params.has !== null ? params.has : null,
        hasNot: params.hasNot !== undefined && params.hasNot !== null ? params.hasNot : null,
        and: Array.isArray(params.and) ? params.and : [],
        or: Array.isArray(params.or) ? params.or : [],
        exact: params.exact === true,
        includeHidden: params.includeHidden === true,
        limit: Math.min(200, Math.max(1, Number(params.limit) || 200)),
      });
      const result = await cdp(params.tabId, "Runtime.evaluate", {
        expression: `(() => {
          window.__dshLocatorRefs = window.__dshLocatorRefs || {};
          const opts = ${opts};
          const roleOf = (el) => {
            const explicit = el.getAttribute && el.getAttribute('role');
            if (explicit) return explicit.toLowerCase();
            const tag = el.tagName.toLowerCase();
            if (tag === 'button') return 'button';
            if (tag === 'a' && el.hasAttribute('href')) return 'link';
            if (tag === 'select') return 'combobox';
            if (tag === 'textarea') return 'textbox';
            if (tag === 'input') {
              const type = (el.getAttribute('type') || 'text').toLowerCase();
              if (type === 'checkbox') return 'checkbox';
              if (type === 'radio') return 'radio';
              if (type === 'submit' || type === 'button') return 'button';
              return 'textbox';
            }
            if (tag === 'img') return 'img';
            if (/^h[1-6]$/.test(tag)) return 'heading';
            return tag;
          };
          const nameOf = (el) => {
            const aria = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt'));
            if (aria) return aria.trim();
            if (el.labels && el.labels.length > 0) return [...el.labels].map((label) => label.innerText || label.textContent || '').join(' ').trim();
            return (el.innerText || el.textContent || '').trim().slice(0, 120);
          };
          const textOf = (el) => (el.innerText || el.textContent || '').trim().slice(0, 400);
          const match = (value, query, exact) => {
            if (query == null) return true;
            const text = String(value || '').toLowerCase();
            const wanted = String(query).toLowerCase();
            return exact ? text === wanted : text.includes(wanted);
          };
          const absoluteRect = (el) => {
            const rect = el.getBoundingClientRect();
            let left = rect.left, top = rect.top, width = rect.width, height = rect.height;
            let win = el.ownerDocument && el.ownerDocument.defaultView;
            while (win && win.frameElement) {
              try {
                const frameRect = win.frameElement.getBoundingClientRect();
                left += frameRect.left; top += frameRect.top;
                win = win.parent;
              } catch { break; }
            }
            return { left, top, width, height };
          };
          const visible = (el) => {
            const rect = absoluteRect(el);
            const style = getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          };
          const fieldValues = (el) => ({
            role: roleOf(el),
            name: nameOf(el),
            text: textOf(el),
            label: el.labels && el.labels.length > 0 ? [...el.labels].map((label) => label.innerText || label.textContent || '').join(' ') : nameOf(el),
            placeholder: el.getAttribute ? (el.getAttribute('placeholder') || '') : '',
            testId: el.getAttribute ? (el.getAttribute('data-testid') || el.getAttribute('data-test-id') || '') : '',
            alt: el.getAttribute ? (el.getAttribute('alt') || '') : '',
            title: el.getAttribute ? (el.getAttribute('title') || '') : '',
          });
          const inScope = (el, scopes) => {
            let current = el;
            for (let index = scopes.length - 1; index >= 0; index -= 1) {
              const selector = scopes[index];
              let candidate = current;
              let found = null;
              while (candidate) {
                try { if (candidate.matches(selector)) { found = candidate; break; } } catch (e) { break; }
                candidate = candidate.parentElement;
              }
              if (!found) return false;
              current = found.parentElement;
            }
            return true;
          };
          const matchesDescendant = (el, filter) => {
            if (typeof filter === 'string') {
              try { return !!el.querySelector(filter); } catch { return false; }
            }
            if (filter === null || typeof filter !== 'object') return false;
            return [...el.querySelectorAll('*')].some((child) => matchCriteria(child, filter));
          };
          function matchCriteria(el, criteria) {
            if (criteria === null || typeof criteria !== 'object') return false;
            if (criteria.selector != null) {
              try { if (!el.matches(String(criteria.selector))) return false; } catch { return false; }
            }
            const v = fieldValues(el);
            const exact = criteria.exact === true || (criteria.exact === undefined && opts.exact);
            if (!match(v.role, criteria.role, exact)) return false;
            if (!match(v.name, criteria.name, exact)) return false;
            if (!match(v.text, criteria.text, exact)) return false;
            if (!match(v.text, criteria.hasText, exact)) return false;
            if (criteria.hasNotText != null && match(v.text, criteria.hasNotText, exact)) return false;
            if (!match(v.label, criteria.label, exact)) return false;
            if (!match(v.placeholder, criteria.placeholder, exact)) return false;
            if (!match(v.testId, criteria.testId, exact)) return false;
            if (!match(v.alt, criteria.alt, exact)) return false;
            if (!match(v.title, criteria.title, exact)) return false;
            if (criteria.visible === true && !visible(el)) return false;
            if (criteria.visible === false && visible(el)) return false;
            if (criteria.has != null && !matchesDescendant(el, criteria.has)) return false;
            if (criteria.hasNot != null && matchesDescendant(el, criteria.hasNot)) return false;
            if (Array.isArray(criteria.scope) && criteria.scope.length > 0 && !inScope(el, criteria.scope)) return false;
            if (Array.isArray(criteria.and) && !criteria.and.every((branch) => matchCriteria(el, branch))) return false;
            if (Array.isArray(criteria.or) && criteria.or.length > 0 && !criteria.or.some((branch) => matchCriteria(el, branch))) return false;
            return true;
          }
          const candidates = [];
          let root = document;
          for (const frameSelector of opts.frame ?? []) {
            try {
              const frame = root.querySelector(frameSelector);
              root = frame && frame.contentDocument;
            } catch { root = null; }
            if (!root) break;
          }
          const visit = (doc) => {
            try {
              const defaultSelector = 'button,a[href],input,select,textarea,[role],[tabindex],[contenteditable="true"]';
              const broad = opts.scope.length === 0 && (
                opts.text != null || opts.name != null || opts.hasText != null || opts.role != null ||
                opts.label != null || opts.placeholder != null || opts.testId != null || opts.alt != null || opts.title != null
              );
              const selector = opts.selector || (broad ? '*' : defaultSelector);
              candidates.push(...doc.querySelectorAll(selector));
              for (const frame of doc.querySelectorAll('iframe')) {
                try { if (frame.contentDocument) visit(frame.contentDocument); } catch {}
              }
            } catch {}
          };
          if (root) visit(root);
          const out = [];
          for (const el of candidates) {
            if (!(el instanceof Element)) continue;
            if (!opts.includeHidden && !visible(el)) continue;
            if (opts.scope.length > 0 && !inScope(el, opts.scope)) continue;
            const base = {
              role: opts.role, name: opts.name, text: opts.text, hasText: opts.hasText, hasNotText: opts.hasNotText,
              label: opts.label, placeholder: opts.placeholder, testId: opts.testId, alt: opts.alt, title: opts.title,
              has: opts.has, hasNot: opts.hasNot, and: opts.and, or: opts.or, exact: opts.exact,
            };
            if (!matchCriteria(el, base)) continue;
            const rect = absoluteRect(el);
            const ref = 'l' + (out.length + 1);
            window.__dshLocatorRefs[ref] = el;
            const values = fieldValues(el);
            out.push({
              ref,
              tag: el.tagName.toLowerCase(),
              role: values.role,
              name: values.name.slice(0, 120),
              text: values.text.slice(0, 400),
              value: typeof el.value === 'string' ? el.value : undefined,
              placeholder: values.placeholder,
              disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
              checked: typeof el.checked === 'boolean' ? el.checked : undefined,
              selected: typeof el.selected === 'boolean' ? el.selected : undefined,
              visible: visible(el),
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
            });
            if (out.length >= opts.limit) break;
          }
          return out;
        })()`,
        returnByValue: true,
      });
      const elements = result.result?.value ?? [];
      // Cross-origin frames cannot be traversed from the main world; use CDP
      // isolated worlds for selector-based lookups and return clickable
      // coordinates (refs stored in __dshLocatorCoords) for those elements.
      if (
        typeof params.selector === "string" &&
        params.selector.length > 0 &&
        (!Array.isArray(params.scope) || params.scope.length === 0) &&
        (!Array.isArray(params.frame) || params.frame.length === 0)
      ) {
        try {
          await cdp(params.tabId, "DOM.enable");
          const { frameTree } = await cdp(params.tabId, "Page.getFrameTree");
          const frames = [];
          const walk = (node) => {
            for (const child of node.childFrames ?? []) {
              frames.push(child.frame);
              walk(child);
            }
          };
          walk(frameTree);
          let frameIndex = 0;
          for (const frame of frames) {
            frameIndex += 1;
            try {
              const world = await cdp(params.tabId, "Page.createIsolatedWorld", {
                frameId: frame.id,
                worldName: `dsh-locator-${frameIndex}`,
              });
              const found = await cdp(params.tabId, "Runtime.evaluate", {
                contextId: world.executionContextId,
                expression: `(() => [...document.querySelectorAll(${JSON.stringify(params.selector)})].map((el) => {
                  const rect = el.getBoundingClientRect();
                  return {
                    tag: el.tagName.toLowerCase(),
                    role: el.getAttribute('role') || '',
                    name: (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || el.innerText || el.textContent || '').trim().slice(0, 120),
                    text: (el.innerText || el.textContent || '').trim().slice(0, 400),
                    width: rect.width, height: rect.height,
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                  };
                }))()`,
                returnByValue: true,
              });
              const owner = await cdp(params.tabId, "DOM.getFrameOwner", { frameId: frame.id });
              const quads = await cdp(params.tabId, "DOM.getContentQuads", { backendNodeId: owner.backendNodeId });
              const quad = quads.quads?.[0];
              const offsetX = quad === undefined ? 0 : Math.min(quad[0], quad[2], quad[4], quad[6]);
              const offsetY = quad === undefined ? 0 : Math.min(quad[1], quad[3], quad[5], quad[7]);
              const items = found.result?.value ?? [];
              for (const item of items) {
                const ref = `f${frameIndex}_${elements.length + 1}`;
                const x = Math.round(offsetX + item.x);
                const y = Math.round(offsetY + item.y);
                await cdp(params.tabId, "Runtime.evaluate", {
                  expression: `window.__dshLocatorCoords = window.__dshLocatorCoords || {}; window.__dshLocatorCoords[${JSON.stringify(ref)}] = { x: ${x}, y: ${y}, width: ${item.width}, height: ${item.height} };`,
                });
                elements.push({ ...item, ref, x, y, visible: true, frameUrl: frame.url, crossFrame: true });
              }
            } catch {
              /* frame may have been detached or be inaccessible */
            }
          }
        } catch {
          /* Page domain or frame owner lookup unavailable */
        }
      }
      return { elements };
    }

    case "page.snapshot": {
      return accessibilitySnapshot(params.tabId, params.maxElements ?? 120, {
        disableDiffing: params.disableDiffing === true,
      });
    }

    case "input.setValueRef": {
      const objectId = await refObjectId(params.tabId, params.ref);
      const setValue = await cdp(params.tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration:
          "function(value){const proto=this instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:this instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;const desc=Object.getOwnPropertyDescriptor(proto,'value');if(desc&&desc.set){desc.set.call(this,value)}else{this.value=value}this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return this.value}",
        arguments: [{ value: String(params.value ?? "") }],
        returnByValue: true,
      });
      return { ref: params.ref, value: setValue.result?.value ?? String(params.value ?? "") };
    }

    case "input.selectOptionRef": {
      const objectId = await refObjectId(params.tabId, params.ref);
      const selected = await cdp(params.tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration:
          "function(values){if(!(this instanceof HTMLSelectElement))throw new Error('element is not a select');const list=Array.isArray(values)?values:[values];const matches=(option,item)=>{if(item&&typeof item==='object'){return (item.value!==undefined&&String(item.value)===option.value)||(item.label!==undefined&&String(item.label)===option.label)||(item.index!==undefined&&Number(item.index)===option.index)}return String(item)===option.value||String(item)===option.label||Number(item)===option.index};for(const option of this.options){option.selected=list.some((item)=>matches(option,item))}if(!this.multiple){const first=this.selectedOptions[0];if(first){for(const option of this.options)option.selected=option===first}}this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return [...this.selectedOptions].map((option)=>({value:option.value,label:option.label,index:option.index}))}",
        arguments: [{ value: Array.isArray(params.values) ? params.values : [params.values] }],
        returnByValue: true,
      });
      return { ref: params.ref, selected: selected.result?.value ?? [] };
    }

    case "page.attribute": {
      const objectId = await refObjectId(params.tabId, params.ref);
      const result = await cdp(params.tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function(name){return this.getAttribute ? this.getAttribute(name) : null}",
        arguments: [{ value: String(params.name ?? "") }],
        returnByValue: true,
      });
      return { ref: params.ref, name: params.name, value: result.result?.value ?? null };
    }

    case "input.clickRef": {
      const center = await refCenter(params.tabId, params.ref);
      return clickMaybeDownload(params, async () => {
        await clickAt(
          params.tabId,
          center.x,
          center.y,
          params.button ?? "left",
          params.clickCount ?? 1,
          Math.min(30000, Math.max(0, Number(params.duration ?? 0) * 1000)),
          params.modifiers ?? []
        );
        return { ref: params.ref, x: center.x, y: center.y, tag: center.tag };
      });
    }

    case "webmcp.list": {
      const result = await cdp(params.tabId, "Runtime.evaluate", {
        expression: `(async () => {
          const modelContext = document.modelContext;
          if (!modelContext || typeof modelContext.getTools !== 'function' || globalThis.origin === 'null') {
            return { available: false, tools: [] };
          }
          const tools = await modelContext.getTools();
          window.__dshWebMcpHandles = {};
          const describe = (tool, index) => {
            const id = 'w' + (index + 1);
            window.__dshWebMcpHandles[id] = tool;
            let inputSchema = tool.inputSchema ?? null;
            if (typeof inputSchema === 'string') { try { inputSchema = JSON.parse(inputSchema); } catch {} }
            return {
              registrationId: id,
              name: tool.name,
              title: tool.title ?? null,
              description: tool.description ?? null,
              inputSchema,
              annotations: tool.annotations ?? null,
              origin: tool.origin ?? null,
            };
          };
          return { available: true, tools: tools.map(describe) };
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      return result.result?.value ?? { available: false, tools: [] };
    }

    case "webmcp.invoke": {
      const registrationId = String(params.registrationId ?? "");
      const input = params.input ?? null;
      const timeoutMs = Number(params.timeoutMs) || 30000;
      const result = await cdp(params.tabId, "Runtime.evaluate", {
        expression: `(async () => {
          const modelContext = document.modelContext;
          const tool = window.__dshWebMcpHandles && window.__dshWebMcpHandles[${JSON.stringify(registrationId)}];
          if (!modelContext || !tool) throw new Error('stale WebMCP handle; call chrome_webmcp action=list again');
          const input = ${JSON.stringify(input)};
          const arity = modelContext.executeTool.length;
          return await modelContext.executeTool(tool, arity === 2 ? JSON.stringify(input) : input, { signal: AbortSignal.timeout(${Math.max(1000, timeoutMs)}) });
        })()`,
        awaitPromise: true,
        userGesture: true,
        returnByValue: true,
      });
      return { result: result.result?.value ?? null };
    }

    case "network.setHeaders": {
      await cdp(params.tabId, "Network.enable");
      const headers = params.headers && typeof params.headers === "object" ? params.headers : {};
      await cdp(params.tabId, "Network.setExtraHTTPHeaders", { headers });
      return { headers };
    }

    case "network.blockUrls": {
      await cdp(params.tabId, "Network.enable");
      const urls = Array.isArray(params.urls) ? params.urls.map(String) : [];
      await cdp(params.tabId, "Network.setBlockedURLs", { urls });
      return { urls };
    }

    case "network.clear": {
      await cdp(params.tabId, "Network.enable");
      await cdp(params.tabId, "Network.setExtraHTTPHeaders", { headers: {} });
      await cdp(params.tabId, "Network.setBlockedURLs", { urls: [] });
      return { cleared: true };
    }

    case "page.assets": {
      const result = await cdp(params.tabId, "Runtime.evaluate", {
        expression: `(() => {
          const abs = (value) => { try { return new URL(value, document.baseURI).href; } catch { return value || ''; } };
          return {
            pageUrl: location.href,
            title: document.title,
            images: [...document.images].map((img) => ({ src: abs(img.currentSrc || img.src), alt: img.alt || '', width: img.naturalWidth, height: img.naturalHeight })),
            stylesheets: [...document.styleSheets].map((sheet) => ({ href: abs(sheet.href || ''), title: sheet.title || '' })),
            scripts: [...document.scripts].map((script) => ({ src: abs(script.src || ''), inline: !script.src, chars: (script.textContent || '').length })),
            videos: [...document.querySelectorAll('video')].map((video) => ({ src: abs(video.currentSrc || video.src || ''), poster: abs(video.poster || '') })),
            fonts: [...document.fonts].map((face) => ({ family: face.family, weight: face.weight, style: face.style, status: face.status })),
          };
        })()`,
        returnByValue: true,
      });
      return result.result?.value ?? {};
    }

    case "host.info": {
      const [platform, windows] = await Promise.all([
        chrome.runtime.getPlatformInfo().catch(() => ({ os: "unknown", arch: "unknown" })),
        chrome.windows.getAll({ populate: false }).catch(() => []),
      ]);
      return {
        extensionId: chrome.runtime.id,
        version: chrome.runtime.getManifest().version,
        browserName: browserLabel(),
        platform,
        windows: windows.map((win) => ({ id: win.id, focused: win.focused, state: win.state, incognito: win.incognito, type: win.type })),
        browserId: (await getConfig()).browserId,
      };
    }

    case "notification.create": {
      const id = await chrome.notifications.create({
        type: "basic",
        iconUrl: chrome.runtime.getURL("images/cursor-chat.png"),
        title: String(params.title ?? "DSH Chrome Bridge"),
        message: String(params.message ?? ""),
        priority: params.priority === "high" ? 2 : 0,
      });
      return { id };
    }

    case "contextMenu.create": {
      const id = String(params.id ?? `dsh-${Date.now()}`);
      await new Promise((resolve, reject) => {
        chrome.contextMenus.create(
          {
            id,
            title: String(params.title ?? "Ask DSH about this page"),
            contexts: Array.isArray(params.contexts) ? params.contexts : ["page"],
          },
          () => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve()),
        );
      });
      return { id };
    }

    case "contextMenu.removeAll": {
      await new Promise((resolve) => chrome.contextMenus.removeAll(resolve));
      return {};
    }

    case "auth.detect": {
      const result = await cdp(params.tabId, "Runtime.evaluate", {
        expression: `(() => {
          const out = [];
          for (const el of document.querySelectorAll('button,a,[role=button]')) {
            const text = (el.innerText || el.textContent || '').trim();
            if (!text) continue;
            if (!/sign in|log in|continue with|chatgpt|openai|google|passkey|magic link|email|phone|otp|verification code/i.test(text)) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width < 2 || rect.height < 2) continue;
            out.push({ text: text.slice(0, 120), tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), id: el.id || null, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), visible: getComputedStyle(el).visibility !== 'hidden' });
            if (out.length >= 20) break;
          }
          const fields = [...document.querySelectorAll('input')].map((el) => ({ type: el.getAttribute('type') || 'text', name: el.getAttribute('name'), autocomplete: el.getAttribute('autocomplete'), placeholder: el.getAttribute('placeholder') || '', visible: el.getBoundingClientRect().width > 0 }));
          return { origin: location.origin, candidates: out, fields, signedInHint: /sign out|log out|account menu|my account/i.test(document.body?.innerText || '') };
        })()`,
        returnByValue: true,
      });
      return result.result?.value ?? { origin: "", candidates: [], fields: [], signedInHint: false };
    }

    case "siwc.detect": {
      const result = await cdp(params.tabId, "Runtime.evaluate", {
        expression: `(() => {
          const out = [];
          for (const el of document.querySelectorAll('button,a,[role=button]')) {
            const text = (el.innerText || el.textContent || '').trim();
            const aria = el.getAttribute('aria-label') || '';
            const data = (el.getAttribute('data-testid') || '') + ' ' + (el.className || '');
            const label = text || aria;
            if (!label) continue;
            const marker = /sign in with chatgpt|continue with chatgpt|chatgpt/i.test(label + ' ' + aria + ' ' + data);
            if (!marker) continue;
            const rect = el.getBoundingClientRect();
            out.push({ label: label.slice(0, 120), evidence: marker ? 'chatgpt_button_detected' : 'siwc_marker_detected', visibility: rect.width > 0 && rect.height > 0 ? 'rendered' : 'hidden', x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) });
          }
          return { candidates: out, status: out.length > 0 ? 'possible_matches' : 'no_deterministic_matches' };
        })()`,
        returnByValue: true,
      });
      return result.result?.value ?? { candidates: [], status: 'no_deterministic_matches' };
    }

    case "page.fetch": {
      const url = String(params.url ?? "");
      if (!/^https?:/i.test(url)) throw new Error("page.fetch needs an http(s) url");
      const result = await cdp(params.tabId, "Runtime.evaluate", {
        expression: `(async () => {
          const response = await fetch(${JSON.stringify(url)});
          const buffer = await response.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return { contentType: response.headers.get('content-type') || '', size: bytes.length, base64: btoa(binary) };
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      return result.result?.value ?? { contentType: "", size: 0, base64: "" };
    }

    case "content.exportGsuite": {
      const tab = await chrome.tabs.get(params.tabId);
      const pageUrl = String(tab.url ?? "");
      const format = String(params.type ?? "pdf").toLowerCase();
      let exportUrl = null;
      let match = pageUrl.match(/docs\.google\.com\/document\/d\/([^/]+)/);
      if (match !== null) exportUrl = `https://docs.google.com/document/d/${match[1]}/export?format=${format}`;
      if (exportUrl === null) {
        match = pageUrl.match(/docs\.google\.com\/spreadsheets\/d\/([^/]+)/);
        if (match !== null) exportUrl = `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=${format}`;
      }
      if (exportUrl === null) {
        match = pageUrl.match(/docs\.google\.com\/presentation\/d\/([^/]+)/);
        if (match !== null) exportUrl = `https://docs.google.com/presentation/d/${match[1]}/export/${format}`;
      }
      if (exportUrl === null) throw new Error("the current tab is not a Google Workspace document, spreadsheet, or presentation");
      const id = await chrome.downloads.download({ url: exportUrl, saveAs: false });
      return { exportUrl, downloadId: id, format };
    }

    case "content.exportYouTubeTranscript": {
      const tab = await chrome.tabs.get(params.tabId);
      if (!/(^|\.)youtube\.com$/i.test(new URL(tab.url).hostname)) throw new Error("the current tab is not a YouTube watch page");
      const result = await cdp(params.tabId, "Runtime.evaluate", {
        expression: `(async () => {
          const player = window.ytInitialPlayerResponse;
          const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
          const track = tracks.find((item) => item.kind !== 'asr' && item.languageCode?.startsWith('en')) ?? tracks[0];
          if (!track) return null;
          const response = await fetch(track.baseUrl + '&fmt=json3');
          const data = await response.json();
          return (data.events ?? []).map((event) => (event.segs ?? []).map((seg) => seg.utf8).join('')).filter(Boolean).join('\\n');
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      const text = String(result.result?.value ?? "");
      if (text.length === 0) throw new Error("no transcript is available for this video");
      return { text };
    }

    case "page.export": {
      const format = String(params.format ?? "text").toLowerCase();
      if (format === "pdf") {
        const pdf = await cdp(params.tabId, "Page.printToPDF", { printBackground: true, preferCSSPageSize: true });
        return { format, dataBase64: pdf.data };
      }
      const expression =
        format === "html"
          ? "document.documentElement.outerHTML"
          : "document.body ? document.body.innerText : ''";
      const result = await cdp(params.tabId, "Runtime.evaluate", { expression, returnByValue: true });
      return { format, text: String(result.result?.value ?? "") };
    }

    case "page.screenshot": {
      await cdp(params.tabId, "Page.enable");
      const format = String(params.format ?? "png").toLowerCase() === "jpeg" ? "jpeg" : "png";
      const options = { format };
      if (format === "jpeg") options.quality = Math.max(0, Math.min(100, Number(params.quality) || 80));
      if (params.fullPage === true) {
        const metrics = await cdp(params.tabId, "Page.getLayoutMetrics");
        const size = metrics.cssContentSize ?? metrics.contentSize;
        if (size?.width > 0 && size?.height > 0) {
          options.captureBeyondViewport = true;
          options.clip = { x: size.x ?? 0, y: size.y ?? 0, width: size.width, height: size.height, scale: 1 };
        }
      } else if (params.clip !== undefined && params.clip !== null) {
        const clip = params.clip;
        if (
          typeof clip.x === "number" &&
          typeof clip.y === "number" &&
          typeof clip.width === "number" &&
          typeof clip.height === "number"
        ) {
          options.captureBeyondViewport = true;
          options.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: clip.scale ?? 1 };
        }
      }
      const shot = await cdp(params.tabId, "Page.captureScreenshot", options);
      return {
        dataBase64: shot.data,
        fullPage: params.fullPage === true,
        format,
        mediaType: format === "jpeg" ? "image/jpeg" : "image/png",
      };
    }

    case "page.elementInfo": {
      const x = Number(params.x);
      const y = Number(params.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("page.elementInfo needs x and y");
      const result = await cdp(params.tabId, "Runtime.evaluate", {
        expression: `(() => {
          const point = { x: ${x}, y: ${y} };
          const elements = document.elementsFromPoint(point.x, point.y).slice(0, 5);
          return elements.map((el) => {
            const rect = el.getBoundingClientRect();
            const attrs = {};
            for (const attr of el.attributes ?? []) attrs[attr.name] = attr.value;
            const candidates = [];
            if (el.id) candidates.push('#' + CSS.escape(el.id));
            for (const attr of ['data-testid', 'data-test-id', 'name', 'aria-label', 'placeholder']) {
              const value = el.getAttribute && el.getAttribute(attr);
              if (value) candidates.push(el.tagName.toLowerCase() + '[' + attr + '="' + CSS.escape(value) + '"]');
            }
            if (el.className && typeof el.className === 'string') candidates.push(el.tagName.toLowerCase() + '.' + el.className.trim().split(/\\s+/).map((c) => CSS.escape(c)).join('.'));
            return {
              tag: el.tagName.toLowerCase(),
              role: el.getAttribute('role'),
              attributes: attrs,
              text: (el.innerText || el.textContent || '').trim().slice(0, 120),
              rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
              selectorCandidates: candidates,
              primary: candidates[0] ?? null,
            };
          });
        })()`,
        returnByValue: true,
      });
      return { point: { x, y }, elements: result.result?.value ?? [] };
    }

    case "page.elementScreenshot": {
      const x = Number(params.x);
      const y = Number(params.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("page.elementScreenshot needs x and y");
      const size = Math.max(40, Math.min(1200, Number(params.size) || 320));
      const scroll = await cdp(params.tabId, "Runtime.evaluate", {
        expression: "({ x: window.scrollX || 0, y: window.scrollY || 0 })",
        returnByValue: true,
      });
      const scrollX = Number(scroll.result?.value?.x) || 0;
      const scrollY = Number(scroll.result?.value?.y) || 0;
      const shot = await cdp(params.tabId, "Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: {
          x: Math.max(0, scrollX + x - size / 2),
          y: Math.max(0, scrollY + y - size / 2),
          width: size,
          height: size,
          scale: 1,
        },
      });
      return { dataBase64: shot.data, point: { x, y }, size, mediaType: "image/png" };
    }

    case "tab.logs": {
      await ensureDebugger(params.tabId);
      const limit = Math.min(MAX_LOG_ENTRIES, Math.max(1, Number(params.limit) || 100));
      const levels = Array.isArray(params.levels) ? new Set(params.levels) : null;
      const filter = typeof params.filter === "string" ? params.filter.toLowerCase() : "";
      const logs = (logEntriesByTab.get(params.tabId) ?? [])
        .filter((entry) => levels === null || levels.has(entry.level))
        .filter((entry) => filter.length === 0 || entry.message.toLowerCase().includes(filter))
        .slice(-limit);
      return { logs };
    }

    case "dialog.get": {
      await ensureDebugger(params.tabId);
      await sleep(50);
      return { dialog: openDialogs.get(params.tabId) ?? null };
    }

    case "dialog.handle": {
      await ensureDebugger(params.tabId);
      const action = params.action === "accept" ? "accept" : "dismiss";
      await cdp(params.tabId, "Page.handleJavaScriptDialog", {
        accept: action === "accept",
        ...(typeof params.promptText === "string" ? { promptText: params.promptText } : {}),
      });
      openDialogs.delete(params.tabId);
      return { action };
    }

    case "clipboard.write": {
      return writeClipboardText(params.tabId, params.text);
    }

    case "clipboard.paste": {
      const written = await writeClipboardText(params.tabId, params.text);
      if (params.ref !== undefined) await focusRef(params.tabId, params.ref);
      // Insert through the browser input pipeline while also keeping the
      // session clipboard populated for subsequent real Ctrl+V shortcuts.
      await cdp(params.tabId, "Input.insertText", { text: String(params.text ?? "") });
      return { pasted: true, chars: String(params.text ?? "").length, ...(params.ref !== undefined ? { ref: params.ref } : {}), written: written.written };
    }

    case "clipboard.read": {
      const result = await cdp(params.tabId, "Runtime.evaluate", {
        expression: `(async () => {
          if (navigator.clipboard && navigator.clipboard.readText) return await navigator.clipboard.readText();
          return '';
        })()`,
        awaitPromise: true,
        userGesture: true,
        returnByValue: true,
      });
      return { text: String(result.result?.value ?? "") };
    }

    case "viewport.set": {
      const width = Math.round(Number(params.width));
      const height = Math.round(Number(params.height));
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
        throw new Error("viewport.set needs positive width and height");
      }
      await cdp(params.tabId, "Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: Number(params.deviceScaleFactor) || 1,
        mobile: params.mobile === true,
      });
      return { width, height };
    }

    case "viewport.reset": {
      await cdp(params.tabId, "Emulation.clearDeviceMetricsOverride");
      return {};
    }

    case "visibility.get": {
      const tab = await chrome.tabs.get(params.tabId);
      const win = await chrome.windows.get(tab.windowId);
      return { visible: win.state !== "minimized" && win.focused === true };
    }

    case "visibility.set": {
      const tab = await chrome.tabs.get(params.tabId);
      await chrome.windows.update(tab.windowId, {
        focused: params.visible === true,
        state: params.visible === true ? "normal" : "minimized",
      });
      return { visible: params.visible === true };
    }

    case "cdp.send": {
      if (typeof params.method !== "string" || params.method.length === 0) throw new Error("cdp.send needs method");
      const value = await cdp(params.tabId, params.method, params.params ?? {});
      return { value };
    }

    case "cdp.events": {
      const after = Number.isInteger(params.afterSequence) ? params.afterSequence : 0;
      const limit = Math.min(1000, Math.max(1, Number(params.limit) || 200));
      const methods = Array.isArray(params.methods) ? new Set(params.methods) : null;
      const events = (cdpEventsByTab.get(params.tabId) ?? [])
        .filter((event) => event.sequence > after)
        .filter((event) => methods === null || methods.has(event.method))
        .slice(0, limit);
      return {
        events,
        cursor: events.length > 0 ? events[events.length - 1].sequence : after,
        hasMore: (cdpEventsByTab.get(params.tabId) ?? []).some((event) => event.sequence > (events.at(-1)?.sequence ?? after)),
      };
    }

    case "management.call": {
      const namespaces = {
        tabs: chrome.tabs,
        tabGroups: chrome.tabGroups,
        windows: chrome.windows,
        bookmarks: chrome.bookmarks,
        history: chrome.history,
        sessions: chrome.sessions,
        topSites: chrome.topSites,
      };
      const namespace = namespaces[params.namespace];
      if (namespace === undefined) throw new Error(`unsupported management namespace: ${params.namespace}`);
      if (typeof namespace[params.method] !== "function") {
        throw new Error(`unsupported management method: ${params.namespace}.${params.method}`);
      }
      const args = Array.isArray(params.args) ? params.args : [];
      // The management capability is for organization, not navigation.
      if (params.namespace === "tabs" && params.method === "update") {
        const patch = args[1];
        if (patch != null && typeof patch === "object" && ("url" in patch || "pendingUrl" in patch)) {
          throw new Error("management tabs.update cannot navigate; use chrome_navigate");
        }
      }
      if (params.namespace === "windows" && params.method === "create") {
        const createData = args[0];
        if (createData != null && typeof createData === "object" && "url" in createData) {
          throw new Error("management windows.create cannot open URLs; use chrome_navigate");
        }
      }
      const value = await namespace[params.method](...args);
      return { value };
    }

    case "tabs.content": {
      const urls = Array.isArray(params.urls) ? params.urls.map(String) : [];
      if (urls.length === 0) throw new Error("tabs.content needs at least one url");
      const format = params.format === "html" || params.format === "domSnapshot" ? "html" : "text";
      const results = [];
      for (const url of urls) {
        let temp;
        try {
          temp = await chrome.tabs.create({ url, active: false });
          await waitForLoad(temp.id, Math.max(1000, Number(params.timeoutMs) || 15000));
          const expression =
            format === "html"
              ? "JSON.stringify({url: location.href, title: document.title, content: document.documentElement.outerHTML})"
              : "JSON.stringify({url: location.href, title: document.title, content: (document.body && document.body.innerText) || ''})";
          const page = await cdp(temp.id, "Runtime.evaluate", { expression, returnByValue: true });
          const value = JSON.parse(page.result.value);
          results.push({ url: value.url, title: value.title, content: value.content });
        } catch (error) {
          results.push({ url, title: null, content: null, error: String(error?.message ?? error) });
        } finally {
          if (temp?.id !== undefined) await chrome.tabs.remove(temp.id).catch(() => {});
        }
      }
      return { results };
    }

    case "filechooser.setFiles": {
      const files = Array.isArray(params.files) ? params.files.map(String) : [];
      if (files.length === 0) throw new Error("filechooser.setFiles needs files");
      await cdp(params.tabId, "DOM.setFileInputFiles", { files, backendNodeId: Number(params.backendNodeId) });
      return { files, count: files.length };
    }

    case "downloads.wait": {
      const waiter = createDownloadWaiter(params.timeoutMs ?? 30000);
      const download = await waiter.promise;
      if (download === null) throw new Error("timed out waiting for a download");
      return {
        id: download.id,
        filename: download.filename ?? null,
        state: download.state ?? "in_progress",
        bytesReceived: download.bytesReceived ?? 0,
        totalBytes: download.totalBytes ?? 0,
      };
    }

    case "filechooser.wait": {
      await cdp(params.tabId, "Page.enable");
      await cdp(params.tabId, "Page.setInterceptFileChooserDialog", { enabled: true });
      try {
        return await waitForFileChooser(params.tabId, params.timeoutMs ?? 10000);
      } finally {
        await cdp(params.tabId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
      }
    }

    case "downloads.list": {
      const items = await chrome.downloads.search({
        limit: Math.min(100, Math.max(1, Number(params.limit) || 20)),
        orderBy: ["-startTime"],
      });
      return {
        downloads: items.map((item) => ({
          id: item.id,
          filename: item.filename,
          url: item.url,
          state: item.state,
          bytesReceived: item.bytesReceived,
          totalBytes: item.totalBytes,
          startTime: item.startTime,
        })),
      };
    }

    case "downloads.download": {
      if (typeof params.url !== "string" || params.url.length === 0) throw new Error("downloads.download needs a url");
      const id = await chrome.downloads.download({
        url: params.url,
        saveAs: params.saveAs === true,
        ...(typeof params.filename === "string" && params.filename.length > 0 ? { filename: params.filename } : {}),
      });
      return { id };
    }

    case "downloads.show": {
      chrome.downloads.show(Number(params.id));
      return { id: Number(params.id) };
    }

    case "favicon.set": {
      const badge = String(params.badge ?? "none").toLowerCase();
      const colors = { active: "#111827", deliverable: "#22c55e", handoff: "#facc15", none: null };
      const color = colors[badge] ?? null;
      await cdp(params.tabId, "Runtime.evaluate", {
        expression: `(() => {
          const ID = '__dsh_favicon__';
          let link = document.getElementById(ID);
          const original = link?.dataset.originalHref ?? null;
          if (${JSON.stringify(color)} === null) {
            if (link !== null) {
              if (original !== null) link.href = original; else link.remove();
            }
            return { cleared: true };
          }
          const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="24" cy="24" r="7" fill="${color}"/></svg>';
          const href = 'data:image/svg+xml,' + encodeURIComponent(svg);
          if (link === null) {
            const existing = document.querySelector('link[rel~="icon"]');
            link = document.createElement('link');
            link.id = ID;
            link.rel = 'icon';
            link.dataset.originalHref = existing?.href ?? '';
            if (existing) existing.remove();
            document.head.appendChild(link);
          }
          link.href = href;
          return { badge: '${badge}', href };
        })()`,
        returnByValue: true,
      });
      return { badge };
    }

    case "sidePanel.open": {
      const tab = await chrome.tabs.get(params.tabId);
      await chrome.sidePanel.open({ windowId: tab.windowId });
      return { windowId: tab.windowId };
    }

    case "input.upload": {
      const files = Array.isArray(params.files) ? params.files.map(String) : [];
      if (files.length === 0) throw new Error("input.upload needs at least one absolute file path");
      if (typeof params.selector === "string" && params.selector.length > 0) {
        return setFileInputFiles(params.tabId, params.selector, files);
      }
      if (typeof params.clickSelector === "string" && params.clickSelector.length > 0) {
        await cdp(params.tabId, "Page.enable");
        await cdp(params.tabId, "Page.setInterceptFileChooserDialog", { enabled: true });
        const chooserPromise = waitForFileChooser(params.tabId, params.timeoutMs ?? 10000);
        try {
          const center = await elementCenter(params.tabId, params.clickSelector, params.timeoutMs ?? 10000);
          if (center === null) throw new Error(`no element matches selector ${JSON.stringify(params.clickSelector)}`);
          await clickAt(params.tabId, center.x, center.y);
          const chooser = await chooserPromise;
          if (typeof chooser.backendNodeId !== "number") throw new Error("file chooser did not expose a file input");
          await cdp(params.tabId, "DOM.setFileInputFiles", { files, backendNodeId: chooser.backendNodeId });
          return { clickSelector: params.clickSelector, files, count: files.length };
        } finally {
          await cdp(params.tabId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
        }
      }
      throw new Error("input.upload needs either selector (file input) or clickSelector (button that opens the chooser)");
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

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  let events = cdpEventsByTab.get(tabId);
  if (events === undefined) {
    events = [];
    cdpEventsByTab.set(tabId, events);
  }
  events.push({ sequence: ++cdpEventSequence, method, params });
  if (events.length > MAX_CDP_EVENTS) events.splice(0, events.length - MAX_CDP_EVENTS);
  const state = pageState(tabId);
  if (method === "Network.requestWillBeSent" && params.requestId !== undefined) {
    state.inflight.add(params.requestId);
    state.lastNetworkActivity = Date.now();
  } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
    state.inflight.delete(params.requestId);
    state.lastNetworkActivity = Date.now();
  } else if (method === "Page.frameNavigated" && params.frame?.parentId === undefined) {
    state.navigationCount += 1;
    state.documentKey += 1;
    state.lastNetworkActivity = Date.now();
    // Element refs are document-scoped: after a main-frame navigation they
    // must be re-derived from a fresh snapshot.
    axStates.delete(tabId);
    refMaps.delete(tabId);
  } else if (method === "Page.loadEventFired") {
    state.loadCount += 1;
    state.lastLoadAt = Date.now();
  } else if (method === "Page.domContentEventFired") {
    state.domContentLoadedCount += 1;
  }
  if (method === "Page.fileChooserOpened") {
    const waiter = fileChooserWaiters.get(tabId);
    if (waiter !== undefined) waiter.resolve(params);
    return;
  }
  if (method === "Page.javascriptDialogOpening") {
    openDialogs.set(tabId, {
      type: params.type,
      message: params.message,
      defaultPrompt: params.defaultPrompt ?? "",
      url: params.url ?? "",
      openedAt: Date.now(),
    });
    return;
  }
  if (method === "Page.javascriptDialogClosed") {
    openDialogs.delete(tabId);
    return;
  }
  if (method === "Runtime.consoleAPICalled") {
    let list = logEntriesByTab.get(tabId);
    if (list === undefined) {
      list = [];
      logEntriesByTab.set(tabId, list);
    }
    const message = (params.args ?? [])
      .map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description ?? arg.type ?? ""))
      .join(" ");
    list.push({
      level: params.type ?? "log",
      message,
      timestamp: params.timestamp ?? Date.now(),
    });
    if (list.length > MAX_LOG_ENTRIES) list.splice(0, list.length - MAX_LOG_ENTRIES);
    return;
  }
  if (method === "Log.entryAdded" && params.entry !== undefined) {
    let list = logEntriesByTab.get(tabId);
    if (list === undefined) {
      list = [];
      logEntriesByTab.set(tabId, list);
    }
    list.push({
      level: params.entry.level ?? "info",
      message: params.entry.text ?? "",
      timestamp: params.entry.timestamp ?? Date.now(),
      ...(params.entry.url !== undefined ? { url: params.entry.url } : {}),
    });
    if (list.length > MAX_LOG_ENTRIES) list.splice(0, list.length - MAX_LOG_ENTRIES);
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) {
    void endCursor(undefined, source.tabId);
    attached.delete(source.tabId);
    fileChooserWaiters.delete(source.tabId);
    openDialogs.delete(source.tabId);
    pageStates.delete(source.tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cursors.delete(tabId);
  attached.delete(tabId);
  pageStates.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "dsh.cursor.get" && sender.tab && sender.frameId === 0) {
    sendResponse(cursorState(sender.tab.id, sender.origin ?? new URL(sender.url).origin));
    return false;
  }
  if (message === null || typeof message !== "object" || message.type !== "status") return false;
  getConfig().then(({ port, browserId }) => {
    sendResponse({
      connected: ws !== null && ws.readyState === WebSocket.OPEN,
      port,
      browserName: browserLabel(),
      browserId,
      extensionDir: chrome.runtime.getURL(""),
    });
  });
  return true;
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "open-dsh-side-panel") {
    chrome.windows.getCurrent().then((win) => {
      if (win?.id !== undefined) chrome.sidePanel.open({ windowId: win.id }).catch(() => {});
    }).catch(() => {});
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.id !== undefined) {
    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("images/cursor-chat.png"),
      title: "DSH Chrome Bridge",
      message: `Context action on ${info.pageUrl ?? "this page"}. Ask the agent in DSH to continue.`,
    }).catch(() => {});
  }
});

/* The DSH host pings every 20s and this worker's pong keeps it alive; the
   alarm covers cold starts while the host is down. */
connect();
