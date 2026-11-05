/** Host-side browser discovery tests: no browser process is started. */
import { installedBrowsers, chromeIsRunning, launchBrowser } from "./../browsers.js";
import { assert, assertEqual, assertRejects } from "./helpers.mjs";

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

await test("installedBrowsers returns a structured report", async () => {
  const report = await installedBrowsers();
  assert(["linux", "darwin", "win32"].includes(report.platform), "platform reported");
  assert(typeof report.configHome === "string" && report.configHome.length > 0, "configHome reported");
  assert(report.extensionDirectory.endsWith("/extension/"), "extensionDirectory reported");
  assert(Array.isArray(report.browsers), "browsers is an array");
  for (const browser of report.browsers) {
    assert(typeof browser.family === "string", "browser family");
    assert(typeof browser.running === "boolean", "browser running flag");
    assert(Array.isArray(browser.profiles), "browser profiles");
    assert(browser.nativeHost !== undefined && typeof browser.nativeHost.status === "string", "native host status");
  }
});

await test("chromeIsRunning reports a boolean aggregate", async () => {
  const result = await chromeIsRunning();
  assertEqual(typeof result.running, "boolean", "running aggregate");
  assert(Array.isArray(result.browsers), "per-browser running list");
});

await test("launchBrowser validates its executable", async () => {
  await assertRejects(
    Promise.resolve().then(() => launchBrowser({ executable: "" })),
    "needs an executable path",
    "empty executable rejected"
  );
});

console.log(results.join("\n"));
console.log(process.exitCode ? "\nSOME TESTS FAILED" : "\nALL BROWSER TESTS PASSED");
