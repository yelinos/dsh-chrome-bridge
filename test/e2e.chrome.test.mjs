/**
 * End-to-end test: real Chrome for Testing loads the real extension, whose
 * service worker connects to a real bridge server; commands drive real tabs,
 * pages, and screenshots. Serves a local page to stay deterministic.
 */
import { apply } from "../index.js";
import { createBridgeServer } from "./../bridge.js";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const results = [];
function report(ok, name, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CHROME = join(process.cwd(), ".tools", "chrome-linux64", "chrome");
const SHIPPED_EXTENSION = join(process.cwd(), "extension");
const SHIPPED_VERSION = JSON.parse(await readFile(join(SHIPPED_EXTENSION, "manifest.json"), "utf8")).version;
/** Isolated copy of the extension bound to the test port (the live profile may own 8765). */
const EXTENSION = join(process.cwd(), "test", ".tmp-extension");
const TEST_PORT = 18795;
const profileDir = join(process.cwd(), "test", ".tmp-chrome-profile");
await rm(profileDir, { recursive: true, force: true });
await mkdir(profileDir, { recursive: true });
await rm(EXTENSION, { recursive: true, force: true });
await cp(SHIPPED_EXTENSION, EXTENSION, { recursive: true });
{
  const swPath = join(EXTENSION, "sw.js");
  const source = await readFile(swPath, "utf8");
  await writeFile(swPath, source.replace("const DEFAULT_PORT = 8765;", `const DEFAULT_PORT = ${TEST_PORT};`));
}

// Local content server.
const PAGE_HTML = `<!doctype html><html><head><title>E2E Local Page</title></head>
<body><h1>Hello from local e2e</h1>
<button id="b" onclick="document.body.dataset.clicked='yes'">click me</button>
<input id="q" onkeydown="if(event.key==='Enter')document.body.dataset.entered='yes'" />
<textarea id="editor">hello world</textarea>
<input id="check" type="checkbox" aria-label="Accept terms" />
<div id="scope"><button id="save" data-testid="save">Save</button><button id="cancel">Cancel</button></div>
<button id="expander" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true')">Details</button>
<input id="file" type="file" />
<script>document.body.dataset.loaded='1'</script>
<iframe id="xframe" src="http://127.0.0.1:18801/?frame=1" style="width:300px;height:120px"></iframe>
<div style="height:2400px"></div></body></html>`;
const httpServer = createServer((req, res) => {
  if (req.url.includes("frame=1")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end('<!doctype html><html><body><button id="frame-button" onclick="parent.postMessage(\'frame-clicked\', \'*\')">frame button</button></body></html>');
    return;
  }
  if (req.url.includes("csp")) {
    res.writeHead(200, {
      "content-type": "text/html",
      "content-security-policy": "default-src 'self'; style-src 'self'; img-src 'self'; script-src 'self'"
    });
    res.end("<!doctype html><title>CSP Cursor</title><h1>CSP page</h1>");
    return;
  }
  const isSecond = req.url.includes('second');
  const html = isSecond ? PAGE_HTML.replace('E2E Local Page', 'E2E Second Page') : PAGE_HTML;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((resolve) => httpServer.listen(18800, "127.0.0.1", resolve));
const frameServer = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end('<!doctype html><html><body><button id="frame-button" onclick="parent.postMessage(\'frame-clicked\', \'*\')">frame button</button></body></html>');
});
await new Promise((resolve) => frameServer.listen(18801, "127.0.0.1", resolve));

// The bridge must use the extension's default port (8765) unless storage was
// pre-seeded, which headless makes impractical.
const server = createBridgeServer({ port: TEST_PORT, commandTimeoutMs: 30000 });
await server.listen();
const toolMap = new Map();
const hostHandlers = new Map();
apply({
  chromeBridge: server,
  tools: {register: (tool) => toolMap.set(tool.name, tool)},
  userQuestions: {ask: async () => { throw new Error("unexpected approval"); }},
  workingDirectory: {ensure: async () => process.cwd()},
  effect: (fn) => fn(),
  on: (event, handler) => hostHandlers.set(event, handler),
}, {
  allowedDomains: ["127.0.0.1"], blockedDomains: [], askForNewDomains: false,
  maxSnapshotChars: 24000, tabGroupTitle: "DSH", maxSessionTabs: 20,
  autoCloseIdleMs: 0, autoCloseOnSessionEnd: false,
});
const exec = {agent: {session: {id: "e2e-cursor-turn"}}, signal: new AbortController().signal};
const invoke = (name, args) => toolMap.get(name).execute(args, exec);

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${EXTENSION}`,
    `--load-extension=${EXTENSION}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--no-sandbox", // container-style test environment only
    "--remote-debugging-port=0",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);
let chromeLog = "";
chrome.stderr.on("data", (data) => {
  chromeLog += data.toString();
});

try {
  // 1. Wait for the extension service worker to connect and say hello.
  let connected = false;
  for (let i = 0; i < 90 && !connected; i++) {
    await sleep(500);
    connected = server.status().connected;
  }
  report(connected, "extension service worker connects to the bridge");
  if (!connected) throw new Error("extension never connected; chrome log tail:\n" + chromeLog.slice(-2000));
  const extension = server.status().extension;
  report(extension?.name === "DSH Chrome Bridge", "hello identifies the extension", JSON.stringify(extension));

  // 2. Command round-trip.
  const ping = await server.command("ext.ping");
  report(ping.version === SHIPPED_VERSION, "ext.ping reports the manifest version", JSON.stringify(ping));

  // 3. Open a tab in the DSH group and load the local page.
  const opened = await server.command("tabs.open", {
    url: "http://127.0.0.1:18800/",
    active: true,
    groupTitle: "DSH",
    groupColor: "purple",
  });
  await invoke("chrome_read_page", {tabId: opened.id});
  const readCursor = await server.command("page.eval", {
    tabId: opened.id, expression: "!!document.getElementById('__dsh_cursor__')",
  });
  report(readCursor.value, "reading activates the cursor before any pointer action");
  report(opened.url === "http://127.0.0.1:18800/", "tabs.open navigates", JSON.stringify(opened));
  report(opened.title === "E2E Local Page", "page loaded with the expected title", opened.title);

  report(opened.groupColor === "purple", "new group uses the requested color", String(opened.groupColor));

  // 3b. Rename and recolor the group through the extension.
  const renamed = await server.command("tabs.setGroup", { tabId: opened.id, title: "E2E Group", color: "orange" });
  report(
    renamed.title === "E2E Group" && renamed.color === "orange",
    "tabs.setGroup renames and recolors the group",
    JSON.stringify(renamed)
  );

  // 3c. Two sessions never merge: a second tab without groupId gets its own group.
  const second = await server.command("tabs.open", {
    url: "http://127.0.0.1:18800/?second=1",
    active: false,
    groupTitle: "Second Group",
    groupColor: "cyan",
  });
  report(
    second.groupId !== opened.groupId,
    "tabs.open without groupId creates a separate group",
    `${opened.groupId} vs ${second.groupId}`
  );
  const joined = await server.command("tabs.open", {
    url: "http://127.0.0.1:18800/?joined=1",
    active: false,
    groupTitle: "Second Group",
    groupColor: "cyan",
    groupId: second.groupId,
  });
  report(joined.groupId === second.groupId, "tabs.open joins the group id it is given", String(joined.groupId));
  await server.command("tabs.close", { tabId: joined.id, groupTitle: "Second Group" });
  await server.command("tabs.close", { tabId: second.id, groupTitle: "Second Group" });

  // 4. Read the page through CDP.
  const page = await server.command("page.read", { tabId: opened.id });
  report(page.url === "http://127.0.0.1:18800/", "page.read url", page.url);
  report(page.text.includes("Hello from local e2e"), "page.read sees the body text");

  const batch = await server.command("tabs.content", {
    urls: ["http://127.0.0.1:18800/?batch=1"],
    format: "text",
  });
  report(batch.results?.[0]?.content?.includes("Hello from local e2e") === true, "tabs.content reads a temporary tab", JSON.stringify(batch.results?.map((item) => item.title)));

  // 4a2. Native file upload through DOM.setFileInputFiles.
  const uploadPath = join(process.cwd(), "test", ".tmp-upload.txt");
  await writeFile(uploadPath, "hello upload");
  try {
    const uploaded = await server.command("input.upload", { tabId: opened.id, selector: "#file", files: [uploadPath] });
    const uploadedName = await server.command("page.eval", {
      tabId: opened.id,
      expression: "document.getElementById('file').files[0] && document.getElementById('file').files[0].name",
    });
    report(uploaded.count === 1 && uploadedName.value === ".tmp-upload.txt", "input.upload sets a file input", JSON.stringify({ uploaded, uploadedName }));
  } finally {
    await rm(uploadPath, { force: true }).catch(() => {});
  }

  // 4b. Compact accessibility snapshot with refs, then click by ref.
  const snapshot = await server.command("page.snapshot", { tabId: opened.id, maxElements: 120 });
  const button = snapshot.elements.find((element) => element.role === "button" && /click/i.test(element.name));
  report(button !== undefined, "page.snapshot lists the button", JSON.stringify(snapshot.elements.slice(0, 6)));
  const byRef = await server.command("input.clickRef", { tabId: opened.id, ref: button.ref });
  report(byRef.ref === button.ref, "input.clickRef resolves the ref", JSON.stringify(byRef));
  const clickedByRef = await server.command("page.eval", {
    tabId: opened.id,
    expression: "document.body.dataset.clicked",
  });
  report(clickedByRef.value === "yes", "ref click triggers the button handler", JSON.stringify(clickedByRef));

  // 4b1. AX text state, diffing and semantic actions.
  const axState = await server.command("page.snapshot", { tabId: opened.id, maxElements: 200, disableDiffing: true });
  report(typeof axState.text === "string" && axState.text.startsWith("Browser tab:"), "AX state is text with tab identity", axState.text?.split("\n")[0]);
  report(axState.text.includes("hello world") && axState.text.includes("Save"), "AX text includes textarea value and button names", axState.text?.slice(0, 300));
  const axRepeat = await server.command("page.snapshot", { tabId: opened.id, maxElements: 200 });
  report(axRepeat.changed === false && axRepeat.text.includes("no accessibility changes"), "AX repeat reports no change", JSON.stringify({changed: axRepeat.changed, text: axRepeat.text?.slice(0, 80)}));
  const editorElement = axState.elements.find((element) => element.role === "textbox" && element.value === "hello world");
  const expanderElement = axState.elements.find((element) => element.role === "button" && element.name === "Details");
  report(editorElement !== undefined && expanderElement !== undefined, "AX state exposes textarea and expander", JSON.stringify({editor: editorElement?.ref, expander: expanderElement?.ref}));
  if (editorElement !== undefined) {
    const editorIndex = Number(editorElement.ref.slice(1));
    await invoke("chrome_js", {code: `const axTab = await browser.tabs.get(${opened.id});
      await axTab.ax.pressKey(${editorIndex}, "End");
      await axTab.ax.paste(${editorIndex}, "XYZ");
      await axTab.ax.selectText(${editorIndex}, "world");`});
    const editorState = await server.command("page.eval", {
      tabId: opened.id,
      expression: "({value: document.getElementById('editor').value, start: document.getElementById('editor').selectionStart, end: document.getElementById('editor').selectionEnd, focused: document.activeElement === document.getElementById('editor')})",
    });
    report(editorState.value.value === "hello worldXYZ" && editorState.value.focused,
      "ax.pressKey/paste focus and insert at the target", JSON.stringify(editorState.value));
    report(editorState.value.start === 6 && editorState.value.end === 11,
      "ax.selectText selects the requested range", JSON.stringify(editorState.value));
    const written = await invoke("chrome_js", {code: `const axWriteTab = await browser.tabs.get(${opened.id}); await axWriteTab.ax.write();`});
    report((written.outputs ?? []).flat().some((block) => block.type === "text" && block.text.includes("Browser tab:")),
      "ax.write emits model-visible state text");
  }
  if (expanderElement !== undefined) {
    const expanded = await invoke("chrome_js", {code: `const expandTab = await browser.tabs.get(${opened.id}); await expandTab.ax.performSecondaryAction(${Number(expanderElement.ref.slice(1))}, "Expand");`});
    const aria = await server.command("page.eval", {tabId: opened.id, expression: "document.getElementById('expander').getAttribute('aria-expanded')"});
    report(aria.value === "true", "ax.performSecondaryAction invokes Expand", JSON.stringify({aria: aria.value, expanded}));
  }
  await server.command("page.eval", {tabId: opened.id, expression: "document.getElementById('editor').value='hello world'; document.getElementById('editor').blur(); true"});

  // 4b2. Locator-style search returns l-refs usable by click.
  const located = await server.command("page.locate", { tabId: opened.id, role: "button", name: "click" });
  report(located.elements.length > 0, "page.locate finds a button", JSON.stringify(located.elements.slice(0, 3)));
  if (located.elements[0] !== undefined) {
    const locatedClick = await server.command("input.clickRef", { tabId: opened.id, ref: located.elements[0].ref });
    report(locatedClick.ref === located.elements[0].ref, "locator ref is clickable", JSON.stringify(locatedClick));
  }

  // 4b2b. Locator chaining, and/or, descriptors and native return values.
  const scoped = await invoke("chrome_locator", { action: "count", scope: ["#scope"], hasText: "Save" });
  report(scoped.count === 1, "locator scope + hasText finds the scoped button", JSON.stringify(scoped));
  const combined = await invoke("chrome_locator", {
    action: "count",
    selector: "#scope button",
    and: [{ role: "button" }],
    or: [{ name: "Save" }, { name: "Cancel" }],
  });
  report(combined.count === 2, "locator and/or combines criteria", JSON.stringify(combined));
  let nthError = null;
  try {
    await invoke("chrome_locator", { action: "click", selector: "#scope button", nth: 9 });
  } catch (error) {
    nthError = String(error.message ?? error);
  }
  report(nthError !== null && nthError.includes("no element at index 9"), "locator nth does not clamp", nthError);
  const locatorValues = await invoke("chrome_js", {
    code: `const locTab = await browser.tabs.get(${opened.id});
      const scopeLoc = locTab.playwright.locator("#scope").locator("button").filter({hasText: "Save"});
      const count = await scopeLoc.count();
      const text = await scopeLoc.first().textContent();
      const id = await scopeLoc.first().evaluate((el) => el.id);
      const visible = await scopeLoc.first().isVisible();
      ({ count, text, id, visible })`,
  });
  report(locatorValues.value.count === 1 && locatorValues.value.text === "Save" && locatorValues.value.id === "save" && locatorValues.value.visible === true,
    "Playwright locator chain returns native values", JSON.stringify(locatorValues.value));
  const select = await invoke("chrome_js", {
    code: `const selectTab = await browser.tabs.get(${opened.id});
      await selectTab.playwright.evaluate(() => { const s = document.createElement('select'); s.id='picked'; s.multiple=true; s.innerHTML='<option value=a>A</option><option value=b>B</option><option value=c>C</option>'; document.body.append(s); });
      const sel = selectTab.playwright.locator("#picked");
      await sel.selectOption([{value:'a'}, {label:'C'}]);
      await sel.evaluate((el) => [...el.selectedOptions].map((o) => o.value))`,
  });
  report(JSON.stringify(select.value) === JSON.stringify(["a", "c"]), "selectOption supports descriptors and multi-select", JSON.stringify(select.value));

  // 4b3. Cross-origin iframe lookup through CDP isolated worlds.
  await new Promise((resolve) => setTimeout(resolve, 500));
  let frameTreeReport = null;
  try { frameTreeReport = await server.command("cdp.send", { tabId: opened.id, method: "Page.getFrameTree", params: {} }); } catch (error) { frameTreeReport = { error: String(error.message ?? error) }; }
  report(frameTreeReport?.value?.frameTree !== undefined, "Page.getFrameTree exposes child frames", JSON.stringify(frameTreeReport).slice(0, 500));
  const crossFrame = await server.command("page.locate", { tabId: opened.id, selector: "#frame-button" });
  const crossElement = (crossFrame.elements ?? []).find((element) => element.crossFrame === true);
  report(crossElement !== undefined, "page.locate finds a cross-origin iframe element", JSON.stringify(crossFrame.elements?.slice(0, 2)));
  if (crossElement !== undefined) {
    const crossClick = await server.command("input.clickRef", { tabId: opened.id, ref: crossElement.ref });
    report(crossClick.ref === crossElement.ref, "cross-frame ref is clickable", JSON.stringify(crossClick));
  }

  // 4c. Virtual cursor appears after pointer actions.
  const cursor = await server.command("page.eval", {
    tabId: opened.id,
    expression: "!!document.getElementById('__dsh_cursor__')",
  });
  report(cursor.value === true, "virtual cursor is injected into the page", JSON.stringify(cursor));

  // 4c2. Cursor motion uses springs/curves and lands within one CSS pixel.
  async function readCursorLayer() {
    const dom = await server.command("cdp.send", { tabId: opened.id, method: "DOM.getDocument", params: { depth: -1, pierce: true } });
    const walk = (node, predicate) => {
      if (predicate(node)) return node;
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
        const match = walk(child, predicate);
        if (match !== undefined) return match;
      }
      return undefined;
    };
    const layerNode = walk(dom.value.root, (node) => {
      const attrs = node.attributes ?? [];
      const index = attrs.indexOf("class");
      return index >= 0 && attrs[index + 1] === "layer";
    });
    if (layerNode === undefined) return null;
    const resolved = await server.command("cdp.send", { tabId: opened.id, method: "DOM.resolveNode", params: { backendNodeId: layerNode.backendNodeId } });
    const objectId = resolved.value.object.objectId;
    const state = await server.command("cdp.send", { tabId: opened.id, method: "Runtime.callFunctionOn", params: {
      objectId,
      functionDeclaration: "function(){const m=new DOMMatrixReadOnly(getComputedStyle(this).transform);return {x:m.m41,y:m.m42,opacity:getComputedStyle(this).opacity};}",
      returnByValue: true,
    }});
    await server.command("cdp.send", { tabId: opened.id, method: "Runtime.releaseObject", params: { objectId } });
    return state.value.result.value;
  }
  await invoke("chrome_move", { tabId: opened.id, x: 180, y: 160 });
  await sleep(40);
  const earlyCursor = await readCursorLayer();
  await sleep(1300);
  const lateCursor = await readCursorLayer();
  if (earlyCursor !== null && lateCursor !== null) {
    const moved = Math.hypot(earlyCursor.x - lateCursor.x, earlyCursor.y - lateCursor.y);
    const landing = Math.hypot(lateCursor.x - (180 - 12), lateCursor.y - (160 - 12));
    report(moved > 1, "cursor animates along a path rather than jumping", JSON.stringify({ earlyCursor, lateCursor }));
    report(landing <= 1, "cursor lands within 1 CSS px of its anchor", JSON.stringify({ lateCursor, landing }));
  } else {
    report(false, "cursor layer is inspectable", "layer not found");
  }

  // 4d. Wheel scrolling actually scrolls, and `pages` moves one viewport.
  await server.command("page.eval", {
    tabId: opened.id,
    expression: "window.__scrollEvents = []; window.addEventListener('scroll', () => window.__scrollEvents.push({t: performance.now(), y: scrollY}), {passive: true}); true",
  });
  await server.command("page.scroll", { tabId: opened.id, deltaY: 700 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const scrolled = await server.command("page.eval", {
    tabId: opened.id,
    expression: "window.scrollY",
  });
  report(scrolled.value > 0, "page.scroll moves the page", String(scrolled.value));
  const scrollEvents = await server.command("page.eval", {
    tabId: opened.id,
    expression: "window.__scrollEvents.length",
  });
  report(scrollEvents.value > 1, "page.scroll produces multiple scroll events", String(scrollEvents.value));
  await server.command("page.eval", { tabId: opened.id, expression: "window.scrollTo(0, 0)" });
  await server.command("page.scroll", { tabId: opened.id, pages: 1 });
  await new Promise((resolve) => setTimeout(resolve, 600));
  const pageTurned = await server.command("page.eval", {
    tabId: opened.id,
    expression: "window.scrollY",
  });
  report(pageTurned.value > 300, "page.scroll pages moves one viewport", String(pageTurned.value));

  // A tall nested pane must scroll through the real model-facing AX API.
  await server.command("page.eval", {tabId: opened.id, expression: `
    window.scrollTo(0, 0);
    var pane = document.createElement("div");
    pane.id = "pane"; pane.setAttribute("role", "region"); pane.setAttribute("aria-label", "Results");
    pane.style.cssText = "position:fixed;left:30px;top:20px;width:280px;height:220px;overflow:auto;background:white;z-index:100";
    pane.innerHTML = '<div style="height:1800px;width:1900px">Scrollable results</div>';
    document.body.append(pane);
    true
  `});
  const paneSnapshot = await invoke("chrome_snapshot", {tabId: opened.id});
  const paneRef = paneSnapshot.elements.find(element => element.role === "region" && element.name === "Results");
  report(!!paneRef, "AX exposes the named scrollable region");
  await invoke("chrome_js", {code: `const axTab = await browser.tabs.get(${opened.id});
await axTab.ax.scroll(${Number(paneRef.ref.slice(1))}, "down", 1)`});
  await sleep(200);
  const axScroll = await server.command("page.eval", {tabId: opened.id, expression: "({top:pane.scrollTop,height:pane.clientHeight,page:scrollY})"});
  report(axScroll.value.top >= 200 && axScroll.value.top <= 230 && axScroll.value.page === 0,
    "AX scroll uses region height rather than a fixed 600px", JSON.stringify(axScroll.value));
  await server.command("page.eval", {tabId: opened.id, expression: "pane.scrollTop=0"});
  const foundPane = await invoke("chrome_find", {tabId: opened.id, selector: "#pane"});
  await invoke("chrome_js", {code: `const target = await browser.tabs.get(${opened.id});
await target.dom_cua.scroll({node_id: "${foundPane.elements[0].ref}", x: 0, y: 320})`});
  await sleep(200);
  let paneState = await server.command("page.eval", {tabId: opened.id, expression: "({top:pane.scrollTop,left:pane.scrollLeft,page:scrollY})"});
  report(paneState.value.top > 200 && paneState.value.page === 0, "DOM scroll targets nested pane", JSON.stringify(paneState.value));
  await invoke("chrome_scroll", {tabId: opened.id, ref: foundPane.elements[0].ref, direction: "right", pages: 1});
  await sleep(200);
  paneState = await server.command("page.eval", {tabId: opened.id, expression: "({left:pane.scrollLeft,width:pane.clientWidth})"});
  report(paneState.value.left > 200, "page scrolling supports horizontal target dimensions", JSON.stringify(paneState.value));
  await server.command("page.eval", {tabId: opened.id, expression: "pane.remove(); true"});

  // Site CSS cannot hide the isolated cursor image. Keep it visible during
  // model thinking beyond the previous 12-second hide timer.
  await server.command("page.eval", {tabId: opened.id, expression: `
    var cursorStyle = document.createElement("style");
    cursorStyle.textContent = "img {display:none !important}";
    document.head.append(cursorStyle); true
  `});
  await invoke("chrome_move", {tabId: opened.id, x: 400, y: 300});
  await sleep(13000);
  const cursorAlive = await server.command("page.eval", {tabId: opened.id, expression: `
    (() => {const node=document.getElementById("__dsh_cursor__");
      return {present:!!node, opacity:node ? getComputedStyle(node).opacity : null, shadowClosed:node?.shadowRoot===null};})()
  `});
  report(cursorAlive.value.present && cursorAlive.value.opacity === "1" && cursorAlive.value.shadowClosed,
    "cursor persists in closed shadow DOM while the turn is active", JSON.stringify(cursorAlive.value));
  const visual = await server.command("page.screenshot", {tabId: opened.id});
  await writeFile("/tmp/dsh-cursor-parity.png", Buffer.from(visual.dataBase64, "base64"));
  await server.command("page.eval", {tabId: opened.id, expression: "cursorStyle.remove(); true"});

  await server.command("page.reload", {tabId: opened.id});
  await server.command("page.waitForLoad", {tabId: opened.id});
  await sleep(200);
  const restored = await server.command("page.eval", {tabId: opened.id, expression: "!!document.getElementById('__dsh_cursor__')"});
  report(restored.value, "cursor is restored after same-origin navigation");

  await invoke("chrome_mark_tab", {tabId: opened.id, status: "deliverable"});
  hostHandlers.get("session/event")(exec.agent.session, {type: "turn/end"});
  await sleep(200);
  const endedCursor = await server.command("page.eval", {tabId: opened.id, expression: "!!document.getElementById('__dsh_cursor__')"});
  report(!endedCursor.value, "cursor disappears automatically when the model turn ends");
  await invoke("chrome_snapshot", {tabId: opened.id});

  const csp = await invoke("chrome_navigate", {url: "http://127.0.0.1:18800/?csp", newTab: true});
  await invoke("chrome_mark_tab", {tabId: csp.tabId, status: "deliverable"});
  await invoke("chrome_move", {tabId: csp.tabId, x: 400, y: 300});
  await sleep(100);
  const dom = await server.command("cdp.send", {tabId: csp.tabId, method: "DOM.getDocument", params: {depth: -1, pierce: true}});
  function findNode(node, predicate) {
    if (predicate(node)) return node;
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
      const match = findNode(child, predicate);
      if (match) return match;
    }
  }
  const cursorHost = findNode(dom.value.root, node => node.attributes?.includes("__dsh_cursor__"));
  const cursorImage = findNode(cursorHost, node => node.nodeName === "IMG");
  const resolvedImage = await server.command("cdp.send", {tabId: csp.tabId, method: "DOM.resolveNode", params: {backendNodeId: cursorImage.backendNodeId}});
  const imageState = await server.command("cdp.send", {tabId: csp.tabId, method: "Runtime.callFunctionOn", params: {
    objectId: resolvedImage.value.object.objectId, returnByValue: true,
    functionDeclaration: "function(){const r=this.getBoundingClientRect();return {decoded:this.complete&&this.naturalWidth>0,display:getComputedStyle(this).display,width:r.width,height:r.height}}",
  }});
  const imageStatus = imageState.value.result.value;
  report(imageStatus.decoded && imageStatus.display !== "none" && imageStatus.width > 0,
    "cursor image is decoded and visibly rendered under restrictive CSP", JSON.stringify(imageStatus));
  await server.command("cdp.send", {tabId: csp.tabId, method: "Runtime.releaseObject", params: {objectId: resolvedImage.value.object.objectId}});
  const cspShot = await server.command("page.screenshot", {tabId: csp.tabId});
  await writeFile("/tmp/dsh-cursor-csp.png", Buffer.from(cspShot.dataBase64, "base64"));
  await server.command("page.navigate", {tabId: csp.tabId, url: "http://127.0.0.1:18801/"});
  await sleep(200);
  let visible = await server.command("page.eval", {tabId: csp.tabId, expression: "!!document.getElementById('__dsh_cursor__')"});
  report(!visible.value, "cursor does not follow navigation into an uncontrolled origin");
  await server.command("page.back", {tabId: csp.tabId});
  await server.command("page.waitForLoad", {tabId: csp.tabId});
  await sleep(200);
  visible = await server.command("page.eval", {tabId: csp.tabId, expression: "!!document.getElementById('__dsh_cursor__')"});
  report(visible.value, "cursor restores on returning to the controlled origin");
  const sharedExec = {agent: {session: {id: "e2e-other-turn"}}, signal: new AbortController().signal};
  await toolMap.get("chrome_read_page").execute({tabId: csp.tabId}, sharedExec);
  await toolMap.get("chrome_mark_tab").execute({tabId: csp.tabId, status: "deliverable"}, sharedExec);
  hostHandlers.get("session/event")(exec.agent.session, {type: "turn/end"});
  await sleep(100);
  visible = await server.command("page.eval", {tabId: csp.tabId, expression: "!!document.getElementById('__dsh_cursor__')"});
  report(visible.value, "ending one turn preserves another turn's active cursor");
  hostHandlers.get("session/event")(sharedExec.agent.session, {type: "turn/end"});
  await sleep(100);
  visible = await server.command("page.eval", {tabId: csp.tabId, expression: "!!document.getElementById('__dsh_cursor__')"});
  report(!visible.value, "last owner ending clears the shared cursor");
  await server.command("tabs.close", {tabId: csp.tabId});
  await invoke("chrome_snapshot", {tabId: opened.id});

  // 4e. Closed shadow DOM: create one after the patch is installed, then
  // snapshot and click through it.
  await server.command("page.eval", {
    tabId: opened.id,
    expression: `(() => {
      const host = document.createElement('div');
      host.id = 'shadow-host';
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = '<button id="sb">Shadow Button</button>';
      root.getElementById('sb').addEventListener('click', () => { document.body.dataset.shadow = 'yes'; });
      document.body.appendChild(host);
      return true;
    })()`,
  });
  const shadowSnap = await server.command("page.snapshot", { tabId: opened.id });
  const shadowButton = shadowSnap.elements.find((element) => (element.name || '').includes('Shadow Button'));
  report(shadowButton !== undefined, "snapshot sees closed shadow DOM", JSON.stringify(shadowButton));
  if (shadowButton !== undefined) {
    await server.command("input.clickRef", { tabId: opened.id, ref: shadowButton.ref });
    const shadowClicked = await server.command("page.eval", {
      tabId: opened.id,
      expression: "document.body.dataset.shadow",
    });
    report(shadowClicked.value === "yes", "click works inside a closed shadow root", JSON.stringify(shadowClicked));
  }

  // 5. Evaluate JavaScript.
  const title = await server.command("page.eval", { tabId: opened.id, expression: "document.title" });
  report(title.value === "E2E Local Page", "page.eval returns the title", JSON.stringify(title));
  const clicked = await server.command("page.eval", {
    tabId: opened.id,
    expression: "document.getElementById('b').click(); document.body.dataset.clicked",
  });
  report(clicked.value === "yes", "page.eval clicks a real button", JSON.stringify(clicked));

  // 5b. Real mouse and keyboard input (CDP Input domain).
  const clickedBox = await server.command("input.clickSelector", { tabId: opened.id, selector: "#b" });
  report(clickedBox.tag === "BUTTON", "input.clickSelector finds the button", JSON.stringify(clickedBox));
  const afterClick = await server.command("page.eval", {
    tabId: opened.id,
    expression: "document.body.dataset.clicked",
  });
  report(afterClick.value === "yes", "real mouse click triggers the button handler", JSON.stringify(afterClick));

  await server.command("input.clickSelector", { tabId: opened.id, selector: "#q" });
  await server.command("input.type", { tabId: opened.id, text: "hello chrome" });
  const typedValue = await server.command("page.eval", {
    tabId: opened.id,
    expression: "document.getElementById('q').value",
  });
  report(typedValue.value === "hello chrome", "real keyboard typing lands in the field", JSON.stringify(typedValue));
  await server.command("input.key", { tabId: opened.id, key: "Enter" });
  const entered = await server.command("page.eval", {
    tabId: opened.id,
    expression: "document.body.dataset.entered",
  });
  report(entered.value === "yes", "real key press reaches the page", JSON.stringify(entered));

  // 5c. Navigation history, reload and waitForURL.
  await server.command("page.navigate", { tabId: opened.id, url: "http://127.0.0.1:18800/?second=1" });
  const secondTitle = await server.command("page.eval", { tabId: opened.id, expression: "document.title" });
  report(secondTitle.value === "E2E Second Page", "page.navigate loads the second page", JSON.stringify(secondTitle));
  await server.command("page.back", { tabId: opened.id, timeoutMs: 5000 });
  const backTitle = await server.command("page.eval", { tabId: opened.id, expression: "document.title" });
  report(backTitle.value === "E2E Local Page", "page.back returns to the first page", JSON.stringify(backTitle));
  await server.command("page.forward", { tabId: opened.id, timeoutMs: 5000 });
  await server.command("page.waitForURL", { tabId: opened.id, url: "http://127.0.0.1:18800/?second=1", timeoutMs: 5000 });
  await server.command("page.reload", { tabId: opened.id, timeoutMs: 10000 });
  const reloaded = await server.command("page.waitForLoad", { tabId: opened.id, timeoutMs: 10000 });
  report(reloaded.status === "complete" || reloaded.status === "", "page.reload + waitForLoad complete", JSON.stringify(reloaded));
  try {
    await server.command("page.waitForLoadState", { tabId: opened.id, state: "networkidle", timeoutMs: 5000 });
    report(true, "page.waitForLoadState networkidle resolves", "ok");
  } catch (error) {
    report(false, "page.waitForLoadState networkidle resolves", String(error.message ?? error));
  }

  // 5c2. expectNavigation listens before the triggering action.
  try {
    const nav = await invoke("chrome_js", {
      code: `const navTab = await browser.tabs.get(${opened.id});
        const result = await navTab.playwright.expectNavigation(
          () => navTab.goto("http://127.0.0.1:18800/?expectnav=1"),
          { url: "http://127.0.0.1:18800/?expectnav=1", waitUntil: "load" }
        );
        result.url`,
    });
    report(nav.value === "http://127.0.0.1:18800/?expectnav=1", "expectNavigation catches a fast navigation", JSON.stringify(nav.value));
  } catch (error) {
    report(false, "expectNavigation catches a fast navigation", String(error.message ?? error));
  }

  // 5d. Host diagnostics, auth detection, SIWC detection and page fetch.
  const host = await server.command("host.info");
  report(host.browserName.length > 0 && Array.isArray(host.windows), "host.info reports browser diagnostics", JSON.stringify(host.browserName));
  const auth = await server.command("auth.detect", { tabId: opened.id });
  report(Array.isArray(auth.candidates) && Array.isArray(auth.fields), "auth.detect inspects sign-in controls", JSON.stringify({ candidates: auth.candidates.length, fields: auth.fields.length }));
  const siwc = await server.command("siwc.detect", { tabId: opened.id });
  report(["possible_matches", "no_deterministic_matches"].includes(siwc.status), "siwc.detect reports status", JSON.stringify(siwc.status));
  try {
    const fetched = await server.command("page.fetch", { tabId: opened.id, url: "http://127.0.0.1:18800/?fetch=1" });
    report(fetched.size > 0 && fetched.base64.length > 0, "page.fetch returns bytes", JSON.stringify({ size: fetched.size, contentType: fetched.contentType }));
  } catch (error) {
    report(false, "page.fetch returns bytes", String(error.message ?? error));
  }
  const webmcp = await server.command("webmcp.list", { tabId: opened.id });
  report(Array.isArray(webmcp.tools), "webmcp.list returns tools", JSON.stringify(webmcp));

  // 5e. Network overrides, element info, JPEG screenshot and AX diff.
  try {
    const headers = await server.command("network.setHeaders", { tabId: opened.id, headers: { "X-DSH-Test": "1" } });
    report(headers.headers["X-DSH-Test"] === "1", "network.setHeaders applies extra headers", JSON.stringify(headers));
    await server.command("network.blockUrls", { tabId: opened.id, urls: ["*blocked.example*"] });
    await server.command("network.clear", { tabId: opened.id });
    report(true, "network.blockUrls + clear work", "ok");
  } catch (error) {
    report(false, "network overrides work", String(error.message ?? error));
  }
  const elementInfo = await server.command("page.elementInfo", { tabId: opened.id, x: 40, y: 93 });
  report(Array.isArray(elementInfo.elements) && elementInfo.elements.length > 0, "page.elementInfo resolves elements", JSON.stringify(elementInfo.elements?.[0]?.tag));
  const elementShot = await server.command("page.elementScreenshot", { tabId: opened.id, x: 40, y: 93, size: 120 });
  report(Buffer.from(elementShot.dataBase64, "base64").length > 100, "page.elementScreenshot returns bytes", String(Buffer.from(elementShot.dataBase64, "base64").length));
  const jpeg = await server.command("page.screenshot", { tabId: opened.id, format: "jpeg", quality: 80 });
  const jpegBytes = Buffer.from(jpeg.dataBase64, "base64");
  report(jpeg.mediaType === "image/jpeg" && jpegBytes[0] === 0xff && jpegBytes[1] === 0xd8, "page.screenshot supports JPEG", `${jpegBytes.length} bytes`);
  const ax1 = await server.command("page.snapshot", { tabId: opened.id });
  const ax2 = await server.command("page.snapshot", { tabId: opened.id });
  report(typeof ax1.snapshotId === "string" && ax2.changed === false && ax2.diff?.unchanged === true, "AX snapshots carry diff + snapshotId", JSON.stringify({ id: ax2.snapshotId, changed: ax2.changed }));

  // 6. Screenshot returns a real PNG.
  const shot = await server.command("page.screenshot", { tabId: opened.id });
  const png = Buffer.from(shot.dataBase64, "base64");
  report(
    png.length > 1000 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47,
    "page.screenshot returns PNG bytes",
    `${png.length} bytes`
  );

  // 7. Tab listing carries the renamed group title and color.
  const tabs = await server.command("tabs.list");
  const ours = tabs.find((tab) => tab.id === opened.id);
  report(
    ours?.groupTitle === "E2E Group" && ours?.groupColor === "orange",
    "tabs.list shows the renamed group and color",
    JSON.stringify(ours ?? null)
  );

  // 8. Close the tab through the bridge.
  await server.command("tabs.close", { tabId: opened.id, groupTitle: "E2E Group" });
  const after = await server.command("tabs.list");
  report(after.every((tab) => tab.id !== opened.id), "tabs.close removes the tab");
} catch (error) {
  report(false, "e2e run crashed", error.message);
} finally {
  chrome.kill("SIGTERM");
  server.dispose();
  httpServer.close();
  frameServer.close();
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  await rm(EXTENSION, { recursive: true, force: true }).catch(() => {});
}

console.log(results.join("\n"));
console.log(process.exitCode ? "\nE2E TESTS FAILED" : "\nALL E2E TESTS PASSED");
