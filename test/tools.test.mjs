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
    results.push(`FAIL ${name}: ${error.message}`);
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
function fakeOpen(url, groupTitle, active = true) {
  const id = nextTabId++;
  const tab = { id, windowId: 1, index: fakeTabs.size, active, url, title: `Page: ${url}`, groupId: 55, groupTitle };
  fakeTabs.set(id, tab);
  return tab;
}

const ext = await connectFakeExtension({
  port: PORT,
  handlers: {
    "ext.ping": () => ({ version: "test" }),
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
    "tabs.open": ({ url, active, groupTitle }) => fakeOpen(url, groupTitle ?? "", active !== false),
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
    "input.clickSelector": ({ selector }) => ({ x: 12, y: 34, tag: "BUTTON", text: selector }),
    "input.type": ({ text }) => ({ typed: text.length }),
    "input.key": ({ key, modifiers }) => ({ key, modifiers: modifiers ?? [] }),
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
    command: (cmd, params, signal) => server.command(cmd, params, signal),
  },
  fiber: { entry: { options: { id: "chrome-bridge-tools" } } },
  emit: (name) => {
    emittedEvents.push(name);
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

await test("apply registers exactly the ten chrome_* tools", async () => {
  assertEqual(
    [...tools.keys()].sort(),
    [
      "chrome_click",
      "chrome_close_tab",
      "chrome_eval",
      "chrome_key",
      "chrome_navigate",
      "chrome_read_page",
      "chrome_screenshot",
      "chrome_status",
      "chrome_tabs",
      "chrome_type",
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

await test("chrome_navigate opens tabs in a per-session DSH group", async () => {
  const exec = makeExec();
  const first = await tools.get("chrome_navigate").execute({ url: "https://site.example/one" }, exec);
  assert(/^DSH · [0-9a-f]{6}$/.test(first.group), "session group title format", first.group);
  const tab = fakeTabs.get(first.tabId);
  assertEqual(tab.groupTitle, first.group, "extension received the group title");
  const other = await tools.get("chrome_navigate").execute({ url: "https://site.example/two" }, makeExec());
  assert(other.group !== first.group, "a second session gets its own group");
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

await test("chrome_tabs lists only agent DSH groups by default", async () => {
  const grouped = await tools.get("chrome_tabs").execute({}, makeExec());
  assert(grouped.tabs.every((tab) => tab.groupTitle === "DSH" || /^DSH · /.test(tab.groupTitle)), "only DSH groups");
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
    "needs either a selector or both x and y",
    "incomplete coordinates rejected"
  );
});

await test("invalid URL scheme is rejected before any browser action", async () => {
  await assertRejects(
    tools.get("chrome_navigate").execute({ url: "file:///etc/passwd" }, makeExec()),
    "Only http(s) URLs are supported",
    "file scheme rejected"
  );
});

ext.close();
server.dispose();

console.log(results.join("\n"));
console.log(process.exitCode ? "\nSOME TOOLS TESTS FAILED" : "\nALL TOOLS TESTS PASSED");
