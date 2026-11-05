/**
 * Host-side browser family / profile discovery, modeled after the Codex
 * browser plugin's `installed-browsers.js`, `chrome-is-running.js`,
 * `check-extension-installed.js`, `check-native-host-manifest.js` and
 * `open-chrome-window.js` diagnostics.
 *
 * The extension itself cannot read the filesystem or launch processes, so
 * these checks live in the Host plugin (Node) and are exposed to the model
 * through `chrome_browser_diagnostics`.
 */
import { execFile, spawn } from "node:child_process";
import { access, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const EXTENSION_DIR = fileURLToPath(new URL("./extension/", import.meta.url));
const NATIVE_HOST_NAME = "com.dsh.chromebridge";
const EXTENSION_IDS = ["dsh-chrome-bridge"];

const FAMILIES = [
  {
    family: "chrome",
    name: "Google Chrome",
    linux: { commands: ["google-chrome", "google-chrome-stable", "google-chrome-for-testing"], config: "google-chrome", processNames: ["chrome", "google-chrome"] },
    darwin: { app: "Google Chrome.app", config: "Google/Chrome", processNames: ["Google Chrome"] },
    win32: { exe: "chrome.exe", config: "Google/Chrome/User Data", processNames: ["chrome.exe"] },
  },
  {
    family: "chrome-beta",
    name: "Google Chrome Beta",
    linux: { commands: ["google-chrome-beta"], config: "google-chrome-beta", processNames: ["chrome"] },
    darwin: { app: "Google Chrome Beta.app", config: "Google/Chrome Beta", processNames: ["Google Chrome Beta"] },
    win32: { exe: "chrome.exe", config: "Google/Chrome Beta/User Data", processNames: ["chrome.exe"] },
  },
  {
    family: "chromium",
    name: "Chromium",
    linux: { commands: ["chromium", "chromium-browser"], config: "chromium", processNames: ["chromium"] },
    darwin: { app: "Chromium.app", config: "Chromium", processNames: ["Chromium"] },
    win32: { exe: "chrome.exe", config: "Chromium/User Data", processNames: ["chrome.exe"] },
  },
  {
    family: "edge",
    name: "Microsoft Edge",
    linux: { commands: ["microsoft-edge", "microsoft-edge-stable"], config: "microsoft-edge", processNames: ["msedge"] },
    darwin: { app: "Microsoft Edge.app", config: "Microsoft Edge", processNames: ["Microsoft Edge"] },
    win32: { exe: "msedge.exe", config: "Microsoft/Edge/User Data", processNames: ["msedge.exe"] },
  },
  {
    family: "brave",
    name: "Brave Browser",
    linux: { commands: ["brave-browser", "brave-browser-stable"], config: "BraveSoftware/Brave-Browser", processNames: ["brave"] },
    darwin: { app: "Brave Browser.app", config: "BraveSoftware/Brave-Browser", processNames: ["Brave Browser"] },
    win32: { exe: "brave.exe", config: "BraveSoftware/Brave-Browser/User Data", processNames: ["brave.exe"] },
  },
  {
    family: "opera",
    name: "Opera",
    linux: { commands: ["opera", "opera-stable"], config: "opera", processNames: ["opera"] },
    darwin: { app: "Opera.app", config: "com.operasoftware.Opera", processNames: ["Opera"] },
    win32: { exe: "opera.exe", config: "Opera Software/Opera Stable", processNames: ["opera.exe"] },
  },
  {
    family: "vivaldi",
    name: "Vivaldi",
    linux: { commands: ["vivaldi", "vivaldi-stable"], config: "vivaldi", processNames: ["vivaldi"] },
    darwin: { app: "Vivaldi.app", config: "Vivaldi", processNames: ["Vivaldi"] },
    win32: { exe: "vivaldi.exe", config: "Vivaldi/User Data", processNames: ["vivaldi.exe"] },
  },
];

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function which(command) {
  for (const name of command) {
    try {
      const { stdout } = await run("which", [name], { timeout: 5000 });
      const path = stdout.trim().split("\n")[0];
      if (path) return path;
    } catch {
      /* not found */
    }
  }
  return null;
}

function configHome() {
  const os = platform();
  if (os === "linux") return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  if (os === "darwin") return join(homedir(), "Library", "Application Support");
  return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
}

function nativeHostDir(family) {
  const os = platform();
  const relative = family[os]?.config;
  if (relative === undefined) return null;
  const base = configHome();
  return os === "linux" ? join(base, relative, "NativeMessagingHosts") : join(base, relative, "NativeMessagingHosts");
}

async function listProfiles(directory) {
  if (directory === null || !(await exists(directory))) return [];
  const root = directory.replace(/\/NativeMessagingHosts$/, "");
  if (!(await exists(root))) return [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const profiles = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "Default" || /^Profile \d+$/.test(entry.name)) profiles.push(join(root, entry.name));
    }
    return (await exists(root)) && !profiles.includes(join(root, "Default")) ? [join(root, "Default"), ...profiles] : profiles;
  } catch {
    return [];
  }
}

async function isRunning(family) {
  const os = platform();
  const names = family[os]?.processNames ?? [];
  if (names.length === 0) return false;
  try {
    const { stdout } = await run(os === "win32" ? "tasklist" : "pgrep", os === "win32" ? [] : ["-a", "-f", names.join("|")], { timeout: 5000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function extensionInstalled(profileDir) {
  if (profileDir === null) return false;
  const preferences = join(profileDir, "Preferences");
  try {
    const raw = await readFile(preferences, "utf8");
    return EXTENSION_IDS.some((id) => raw.includes(id)) || raw.includes("DSH Chrome Bridge");
  } catch {
    return false;
  }
}

async function nativeHostManifest(family) {
  const os = platform();
  const dir = nativeHostDir(family);
  if (dir === null) return { path: null, status: "missing" };
  const file = join(dir, `${NATIVE_HOST_NAME}.json`);
  if (!(await exists(file))) return { path: file, status: "missing" };
  try {
    const manifest = JSON.parse(await readFile(file, "utf8"));
    const allowed = manifest.allowed_origins ?? [];
    const ok = manifest.name === NATIVE_HOST_NAME && manifest.type === "stdio" && allowed.length > 0;
    return { path: file, status: ok ? "ok" : "invalid", manifest };
  } catch {
    return { path: file, status: "invalid" };
  }
}

/** Report installed browsers, running state, profiles and native-host status. */
export async function installedBrowsers() {
  const os = platform();
  const results = [];
  for (const family of FAMILIES) {
    const spec = family[os];
    if (spec === undefined) continue;
    const candidates = (spec.commands ?? [spec.exe, spec.app]).filter((value) => typeof value === "string" && value.length > 0);
    let executable = candidates.length > 0 ? await which(candidates) : null;
    if (executable === null && os === "darwin" && typeof spec.app === "string") {
      const appPath = join("/Applications", spec.app);
      executable = (await exists(appPath)) ? appPath : null;
    }
    const dir = nativeHostDir(family);
    const profiles = await listProfiles(dir);
    const running = await isRunning(family);
    const installed = executable !== null || profiles.length > 0 || dir !== null && (await exists(dir.replace(/\/NativeMessagingHosts$/, "")));
    if (!installed) continue;
    results.push({
      family: family.family,
      name: family.name,
      executable,
      configDirectory: dir?.replace(/\/NativeMessagingHosts$/, "") ?? null,
      running,
      profiles: profiles.map((profile) => ({ path: profile, extensionInstalled: false })),
      nativeHost: await nativeHostManifest(family),
      extensionManagementUrl: os === "win32" ? "edge://extensions" : `${family.family === "edge" ? "edge" : "chrome"}://extensions`,
    });
  }
  for (const result of results) {
    for (const profile of result.profiles) profile.extensionInstalled = await extensionInstalled(profile.path);
  }
  return { platform: os, configHome: configHome(), extensionDirectory: EXTENSION_DIR, browsers: results };
}

/** Check whether any browser process from the supported families is running. */
export async function chromeIsRunning() {
  const report = await installedBrowsers();
  return { running: report.browsers.some((browser) => browser.running), browsers: report.browsers.map((browser) => ({ family: browser.family, running: browser.running })) };
}

/** Write the native messaging host manifest for all discovered browser config dirs. */
export async function installNativeHostManifest(hostPath) {
  const os = platform();
  if (os === "win32") return { status: "unsupported", written: [] };
  const report = await installedBrowsers();
  const written = [];
  for (const browser of report.browsers) {
    const dir = nativeHostDir(FAMILIES.find((family) => family.family === browser.family));
    if (dir === null) continue;
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${NATIVE_HOST_NAME}.json`);
    const manifest = {
      name: NATIVE_HOST_NAME,
      description: "DSH Chrome Bridge native messaging host",
      path: hostPath,
      type: "stdio",
      allowed_origins: EXTENSION_IDS.map((id) => `chrome-extension://${id}/`),
    };
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    written.push(file);
  }
  return { status: "ok", written };
}

/** Spawn a browser with the unpacked extension loaded. Only used after explicit user approval. */
export function launchBrowser({ executable, userDataDir, url = "about:blank" } = {}) {
  if (typeof executable !== "string" || executable.length === 0) throw new Error("launchBrowser needs an executable path");
  const args = [
    `--user-data-dir=${userDataDir ?? join(homedir(), ".dsh", "chrome-bridge-profile")}`,
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    url,
  ];
  const child = spawn(executable, args, { detached: true, stdio: "ignore" });
  child.unref();
  return { executable, args, url, started: child.pid !== undefined, pid: child.pid ?? null };
}
