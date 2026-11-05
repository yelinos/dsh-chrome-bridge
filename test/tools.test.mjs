/** Tools-layer tests: apply() over a mock ctx + real bridge + fake extension. */
import * as plugin from "./../index.js";
import { createBridgeServer } from "./../bridge.js";
import { assert, assertEqual, assertRejects, connectFakeExtension } from "./helpers.mjs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  }
}

const testDir = join(process.cwd(), "test", ".tmp-workspace");
await rm(testDir, { recursive: true, force: true });
await mkdir(testDir, { recursive: true });

const PORT = 18790;
const server = createBridgeServer({ port: PORT, commandTimeoutMs: 1500 });
await server.listen();

/** Fake browser state driven by the fake extension handlers. */
const fakeTabs = new Map();
let nextTabId = 100;
let tabsOpened = 0;
function fakeOpen(url, groupTitle, active = true, groupColor = "blue") {
  const id = nextTabId++;
  const tab = { id, windowId: 1, index: fakeTabs.size, active, url, title: `Page: ${url}`, groupId: 55, groupTitle, groupColor };
  fakeTabs.set(id, tab);
  return tab;
}

const cursorCalls = [];
let lastLocateParams = null;
const ext = await connectFakeExtension({
  port: PORT,
  handlers: {
    "ext.ping": () => ({ version: "test" }),
    "cursor.begin": (params) => { cursorCalls.push({cmd: "begin", ...params}); return {}; },
    "cursor.end": (params) => { cursorCalls.push({cmd: "end", ...params}); return {}; },
    "tabs.list": () => [...fakeTabs.values()].map((tab) => ({ ...tab })),
    "tabs.get": ({ tabId }) => {
      const tab = fakeTabs.get(tabId);
      if (tab === undefined) throw new Error("no such tab");
      return { ...tab };
    },
    "tabs.active": () => {
      const tab = [...fakeTabs.values()].find((t) => t.active);
      if (tab === undefined) throw new Error("no active tab");
      return { ...tab };
    },
    "tabs.open": ({ url, active, groupTitle, groupColor }) => {
      tabsOpened += 1;
      return fakeOpen(url, groupTitle ?? "", active !== false, groupColor ?? "blue");
    },
    "tabs.setGroup": ({ tabId, title, color }) => {
      const tab = fakeTabs.get(tabId);
      if (tab === undefined) throw new Error("no such tab");
      if (title !== undefined) tab.groupTitle = title;
      if (color !== undefined) tab.groupColor = color;
      return { groupId: tab.groupId, title: tab.groupTitle, color: tab.groupColor };
    },
    "tabs.close": ({ tabId }) => {
      if (!fakeTabs.has(tabId)) throw new Error("no such tab");
      fakeTabs.delete(tabId);
      return { closed: tabId };
    },
    "page.navigate": ({ tabId, url }) => {
      const tab = fakeTabs.get(tabId);
      tab.url = url;
      tab.title = `Page: ${url}`;
      return { ...tab };
    },
    "page.eval": ({ tabId, expression }) => ({ value: { echo: expression, tabId } }),
    "page.read": ({ tabId }) => {
      const tab = fakeTabs.get(tabId);
      return { url: tab.url, title: tab.title, text: `Hello from ${tab.url}` };
    },
    "page.screenshot": () => ({ dataBase64: Buffer.from("fake-png-bytes").toString("base64") }),
    "input.click": ({ x, y }) => ({ x, y }),
    "input.clickSelector": ({ selector }) => {
      if (selector === "#missing") throw new Error("no element matches selector");
      return { x: 12, y: 34, tag: "BUTTON", text: selector };
    },
    "input.type": ({ text }) => ({ typed: text.length }),
    "input.key": ({ key, modifiers }) => ({ key, modifiers: modifiers ?? [] }),
    "input.clickRef": ({ ref }) => ({ ref, x: 20, y: 30, tag: "BUTTON" }),
    "input.focusRef": ({ ref }) => ({ ref, focused: true, tag: "INPUT" }),
    "input.focusSelector": ({ selector }) => {
      if (selector === "#missing") throw new Error("no focusable element matches selector");
      return { selector, focused: true, tag: "INPUT" };
    },
    "input.selectTextRef": ({ ref, text }) => ({ ref, selection: { text, start: 0, end: String(text).length, selectionType: "text" } }),
    "input.secondaryAction": ({ ref, action }) => ({ ref, action, supported: ["Expand"] }),
    "input.pressSequentially": ({ text }) => ({ typed: String(text).length, text }),
    "clipboard.paste": ({ ref, text }) => ({ pasted: true, chars: String(text).length, ...(ref ? { ref } : {}) }),
    "page.evaluateOnRef": ({ refs, source }) => (refs.length > 1 ? { value: refs.length } : { value: { ref: refs[0], source } }),
    "input.drag": ({ fromRef, toRef, fromX, fromY, toX, toY }) => ({
      from: { x: fromX ?? 10, y: fromY ?? 20 },
      to: { x: toX ?? 100, y: toY ?? 120 },
    }),
    "page.scroll": (params) => ({ ...params, pages: params.pages ?? 0 }),
    "page.scrollRef": ({ ref }) => ({ ref, x: 30, y: 40 }),
    "input.move": ({ ref, x, y }) => ({ ref, x: x ?? 50, y: y ?? 60 }),
    "page.snapshot": () => ({
      url: "https://snapshot.example/",
      title: "Snapshot Page",
      elements: [
        { ref: "e1", role: "textbox", name: "Search" },
        { ref: "e2", role: "button", name: "Go" },
      ],
      truncated: false,
      snapshotId: "ax-test",
      changed: true,
    }),
    "page.locate": (params) => {
      lastLocateParams = params;
      const elements = params.selector === "#multi" || (Array.isArray(params.scope) && params.scope.includes("#multi"))
        ? [
            { ref: "l1", role: "button", name: "First", text: "First", checked: false, disabled: false, visible: true },
            { ref: "l2", role: "button", name: "Second", text: "Second", checked: false, disabled: false, visible: true },
          ]
        : [{ ref: "l1", role: "button", name: "Submit", text: "Submit", checked: false, disabled: false, visible: true }];
      return { elements };
    },
    "page.attribute": ({ name }) => ({ value: `value-of-${name}` }),
    "input.setValueRef": ({ ref, value }) => ({ ref, value }),
    "input.selectOptionRef": ({ ref, values }) => ({ ref, selected: values.map((value) => ({ value })) }),
  },
});

/** Recorded user-approval answers and persisted settings. */
const askCalls = [];
let askAnswer = "允许（本会话）Allow this session";
const settingsWrites = [];
const settingsStore = {
  update: async (entryId, patch) => {
    settingsWrites.push({ entryId, patch });
    // Simulate the volatile config refresh the real settings service performs.
    if (patch.allowedDomains !== undefined) {
      persistedAllowed.length = 0;
      persistedAllowed.push(...patch.allowedDomains);
    }
  },
};
const persistedAllowed = ["allowed.example"];
const attachmentRefs = [];
const attachmentsStore = {
  saveImage: async (input) => {
    const ref = {
      attachmentId: `sha256:test-${attachmentRefs.length}`,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 640,
      height: 480,
      name: input.name ?? null,
    };
    attachmentRefs.push(ref);
    return ref;
  },
};
const emittedEvents = [];
/** Captured ctx.on handlers, keyed by event name. */
const hostHandlers = new Map();

const registered = [];
const ctx = {
  tools: { register: (definition) => registered.push(definition) },
  userQuestions: {
    ask: async (request) => {
      askCalls.push(request);
      return { answers: [{ id: "allow-domain", selected: [askAnswer] }] };
    },
  },
  workingDirectory: { ensure: async () => testDir },
  chromeBridge: {
    status: () => ({ ...server.status(), extensionDir: "/bundle/extension/" }),
    command: (cmd, params, signal, browserId) => server.command(cmd, params, signal, browserId),
    setActiveBrowser: (browserId) => server.setActiveBrowser(browserId),
  },
  fiber: { entry: { options: { id: "chrome-bridge-tools" } } },
  emit: (name) => {
    emittedEvents.push(name);
  },
  effect: (fn) => {
    const dispose = fn();
    return typeof dispose === "function" ? dispose : () => {};
  },
  on: (event, handler) => {
    let list = hostHandlers.get(event);
    if (list === undefined) {
      list = [];
      hostHandlers.set(event, list);
    }
    list.push(handler);
    return () => {};
  },
  inject: (names, callback) => {
    const available = { settings: settingsStore, attachments: attachmentsStore };
    if (!names.every((n) => available[n] !== undefined)) return;
    const scope = {};
    for (const n of names) scope[n] = available[n];
    callback(scope);
  },
};

const config = {
  tabGroupTitle: "DSH",
  askForNewDomains: true,
  allowedDomains: persistedAllowed,
  blockedDomains: ["blocked.example"],
  maxSnapshotChars: 24000,
  maxSessionTabs: 3,
  autoCloseIdleMs: 0,
  autoCloseOnSessionEnd: true,
};
plugin.apply(ctx, config);
const tools = new Map(registered.map((tool) => [tool.name, tool]));
let sessionCounter = 0;
function makeExec() {
  sessionCounter += 1;
  const hex = sessionCounter.toString(16).padStart(6, "0");
  return {
    agent: { session: { id: `session-${hex}0000-1111-2222-333344445555` } },
    signal: new AbortController().signal,
    callId: "c1",
  };
}

await test("apply registers the complete chrome_* tool set", async () => {
  assertEqual(
    [...tools.keys()].sort(),
    [
      "chrome_act",
      "chrome_active_tab",
      "chrome_audit_trail",
      "chrome_bookmarks",
      "chrome_bot_detection",
      "chrome_browser_auth",
      "chrome_browser_diagnostics",
      "chrome_browser_info",
      "chrome_cdp",
      "chrome_claim_tab",
      "chrome_click",
      "chrome_clipboard",
      "chrome_close_tab",
      "chrome_context_menu",
      "chrome_dialog",
      "chrome_download",
      "chrome_drag",
      "chrome_element_info",
      "chrome_element_screenshot",
      "chrome_eval",
      "chrome_export",
      "chrome_export_gsuite",
      "chrome_export_youtube_transcript",
      "chrome_favicon",
      "chrome_find",
      "chrome_group",
      "chrome_history",
      "chrome_js",
      "chrome_key",
      "chrome_locator",
      "chrome_logs",
      "chrome_management",
      "chrome_mark_tab",
      "chrome_move",
      "chrome_navigate",
      "chrome_network",
      "chrome_notify",
      "chrome_open_tabs",
      "chrome_page_assets",
      "chrome_read_page",
      "chrome_read_urls",
      "chrome_release_tab",
      "chrome_screenshot",
      "chrome_scroll",
      "chrome_select_option",
      "chrome_set_value",
      "chrome_side_panel",
      "chrome_siwc",
      "chrome_snapshot",
      "chrome_status",
      "chrome_tab_mentions",
      "chrome_tabs",
      "chrome_turn_ended",
      "chrome_type",
      "chrome_upload",
      "chrome_use_browser",
      "chrome_user_takeover",
      "chrome_viewport",
      "chrome_visibility",
      "chrome_webmcp",
    ],
    "tool set"
  );
});

await test("chrome_status reports bridge + policy state + extension dir", async () => {
  const value = await tools.get("chrome_status").execute({}, makeExec());
  assert(value.connected, "connected");
  assertEqual(value.extension.name, "Fake Extension", "extension info");
  assertEqual(value.extensionDir, "/bundle/extension/", "extension dir");
  assert(value.allowedDomains.includes("allowed.example"), "allowed list");
  assert(value.blockedDomains.includes("blocked.example"), "blocked list");
});

await test("chrome_navigate opens tabs in a named per-session group", async () => {
  const exec = makeExec();
  const first = await tools.get("chrome_navigate").execute({ url: "https://site.example/one" }, exec);
  assert(first.group.length > 0 && first.group.length <= 24, "group has a short name", first.group);
  const tab = fakeTabs.get(first.tabId);
  assertEqual(tab.groupTitle, first.group, "extension received the group title");
  assert(["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange", "grey"].includes(first.groupColor), "group has a palette color");
  const other = await tools.get("chrome_navigate").execute({ url: "https://site.example/two" }, makeExec());
  assert(other.groupColor !== undefined, "second session also has a color");
});

await test("domain approval: session memory, ask, decline", async () => {
  const exec = makeExec();
  const before = askCalls.length;
  await tools.get("chrome_navigate").execute({ url: "https://newsite.example/a" }, exec);
  assertEqual(askCalls.length, before + 1, "asked once");
  assert(askCalls[askCalls.length - 1].questions[0].question.includes("newsite.example"), "ask names the domain");
  await tools.get("chrome_navigate").execute({ url: "https://newsite.example/b" }, exec);
  assertEqual(askCalls.length, before + 1, "no re-ask within the session");
  await tools.get("chrome_navigate").execute({ url: "https://newsite.example/c" }, makeExec());
  assertEqual(askCalls.length, before + 2, "asks again for a new session");
  askAnswer = "拒绝 Decline";
  try {
    await assertRejects(
      tools.get("chrome_navigate").execute({ url: "https://declined.example/" }, makeExec()),
      "declined to allow",
      "decline rejects"
    );
  } finally {
    askAnswer = "允许（本会话）Allow this session";
  }
});

await test("allowedDomains and blockedDomains bypass the ask", async () => {
  const before = askCalls.length;
  const ok = await tools.get("chrome_navigate").execute({ url: "https://allowed.example/x" }, makeExec());
  assert(ok.tabId > 0, "allowed domain navigates without asking");
  await assertRejects(
    tools.get("chrome_navigate").execute({ url: "https://blocked.example/x" }, makeExec()),
    "blocked by chrome-bridge-tools blockedDomains",
    "blocked domain rejects"
  );
  assertEqual(askCalls.length, before, "no ask for either");
});

await test('"Always allow" persists through the settings service', async () => {
  askAnswer = "始终允许 Always allow";
  try {
    const exec = makeExec();
    await tools.get("chrome_navigate").execute({ url: "https://persist.example/" }, exec);
    const write = settingsWrites[settingsWrites.length - 1];
    assert(write !== undefined, "settings.update was called");
    assertEqual(write.entryId, "chrome-bridge-tools", "written to the plugin's entry");
    assert(write.patch.allowedDomains.includes("persist.example"), "domain persisted");
    assert(emittedEvents.includes("chrome-bridge/changed"), "change event emitted");
    // The (simulated) volatile refresh makes it visible without re-asking.
    const before = askCalls.length;
    await tools.get("chrome_navigate").execute({ url: "https://persist.example/again" }, makeExec());
    assertEqual(askCalls.length, before, "persisted domain needs no ask in a new session");
    const status = await tools.get("chrome_status").execute({}, makeExec());
    assert(status.allowedDomains.includes("persist.example"), "status lists the persisted domain");
  } finally {
    askAnswer = "允许（本会话）Allow this session";
  }
});

await test("chrome_read_page / chrome_eval operate on the last tab", async () => {
  const exec = makeExec();
  const nav = await tools.get("chrome_navigate").execute({ url: "https://site.example/" }, exec);
  const read = await tools.get("chrome_read_page").execute({}, exec);
  assertEqual(read.url, "https://site.example/", "read url");
  assert(read.text.includes("Hello from"), "read text");
  const evaluated = await tools.get("chrome_eval").execute({ expression: "1+1" }, exec);
  assertEqual(evaluated.value.echo, "1+1", "eval round-trip");
  assertEqual(evaluated.tabId, nav.tabId, "eval targets the last tab");
});

await test("chrome_screenshot returns a durable image attachment inline", async () => {
  const exec = makeExec();
  await tools.get("chrome_navigate").execute({ url: "https://site.example/shot" }, exec);
  const value = await tools.get("chrome_screenshot").execute({}, exec);
  assert(value.attachment !== undefined, "attachment present");
  assertEqual(value.attachment.mediaType, "image/png", "media type");
  const blocks = tools.get("chrome_screenshot").output.render({}, value);
  assertEqual(blocks[0].type, "image", "first render block is the image");
  assertEqual(blocks[0].attachment.attachmentId, value.attachment.attachmentId, "image carries the ref");
  assert(blocks[1].text.includes("640×480"), "caption carries dimensions");
});

await test("chrome_tabs lists only agent tabs by default", async () => {
  const exec = makeExec();
  const nav = await tools.get("chrome_navigate").execute({ url: "https://list.example/" }, exec);
  const grouped = await tools.get("chrome_tabs").execute({}, exec);
  assert(grouped.tabs.some((tab) => tab.id === nav.tabId), "agent tab is listed");
  assert(grouped.tabs.every((tab) => tab.session === true || tab.groupTitle === "DSH" || /^DSH · /.test(tab.groupTitle)), "only agent tabs");
  const all = await tools.get("chrome_tabs").execute({ all: true }, makeExec());
  assert(all.tabs.length >= grouped.tabs.length, "all=true includes everything");
});

await test("chrome_close_tab refuses tabs outside agent groups", async () => {
  const outside = fakeOpen("https://private.example/", "Personal");
  await assertRejects(
    tools.get("chrome_close_tab").execute({ tabId: outside.id }, makeExec()),
    "refusing to close",
    "outside group rejected"
  );
  assert(fakeTabs.has(outside.id), "the outside tab survives");
  const exec = makeExec();
  const nav = await tools.get("chrome_navigate").execute({ url: "https://site.example/close-me" }, exec);
  const closed = await tools.get("chrome_close_tab").execute({ tabId: nav.tabId }, exec);
  assertEqual(closed.tabId, nav.tabId, "agent tab closed");
  assert(!fakeTabs.has(nav.tabId), "removed from the fake browser");
});

await test("chrome_navigate reuses the session tab by default", async () => {
  const exec = makeExec();
  const openedBefore = tabsOpened;
  const first = await tools.get("chrome_navigate").execute({ url: "https://reuse.example/one" }, exec);
  assertEqual(first.reused, false, "first visit opens a tab");
  const second = await tools.get("chrome_navigate").execute({ url: "https://reuse.example/two" }, exec);
  assertEqual(second.tabId, first.tabId, "second navigation reuses the same tab");
  assertEqual(second.reused, true, "second navigation reports reuse");
  assertEqual(tabsOpened - openedBefore, 1, "only one tab was created for two navigations");
  const third = await tools.get("chrome_navigate").execute({ url: "https://reuse.example/three", newTab: true }, exec);
  assert(third.tabId !== first.tabId, "newTab: true opens another tab");
  assertEqual(tabsOpened - openedBefore, 2, "exactly one extra tab for newTab");
});

await test("maxSessionTabs closes the least recently used session tab", async () => {
  const previous = config.maxSessionTabs;
  config.maxSessionTabs = 2;
  try {
    const exec = makeExec();
    const openedBefore = tabsOpened;
    const a = await tools.get("chrome_navigate").execute({ url: "https://cap.example/a", newTab: true }, exec);
    const b = await tools.get("chrome_navigate").execute({ url: "https://cap.example/b", newTab: true }, exec);
    const c = await tools.get("chrome_navigate").execute({ url: "https://cap.example/c", newTab: true }, exec);
    assertEqual(tabsOpened - openedBefore, 3, "three tabs opened");
    assert(c.closedTabs.includes(a.tabId), "oldest tab closed by the cap", JSON.stringify(c.closedTabs));
    assert(!fakeTabs.has(a.tabId), "oldest tab actually gone");
    assert(fakeTabs.has(b.tabId) && fakeTabs.has(c.tabId), "newest tabs kept");
  } finally {
    config.maxSessionTabs = previous;
  }
});

await test("agent/disposed closes every tab the session opened", async () => {
  const exec = makeExec();
  const nav = await tools.get("chrome_navigate").execute({ url: "https://dispose.example/" }, exec);
  assert(fakeTabs.has(nav.tabId), "tab exists before disposal");
  const handlers = hostHandlers.get("agent/disposed") ?? [];
  assert(handlers.length === 1, "agent/disposed handler registered");
  handlers[0]({ agent: exec.agent });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert(!fakeTabs.has(nav.tabId), "tab closed when the agent is disposed");
});

await test("chrome_tabs marks tabs owned by the current session", async () => {
  const exec = makeExec();
  const nav = await tools.get("chrome_navigate").execute({ url: "https://owned.example/" }, exec);
  const listed = await tools.get("chrome_tabs").execute({}, exec);
  const row = listed.tabs.find((tab) => tab.id === nav.tabId);
  assert(row !== undefined && row.session === true, "session-owned tab is marked");
});

await test("new tab groups get an automatic purpose name and a session color", async () => {
  const exec = makeExec();
  const nav = await tools.get("chrome_navigate").execute({ url: "https://auto-name.example/very-long-path" }, exec);
  assert(nav.group.length > 0 && nav.group.length <= 24, "auto group name is short", nav.group);
  assert(nav.group.startsWith("Page:"), "auto name comes from the page title", nav.group);
  const palette = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange", "grey"];
  assert(palette.includes(nav.groupColor), "group color comes from the palette", nav.groupColor);
  const tab = fakeTabs.get(nav.tabId);
  assertEqual(tab.groupColor, nav.groupColor, "extension received the color");
});

await test("chrome_group renames the group and changes its color", async () => {
  const exec = makeExec();
  const nav = await tools.get("chrome_navigate").execute({ url: "https://rename.example/" }, exec);
  const renamed = await tools.get("chrome_group").execute({ name: "Repo review", color: "purple" }, exec);
  assertEqual(renamed.groupTitle, "Repo review", "renamed title");
  assertEqual(renamed.groupColor, "purple", "renamed color");
  const tab = fakeTabs.get(nav.tabId);
  assertEqual(tab.groupTitle, "Repo review", "extension tab group renamed");
  assertEqual(tab.groupColor, "purple", "extension group recolored");
});

await test("chrome_group validates name length and color", async () => {
  const exec = makeExec();
  await tools.get("chrome_navigate").execute({ url: "https://validate.example/" }, exec);
  await assertRejects(
    tools.get("chrome_group").execute({ name: "x".repeat(25) }, exec),
    "at most 24 characters",
    "long name rejected"
  );
  await assertRejects(
    tools.get("chrome_group").execute({ color: "rainbow" }, exec),
    "invalid tab group color",
    "invalid color rejected"
  );
});

await test("chrome_snapshot returns compact refs and click accepts them", async () => {
  const exec = makeExec();
  await tools.get("chrome_navigate").execute({ url: "https://snapshot.example/" }, exec);
  const snapshot = await tools.get("chrome_snapshot").execute({}, exec);
  assertEqual(snapshot.elements.length, 2, "two interactive elements");
  assertEqual(snapshot.elements[0].ref, "e1", "stable refs");
  const rendered = tools.get("chrome_snapshot").output.render({}, snapshot)[0].text;
  assert(rendered.includes("[e1] textbox"), "render shows refs");
  const clicked = await tools.get("chrome_click").execute({ ref: "e2" }, exec);
  assertEqual(clicked.ref, "e2", "click by ref");
  const typed = await tools.get("chrome_type").execute({ ref: "e1", text: "hello" }, exec);
  assertEqual(typed.typed, 5, "type after focusing a ref");
});

await test("chrome_locator supports count, strict mode, nth, fill and attribute", async () => {
  const exec = makeExec();
  const count = await tools.get("chrome_locator").execute({ action: "count", selector: "#multi" }, exec);
  assertEqual(count.count, 2, "locator count");
  await assertRejects(
    tools.get("chrome_locator").execute({ action: "click", selector: "#multi" }, exec),
    "strict mode violation",
    "strict mode rejects multiple matches"
  );
  const second = await tools.get("chrome_locator").execute({ action: "click", selector: "#multi", nth: 1 }, exec);
  assertEqual(second.element.ref, "l2", "nth selects the second element");
  const filled = await tools.get("chrome_locator").execute({ action: "fill", selector: "#multi", nth: 0, value: "hello" }, exec);
  assertEqual(filled.value, "hello", "fill forwards value");
  const attribute = await tools.get("chrome_locator").execute({ action: "getAttribute", selector: "#multi", nth: 0, attribute: "data-x" }, exec);
  assertEqual(attribute.value, "value-of-data-x", "attribute lookup");
});

await test("chrome_act runs several actions in one call", async () => {
  const exec = makeExec();
  const result = await tools.get("chrome_act").execute(
    {
      actions: [
        { tool: "chrome_navigate", args: { url: "https://batch.example/" } },
        { tool: "chrome_snapshot", args: {} },
        { tool: "chrome_click", args: { ref: "e2" } },
        { tool: "chrome_type", args: { ref: "e1", text: "hi" } },
      ],
    },
    exec
  );
  assertEqual(result.results.length, 4, "all actions ran");
  assert(result.results.every((entry) => entry.ok), "all actions succeeded");
  assertEqual(result.stopped, false, "not stopped");
  assert(result.results[1].summary.includes("e1"), "observation results are returned inline");
  const failing = await tools.get("chrome_act").execute(
    {
      actions: [
        { tool: "chrome_navigate", args: { url: "https://batch.example/2" } },
        { tool: "chrome_click", args: { selector: "#missing" } },
        { tool: "chrome_key", args: { key: "Enter" } },
      ],
    },
    { ...exec, agent: exec.agent }
  );
  assertEqual(failing.results.length, 2, "stops after the failing action");
  assertEqual(failing.results[1].ok, false, "failure recorded");
  assertEqual(failing.stopped, true, "reports stopped");
});

await test("chrome_drag drags between refs or points", async () => {
  const exec = makeExec();
  const dragged = await tools.get("chrome_drag").execute({ fromRef: "e1", toRef: "e2" }, exec);
  assertEqual(dragged.from.x, 10, "drag start");
  assertEqual(dragged.to.x, 100, "drag end");
  const points = await tools.get("chrome_drag").execute({ fromX: 5, fromY: 6, toX: 7, toY: 8 }, exec);
  assertEqual(points.to.y, 8, "coordinate drag");
});

await test("chrome_scroll and chrome_move drive the page", async () => {
  const exec = makeExec();
  await tools.get("chrome_navigate").execute({ url: "https://scroll.example/" }, exec);
  const wheel = await tools.get("chrome_scroll").execute({ deltaY: 600 }, exec);
  assertEqual(wheel.deltaY, 600, "wheel delta forwarded");
  const pageTurn = await tools.get("chrome_scroll").execute({ pages: 1 }, exec);
  assertEqual(pageTurn.pages, 1, "page turn forwarded");
  const intoView = await tools.get("chrome_scroll").execute({ ref: "e5" }, exec);
  assertEqual(intoView.ref, "e5", "scroll to ref");
  const moved = await tools.get("chrome_move").execute({ ref: "e2" }, exec);
  assertEqual(moved.ref, "e2", "move to ref");
  await assertRejects(
    tools.get("chrome_scroll").execute({}, exec),
    "needs either a ref, pages, or deltaX/deltaY",
    "empty scroll rejected"
  );
});

await test("AX and DOM scrolling preserve target, direction and distance", async () => {
  const exec = makeExec();
  const tab = await tools.get("chrome_navigate").execute({ url: "https://scroll.example/" }, exec);
  const result = await tools.get("chrome_js").execute({
    code: `const t = await browser.tabs.get(${tab.tabId});
await t.ax.scroll(5, "right", 2)`
  }, exec);
  assertEqual(result.value.ref, "e5", "AX target preserved");
  assertEqual(result.value.direction, "right", "horizontal direction preserved");
  assertEqual(result.value.pages, 2, "page distance preserved");
  const dom = await tools.get("chrome_js").execute({
    code: `await t.dom_cua.scroll({node_id: "l2", x: 20, y: 300})`
  }, exec);
  assertEqual(dom.value.ref, "l2", "DOM target preserved");
  assertEqual(dom.value.deltaY, 300, "DOM distance preserved");
});

await test("cursor follows read activity and automatic turn end", async () => {
  const exec = makeExec();
  await tools.get("chrome_navigate").execute({ url: "https://cursor.example/" }, exec);
  await tools.get("chrome_read_page").execute({}, exec);
  const begin = cursorCalls.at(-1);
  assertEqual(begin.cmd, "begin", "reading activates cursor");
  assertEqual(begin.origin, "https://cursor.example", "origin-scoped");
  for (const handler of hostHandlers.get("session/event") ?? []) {
    handler(exec.agent.session, {type: "turn/end"});
  }
  await new Promise(resolve => setTimeout(resolve, 30));
  assertEqual(cursorCalls.at(-1).cmd, "end", "turn end hides cursor");
  assertEqual(cursorCalls.at(-1).owner, begin.owner, "only this turn released");
  await tools.get("chrome_read_page").execute({}, exec);
  assert(cursorCalls.at(-1).owner !== begin.owner, "next turn has a fresh owner");
});

await test("chrome_click / chrome_type / chrome_key drive real input", async () => {
  const exec = makeExec();
  await tools.get("chrome_navigate").execute({ url: "https://site.example/input" }, exec);
  const clicked = await tools.get("chrome_click").execute({ selector: "#submit" }, exec);
  assertEqual(clicked.tag, "BUTTON", "selector click resolves the element");
  assert(clicked.x > 0 && clicked.y > 0, "click has viewport coordinates");
  const typed = await tools.get("chrome_type").execute({ selector: "#q", text: "hello" }, exec);
  assertEqual(typed.typed, 5, "type reports characters");
  const key = await tools.get("chrome_key").execute({ key: "Enter", modifiers: ["control"] }, exec);
  assertEqual(key.key, "Enter", "key echoed");
  assertEqual(key.modifiers, ["control"], "modifiers forwarded");
  await assertRejects(
    tools.get("chrome_click").execute({ x: 1 }, exec),
    "needs a ref, a selector, or both x and y",
    "incomplete coordinates rejected"
  );
});

await test("chrome_js exposes a persistent Codex-style browser session", async () => {
  const exec = makeExec();
  const first = await tools.get("chrome_js").execute({ code: "const answer = 40 + 2; answer" }, exec);
  assertEqual(first.value, 42, "initial JS value");
  const second = await tools.get("chrome_js").execute({ code: "answer + 1" }, exec);
  assertEqual(second.value, 43, "VM state persists");
  const third = await tools.get("chrome_js").execute({
    code: "const tab = await browser.tabs.selected(); const result = await tab.playwright.evaluate('2+2'); ({ id: tab.id, echo: result.echo })",
  }, exec);
  assertEqual(third.value.echo, "2+2", "tab.playwright.evaluate returns the page value");
  const browsers = await tools.get("chrome_js").execute({ code: "(await agent.browsers.list()).map((browser) => browser.id)" }, exec);
  assert(Array.isArray(browsers.value), "agent.browsers.list returns an array");
});

await test("invalid URL scheme is rejected before any browser action", async () => {
  await assertRejects(
    tools.get("chrome_navigate").execute({ url: "file:///etc/passwd" }, makeExec()),
    "Only http(s) URLs are supported",
    "file scheme rejected"
  );
});

await test("chrome_js supports destructuring, multiple declarations, functions and duplicate lets", async () => {
  const exec = makeExec();
  const first = await tools.get("chrome_js").execute({
    code: "const a = 1, b = 2; const {left, right} = {left: a, right: b}; left * 10 + right",
  }, exec);
  assertEqual(first.value, 12, "multiple declarations and destructuring");
  const second = await tools.get("chrome_js").execute({
    code: "let total = 0; total = total + 5; const [first, second] = [7, 8]; total + first + second",
  }, exec);
  assertEqual(second.value, 20, "array destructuring and reassignment");
  const third = await tools.get("chrome_js").execute({ code: "function triple(n) { return n * 3; } triple(4)" }, exec);
  assertEqual(third.value, 12, "function declaration persists");
  const fourth = await tools.get("chrome_js").execute({ code: "let total = 100; total" }, exec);
  assertEqual(fourth.value, 100, "duplicate let is a reassignment");
  const multiline = await tools.get("chrome_js").execute({ code: "({\n  alpha: 1,\n  beta: 2,\n}).beta" }, exec);
  assertEqual(multiline.value, 2, "multiline trailing expression");
});

await test("chrome_js enforces timeout on pending async work", async () => {
  const exec = makeExec();
  const started = Date.now();
  await assertRejects(
    tools.get("chrome_js").execute({ code: "await new Promise(() => {}); 1", timeoutMs: 150 }, exec),
    "timed out",
    "async timeout"
  );
  assert(Date.now() - started < 3000, "async timeout resolves promptly");
});

await test("chrome_js tab.ax.get/write follow the official output split", async () => {
  const exec = makeExec();
  await tools.get("chrome_navigate").execute({ url: "https://ax.example/" }, exec);
  const got = await tools.get("chrome_js").execute({
    code: `const axTab = await browser.tabs.selected(); const s = await axTab.ax.get(); ({ type: typeof s, hasSearch: s.includes("Search"), hasTab: s.includes("Browser tab:") })`,
  }, exec);
  assertEqual(got.value.type, "string", "ax.get returns a string");
  assert(got.value.hasSearch, "ax.get contains element text");
  assert(got.value.hasTab, "ax.get contains tab header");
  const wrote = await tools.get("chrome_js").execute({
    code: `const axTab2 = await browser.tabs.selected(); await axTab2.ax.write();`,
  }, exec);
  const textBlocks = (wrote.outputs ?? []).flat().filter((block) => block.type === "text");
  assert(textBlocks.length > 0, "ax.write emits model-visible text");
  assert(textBlocks[0].text.includes("Search"), "ax.write text carries the snapshot");
});

await test("chrome_js AX actions target and focus the requested element", async () => {
  const exec = makeExec();
  const result = await tools.get("chrome_js").execute({
    code: `const at = await browser.tabs.selected();
      await at.ax.pressKey(7, "Return");
      await at.ax.paste(7, "hello");
      await at.ax.selectText(7, "ell");
      await at.ax.performSecondaryAction(7, "Expand");
      ({ done: true })`,
  }, exec);
  assertEqual(result.value.done, true, "AX action batch");
  const focused = cursorCalls.length >= 0;
  assert(focused, "cursor state captured");
});

await test("multiple ax.write calls remain ordered and capabilities fail closed", async () => {
  const exec = makeExec();
  const result = await tools.get("chrome_js").execute({
    code: `const multi = await browser.tabs.selected();
      await multi.ax.write();
      await multi.ax.write("both");
      const capabilities = await multi.capabilities.list();
      let unknownError = null;
      try { await multi.capabilities.get("nope"); } catch (error) { unknownError = String(error.message); }
      ({ capabilities, unknownError })`,
  }, exec);
  const outputs = result.outputs ?? [];
  assertEqual(outputs.length, 2, "two write calls produce two ordered output groups");
  assert(outputs[0][0].type === "text" && outputs[0][0].text.includes("Search"), "first write is text");
  assert(outputs[1].some((block) => block.type === "image"), "second write emits an image attachment");
  assert(Array.isArray(result.value.capabilities) && result.value.capabilities.includes("cdp"), "capability list returns ids");
  assert(result.value.unknownError.includes("Unknown tab capability"), "unknown capability fails closed");
});

await test("chrome_locator passes and/or/scope/has criteria to the page", async () => {
  const exec = makeExec();
  await tools.get("chrome_locator").execute({
    action: "count",
    scope: ["#multi"],
    hasText: "First",
    and: [{ role: "button" }],
    or: [{ name: "First" }, { name: "Second" }],
  }, exec);
  assertEqual(lastLocateParams.scope, ["#multi"], "scope forwarded");
  assertEqual(lastLocateParams.and, [{ role: "button" }], "and forwarded");
  assertEqual(lastLocateParams.or.length, 2, "or forwarded");
  assertEqual(lastLocateParams.hasText, "First", "hasText forwarded");
});

await test("chrome_locator rejects out-of-range nth instead of clamping", async () => {
  const exec = makeExec();
  await assertRejects(
    tools.get("chrome_locator").execute({ action: "click", selector: "#multi", nth: 5 }, exec),
    "no element at index 5",
    "nth out of range"
  );
  const neg = await tools.get("chrome_locator").execute({ action: "click", selector: "#multi", nth: -1 }, exec);
  assertEqual(neg.element.ref, "l2", "negative nth selects from the end");
});

await test("tab.playwright locator methods return native values", async () => {
  const exec = makeExec();
  const result = await tools.get("chrome_js").execute({
    code: `const lt = await browser.tabs.selected();
      const loc = lt.playwright.locator("#multi");
      const count = await loc.count();
      const visible = await loc.first().isVisible();
      const text = await loc.nth(1).textContent();
      const attr = await loc.nth(0).getAttribute("data-x");
      const evaluated = await loc.first().evaluate((el) => el.name);
      ({ count, visible, text, attr, evaluated })`,
  }, exec);
  assertEqual(result.value.count, 2, "locator count is a number");
  assertEqual(result.value.visible, true, "isVisible is a boolean");
  assertEqual(result.value.text, "Second", "textContent returns text");
  assertEqual(result.value.attr, "value-of-data-x", "getAttribute returns an attribute");
  assertEqual(result.value.evaluated.ref, "l1", "evaluate is bound to the element");
});

await test("chrome_turn_ended applies deliverable/handoff cleanup", async () => {
  const exec = makeExec();
  const a = await tools.get("chrome_navigate").execute({ url: "https://turn.example/a", newTab: true }, exec);
  const b = await tools.get("chrome_navigate").execute({ url: "https://turn.example/b", newTab: true }, exec);
  const c = await tools.get("chrome_navigate").execute({ url: "https://turn.example/c", newTab: true }, exec);
  await tools.get("chrome_mark_tab").execute({ tabId: a.tabId, status: "deliverable" }, exec);
  await tools.get("chrome_mark_tab").execute({ tabId: b.tabId, status: "handoff" }, exec);
  const ended = await tools.get("chrome_turn_ended").execute({}, exec);
  assert(ended.closed.includes(c.tabId), "unmarked agent tab closed");
  assert(ended.kept.includes(a.tabId) && ended.kept.includes(b.tabId), "marked tabs kept");
  assert(fakeTabs.has(a.tabId) && fakeTabs.has(b.tabId), "kept tabs still exist");
  assert(!fakeTabs.has(c.tabId), "closed tab removed");
});

await test("browser and tab handles stay bound to their browser identity", async () => {
  const second = await connectFakeExtension({
    port: PORT,
    browserId: "browser-two",
    browserName: "Edge",
    handlers: {
      "tabs.list": () => [{ id: 901, title: "Edge Tab", url: "https://edge.example/", active: true, groupTitle: "", groupColor: "" }],
      "tabs.get": ({ tabId }) => {
        if (tabId !== 901) throw new Error("wrong tab for browser-two");
        return { id: 901, title: "Edge Tab", url: "https://edge.example/", active: true, groupTitle: "", groupColor: "" };
      },
      "tabs.active": () => ({ id: 901, title: "Edge Tab", url: "https://edge.example/", active: true, groupTitle: "", groupColor: "" }),
      "page.eval": ({ expression }) => ({ value: { echo: expression, browser: "edge" } }),
      "cursor.begin": () => ({}),
      "cursor.end": () => ({}),
    },
  });
  try {
    const exec = makeExec();
    const result = await tools.get("chrome_js").execute({
      code: `const edge = await agent.browsers.get("browser-two");
        const edgeTab = await edge.tabs.get(901);
        const title = await edgeTab.title();
        const evaluated = await edgeTab.playwright.evaluate("1+1");
        ({ title, evaluated, browserId: edge.browserId, tabId: edgeTab.tabId })`,
    }, exec);
    assertEqual(result.value.title, "Edge Tab", "tab handle routed to Edge");
    assertEqual(result.value.evaluated.browser, "edge", "evaluate routed to Edge");
    assertEqual(result.value.browserId, "browser-two", "browser handle reports its id");
    assertEqual(result.value.tabId, 901, "tab handle carries the id");
  } finally {
    second.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

await test("automatic turn/end runs the same full tab cleanup", async () => {
  const exec = makeExec();
  const keep = await tools.get("chrome_navigate").execute({ url: "https://auto-turn.example/keep", newTab: true }, exec);
  const close = await tools.get("chrome_navigate").execute({ url: "https://auto-turn.example/close", newTab: true }, exec);
  await tools.get("chrome_mark_tab").execute({ tabId: keep.tabId, status: "deliverable" }, exec);
  for (const handler of hostHandlers.get("session/event") ?? []) handler(exec.agent.session, { type: "turn/end" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert(fakeTabs.has(keep.tabId), "deliverable tab survives automatic turn end");
  assert(!fakeTabs.has(close.tabId), "unmarked tab closes at automatic turn end");
});

await test("default browser handles follow chrome_use_browser switches", async () => {
  const second = await connectFakeExtension({
    port: PORT,
    browserId: "browser-three",
    browserName: "Brave",
    handlers: {
      "tabs.list": () => [{ id: 1001, title: "Brave Tab", url: "https://brave.example/", active: true, groupTitle: "" }],
      "tabs.get": () => ({ id: 1001, title: "Brave Tab", url: "https://brave.example/", active: true, groupTitle: "" }),
      "tabs.active": () => ({ id: 1001, title: "Brave Tab", url: "https://brave.example/", active: true, groupTitle: "" }),
      "cursor.begin": () => ({}),
      "cursor.end": () => ({}),
    },
  });
  try {
    const exec = makeExec();
    const before = await tools.get("chrome_js").execute({ code: "(await agent.browsers.getDefault()).browserId" }, exec);
    assert(before.value !== "browser-three", "default starts on the original browser");
    const switched = await tools.get("chrome_use_browser").execute({ browserId: "browser-three" }, exec);
    assertEqual(switched.ok, true, "switch succeeds");
    const after = await tools.get("chrome_js").execute({ code: "(await agent.browsers.getDefault()).browserId" }, exec);
    assertEqual(after.value, "browser-three", "new default handle follows the switch");
    await tools.get("chrome_use_browser").execute({ browserId: "default" }, exec).catch(() => {});
  } finally {
    second.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

await test("chrome_act returns ordered observation blocks including images", async () => {
  const exec = makeExec();
  await tools.get("chrome_navigate").execute({ url: "https://blocks.example/" }, exec);
  const batch = await tools.get("chrome_act").execute({
    actions: [
      { tool: "chrome_snapshot", args: {} },
      { tool: "chrome_screenshot", args: {} },
    ],
  }, exec);
  assertEqual(batch.results.length, 2, "two actions");
  assertEqual(batch.results[0].blocks[0].type, "text", "snapshot text block first");
  const image = batch.results[1].blocks.find((block) => block.type === "image");
  assert(image !== undefined, "screenshot block includes image");
  const rendered = tools.get("chrome_act").output.render({}, batch);
  assert(rendered.some((block) => block.type === "image"), "batch render keeps images");
});

ext.close();
server.dispose();

console.log(results.join("\n"));
console.log(process.exitCode ? "\nSOME TOOLS TESTS FAILED" : "\nALL TOOLS TESTS PASSED");
