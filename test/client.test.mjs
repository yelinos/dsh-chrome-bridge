/** Client-module test: load client.js with a module-loader stub and a fake ctx. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import vm from "node:vm";

const results = [];
function report(ok, name, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

const source = await readFile(new URL("../client.js", import.meta.url), "utf8");

let loaded = null;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(module) {
        loaded = module;
      },
    },
  },
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  navigator: { clipboard: { writeText: async () => {} } },
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "client.js" });

report(loaded !== null && loaded.id === "dsh-chrome-bridge", "module loader receives the client module", String(loaded && loaded.id));

const ReactStub = {
  createElement: () => null,
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
};
const module = loaded.factory((name) => {
  if (name === "react") return ReactStub;
  throw new Error(`unexpected require: ${name}`);
});
report(Array.isArray(module.inject) && module.inject.includes("slots"), "module exports inject", JSON.stringify(module.inject));

const registeredTypes = [];
const slotRegistrations = [];
const effects = [];
const fakeCtx = {
  locale: {
    bind: () => (key) => key,
    register: () => () => {},
  },
  sidebarRightTabs: {
    register: (definition) => {
      registeredTypes.push(definition);
      return () => {};
    },
  },
  slots: {
    inject: (_name, callback) => callback(),
    register: (definition, component) => {
      slotRegistrations.push({ definition, component });
      return () => {};
    },
  },
  remote: {
    chromeBridge: {
      status: async () => ({
        listening: true,
        connected: true,
        host: "127.0.0.1",
        port: 8765,
        extension: { name: "DSH Chrome Bridge", version: "0.2.0" },
        allowedDomains: ["a.example"],
        blockedDomains: [],
        pendingCommands: 0,
        extensionDir: "/bundle/extension/",
      }),
    },
    $on: () => {},
    $off: () => {},
  },
  effect: (fn) => {
    effects.push(fn);
    return typeof fn === "function" ? fn() : undefined;
  },
};

module.apply(fakeCtx);

report(registeredTypes.length === 1, "registers exactly one sidebar tab type");
const type = registeredTypes[0];
report(type?.id === "dsh-chrome-bridge" && type?.kind === "chrome-bridge", "tab identity", `${type?.id}/${type?.kind}`);
report(Array.isArray(type?.guide) && type.guide.length === 1, "tab exposes a guide entry so users can open it");
report(typeof type?.title === "function" && type.title() === "title", "tab title comes from locale");

const paneBodies = slotRegistrations.filter((entry) => entry.definition.name === "sidebar.right.pane.tab");
report(paneBodies.length === 1 && paneBodies[0].definition.key === "dsh-chrome-bridge", "body registered under the tab key");
const titles = slotRegistrations.filter((entry) => entry.definition.name === "sidebar.right.pane.tab.title");
report(titles.length === 1 && titles[0].definition.key === "dsh-chrome-bridge", "title view registered under the tab key");

const body = paneBodies[0];
const props = body.definition.inject();
report(typeof props.loadStatus === "function", "body receives a status loader");
report(typeof props.subscribe === "function", "body receives a change subscription");
const status = await props.loadStatus();
report(status.connected === true && status.extension.name === "DSH Chrome Bridge", "status loader reaches the remote namespace");
report(props.t("state.connected") === "state.connected", "body receives the bound translator");

report(effects.length >= 3, "all registrations are effects (cleanup owned)", String(effects.length));

console.log(results.join("\n"));
console.log(process.exitCode ? "\nCLIENT TESTS FAILED" : "\nALL CLIENT TESTS PASSED");
