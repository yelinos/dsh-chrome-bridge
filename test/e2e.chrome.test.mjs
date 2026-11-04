/**
 * End-to-end test: real Chrome for Testing loads the real extension, whose
 * service worker connects to a real bridge server; commands drive real tabs,
 * pages, and screenshots. Serves a local page to stay deterministic.
 */
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
<script>document.body.dataset.loaded='1'</script></body></html>`;
const httpServer = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE_HTML);
});
await new Promise((resolve) => httpServer.listen(18800, "127.0.0.1", resolve));

// The bridge must use the extension's default port (8765) unless storage was
// pre-seeded, which headless makes impractical.
const server = createBridgeServer({ port: TEST_PORT, commandTimeoutMs: 30000 });
await server.listen();

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
  report(ping.version === "0.4.1", "ext.ping reports the manifest version", JSON.stringify(ping));

  // 3. Open a tab in the DSH group and load the local page.
  const opened = await server.command("tabs.open", {
    url: "http://127.0.0.1:18800/",
    active: true,
    groupTitle: "DSH",
    groupColor: "purple",
  });
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
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  await rm(EXTENSION, { recursive: true, force: true }).catch(() => {});
}

console.log(results.join("\n"));
console.log(process.exitCode ? "\nE2E TESTS FAILED" : "\nALL E2E TESTS PASSED");
