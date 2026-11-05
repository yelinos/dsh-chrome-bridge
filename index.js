/**
 * DSH Chrome Bridge — agent tools.
 *
 * Model-facing chrome_* tools over the {@link ChromeBridgeService}:
 * per-domain approval (ask through user questions, Codex-Chrome-extension
 * style), one Chrome tab group per agent session, page reading, script
 * evaluation, and screenshots admitted through the durable attachment
 * pipeline (with a workspace-file fallback).
 *
 * @module dsh-chrome-bridge
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createBrowserRepl } from "./repl.js";
import { installedBrowsers, chromeIsRunning, installNativeHostManifest, launchBrowser } from "./browsers.js";

const name = "chrome-bridge-tools";

const Config = z.object({
  tabGroupTitle: z.string().default("DSH"),
  askForNewDomains: z.boolean().default(true),
  /**
   * Always-allowed hostnames. Volatile: "Always allow" answers persist here
   * through the settings service and apply live without remounting.
   */
  allowedDomains: z.array(z.string()).default([]).volatile(),
  blockedDomains: z.array(z.string()).default([]),
  maxSnapshotChars: z.number().default(24000),
  /** Maximum agent tabs kept open per session; the least recently used is closed first. */
  maxSessionTabs: z.number().default(3),
  /** Close agent tabs not used for this long (0 disables idle cleanup). */
  autoCloseIdleMs: z.number().default(180000),
  /** Close all of a session's agent tabs when its agent is disposed. */
  autoCloseOnSessionEnd: z.boolean().default(true),
});

const inject = ["tools", "chromeBridge", "userQuestions", "workingDirectory"];

const CONNECTION_HINT =
  "Check chrome_status; if the bridge is not listening or the extension is not connected, " +
  "load the unpacked extension from the bundle's extension/ directory in Chrome " +
  "(chrome://extensions → Developer mode → Load unpacked) and confirm its popup shows Connected.";

/** Permissive output schema: the renderers below own model-facing formatting. */
const looseObject = { type: "object", additionalProperties: true };

const ALLOW_SESSION_LABELS = ["允许（本会话）Allow this session", "Allow this session"];
const ALLOW_ALWAYS_LABELS = ["始终允许 Always allow", "Always allow"];
const DECLINE_LABELS = ["拒绝 Decline", "Decline"];

function isLabel(answer, labels) {
  const selected = answer?.selected ?? [];
  const custom = typeof answer?.custom === "string" ? answer.custom : "";
  return labels.some((label) => selected.includes(label) || custom.includes(label));
}

/**
 * Register the chrome_* tools.
 *
 * @param {object} ctx - Context providing tools, chromeBridge, userQuestions,
 *   and workingDirectory; settings and attachments are optional children.
 * @param {object} config - Validated {@link Config}.
 */
function apply(ctx, config) {
  /**
   * Tool executions are async and may overlap across sessions. Async-local
   * storage keeps each call's browser selection available to every
   * `bridge.command` without threading a new argument through 90 call sites.
   */
  const toolScope = new AsyncLocalStorage();
  const upstreamBridge = ctx.chromeBridge;
  const bridge = {
    status: (...args) => upstreamBridge.status(...args),
    setActiveBrowser: (...args) => upstreamBridge.setActiveBrowser(...args),
    command: (cmd, params, signal, browserId) => {
      const exec = toolScope.getStore();
      return upstreamBridge.command(cmd, params, signal, browserId ?? exec?.chromeBrowserId);
    },
  };
  const entryId = ctx.fiber?.entry?.options?.id;
  /** Definitions by name, so chrome_act can compose them in one call. */
  const definitions = new Map();
  const runBrowserRepl = createBrowserRepl({ bridge, definitions, resolveTabId });
  function registerTool(definition) {
    const wrapped = {
      ...definition,
      execute: (args, exec) => toolScope.run(exec, () => definition.execute(args, exec)),
    };
    definitions.set(definition.name, wrapped);
    ctx.tools.register(wrapped);
  }

  /** session → Set(hostname) approved for that session only. */
  const sessionApproved = new Map();
  /** Hostnames approved with "Always allow" for this process lifetime. */
  const runtimeAllowed = new Set();
  /** session → Map(tabId → { lastUsed, openedAt, origin, mark, browserId }) tabs this session opened. */
  const sessionTabs = new Map();
  /** session → { tabId, browserId } last tab this session used. */
  const lastTab = new Map();
  /** session → explicit, short purpose name for its Chrome tab group. */
  const groupNames = new Map();
  /** Recent model-initiated browser changes, newest first. */
  const auditTrail = [];
  function recordChange(namespace, method, args, before = null, result = null) {
    auditTrail.unshift({ namespace, method, args, before, result, createdAt: Date.now() });
    if (auditTrail.length > 200) auditTrail.pop();
  }
  /** session → Chrome tab-group id, so sessions never merge by title collision. */
  const sessionGroupIds = new Map();

  /** Best-effort favicon badge for a tab; official extension shows active/deliverable/handoff badges. */
  async function setFaviconBadge(exec, tabId, badge, browserId) {
    try {
      await bridge.command("favicon.set", { tabId, badge }, exec?.signal, browserId);
    } catch {
      /* badges are cosmetic */
    }
  }

  /** Live read of the volatile allowedDomains list (plain arrays also work). */
  function allowedDomains() {
    const value = config.allowedDomains;
    if (value !== null && typeof value === "object" && typeof value.get === "function") {
      const live = value.get();
      return Array.isArray(live) ? live : [];
    }
    return Array.isArray(value) ? value : [];
  }

  /** Persist an always-allow write through settings; null when unavailable. */
  let persistAllowedDomains = null;
  if (typeof ctx.inject === "function") {
    ctx.inject(["settings"], (scope) => {
      const settings = scope.settings ?? (typeof scope.get === "function" ? scope.get("settings") : undefined);
      if (settings === undefined || entryId === undefined) return;
      persistAllowedDomains = async (domains) => {
        await settings.update(entryId, { allowedDomains: domains });
        try {
          ctx.emit("chrome-bridge/changed");
        } catch {
          /* observers are optional */
        }
      };
    });
  }

  /** Durable image admission; null when no attachment service is mounted. */
  let admitImage = null;
  if (typeof ctx.inject === "function") {
    ctx.inject(["attachments"], (scope) => {
      const attachments = scope.attachments ?? (typeof scope.get === "function" ? scope.get("attachments") : undefined);
      if (attachments === undefined) return;
      admitImage = (input) => attachments.saveImage(input);
    });
  }

  function sessionOf(exec) {
    return exec.agent === undefined ? null : exec.agent.session ?? null;
  }

  function approvedSet(session) {
    if (session === null) return null;
    let set = sessionApproved.get(session);
    if (set === undefined) {
      set = new Set();
      sessionApproved.set(session, set);
    }
    return set;
  }

  /** Short stable label for one session's Chrome tab group. */
  function sessionLabel(exec) {
    const session = sessionOf(exec);
    if (session === null) return null;
    let raw = "";
    try {
      raw = String(session.id ?? "");
    } catch {
      raw = "";
    }
    const match = raw.match(/[0-9a-f]{4,8}/i);
    if (match !== null) return match[0].slice(0, 6);
    return raw.length > 0 ? raw.slice(0, 6) : "session";
  }

  /** This session's tab group: "DSH · <label>", or the plain title outside sessions. */
  function groupTitleFor(exec) {
    const label = sessionLabel(exec);
    return label === null ? config.tabGroupTitle : `${config.tabGroupTitle} · ${label}`;
  }

  /** True for the plain group title and every per-session variant of it. */
  function inAgentGroup(groupTitle) {
    return groupTitle === config.tabGroupTitle || groupTitle.startsWith(`${config.tabGroupTitle} ·`);
  }

  /** True when the plugin opened or tracked this tab in any session. */
  function isTrackedTab(tabId) {
    for (const tabs of sessionTabs.values()) if (tabs.has(tabId)) return true;
    return false;
  }

  /** Chrome tab-group colors, assigned deterministically per session. */
  const GROUP_COLORS = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange", "grey"];

  function hashString(text) {
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * 31 + text.charCodeAt(index)) | 0;
    }
    return Math.abs(hash);
  }

  /** Stable tab-group color for one session, so concurrent groups differ. */
  function sessionGroupColor(exec) {
    const session = sessionOf(exec);
    const id = session === null ? "" : String(session.id ?? "");
    return GROUP_COLORS[hashString(id) % GROUP_COLORS.length];
  }

  /** Explicit purpose name the agent gave this session's group, if any. */
  function sessionGroupName(exec) {
    const session = sessionOf(exec);
    if (session === null) return null;
    return groupNames.get(session) ?? null;
  }

  /** Short default group name from a loaded page: its title, else its host. */
  function autoGroupName(info) {
    const title = String(info.title ?? "").trim();
    if (title.length > 0) return title.slice(0, 24);
    try {
      return new URL(info.url).hostname.replace(/^www\./, "").slice(0, 24);
    } catch {
      return config.tabGroupTitle;
    }
  }

  /** Browser id a call is routed to (explicit chrome_js handle or active default). */
  function browserIdOf(exec) {
    return exec?.chromeBrowserId ?? bridge.status().activeBrowserId ?? null;
  }

  /** Last tab entry for a session, optionally restricted to one browser. */
  function lastTabEntry(session, browserId) {
    const entry = session === null ? undefined : lastTab.get(session);
    if (entry === undefined) return undefined;
    if (browserId !== undefined && browserId !== null && entry.browserId !== browserId) return undefined;
    return entry;
  }

  /** Record that the session touched `tabId` now, creating the record if needed. */
  function touchTab(exec, tabId, options = {}) {
    const session = sessionOf(exec);
    if (session === null) return;
    const browserId = options.browserId ?? browserIdOf(exec);
    lastTab.set(session, { tabId, browserId });
    let tabs = sessionTabs.get(session);
    if (tabs === undefined) {
      tabs = new Map();
      sessionTabs.set(session, tabs);
    }
    const existing = tabs.get(tabId);
    tabs.set(tabId, {
      lastUsed: Date.now(),
      openedAt: existing?.openedAt ?? Date.now(),
      origin: existing?.origin ?? options.origin ?? "agent",
      mark: existing?.mark ?? null,
      browserId: browserId ?? existing?.browserId,
    });
  }

  /** Close one tab, ignoring a tab that is already gone. */
  async function closeTabQuietly(tabId, browserId) {
    try {
      await bridge.command("tabs.close", { tabId }, undefined, browserId ?? undefined);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Keep a session within `maxSessionTabs`: close its least recently used
   * tabs, never the tab the current call is working in.
   */
  async function enforceTabLimit(exec, currentTabId) {
    const session = sessionOf(exec);
    if (session === null) return [];
    const tabs = sessionTabs.get(session);
    if (tabs === undefined) return [];
    const closed = [];
    while (tabs.size > config.maxSessionTabs) {
      let oldest;
      for (const [tabId, record] of tabs) {
        if (tabId === currentTabId || record.mark != null) continue;
        if (oldest === undefined || record.lastUsed < oldest.record.lastUsed) oldest = { tabId, record };
      }
      if (oldest === undefined) break;
      tabs.delete(oldest.tabId);
      if (await closeTabQuietly(oldest.tabId, oldest.record.browserId)) closed.push(oldest.tabId);
    }
    return closed;
  }

  /**
   * Close agent tabs this session has not touched for `autoCloseIdleMs`.
   * The session's current tab is kept while the session is live.
   */
  async function cleanupIdleTabs() {
    if (!(config.autoCloseIdleMs > 0)) return;
    const cutoff = Date.now() - config.autoCloseIdleMs;
    for (const [session, tabs] of sessionTabs) {
      const current = lastTab.get(session)?.tabId;
      for (const [tabId, record] of [...tabs]) {
        if (tabId === current || record.mark != null) continue;
        if (record.lastUsed > cutoff) continue;
        tabs.delete(tabId);
        await closeTabQuietly(tabId, record.browserId);
      }
      if (tabs.size === 0) sessionTabs.delete(session);
    }
  }

  /** Close every tab a session opened (used when its agent is disposed). */
  async function closeSessionTabs(session) {
    const tabs = sessionTabs.get(session);
    lastTab.delete(session);
    sessionTabs.delete(session);
    sessionGroupIds.delete(session);
    groupNames.delete(session);
    if (tabs === undefined) return;
    for (const [tabId, record] of tabs) {
      // Deliverable/handoff tabs are intentionally left open; only unmarked
      // agent tabs are reclaimed at session end.
      if (record.mark != null) continue;
      await closeTabQuietly(tabId, record.browserId);
    }
  }

  /**
   * End-of-turn cleanup, mirroring the official tab cleanup contract:
   * deliverable tabs stay open; handoff tabs stay open and lose their mark
   * when the next turn starts; claimed user tabs are released, not closed;
   * every other agent tab closes. Returns the tab ids handled.
   */
  async function endTurnTabs(exec) {
    const session = sessionOf(exec);
    const tabs = session === null ? undefined : sessionTabs.get(session);
    if (tabs === undefined) return { closed: [], released: [], kept: [] };
    const closed = [];
    const released = [];
    const kept = [];
    for (const [tabId, record] of [...tabs]) {
      if (record.mark === "deliverable") {
        kept.push(tabId);
        continue;
      }
      if (record.mark === "handoff") {
        kept.push(tabId);
        record.mark = null;
        continue;
      }
      tabs.delete(tabId);
      if (lastTab.get(session)?.tabId === tabId) lastTab.delete(session);
      if (record.origin === "user") {
        released.push(tabId);
        await setFaviconBadge(exec, tabId, "none", record.browserId);
      } else if (await closeTabQuietly(tabId, record.browserId)) {
        closed.push(tabId);
      }
    }
    if (tabs.size === 0) sessionTabs.delete(session);
    return { closed, released, kept };
  }

  function parseHttpUrl(raw) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`Invalid URL: ${JSON.stringify(raw)}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Only http(s) URLs are supported, got ${url.protocol}`);
    }
    return url;
  }

  /**
   * Codex-style domain approval: blocked → deny; allowed/session/runtime →
   * pass; otherwise ask the user (this session / always / decline). "Always"
   * persists through the settings service when available.
   */
  async function ensureDomainAllowed(exec, rawUrl) {
    const hostname = parseHttpUrl(rawUrl).hostname;
    if (config.blockedDomains.includes(hostname)) {
      throw new Error(`Domain ${hostname} is blocked by chrome-bridge-tools blockedDomains.`);
    }
    if (allowedDomains().includes(hostname) || runtimeAllowed.has(hostname)) return;
    const set = approvedSet(sessionOf(exec));
    if (set !== null && set.has(hostname)) return;
    if (!config.askForNewDomains || exec.agent === undefined) {
      throw new Error(
        `Domain ${hostname} is not allowed. Add it to chrome-bridge-tools allowedDomains in the profile patch` +
          (config.askForNewDomains ? "" : " or enable askForNewDomains") +
          "."
      );
    }
    const { answers } = await ctx.userQuestions.ask({
      questions: [
        {
          id: "allow-domain",
          header: "DSH Chrome · Domain approval",
          question: `Allow the agent to interact with ${hostname} in your Chrome?`,
          options: [
            { label: ALLOW_SESSION_LABELS[0], description: "Approve for the current session only." },
            { label: ALLOW_ALWAYS_LABELS[0], description: "Approve permanently; saved to allowedDomains." },
            { label: DECLINE_LABELS[0], description: "Decline; this tool call fails." },
          ],
        },
      ],
      agent: exec.agent,
      signal: exec.signal,
    });
    const answer = answers[0];
    if (isLabel(answer, ALLOW_ALWAYS_LABELS)) {
      const current = allowedDomains();
      if (!current.includes(hostname)) {
        const next = [...current, hostname];
        let persisted = false;
        if (persistAllowedDomains !== null) {
          try {
            await persistAllowedDomains(next);
            persisted = true;
          } catch {
            persisted = false;
          }
        }
        if (!persisted) runtimeAllowed.add(hostname);
      }
      if (set !== null) set.add(hostname);
      return;
    }
    if (isLabel(answer, ALLOW_SESSION_LABELS)) {
      if (set !== null) set.add(hostname);
      return;
    }
    throw new Error(`User declined to allow the agent to interact with ${hostname}.`);
  }

  /** Resolve which tab a call addresses: explicit id → last used → active tab. */
  async function resolveTabId(exec, tabId) {
    if (tabId !== undefined) return tabId;
    const session = sessionOf(exec);
    const last = lastTabEntry(session, browserIdOf(exec));
    if (last !== undefined) {
      try {
        await bridge.command("tabs.get", { tabId: last.tabId }, exec.signal);
        return last.tabId;
      } catch {
        if (session !== null) lastTab.delete(session);
      }
    }
    const active = await bridge.command("tabs.active", {}, exec.signal);
    return active.id;
  }

  // One token per turn. End it on the browser(s) that actually received it,
  // even if another session switched the active browser in the meantime.
  const cursorTurns = new Map();
  async function beginCursor(exec, tab) {
    const session = sessionOf(exec);
    if (!session || !/^https?:/i.test(tab.url)) return;
    let turn = cursorTurns.get(session);
    if (!turn) {
      turn = { owner: randomUUID(), browsers: new Set() };
      cursorTurns.set(session, turn);
    }
    const browserId = browserIdOf(exec);
    turn.browsers.add(browserId);
    await bridge.command("cursor.begin", {
      tabId: tab.id, origin: new URL(tab.url).origin, owner: turn.owner,
    }, exec.signal, browserId).catch(() => {});
  }

  async function finishCursor(session, tabId, browserId) {
    const turn = cursorTurns.get(session);
    if (!turn) return;
    if (tabId === undefined) cursorTurns.delete(session);
    const browsers = tabId === undefined ? turn.browsers : [browserId ?? bridge.status().activeBrowserId];
    await Promise.allSettled([...browsers].map(id =>
      bridge.command("cursor.end", { owner: turn.owner, tabId }, undefined, id)
    ));
  }

  /** Gate a tab's current page, then return its info. */
  async function gatedTab(exec, tabId) {
    const info = await bridge.command("tabs.get", { tabId }, exec.signal);
    if (typeof info.url === "string" && info.url.length > 0 && /^https?:/i.test(info.url)) {
      await ensureDomainAllowed(exec, info.url);
      await beginCursor(exec, info);
    }
    touchTab(exec, tabId);
    return info;
  }

  registerTool(
    defineTool({
      name: "chrome_status",
      description:
        "Report the DSH Chrome Bridge state: whether the bridge server is listening, whether the Chrome extension is connected (with its name and version), where the bundled extension lives on disk, and the effective domain approval lists. Call this first when browser tools fail.",
      parameters: {},
      output: {
        schema: looseObject,
        render: (_args, value) => [
          {
            type: "text",
            text:
              `DSH Chrome Bridge ${value.connected ? "connected" : "not connected"}:\n` +
              `- listening: ${value.listening}${value.startError ? ` (start error: ${value.startError})` : ""}\n` +
              `- endpoint: ws://${value.host}:${value.port}\n` +
              `- extension: ${value.extension ? `${value.extension.name} ${value.extension.version}` : "none"}\n` +
              `- browsers: ${Array.isArray(value.browsers) && value.browsers.length > 0 ? value.browsers.map((browser) => `${browser.browserName} [${browser.id}]${browser.active ? " (active)" : ""}`).join(", ") : "none"}\n` +
              `- extension directory: ${value.extensionDir}\n` +
              `- allowed domains: ${value.allowedDomains.length > 0 ? value.allowedDomains.join(", ") : "(none)"}\n` +
              `- blocked domains: ${value.blockedDomains.length > 0 ? value.blockedDomains.join(", ") : "(none)"}\n` +
              (value.connected ? "" : `- hint: ${CONNECTION_HINT}`),
          },
        ],
      },
      async execute(_args, exec) {
        const status = bridge.status();
        return {
          ...status,
          allowedDomains: [...allowedDomains(), ...runtimeAllowed],
          blockedDomains: [...config.blockedDomains],
          askForNewDomains: config.askForNewDomains,
        };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_use_browser",
      description: "Choose which connected browser/profile subsequent chrome_* commands use. Use chrome_status to list available browsers.",
      parameters: {
        browserId: { type: "string", required: true, description: "Browser id from chrome_status.browsers." },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [
          {
            type: "text",
            text: value.ok
              ? `Active browser set to ${value.browser?.browserName ?? value.browserId}.`
              : `No connected browser with id ${value.browserId}.`,
          },
        ],
      },
      async execute(args, exec) {
        if (typeof args.browserId !== "string" || args.browserId.length === 0) {
          throw new Error("chrome_use_browser needs browserId");
        }
        const ok = ctx.chromeBridge.setActiveBrowser(args.browserId);
        const status = bridge.status();
        return { ok, browserId: args.browserId, browser: status.extension, browsers: status.browsers };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_tabs",
      description:
        "List Chrome tabs. By default only the DSH tab groups the agent works in (one group per session); pass all=true to list every tab in the user's browser windows. Returns id, title, url, active flag, and group title per tab.",
      parameters: {
        all: {
          type: "boolean",
          description: "Include tabs outside the agent's DSH tab groups. Defaults to false.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [
          {
            type: "text",
            text:
              value.tabs.length === 0
                ? "No tabs found."
                : value.tabs
                    .map(
                      (tab) =>
                        `${tab.active ? "*" : " "} [${tab.id}] (${tab.groupTitle}${tab.groupColor ? ` · ${tab.groupColor}` : ""}${tab.session ? " · agent" : ""}) ${tab.title} — ${tab.url}`
                    )
                    .join("\n"),
          },
        ],
      },
      async execute(args, exec) {
        const tabs = await bridge.command("tabs.list", {}, exec.signal);
        const session = sessionOf(exec);
        const owned = session === null ? undefined : sessionTabs.get(session);
        const filtered =
          args.all === true
            ? tabs
            : tabs.filter((tab) => inAgentGroup(tab.groupTitle ?? "") || isTrackedTab(tab.id));
        return {
          tabs: filtered.map((tab) => {
            const record = owned?.get(tab.id);
            return {
              ...tab,
              session: isTrackedTab(tab.id),
              currentSession: record !== undefined,
              origin: record?.origin ?? null,
              mark: record?.mark ?? null,
            };
          }),
          total: tabs.length,
        };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_active_tab",
      description: "Return the currently selected/active tab.",
      parameters: {},
      output: {
        schema: looseObject,
        render: (_args, value) => [
          { type: "text", text: `[${value.id}] ${value.title || "(untitled)"} — ${value.url}${value.groupTitle ? ` (${value.groupTitle})` : ""}` },
        ],
      },
      async execute(_args, exec) {
        const tab = await bridge.command("tabs.active", {}, exec.signal);
        return { ...tab, session: isTrackedTab(tab.id), currentSession: sessionOf(exec) !== null && sessionTabs.get(sessionOf(exec))?.has(tab.id) === true };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_open_tabs",
      description:
        "List the user's already-open tabs that are not controlled by this agent, including window/group/pinned state. Use this before chrome_claim_tab when the user asks you to continue work in an existing tab.",
      parameters: {},
      output: {
        schema: looseObject,
        render: (_args, value) => [
          {
            type: "text",
            text:
              value.tabs.length === 0
                ? "No unclaimed user tabs found."
                : value.tabs
                    .map(
                      (tab) =>
                        `[${tab.id}] ${tab.pinned ? "📌 " : ""}${tab.title || "(untitled)"} — ${tab.url}` +
                        (tab.groupTitle ? ` (${tab.groupTitle})` : "")
                    )
                    .join("\n"),
          },
        ],
      },
      async execute(_args, exec) {
        const tabs = await bridge.command("tabs.list", {}, exec.signal);
        const browserId = browserIdOf(exec);
        const candidates = tabs
          .filter((tab) => !isTrackedTab(tab.id) && !inAgentGroup(tab.groupTitle ?? ""))
          .map((tab) => ({
            ...tab,
            providerTabId: tab.id,
            tabId: tab.id,
            browserId,
            snapshotUrl: tab.url ?? "",
            snapshotTitle: tab.title ?? "",
          }));
        return { tabs: candidates, total: tabs.length, browserId };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_claim_tab",
      description:
        "Claim an existing user tab for this session so it can be navigated, read, clicked and closed by the agent. The tab stays in its current window/group.",
      parameters: {
        tabId: {
          type: "integer",
          required: true,
          description: "Tab id returned by chrome_open_tabs or chrome_tabs.",
        },
        url: {
          type: "string",
          description: "Expected URL from the openTabs snapshot; the claim fails if the tab has changed.",
        },
        title: {
          type: "string",
          description: "Expected title from the openTabs snapshot; the claim fails if the tab has changed.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: `Claimed tab [${value.tabId}]: ${value.title} — ${value.url}` }],
      },
      async execute(args, exec) {
        const info = await bridge.command("tabs.get", { tabId: args.tabId }, exec.signal);
        if (args.url !== undefined && info.url !== args.url) {
          throw new Error(`refusing to claim tab ${args.tabId}: URL changed from ${JSON.stringify(args.url)} to ${JSON.stringify(info.url)}`);
        }
        if (args.title !== undefined && info.title !== args.title) {
          throw new Error(`refusing to claim tab ${args.tabId}: title changed from ${JSON.stringify(args.title)} to ${JSON.stringify(info.title)}`);
        }
        if (/^https?:/i.test(info.url)) {
          await ensureDomainAllowed(exec, info.url);
          await beginCursor(exec, info);
        }
        touchTab(exec, args.tabId, { origin: "user" });
        recordChange("tabs", "claimTab", { tabId: args.tabId }, { url: info.url, title: info.title });
        await setFaviconBadge(exec, args.tabId, "active");
        return { tabId: args.tabId, ...info };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_release_tab",
      description:
        "Release a claimed user tab (or an agent tab) from this session's control without closing it. The tab remains open for the user.",
      parameters: {
        tabId: { type: "integer", required: true, description: "Tab id to release." },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: `Released tab [${value.tabId}].` }],
      },
      async execute(args, exec) {
        const session = sessionOf(exec);
        let record;
        if (session !== null) {
          record = sessionTabs.get(session)?.get(args.tabId);
          sessionTabs.get(session)?.delete(args.tabId);
          if (lastTab.get(session)?.tabId === args.tabId) lastTab.delete(session);
        }
        await finishCursor(session, args.tabId, record?.browserId);
        await setFaviconBadge(exec, args.tabId, "none");
        return { tabId: args.tabId };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_mark_tab",
      description:
        "Mark a tab as a user-facing deliverable or a handoff for a later turn. Marked tabs are not closed by the session LRU/idle/session-end cleanup.",
      parameters: {
        tabId: { type: "integer", required: true, description: "Tab id to mark." },
        status: {
          type: "string",
          required: true,
          description: 'Mark: "deliverable" (open result page), "handoff" (continue later), or "none" (clear).',
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: `Tab [${value.tabId}] marked as ${value.mark ?? "unmarked"}.` }],
      },
      async execute(args, exec) {
        const status = String(args.status ?? "").toLowerCase();
        if (!["deliverable", "handoff", "none"].includes(status)) {
          throw new Error('chrome_mark_tab status must be "deliverable", "handoff", or "none"');
        }
        touchTab(exec, args.tabId);
        const session = sessionOf(exec);
        const record = session === null ? undefined : sessionTabs.get(session)?.get(args.tabId);
        if (record !== undefined) record.mark = status === "none" ? null : status;
        recordChange("tabs", "markTab", { tabId: args.tabId, status }, { mark: record?.mark ?? null });
        await setFaviconBadge(exec, args.tabId, status === "none" ? "active" : status);
        return { tabId: args.tabId, mark: record?.mark ?? null };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_navigate",
      description:
        "Navigate to a URL in the user's signed-in Chrome. By default it REUSES this session's current agent tab, so multi-step work stays in one page; only pass newTab: true when a page must stay open for comparison. Pass tabId to target a specific tab. Asks the user for approval the first time a domain is used. Returns the tab id, final URL, and page title. Next inspect with chrome_snapshot. For further content, scroll at the relevant element or viewport point and inspect again.",
      parameters: {
        url: {
          type: "string",
          required: true,
          description: "Absolute http(s) URL to open.",
        },
        tabId: {
          type: "integer",
          description: "Existing tab to navigate; omit to reuse the session's current tab.",
        },
        newTab: {
          type: "boolean",
          description:
            "Open a NEW tab instead of reusing the current one. Defaults to false; use it only when the current page must stay open.",
        },
        background: {
          type: "boolean",
          description: "Open a new tab without focusing it. Defaults to false.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [
          {
            type: "text",
            text:
              `${value.reused ? "Reused" : "Opened"} tab [${value.tabId}] in ${value.group}${value.groupColor ? ` [${value.groupColor}]` : ""}: ${value.title} — ${value.url}` +
              (value.closedTabs.length > 0 ? ` (closed least-recently-used: ${value.closedTabs.join(", ")})` : ""),
          },
        ],
      },
      async execute(args, exec) {
        parseHttpUrl(args.url);
        await ensureDomainAllowed(exec, args.url);
        const group = groupTitleFor(exec);
        let info;
        let reused = false;
        if (args.tabId !== undefined) {
          info = await bridge.command("page.navigate", { tabId: args.tabId, url: args.url }, exec.signal);
        } else {
          // Reuse the session's current agent tab unless a new tab is requested.
          if (args.newTab !== true) {
            const session = sessionOf(exec);
            const preferredEntry = session === null ? undefined : lastTabEntry(session, browserIdOf(exec));
            const preferred = preferredEntry?.tabId;
            if (preferred !== undefined) {
              try {
                const existing = await bridge.command("tabs.get", { tabId: preferred }, exec.signal);
                if (inAgentGroup(existing.groupTitle ?? "") || isTrackedTab(existing.id)) {
                  info = await bridge.command("page.navigate", { tabId: preferred, url: args.url }, exec.signal);
                  reused = true;
                }
              } catch {
                if (session !== null) lastTab.delete(session);
              }
            }
          }
          if (info === undefined) {
            const explicitName = sessionGroupName(exec);
            const session = sessionOf(exec);
            const knownGroupId = session === null ? undefined : sessionGroupIds.get(session);
            info = await bridge.command(
              "tabs.open",
              {
                url: args.url,
                active: args.background !== true,
                groupTitle: explicitName ?? config.tabGroupTitle,
                groupColor: sessionGroupColor(exec),
                ...(knownGroupId !== undefined ? { groupId: knownGroupId } : {}),
              },
              exec.signal
            );
            if (session !== null && Number.isInteger(info.groupId) && info.groupId >= 0) {
              sessionGroupIds.set(session, info.groupId);
            }
            if (explicitName === null) {
              const autoName = autoGroupName(info);
              if (autoName.length > 0 && autoName !== config.tabGroupTitle) {
                try {
                  const renamed = await bridge.command(
                    "tabs.setGroup",
                    { tabId: info.id, title: autoName },
                    exec.signal
                  );
                  info = { ...info, groupTitle: renamed.title ?? autoName, groupColor: renamed.color ?? info.groupColor };
                } catch {
                  /* naming is best-effort */
                }
              }
            }
          }
        }
        if (info.url && new URL(info.url).origin === new URL(args.url).origin) {
          await beginCursor(exec, info);
        }
        touchTab(exec, info.id);
        const closedTabs = (args.tabId !== undefined || reused) ? [] : await enforceTabLimit(exec, info.id);
        return {
          reused,
          tabId: info.id,
          url: info.url,
          title: info.title,
          group: info.groupTitle ?? group,
          groupColor: info.groupColor ?? sessionGroupColor(exec),
          closedTabs,
        };
      }
    })
  );

  registerTool(
    defineTool({
      name: "chrome_group",
      description:
        "Name this session's Chrome tab group with a short purpose label (at most 24 characters) and/or change its color, so the user can tell groups apart. The group defaults to the first page's title; call this when starting a task to make the purpose explicit.",
      parameters: {
        name: {
          type: "string",
          description: "Short purpose label, at most 24 characters (for example \"GitHub repo review\").",
        },
        color: {
          type: "string",
          description: "Tab group color: grey, blue, red, yellow, green, pink, purple, cyan, or orange.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [
          {
            type: "text",
            text: value.tabId === null
              ? `Group name set to "${value.groupTitle}" (applies when the next tab opens).`
              : `Group renamed to "${value.groupTitle}" (${value.groupColor ?? "unchanged color"}).`,
          },
        ],
      },
      async execute(args, exec) {
        const session = sessionOf(exec);
        if (session === null) throw new Error("chrome_group requires an agent Session");
        const VALID_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
        let name;
        if (args.name !== undefined) {
          name = args.name.trim();
          if (name.length === 0) throw new Error("chrome_group needs a non-empty name");
          if (name.length > 24) throw new Error("chrome_group name must be at most 24 characters");
          groupNames.set(session, name);
        }
        if (args.color !== undefined && !VALID_COLORS.includes(args.color)) {
          throw new Error(`invalid tab group color ${JSON.stringify(args.color)}`);
        }
        const tabId = lastTabEntry(session, browserIdOf(exec))?.tabId;
        if (tabId === undefined) {
          return { tabId: null, groupTitle: name ?? sessionGroupName(exec) ?? config.tabGroupTitle, groupColor: args.color ?? sessionGroupColor(exec) };
        }
        const result = await bridge.command(
          "tabs.setGroup",
          {
            tabId,
            ...(name !== undefined ? { title: name } : {}),
            ...(args.color !== undefined ? { color: args.color } : {}),
          },
          exec.signal
        );
        return { tabId, groupTitle: result.title ?? name ?? "", groupColor: result.color ?? args.color };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_read_page",
      description:
        "Extract rendered document text, including content below the viewport. For visible browsing or lazy-loaded content, use chrome_snapshot, chrome_scroll, then inspect the new viewport. Uses the tab the agent used last, or the active tab, unless tabId is given. Asks for approval the first time a domain is interacted with.",
      parameters: {
        tabId: {
          type: "integer",
          description: "Tab to read; omit to use the agent's last tab or the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [
          {
            type: "text",
            text: `${value.url}\n${value.title}\n\n${value.text}${value.truncated ? "\n\n(text truncated)" : ""}`,
          },
        ],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        const page = await bridge.command("page.read", { tabId }, exec.signal);
        const truncated = page.text.length > config.maxSnapshotChars;
        return {
          tabId,
          url: page.url,
          title: page.title,
          text: truncated ? page.text.slice(0, config.maxSnapshotChars) : page.text,
          truncated,
        };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_eval",
      description:
        "Evaluate JavaScript in a Chrome tab and return the JSON value. Use it to extract data or read page state. For visible input and scrolling use chrome_click, chrome_type and chrome_scroll. Runs with the user's logged-in session; ask for approval is enforced per domain.",
      parameters: {
        expression: {
          type: "string",
          required: true,
          description: "JavaScript expression; promises are awaited, the value is JSON-returned.",
        },
        tabId: {
          type: "integer",
          description: "Tab to evaluate in; omit to use the agent's last tab or the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value.value) }],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        const result = await bridge.command("page.eval", { tabId, expression: args.expression }, exec.signal);
        return { tabId, value: result.value };
      },
    })
  );


  registerTool(
    defineTool({
      name: "chrome_snapshot",
      description:
        "Return a compact accessibility snapshot with stable refs like e1, element states, a snapshotId, and a diff from the previous snapshot. Use this to inspect before and after actions. To browse further, scroll at a visible element or at a point over the intended pane, then inspect again (use screenshot or both for visual state).",
      parameters: {
        tabId: {
          type: "integer",
          description: "Tab to snapshot; omit to use the agent's last tab or the active tab.",
        },
        maxElements: {
          type: "integer",
          description: "Maximum elements to return (default 120).",
        },
        disableDiffing: {
          type: "boolean",
          description: "Return a fresh full snapshot without diff metadata (like tab.ax.write({disableDiffing:true})).",
        },
        mode: {
          type: "string",
          description: '"state" (default), "screenshot", or "both".',
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => {
          const blocks = [];
          if (value.mode !== "screenshot" || value.attachment === undefined) {
            const text =
              typeof value.text === "string" && value.text.length > 0
                ? value.text
                : `${value.url}\n${value.title}\n\n` +
                  (value.elements.length === 0
                    ? "(no interactive elements)"
                    : value.elements
                        .map((element) => {
                          const flags = [
                            element.disabled ? "disabled" : "",
                            element.checked !== undefined ? `checked=${JSON.stringify(element.checked)}` : "",
                            element.selected ? "selected" : "",
                            element.expanded !== undefined ? `expanded=${element.expanded}` : "",
                            element.pressed !== undefined ? `pressed=${JSON.stringify(element.pressed)}` : "",
                          ].filter(Boolean);
                          return (
                            `[${element.ref}] ${element.role} ${JSON.stringify(element.name)}` +
                            (element.description ? ` — ${JSON.stringify(element.description)}` : "") +
                            (element.value !== undefined ? ` = ${JSON.stringify(element.value)}` : "") +
                            (flags.length > 0 ? ` (${flags.join(", ")})` : "")
                          );
                        })
                        .join("\n")) +
                  (value.truncated ? "\n\n(elements truncated)" : "") +
                  (value.snapshotId ? `\n\nsnapshot: ${value.snapshotId}${value.changed === false ? " (no AX change)" : ""}` : "");
            blocks.push({
              type: "text",
              text: `${text}${value.screenshotPath !== undefined ? `\nScreenshot: ${value.screenshotPath}` : ""}`,
            });
          }
          if (value.attachment !== undefined) blocks.push({ type: "image", attachment: value.attachment });
          return blocks.length > 0 ? blocks : [{ type: "text", text: "Screenshot captured." }];
        },
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        const mode = String(args.mode ?? "state").toLowerCase();
        if (!["state", "screenshot", "both"].includes(mode)) throw new Error('chrome_snapshot mode must be "state", "screenshot", or "both"');
        const snapshot = await bridge.command(
          "page.snapshot",
          { tabId, maxElements: args.maxElements ?? 120, disableDiffing: args.disableDiffing === true },
          exec.signal
        );
        const result = { tabId, mode, ...snapshot };
        if (typeof result.text !== "string") {
          result.text =
            `Browser tab: ${tabId}, Title: ${JSON.stringify(result.title ?? "")}, URL: ${JSON.stringify(result.url ?? "")}\n` +
            (Array.isArray(result.elements) && result.elements.length > 0
              ? result.elements
                  .map((element) => `[${element.ref}] ${element.role} ${JSON.stringify(element.name ?? "")}`)
                  .join("\n")
              : "(no interactive elements)");
        }
        if (typeof result.text === "string" && result.text.length > config.maxSnapshotChars) {
          result.text = `${result.text.slice(0, config.maxSnapshotChars)}\n\n(text truncated)`;
        }
        if (mode === "state") return result;
        const shot = await bridge.command("page.screenshot", { tabId }, exec.signal);
        const bytes = Buffer.from(shot.dataBase64, "base64");
        if (admitImage !== null) {
          result.attachment = await admitImage({
            data: new Uint8Array(bytes),
            mediaType: shot.mediaType ?? "image/png",
            name: `chrome-ax-${snapshot.snapshotId ?? `tab${tabId}`}.${(shot.mediaType ?? "image/png").includes("jpeg") ? "jpg" : "png"}`,
          });
        } else if (exec.agent !== undefined) {
          const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
          const dir = join(cwd, "chrome-screenshots");
          await mkdir(dir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const path = join(dir, `chrome-ax-${stamp}-tab${tabId}.png`);
          await writeFile(path, bytes);
          result.screenshotPath = path;
        }
        return result;
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_act",
      description:
        "Run several browser actions in ONE tool call to avoid a round trip per step. Each action is {tool, args} using any chrome_* tool. Results of read/snapshot/eval actions are returned inline (truncated to maxResultChars), so actions can observe page state. Actions run in order and stop at the first error.",
      parameters: {
        actions: {
          type: "array",
          required: true,
          description: "Ordered actions; each is {tool, args}. Stops at the first failing action.",
          items: {
            type: "object",
            additionalProperties: true,
            properties: {
              tool: {
                type: "string",
                required: true,
                description: "A chrome_* tool name.",
              },
              args: {
                type: "object",
                additionalProperties: true,
                description: "Arguments for that tool.",
              },
            },
          },
        },
        maxResultChars: {
          type: "number",
          description: "Maximum characters of each action's result value; defaults to 4000.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => {
          const blocks = [];
          value.results.forEach((result, index) => {
            if (result.ok && Array.isArray(result.blocks) && result.blocks.length > 0) {
              blocks.push({ type: "text", text: `${index + 1}. ${result.tool}:` });
              blocks.push(...result.blocks);
              return;
            }
            blocks.push({
              type: "text",
              text:
                `${index + 1}. ${result.tool}: ${result.ok ? "ok" : `ERROR ${result.error}`}` +
                (result.ok && result.summary !== undefined ? `\n${result.summary}` : ""),
            });
          });
          if (value.stopped) blocks.push({ type: "text", text: `Stopped at action ${value.results.length}; later actions were not run.` });
          return blocks.length > 0 ? blocks : [{ type: "text", text: "No actions." }];
        },
      },
      async execute(args, exec) {
        if (!Array.isArray(args.actions) || args.actions.length === 0) {
          throw new Error("chrome_act needs at least one action");
        }
        if (args.actions.length > 20) throw new Error("chrome_act accepts at most 20 actions");
        const maxChars = Math.max(200, Math.min(20000, Number(args.maxResultChars) || 4000));
        const isObservation = new Set([
          "chrome_read_page", "chrome_eval", "chrome_snapshot", "chrome_find", "chrome_scroll",
          "chrome_status", "chrome_tabs", "chrome_open_tabs", "chrome_logs",
          "chrome_page_assets", "chrome_history", "chrome_bookmarks", "chrome_js",
          "chrome_webmcp", "chrome_cdp", "chrome_download", "chrome_element_info",
          "chrome_element_screenshot", "chrome_screenshot",
        ]);
        const results = [];
        let stopped = false;
        for (const action of args.actions) {
          const definition = definitions.get(action.tool);
          if (definition === undefined) {
            results.push({ tool: action.tool, ok: false, error: "unknown tool" });
            stopped = true;
            break;
          }
          try {
            const value = await definition.execute(action.args ?? {}, exec);
            const summary = isObservation.has(action.tool)
              ? JSON.stringify(value).slice(0, maxChars)
              : undefined;
            let blocks =
              isObservation.has(action.tool) && typeof definition.output?.render === "function"
                ? definition.output.render(action.args ?? {}, value)
                : undefined;
            if (blocks !== undefined) {
              blocks = blocks.map((block) =>
                block.type === "text" && typeof block.text === "string" && block.text.length > maxChars
                  ? { ...block, text: `${block.text.slice(0, maxChars)}\n…(truncated)` }
                  : block
              );
            }
            results.push({ tool: action.tool, ok: true, value, ...(summary !== undefined ? { summary } : {}), ...(blocks !== undefined ? { blocks } : {}) });
          } catch (error) {
            results.push({ tool: action.tool, ok: false, error: String(error?.message ?? error) });
            stopped = true;
            break;
          }
        }
        return { results, stopped };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_click",
      description:
        "Click in a Chrome tab with a real mouse event. Pass a CSS selector to click an element, or x/y viewport coordinates. Uses the agent's last tab or the active tab unless tabId is given.",
      parameters: {
        ref: {
          type: "string",
          description: 'Element ref from chrome_snapshot (for example "e3"). Preferred over CSS selectors.',
        },
        selector: {
          type: "string",
          description: "CSS selector of the element to click; the element is scrolled into view first.",
        },
        x: { type: "integer", description: "Viewport x coordinate (when selector is omitted)." },
        y: { type: "integer", description: "Viewport y coordinate (when selector is omitted)." },
        button: {
          type: "string",
          description: "Mouse button: left (default), middle, or right.",
        },
        clickCount: {
          type: "integer",
          description: "Number of clicks: 1 (default) or 2 for a double click.",
        },
        duration: {
          type: "number",
          description:
            "Seconds to hold the mouse button down before releasing (0–30). Useful for long-press menus and drag handles; defaults to 0.",
        },
        waitForDownload: {
          type: "boolean",
          description:
            "Wait for the download this click triggers and return its id/filename/state. Use for download links and export buttons.",
        },
        downloadTimeoutMs: {
          type: "number",
          description: "Download wait timeout in milliseconds; defaults to 30000.",
        },
        timeoutMs: {
          type: "number",
          description: "Selector wait timeout in milliseconds; defaults to 3000.",
        },
        modifiers: {
          type: "array",
          description: 'Modifier keys held during the click: "Alt", "Control", "Meta", "Shift".',
          items: { type: "string" },
        },
        tabId: {
          type: "integer",
          description: "Tab to click in; omit to use the agent's last tab or the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [
          {
            type: "text",
            text:
              value.selector !== undefined
                ? `Clicked ${value.selector} (${value.tag}${value.text ? ` "${value.text}"` : ""}) at (${Math.round(value.x)}, ${Math.round(value.y)}).`
                : `Clicked at (${value.x}, ${value.y}).`,
          },
        ],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        const clickOptions = {
          button: args.button,
          clickCount: args.clickCount,
          duration: args.duration,
          waitForDownload: args.waitForDownload,
          downloadTimeoutMs: args.downloadTimeoutMs,
          timeoutMs: args.timeoutMs,
          modifiers: args.modifiers,
        };
        if (args.ref !== undefined) {
          const hit = await bridge.command(
            "input.clickRef",
            { tabId, ref: args.ref, ...clickOptions },
            exec.signal
          );
          return { tabId, ref: args.ref, ...hit };
        }
        if (args.selector !== undefined) {
          const hit = await bridge.command(
            "input.clickSelector",
            { tabId, selector: args.selector, ...clickOptions },
            exec.signal
          );
          return { tabId, selector: args.selector, ...hit };
        }
        if (args.x === undefined || args.y === undefined) {
          throw new Error("chrome_click needs a ref, a selector, or both x and y");
        }
        const hit = await bridge.command(
          "input.click",
          { tabId, x: args.x, y: args.y, ...clickOptions },
          exec.signal
        );
        return { tabId, x: args.x, y: args.y, ...hit };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_type",
      description:
        "Type text into a Chrome tab with real keyboard input. Pass a ref or selector to focus that element first, then the text is inserted; otherwise text goes to the currently focused element. Uses the agent's last tab or the active tab unless tabId is given.",
      parameters: {
        text: { type: "string", required: true, description: "Text to type." },
        ref: {
          type: "string",
          description: 'Element ref from chrome_snapshot; clicks that element before typing.',
        },
        selector: {
          type: "string",
          description: "CSS selector of the field to focus before typing.",
        },
        clear: {
          type: "boolean",
          description: "Select-all and delete the field before typing. Defaults to false.",
        },
        timeoutMs: {
          type: "number",
          description: "Selector wait timeout in milliseconds; defaults to 3000.",
        },
        tabId: {
          type: "integer",
          description: "Tab to type in; omit to use the agent's last tab or the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [
          { type: "text", text: `Typed ${value.typed} characters${value.selector ? ` into ${value.selector}` : ""}.` },
        ],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        if (args.ref !== undefined) {
          await bridge.command("input.focusRef", { tabId, ref: args.ref }, exec.signal);
        } else if (args.selector !== undefined) {
          await bridge.command(
            "input.focusSelector",
            { tabId, selector: args.selector, ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}) },
            exec.signal
          );
        }
        if (args.clear === true) {
          await bridge.command("input.key", { tabId, key: "a", modifiers: ["control"] }, exec.signal);
          await bridge.command("input.key", { tabId, key: "Backspace" }, exec.signal);
        }
        const result = await bridge.command("input.type", { tabId, text: args.text }, exec.signal);
        return {
          tabId,
          ...(args.selector !== undefined ? { selector: args.selector } : {}),
          typed: result.typed,
        };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_key",
      description:
        "Press a key in a Chrome tab with real keyboard events: Enter, Tab, Escape, Backspace, Delete, arrows, Home, End, PageUp, PageDown, Space, function keys, or a single character. Supports xdotool-style chords such as \"super+c\" and \"shift+Return\". Modifiers combine control/alt/shift/meta. A ref focuses that element first; duration holds the key from 0–30 seconds. Uses the agent's last tab or the active tab unless tabId is given.",
      parameters: {
        key: { type: "string", required: true, description: 'Key name or chord, e.g. "Enter", "super+c", or "a".' },
        modifiers: {
          type: "array",
          description: 'Modifier names: "control", "alt", "shift", "meta".',
          items: { type: "string" },
        },
        ref: {
          type: "string",
          description: "Optional snapshot ref to focus before sending the key.",
        },
        duration: {
          type: "number",
          description: "Seconds to hold the key combination before releasing it (0–30); defaults to 0.",
        },
        tabId: {
          type: "integer",
          description: "Tab to press the key in; omit to use the agent's last tab or the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [
          { type: "text", text: `Pressed ${value.modifiers.length > 0 ? value.modifiers.join("+") + "+" : ""}${value.key}${value.duration ? ` (held ${value.duration}s)` : ""}.` },
        ],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        if (args.ref !== undefined) {
          await bridge.command("input.focusRef", { tabId, ref: args.ref }, exec.signal);
        }
        const result = await bridge.command(
          "input.key",
          { tabId, key: args.key, modifiers: args.modifiers, duration: args.duration },
          exec.signal
        );
        return { tabId, ...result };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_scroll",
      description:
        "Browse or reveal more of the page with real input. Use direction and pages (default 1) over a snapshot ref or x/y point in the scrollable pane. Use pixel deltas for a native Chrome scroll gesture. Passing only ref brings it into view. Inspect the new viewport after scrolling.",
      parameters: {
        ref: {
          type: "string",
          description: 'Wheel over this element (e.g. "e12"); ref alone brings it into view.',
        },
        modifiers: { type: "array", items: { type: "string" }, description: "Modifiers for pixel scrolling." },
        direction: { type: "string", description: "down, up, left or right (abbreviations d/u/l/r)." },
        pages: {
          type: "number",
          description:
            "Number of target heights (vertical) or widths (horizontal). At a coordinate, use the viewport size. Signed pages without direction are supported.",
        },
        deltaY: {
          type: "integer",
          description: "Vertical wheel delta in pixels; positive scrolls down (e.g. 600).",
        },
        deltaX: {
          type: "integer",
          description: "Horizontal wheel delta in pixels; positive scrolls right.",
        },
        x: {
          type: "integer",
          description: "Viewport x coordinate to scroll at; defaults to the viewport center.",
        },
        y: {
          type: "integer",
          description: "Viewport y coordinate to scroll at; defaults to the viewport center.",
        },
        tabId: {
          type: "integer",
          description: "Tab to scroll; omit to use the agent's last tab or the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [
          {
            type: "text",
            text:
              value.ref !== undefined && value.deltaX === undefined
                ? `Scrolled ${value.ref} into view.`
                : `Sent scroll input (${value.deltaX}, ${value.deltaY}) px. Inspect the new viewport.`,
          },
        ],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        const hasDistance = args.direction !== undefined || args.pages !== undefined || args.deltaX !== undefined || args.deltaY !== undefined;
        if (args.ref !== undefined && !hasDistance) {
          const point = await bridge.command("page.scrollRef", { tabId, ref: args.ref }, exec.signal);
          return { tabId, ref: args.ref, ...point };
        }
        if (!hasDistance) {
          throw new Error("chrome_scroll needs either a ref, pages, or deltaX/deltaY");
        }
        const result = await bridge.command(
          "page.scroll",
          {
            tabId,
            ...(args.pages !== undefined ? { pages: args.pages } : {}),
            ...(args.direction !== undefined ? { direction: args.direction } : {}),
            ...(args.ref !== undefined ? { ref: args.ref } : {}),
            ...(args.modifiers !== undefined ? { modifiers: args.modifiers } : {}),
            deltaX: args.deltaX ?? 0,
            deltaY: args.deltaY ?? 0,
            ...(args.x !== undefined ? { x: args.x } : {}),
            ...(args.y !== undefined ? { y: args.y } : {}),
          },
          exec.signal
        );
        return { tabId, ...result };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_move",
      description:
        "Move the virtual mouse cursor to an element (by ref or CSS selector) or to x/y viewport coordinates without clicking. Useful to reveal hover menus.",
      parameters: {
        ref: {
          type: "string",
          description: "Element ref from chrome_snapshot.",
        },
        selector: {
          type: "string",
          description: "CSS selector of the element to hover.",
        },
        x: { type: "integer", description: "Viewport x coordinate." },
        y: { type: "integer", description: "Viewport y coordinate." },
        tabId: {
          type: "integer",
          description: "Tab to move in; omit to use the agent's last tab or the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [
          { type: "text", text: `Cursor moved to (${Math.round(value.x)}, ${Math.round(value.y)}).` },
        ],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        const point = await bridge.command(
          "input.move",
          {
            tabId,
            ...(args.ref !== undefined ? { ref: args.ref } : {}),
            ...(args.selector !== undefined ? { selector: args.selector } : {}),
            ...(args.x !== undefined ? { x: args.x } : {}),
            ...(args.y !== undefined ? { y: args.y } : {}),
          },
          exec.signal
        );
        return { tabId, ...point };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_drag",
      description:
        "Drag with a real mouse from one element (ref) or point to another, with the virtual cursor animating along the path. Useful for sliders, drag-and-drop lists, and canvas editors.",
      parameters: {
        fromRef: { type: "string", description: "Source element ref from chrome_snapshot." },
        toRef: { type: "string", description: "Target element ref from chrome_snapshot." },
        fromX: { type: "integer", description: "Source viewport x (when fromRef is omitted)." },
        fromY: { type: "integer", description: "Source viewport y (when fromRef is omitted)." },
        toX: { type: "integer", description: "Target viewport x (when toRef is omitted)." },
        toY: { type: "integer", description: "Target viewport y (when toRef is omitted)." },
        tabId: {
          type: "integer",
          description: "Tab to drag in; omit to use the agent's last tab or the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [
          {
            type: "text",
            text: `Dragged from (${Math.round(value.from.x)}, ${Math.round(value.from.y)}) to (${Math.round(value.to.x)}, ${Math.round(value.to.y)}).`,
          },
        ],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        const result = await bridge.command(
          "input.drag",
          {
            tabId,
            ...(args.fromRef !== undefined ? { fromRef: args.fromRef } : {}),
            ...(args.toRef !== undefined ? { toRef: args.toRef } : {}),
            ...(args.fromX !== undefined ? { fromX: args.fromX } : {}),
            ...(args.fromY !== undefined ? { fromY: args.fromY } : {}),
            ...(args.toX !== undefined ? { toX: args.toX } : {}),
            ...(args.toY !== undefined ? { toY: args.toY } : {}),
          },
          exec.signal
        );
        return { tabId, ...result };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_screenshot",
      description:
        "Capture a screenshot of a Chrome tab. By default captures the viewport; pass fullPage=true for the entire page or clip={x,y,width,height} for a crop. PNG by default, or JPEG with format=jpeg and an optional quality.",
      parameters: {
        fullPage: { type: "boolean", description: "Capture the full scrollable page instead of the viewport." },
        clip: {
          type: "object",
          description: "Optional crop rectangle: {x, y, width, height, scale?} in CSS pixels.",
          additionalProperties: true,
        },
        format: { type: "string", description: '"png" (default) or "jpeg".' },
        quality: { type: "number", description: "JPEG quality 0–100; defaults to 80." },
        tabId: {
          type: "integer",
          description: "Tab to capture; omit to use the agent's last tab or the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) =>
          value.attachment !== undefined
            ? [
                { type: "image", attachment: value.attachment },
                {
                  type: "text",
                  text: `Screenshot of tab [${value.tabId}] (${value.attachment.width}×${value.attachment.height}, ${value.attachment.bytes} bytes).`,
                },
              ]
            : [
                {
                  type: "text",
                  text: `Screenshot saved to ${value.path} (${value.bytes} bytes). View it with the read_image tool.`,
                },
              ],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        const format = String(args.format ?? "png").toLowerCase() === "jpeg" ? "jpeg" : "png";
        const shot = await bridge.command(
          "page.screenshot",
          {
            tabId,
            format,
            ...(args.quality !== undefined ? { quality: args.quality } : {}),
            ...(args.fullPage === true ? { fullPage: true } : {}),
            ...(args.clip !== undefined ? { clip: args.clip } : {}),
          },
          exec.signal
        );
        const bytes = Buffer.from(shot.dataBase64, "base64");
        const mediaType = shot.mediaType ?? (format === "jpeg" ? "image/jpeg" : "image/png");
        const extension = format === "jpeg" ? "jpg" : "png";
        if (admitImage !== null) {
          const attachment = await admitImage({
            data: new Uint8Array(bytes),
            mediaType,
            name: `chrome-tab${tabId}.${extension}`,
          });
          return { tabId, attachment };
        }
        if (exec.agent === undefined) throw new Error("chrome_screenshot requires an agent Session");
        const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
        const dir = join(cwd, "chrome-screenshots");
        await mkdir(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const path = join(dir, `chrome-${stamp}-tab${tabId}.${extension}`);
        await writeFile(path, bytes);
        return { tabId, path, bytes: bytes.length };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_element_info",
      description:
        "Return locator-oriented metadata for elements at a screenshot coordinate: tags, attributes, text, bounding boxes, and ranked CSS selector candidates (like playwright.elementInfo).",
      parameters: {
        x: { type: "number", required: true, description: "Viewport x coordinate." },
        y: { type: "number", required: true, description: "Viewport y coordinate." },
        tabId: { type: "integer", description: "Tab to inspect; omit to use the active tab." },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2).slice(0, 16000) }],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        return bridge.command("page.elementInfo", { tabId, x: args.x, y: args.y }, exec.signal);
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_element_screenshot",
      description: "Capture a cropped screenshot around a viewport coordinate (like playwright.elementScreenshot).",
      parameters: {
        x: { type: "number", required: true, description: "Viewport x coordinate." },
        y: { type: "number", required: true, description: "Viewport y coordinate." },
        size: { type: "number", description: "Crop width/height in CSS pixels; defaults to 320." },
        tabId: { type: "integer", description: "Tab to capture; omit to use the active tab." },
      },
      output: {
        schema: looseObject,
        render: (_args, value) =>
          value.path !== undefined
            ? [{ type: "text", text: `Element screenshot saved to ${value.path} (${value.bytes} bytes).` }]
            : [{ type: "text", text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error("chrome_element_screenshot requires an agent Session");
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        const shot = await bridge.command(
          "page.elementScreenshot",
          { tabId, x: args.x, y: args.y, ...(args.size !== undefined ? { size: args.size } : {}) },
          exec.signal
        );
        const bytes = Buffer.from(shot.dataBase64, "base64");
        const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
        const dir = join(cwd, "chrome-screenshots");
        await mkdir(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const path = join(dir, `chrome-element-${stamp}-tab${tabId}.png`);
        await writeFile(path, bytes);
        return { tabId, path, bytes: bytes.length, point: shot.point, size: shot.size };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_upload",
      description:
        "Upload files to a page. Pass selector for a visible <input type=file>, or clickSelector for a button that opens the native file chooser. Files must be absolute paths on the browser machine.",
      parameters: {
        files: {
          type: "array",
          required: true,
          description: "Absolute file paths to upload.",
          items: { type: "string" },
        },
        selector: {
          type: "string",
          description: "CSS selector for an existing <input type=file>.",
        },
        clickSelector: {
          type: "string",
          description: "CSS selector for the button/label that opens the file chooser.",
        },
        timeoutMs: {
          type: "number",
          description: "File chooser wait timeout in milliseconds; defaults to 10000.",
        },
        tabId: {
          type: "integer",
          description: "Tab to upload in; omit to use the agent's last tab or the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: `Uploaded ${value.count} file(s) to ${value.selector ?? value.clickSelector}.` }],
      },
      async execute(args, exec) {
        if (!Array.isArray(args.files) || args.files.length === 0) throw new Error("chrome_upload needs at least one file");
        if (args.selector === undefined && args.clickSelector === undefined) {
          throw new Error("chrome_upload needs selector or clickSelector");
        }
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        const result = await bridge.command(
          "input.upload",
          {
            tabId,
            files: args.files,
            ...(args.selector !== undefined ? { selector: args.selector } : {}),
            ...(args.clickSelector !== undefined ? { clickSelector: args.clickSelector } : {}),
            ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          },
          exec.signal
        );
        return { tabId, ...result };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_download",
      description:
        "Download a URL directly through Chrome's download manager, or list recent downloads. For a download triggered by clicking a page control, use chrome_click with waitForDownload=true instead.",
      parameters: {
        url: { type: "string", description: "Absolute http(s) URL to download. Omit to list recent downloads." },
        filename: { type: "string", description: "Optional suggested filename or relative path." },
        limit: { type: "number", description: "Number of recent downloads to return; defaults to 20." },
      },
      output: {
        schema: looseObject,
        render: (_args, value) =>
          value.downloads === undefined
            ? [{ type: "text", text: `Started download ${value.id}.` }]
            : [
                {
                  type: "text",
                  text:
                    value.downloads.length === 0
                      ? "No downloads found."
                      : value.downloads
                          .map(
                            (item) =>
                              `[${item.id}] ${item.state} ${item.filename ?? item.url} (${item.bytesReceived}/${item.totalBytes} bytes)`
                          )
                          .join("\n"),
                },
              ],
      },
      async execute(args, exec) {
        if (args.url === undefined) {
          const result = await bridge.command("downloads.list", { limit: args.limit ?? 20 }, exec.signal);
          return result;
        }
        parseHttpUrl(args.url);
        await ensureDomainAllowed(exec, args.url);
        return bridge.command(
          "downloads.download",
          {
            url: args.url,
            ...(args.filename !== undefined ? { filename: args.filename } : {}),
          },
          exec.signal
        );
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_clipboard",
      description:
        'Read or write text through the browser page clipboard. action "paste" writes the text and pastes it into a focused element with a real paste shortcut.',
      parameters: {
        action: { type: "string", required: true, description: 'Action: "read", "write", or "paste".' },
        text: { type: "string", description: "Text to write/paste when action is write or paste." },
        ref: {
          type: "string",
          description: "Optional snapshot ref to focus before pasting.",
        },
        format: {
          type: "string",
          description: 'Paste format: "text" (default), "md", or "html".',
        },
        tabId: {
          type: "integer",
          description: "Tab whose clipboard to use; omit to use the agent's last tab or the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [
          {
            type: "text",
            text:
              value.pasted !== undefined
                ? `Pasted ${value.chars} characters${value.ref ? ` into ${value.ref}` : ""}.`
                : value.written !== undefined
                  ? `Wrote ${value.chars} characters to the clipboard.`
                  : `Clipboard: ${JSON.stringify(value.text ?? "")}`,
          },
        ],
      },
      async execute(args, exec) {
        const action = String(args.action ?? "").toLowerCase();
        if (!["read", "write", "paste"].includes(action)) throw new Error('chrome_clipboard action must be "read", "write", or "paste"');
        if (action !== "read" && typeof args.text !== "string") throw new Error(`chrome_clipboard ${action} needs text`);
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        if (action === "paste") {
          return bridge.command(
            "clipboard.paste",
            { tabId, text: args.text, ...(args.ref !== undefined ? { ref: args.ref } : {}), ...(args.format !== undefined ? { format: args.format } : {}) },
            exec.signal
          );
        }
        return bridge.command(
          action === "write" ? "clipboard.write" : "clipboard.read",
          { tabId, ...(action === "write" ? { text: args.text } : {}) },
          exec.signal
        );
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_dialog",
      description: "Inspect or handle an open JavaScript dialog (alert, confirm, prompt, beforeunload).",
      parameters: {
        action: { type: "string", description: 'Action: "get" (default) or "handle".' },
        handleAction: { type: "string", description: 'When action is handle: "accept" or "dismiss".' },
        promptText: { type: "string", description: "Text to enter for a prompt() dialog." },
        tabId: {
          type: "integer",
          description: "Tab to inspect; omit to use the agent's last tab or the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [
          {
            type: "text",
            text:
              value.dialog === null || value.dialog === undefined
                ? "No open JavaScript dialog."
                : `Dialog (${value.dialog.type}): ${JSON.stringify(value.dialog.message ?? "")}`,
          },
        ],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        if (String(args.action ?? "get").toLowerCase() === "get") {
          return bridge.command("dialog.get", { tabId }, exec.signal);
        }
        const action = String(args.handleAction ?? "").toLowerCase();
        if (!["accept", "dismiss"].includes(action)) {
          throw new Error('chrome_dialog handleAction must be "accept" or "dismiss"');
        }
        return bridge.command(
          "dialog.handle",
          { tabId, action, ...(args.promptText !== undefined ? { promptText: args.promptText } : {}) },
          exec.signal
        );
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_management",
      description:
        "Use Chrome's organization APIs for tabs/tabGroups/windows/bookmarks/history/sessions/topSites. This is for browser organization, not navigation: tabs.update cannot carry a URL and windows.create cannot open a URL.",
      parameters: {
        namespace: {
          type: "string",
          required: true,
          description: "One of: tabs, tabGroups, windows, bookmarks, history, sessions, topSites.",
        },
        method: {
          type: "string",
          required: true,
          description: "Chrome API method name, e.g. query, get, update, create, move, remove, search.",
        },
        args: {
          type: "array",
          description: "Positional arguments passed to the Chrome API method.",
          items: { type: "json" },
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value.value, null, 2).slice(0, 12000) }],
      },
      async execute(args, exec) {
        if (typeof args.namespace !== "string" || typeof args.method !== "string") {
          throw new Error("chrome_management needs namespace and method");
        }
        const callArgs = Array.isArray(args.args) ? args.args : [];
        const result = await bridge.command(
          "management.call",
          { namespace: args.namespace, method: args.method, args: callArgs },
          exec.signal
        );
        const mutating = /^(create|update|move|remove|delete|add|set|close|group|ungroup)$/i.test(args.method);
        if (mutating) recordChange(args.namespace, args.method, callArgs, null, result?.value ?? null);
        return result;
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_logs",
      description: "Read recent console and browser log entries captured for a tab.",
      parameters: {
        levels: {
          type: "array",
          description: "Optional levels to include: debug, info, log, warn, error.",
          items: { type: "string" },
        },
        filter: { type: "string", description: "Optional case-insensitive substring filter." },
        limit: { type: "number", description: "Maximum entries; defaults to 100." },
        tabId: {
          type: "integer",
          description: "Tab to read logs from; omit to use the agent's last tab or the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [
          {
            type: "text",
            text:
              value.logs.length === 0
                ? "No console logs captured."
                : value.logs
                    .map((entry) => `[${entry.level}] ${entry.message}`)
                    .join("\n")
                    .slice(0, 12000),
          },
        ],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        return bridge.command(
          "tab.logs",
          {
            tabId,
            ...(args.levels !== undefined ? { levels: args.levels } : {}),
            ...(args.filter !== undefined ? { filter: args.filter } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
          },
          exec.signal
        );
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_viewport",
      description: "Set or reset an explicit viewport override for a tab (useful for responsive/device-size testing).",
      parameters: {
        width: { type: "integer", description: "Viewport width in CSS pixels." },
        height: { type: "integer", description: "Viewport height in CSS pixels." },
        deviceScaleFactor: { type: "number", description: "Device scale factor; defaults to 1." },
        mobile: { type: "boolean", description: "Whether to emulate a mobile viewport." },
        reset: { type: "boolean", description: "Clear the override and return to the default browser size." },
        tabId: {
          type: "integer",
          description: "Tab to apply the viewport to; omit to use the agent's last tab or the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) =>
          value.width === undefined
            ? [{ type: "text", text: "Viewport override cleared." }]
            : [{ type: "text", text: `Viewport set to ${value.width}×${value.height}.` }],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        if (args.reset === true) return bridge.command("viewport.reset", { tabId }, exec.signal);
        if (args.width === undefined || args.height === undefined) {
          throw new Error("chrome_viewport needs width and height, or reset=true");
        }
        return bridge.command(
          "viewport.set",
          {
            tabId,
            width: args.width,
            height: args.height,
            ...(args.deviceScaleFactor !== undefined ? { deviceScaleFactor: args.deviceScaleFactor } : {}),
            ...(args.mobile !== undefined ? { mobile: args.mobile } : {}),
          },
          exec.signal
        );
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_visibility",
      description: "Get or set whether the browser window containing a tab is visible/focused.",
      parameters: {
        visible: { type: "boolean", description: "Set true to show/focus the browser, false to minimize it. Omit to read state." },
        tabId: {
          type: "integer",
          description: "Tab whose window to inspect; omit to use the agent's last tab or the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: `Browser visible: ${value.visible}` }],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        return bridge.command(
          args.visible === undefined ? "visibility.get" : "visibility.set",
          { tabId, ...(args.visible !== undefined ? { visible: args.visible } : {}) },
          exec.signal
        );
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_cdp",
      description:
        "Send a raw Chrome DevTools Protocol command to a tab, or read buffered CDP events. Use for advanced development/debugging when the higher-level tools cannot express the operation.",
      parameters: {
        action: { type: "string", description: 'Action: "send" (default) or "events".' },
        method: { type: "string", description: "CDP method for action=send, e.g. Network.enable." },
        params: { type: "object", description: "CDP command parameters.", additionalProperties: true },
        afterSequence: { type: "number", description: "Return events after this cursor for action=events." },
        limit: { type: "number", description: "Maximum events to return; defaults to 200." },
        methods: {
          type: "array",
          description: "Optional CDP event method names to include.",
          items: { type: "string" },
        },
        tabId: {
          type: "integer",
          description: "Tab to use; omit to use the agent's last tab or the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2).slice(0, 16000) }],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        const action = String(args.action ?? "send").toLowerCase();
        if (action === "events") {
          return bridge.command(
            "cdp.events",
            {
              tabId,
              ...(args.afterSequence !== undefined ? { afterSequence: args.afterSequence } : {}),
              ...(args.limit !== undefined ? { limit: args.limit } : {}),
              ...(args.methods !== undefined ? { methods: args.methods } : {}),
            },
            exec.signal
          );
        }
        if (typeof args.method !== "string" || args.method.length === 0) throw new Error("chrome_cdp send needs method");
        return bridge.command(
          "cdp.send",
          { tabId, method: args.method, params: args.params ?? {} },
          exec.signal
        );
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_page_assets",
      description:
        "Inventory images, stylesheets, scripts, and videos observed on the current page, or bundle selected assets into a local directory.",
      parameters: {
        bundle: { type: "boolean", description: "When true, download assets into a workspace directory." },
        kinds: {
          type: "array",
          description: 'Optional kinds to bundle: "image", "stylesheet", "video", "font".',
          items: { type: "string" },
        },
        tabId: {
          type: "integer",
          description: "Tab to inspect; omit to use the agent's last tab or the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2).slice(0, 16000) }],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        const inventory = await bridge.command("page.assets", { tabId }, exec.signal);
        if (args.bundle !== true) return inventory;
        if (exec.agent === undefined) throw new Error("chrome_page_assets bundle requires an agent Session");
        const wanted = new Set(Array.isArray(args.kinds) && args.kinds.length > 0 ? args.kinds : ["image", "stylesheet", "video"]);
        const candidates = [];
        for (const image of inventory.images ?? []) if (wanted.has("image")) candidates.push({ kind: "image", url: image.src, name: image.alt || "image" });
        for (const sheet of inventory.stylesheets ?? []) if (wanted.has("stylesheet")) candidates.push({ kind: "stylesheet", url: sheet.href, name: sheet.title || "stylesheet" });
        for (const video of inventory.videos ?? []) if (wanted.has("video")) candidates.push({ kind: "video", url: video.src, name: "video" });
        const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
        const directoryPath = join(cwd, "chrome-assets");
        await mkdir(directoryPath, { recursive: true });
        const assets = [];
        const failures = [];
        let index = 0;
        for (const candidate of candidates.slice(0, 50)) {
          if (typeof candidate.url !== "string" || !/^https?:/i.test(candidate.url)) continue;
          index += 1;
          try {
            const fetched = await bridge.command("page.fetch", { tabId, url: candidate.url }, exec.signal);
            const bytes = Buffer.from(fetched.base64 ?? "", "base64");
            const extension = candidate.kind === "stylesheet" ? "css" : candidate.kind === "video" ? "mp4" : "bin";
            const path = join(directoryPath, `${String(index).padStart(2, "0")}-${candidate.kind}.${extension}`);
            await writeFile(path, bytes);
            assets.push({ ...candidate, path, size: bytes.length, contentType: fetched.contentType ?? "" });
          } catch (error) {
            failures.push({ ...candidate, reason: String(error?.message ?? error) });
          }
        }
        return { pageUrl: inventory.pageUrl, directoryPath, assets, failures, requestedCount: candidates.length };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_export",
      description: "Export the current page to a local file as text, HTML, or PDF.",
      parameters: {
        format: { type: "string", description: 'Export format: "text" (default), "html", or "pdf".' },
        tabId: {
          type: "integer",
          description: "Tab to export; omit to use the agent's last tab or the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [
          { type: "text", text: `Exported ${value.format} to ${value.path} (${value.bytes} bytes).` },
        ],
      },
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error("chrome_export requires an agent Session");
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        const format = String(args.format ?? "text").toLowerCase();
        if (!["text", "html", "pdf"].includes(format)) {
          throw new Error('chrome_export format must be "text", "html", or "pdf"');
        }
        const result = await bridge.command("page.export", { tabId, format }, exec.signal);
        const bytes =
          format === "pdf"
            ? Buffer.from(result.dataBase64, "base64")
            : Buffer.from(result.text ?? "", "utf8");
        const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
        const dir = join(cwd, "chrome-exports");
        await mkdir(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const path = join(dir, `chrome-export-${stamp}-tab${tabId}.${format}`);
        await writeFile(path, bytes);
        return { tabId, format, path, bytes: bytes.length };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_set_value",
      description:
        "Set the value of an input/textarea/select identified by a chrome_snapshot ref and fire input/change events, or select text inside an editable element (action \"selectText\") with optional prefix/suffix and selectionType.",
      parameters: {
        action: { type: "string", description: 'Action: "set" (default) or "selectText".' },
        ref: { type: "string", required: true, description: "Element ref from chrome_snapshot." },
        value: { type: "string", description: "New value for action set." },
        text: { type: "string", description: "Text to select for action selectText." },
        prefix: { type: "string", description: "Text immediately before the selected text (disambiguates repeats)." },
        suffix: { type: "string", description: "Text immediately after the selected text." },
        selectionType: {
          type: "string",
          description: '"text" (default), "cursor_before", or "cursor_after".',
        },
        tabId: {
          type: "integer",
          description: "Tab to use; omit to use the agent's last tab or the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [
          {
            type: "text",
            text:
              value.selection !== undefined
                ? `Selected ${JSON.stringify(value.selection.text ?? "")} in ${value.ref}.`
                : `Set ${value.ref} to ${JSON.stringify(value.value)}.`,
          },
        ],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        const action = String(args.action ?? "set").toLowerCase();
        if (action === "selecttext") {
          if (typeof args.text !== "string") throw new Error("chrome_set_value selectText needs text");
          return bridge.command(
            "input.selectTextRef",
            {
              tabId,
              ref: args.ref,
              text: args.text,
              ...(args.prefix !== undefined ? { prefix: args.prefix } : {}),
              ...(args.suffix !== undefined ? { suffix: args.suffix } : {}),
              selectionType: args.selectionType ?? "text",
            },
            exec.signal
          );
        }
        if (action !== "set") throw new Error('chrome_set_value action must be "set" or "selectText"');
        if (args.value === undefined) throw new Error("chrome_set_value set needs value");
        return bridge.command("input.setValueRef", { tabId, ref: args.ref, value: args.value }, exec.signal);
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_select_option",
      description: "Select one or more options in a native <select> identified by a chrome_snapshot ref.",
      parameters: {
        ref: { type: "string", required: true, description: "Select element ref from chrome_snapshot." },
        values: {
          type: "array",
          required: true,
          description: "Option value(s), label(s), or index(es) to select.",
          items: { type: "json" },
        },
        tabId: {
          type: "integer",
          description: "Tab to use; omit to use the agent's last tab or the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: `Selected ${value.selected?.length ?? 0} option(s) in ${value.ref}.` }],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        return bridge.command("input.selectOptionRef", { tabId, ref: args.ref, values: args.values }, exec.signal);
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_find",
      description:
        "Find visible elements by CSS selector, ARIA role, accessible name, text, label, placeholder, or test id. Returns stable l1/l2 refs usable with chrome_click, chrome_type, chrome_set_value, and chrome_select_option.",
      parameters: {
        selector: { type: "string", description: "Optional CSS selector." },
        role: { type: "string", description: "ARIA role, e.g. button, link, textbox, checkbox." },
        name: { type: "string", description: "Accessible name (aria-label/title/alt/label/text)." },
        text: { type: "string", description: "Visible text substring." },
        hasText: { type: "string", description: "Filter to elements whose text contains this string." },
        hasNotText: { type: "string", description: "Filter out elements whose text contains this string." },
        label: { type: "string", description: "Form label text." },
        placeholder: { type: "string", description: "Input placeholder." },
        testId: { type: "string", description: "data-testid or data-test-id." },
        frame: {
          type: "array",
          description: "Optional same-origin iframe selector chain to scope the search.",
          items: { type: "string" },
        },
        has: { type: "json", description: "Require a descendant matching this CSS selector or locator criteria object." },
        hasNot: { type: "json", description: "Require no descendant matching this CSS selector or locator criteria object." },
        alt: { type: "string", description: "Image alt text." },
        title: { type: "string", description: "Element title attribute." },
        exact: { type: "boolean", description: "Require exact text matches instead of substring." },
        limit: { type: "number", description: "Maximum matches; defaults to 20." },
        tabId: {
          type: "integer",
          description: "Tab to search; omit to use the agent's last tab or the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [
          {
            type: "text",
            text:
              value.elements.length === 0
                ? "No matching elements."
                : value.elements
                    .map(
                      (element) =>
                        `[${element.ref}] ${element.role} ${JSON.stringify(element.name)}` +
                        (element.value !== undefined ? ` = ${JSON.stringify(element.value)}` : "") +
                        ` @ (${element.x}, ${element.y})${element.disabled ? " disabled" : ""}`
                    )
                    .join("\n"),
          },
        ],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        return bridge.command(
          "page.locate",
          {
            tabId,
            ...(args.selector !== undefined ? { selector: args.selector } : {}),
            ...(args.role !== undefined ? { role: args.role } : {}),
            ...(args.name !== undefined ? { name: args.name } : {}),
            ...(args.text !== undefined ? { text: args.text } : {}),
            ...(args.hasText !== undefined ? { hasText: args.hasText } : {}),
            ...(args.hasNotText !== undefined ? { hasNotText: args.hasNotText } : {}),
            ...(args.label !== undefined ? { label: args.label } : {}),
            ...(args.placeholder !== undefined ? { placeholder: args.placeholder } : {}),
            ...(args.testId !== undefined ? { testId: args.testId } : {}),
            ...(args.frame !== undefined ? { frame: args.frame } : {}),
            ...(args.has !== undefined ? { has: args.has } : {}),
            ...(args.hasNot !== undefined ? { hasNot: args.hasNot } : {}),
            ...(args.alt !== undefined ? { alt: args.alt } : {}),
            ...(args.title !== undefined ? { title: args.title } : {}),
            ...(args.exact !== undefined ? { exact: args.exact } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
          },
          exec.signal
        );
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_user_takeover",
      description:
        "Pause automation and ask the user to take over the browser for login, CAPTCHA, 2FA, payment confirmation, or another sensitive step. The browser window is focused first.",
      parameters: {
        reason: {
          type: "string",
          description: 'Reason: "authentication", "captcha", "user_requested", or "other".',
        },
        message: { type: "string", description: "Optional short explanation shown to the user." },
        tabId: {
          type: "integer",
          description: "Tab to show; omit to use the agent's last tab or the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: `User takeover ${value.completed ? "completed" : "declined"}.` }],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        try {
          await bridge.command("visibility.set", { tabId, visible: true }, exec.signal);
        } catch {
          /* focusing the window is best-effort */
        }
        const reason = String(args.reason ?? "other");
        const { answers } = await ctx.userQuestions.ask({
          questions: [
            {
              id: "chrome-takeover",
              header: "Chrome takeover",
              question:
                (args.message ? `${args.message}\n\n` : "") +
                `The agent is paused for ${reason}. Complete the step in the browser, then confirm.`,
              options: [
                { label: "完成 Done", description: "The user has finished; let the agent continue." },
                { label: "取消 Cancel", description: "Stop this task." },
              ],
            },
          ],
          agent: exec.agent,
          signal: exec.signal,
        });
        const answer = answers[0];
        const selected = answer?.selected ?? [];
        const completed = selected.some((label) => String(label).includes("完成") || String(label).includes("Done"));
        if (!completed) throw new Error("User cancelled the browser takeover.");
        return { tabId, completed: true, reason };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_history",
      description: "Search the user's browser history by text and optional time range.",
      parameters: {
        queries: {
          type: "array",
          description: "Search terms; joined with spaces for Chrome history.search.",
          items: { type: "string" },
        },
        from: { type: "string", description: "ISO 8601 lower bound for visit time." },
        to: { type: "string", description: "ISO 8601 upper bound for visit time." },
        limit: { type: "number", description: "Maximum entries; defaults to 50." },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [
          {
            type: "text",
            text:
              (value.value ?? []).length === 0
                ? "No history entries."
                : (value.value ?? [])
                    .map((item) => `${new Date(item.lastVisitTime).toISOString()} ${item.title ?? ""} — ${item.url}`)
                    .join("\n")
                    .slice(0, 12000),
          },
        ],
      },
      async execute(args, exec) {
        const search = {
          text: Array.isArray(args.queries) ? args.queries.join(" ") : "",
          maxResults: Math.max(1, Math.min(500, Number(args.limit) || 50)),
        };
        if (args.from !== undefined) search.startTime = new Date(args.from).getTime();
        if (args.to !== undefined) search.endTime = new Date(args.to).getTime();
        return bridge.command("management.call", { namespace: "history", method: "search", args: [search] }, exec.signal);
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_bookmarks",
      description: "Search, create, move, or remove Chrome bookmarks.",
      parameters: {
        action: { type: "string", required: true, description: 'Action: "search", "create", "move", or "remove".' },
        query: { type: "string", description: "Search query for action=search." },
        id: { type: "string", description: "Bookmark id for move/remove." },
        parentId: { type: "string", description: "Parent folder id for create/move." },
        title: { type: "string", description: "Bookmark title for create." },
        url: { type: "string", description: "Bookmark URL for create." },
        index: { type: "number", description: "Position index for move." },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value.value ?? null, null, 2).slice(0, 12000) }],
      },
      async execute(args, exec) {
        const action = String(args.action ?? "").toLowerCase();
        if (action === "search") {
          return bridge.command(
            "management.call",
            { namespace: "bookmarks", method: "search", args: [String(args.query ?? "")] },
            exec.signal
          );
        }
        if (action === "create") {
          return bridge.command(
            "management.call",
            {
              namespace: "bookmarks",
              method: "create",
              args: [{ title: args.title ?? args.url ?? "Bookmark", ...(args.url !== undefined ? { url: args.url } : {}), ...(args.parentId !== undefined ? { parentId: args.parentId } : {}) }],
            },
            exec.signal
          );
        }
        if (action === "move") {
          if (args.id === undefined) throw new Error("chrome_bookmarks move needs id");
          return bridge.command(
            "management.call",
            { namespace: "bookmarks", method: "move", args: [args.id, { ...(args.parentId !== undefined ? { parentId: args.parentId } : {}), ...(args.index !== undefined ? { index: args.index } : {}) }] },
            exec.signal
          );
        }
        if (action === "remove") {
          if (args.id === undefined) throw new Error("chrome_bookmarks remove needs id");
          return bridge.command("management.call", { namespace: "bookmarks", method: "remove", args: [args.id] }, exec.signal);
        }
        throw new Error('chrome_bookmarks action must be "search", "create", "move", or "remove"');
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_read_urls",
      description:
        "Load one or more URLs in temporary background tabs and extract their text or HTML without changing the current tab.",
      parameters: {
        urls: {
          type: "array",
          required: true,
          description: "Absolute http(s) URLs to read.",
          items: { type: "string" },
        },
        format: { type: "string", description: '"text" (default), "html", or "domSnapshot".' },
        timeoutMs: { type: "number", description: "Per-page load timeout in milliseconds; defaults to 15000." },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [
          {
            type: "text",
            text: value.results
              .map(
                (result) =>
                  `${result.url} — ${result.title ?? "(failed)"}\n${(result.content ?? result.error ?? "").slice(0, 4000)}`
              )
              .join("\n\n---\n\n"),
          },
        ],
      },
      async execute(args, exec) {
        if (!Array.isArray(args.urls) || args.urls.length === 0) throw new Error("chrome_read_urls needs at least one url");
        for (const url of args.urls) {
          parseHttpUrl(url);
          await ensureDomainAllowed(exec, url);
        }
        return bridge.command(
          "tabs.content",
          {
            urls: args.urls,
            ...(args.format !== undefined ? { format: args.format } : {}),
            ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          },
          exec.signal
        );
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_webmcp",
      description:
        "List or invoke page-defined WebMCP tools bound to the current document. Use action=list first, then pass the returned registrationId to action=invoke.",
      parameters: {
        action: { type: "string", description: 'Action: "list" (default) or "invoke".' },
        registrationId: { type: "string", description: "registrationId returned by action=list." },
        input: { type: "object", description: "JSON input for action=invoke.", additionalProperties: true },
        timeoutMs: { type: "number", description: "Invocation timeout in milliseconds; defaults to 30000." },
        tabId: {
          type: "integer",
          description: "Tab to use; omit to use the agent's last tab or the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2).slice(0, 16000) }],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        const action = String(args.action ?? "list").toLowerCase();
        if (action === "list") return bridge.command("webmcp.list", { tabId }, exec.signal);
        if (action !== "invoke") throw new Error('chrome_webmcp action must be "list" or "invoke"');
        if (typeof args.registrationId !== "string" || args.registrationId.length === 0) {
          throw new Error("chrome_webmcp invoke needs registrationId");
        }
        return bridge.command(
          "webmcp.invoke",
          {
            tabId,
            registrationId: args.registrationId,
            input: args.input ?? null,
            ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          },
          exec.signal
        );
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_locator",
      description:
        "Playwright-style locator action: find elements by role/name/text/label/placeholder/testId or CSS, chain scopes with locator/frameLocator, combine and/or, filter with has/hasNot, then count, click, fill, type, press, select, check, read text/attribute, wait for a state, evaluate a function, or invoke a secondary accessibility action.",
      parameters: {
        action: {
          type: "string",
          required: true,
          description:
            "count, allTextContents, innerText, textContent, click, doubleClick, fill, type, press, pressSequentially, selectOption, check, uncheck, isVisible, isEnabled, getAttribute, waitFor, evaluate, evaluateAll, secondaryAction, scrollIntoView.",
        },
        ref: { type: "string", description: "Optional existing element ref (for actions on an AX/locator ref)." },
        selector: { type: "string", description: "Optional CSS selector." },
        role: { type: "string", description: "ARIA role." },
        name: { type: "string", description: "Accessible name." },
        text: { type: "string", description: "Visible text substring." },
        hasText: { type: "string", description: "Filter to elements whose text contains this string." },
        hasNotText: { type: "string", description: "Filter out elements whose text contains this string." },
        label: { type: "string", description: "Form label text." },
        placeholder: { type: "string", description: "Input placeholder." },
        testId: { type: "string", description: "data-testid or data-test-id." },
        frame: {
          type: "array",
          description: "Optional same-origin iframe selector chain to scope the search.",
          items: { type: "string" },
        },
        scope: {
          type: "array",
          description: "Optional ancestor selector chain; each match must be a descendant of the matched scope.",
          items: { type: "string" },
        },
        has: { type: "json", description: "Require a descendant matching this CSS selector or locator criteria object." },
        hasNot: { type: "json", description: "Require no descendant matching this CSS selector or locator criteria object." },
        and: { type: "json", description: "Additional locator criteria that must all match (intersection)." },
        or: { type: "json", description: "Alternative locator criteria of which at least one must match (union)." },
        alt: { type: "string", description: "Image alt text." },
        title: { type: "string", description: "Element title attribute." },
        exact: { type: "boolean", description: "Require exact text matches." },
        strict: {
          type: "boolean",
          description:
            "Playwright strict mode: fail when the locator matches more than one element unless nth is provided. Defaults to true for single-element actions.",
        },
        nth: { type: "number", description: "Zero-based match index; negative counts from the end." },
        value: { type: "string", description: "Value for fill/type/press/selectOption." },
        values: { type: "array", description: "Values for selectOption multi-select.", items: { type: "json" } },
        button: { type: "string", description: "Mouse button for click: left, middle, or right." },
        modifiers: { type: "array", description: "Modifier keys held during click/press.", items: { type: "string" } },
        duration: { type: "number", description: "Seconds to hold a press (0–30)." },
        delayMs: { type: "number", description: "Delay between characters for pressSequentially." },
        attribute: { type: "string", description: "Attribute name for getAttribute." },
        state: { type: "string", description: 'waitFor state: "visible" (default), "hidden", "attached", or "detached".' },
        evaluateSource: { type: "string", description: "Function source for evaluate/evaluateAll (receives the element/array and arg)." },
        evaluateArg: { type: "json", description: "Argument passed to evaluate/evaluateAll." },
        secondaryAction: { type: "string", description: 'Secondary accessibility action, for example "Expand" or "Collapse".' },
        timeoutMs: { type: "number", description: "Wait/action timeout in milliseconds; defaults to 3000." },
        tabId: {
          type: "integer",
          description: "Tab to use; omit to use the agent's last tab or the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2).slice(0, 12000) }],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        const criteria = {
          ...(args.selector !== undefined ? { selector: args.selector } : {}),
          ...(args.role !== undefined ? { role: args.role } : {}),
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.text !== undefined ? { text: args.text } : {}),
          ...(args.hasText !== undefined ? { hasText: args.hasText } : {}),
          ...(args.hasNotText !== undefined ? { hasNotText: args.hasNotText } : {}),
          ...(args.label !== undefined ? { label: args.label } : {}),
          ...(args.placeholder !== undefined ? { placeholder: args.placeholder } : {}),
          ...(args.testId !== undefined ? { testId: args.testId } : {}),
          ...(args.frame !== undefined ? { frame: args.frame } : {}),
          ...(args.scope !== undefined ? { scope: args.scope } : {}),
          ...(args.has !== undefined ? { has: args.has } : {}),
          ...(args.hasNot !== undefined ? { hasNot: args.hasNot } : {}),
          ...(args.and !== undefined ? { and: args.and } : {}),
          ...(args.or !== undefined ? { or: args.or } : {}),
          ...(args.alt !== undefined ? { alt: args.alt } : {}),
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.exact !== undefined ? { exact: args.exact } : {}),
          limit: 200,
        };
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const timeoutMs = Math.max(1000, Number(args.timeoutMs) || 3000);
        const action = String(args.action ?? "").toLowerCase();
        const locate = (extra = {}) => bridge.command("page.locate", { tabId, ...criteria, ...extra }, exec.signal);
        const deadline = Date.now() + timeoutMs;
        const broadActions = new Set(["count", "alltextcontents", "texts", "isvisible", "isenabled", "getattribute", "innertext", "textcontent"]);
        let result = args.ref !== undefined ? { elements: [{ ref: args.ref, role: "", name: "", text: "", visible: true }] } : await locate({ includeHidden: broadActions.has(action) });
        let elements = result.elements ?? [];
        if (action === "waitfor") {
          const state = String(args.state ?? "visible").toLowerCase();
          if (!["visible", "hidden", "attached", "detached"].includes(state)) {
            throw new Error('chrome_locator waitFor state must be "visible", "hidden", "attached", or "detached"');
          }
          const check = async () => {
            result = await locate({ includeHidden: state !== "visible" });
            elements = result.elements ?? [];
            if (state === "visible") return elements.some((element) => element.visible !== false);
            if (state === "attached") return elements.length > 0;
            if (state === "hidden") return elements.every((element) => element.visible === false);
            return elements.length === 0;
          };
          while (!(await check())) {
            if (Date.now() >= deadline) throw new Error(`chrome_locator waitFor(${state}) timed out after ${timeoutMs}ms`);
            await sleep(100);
          }
          return { state, elements };
        }
        if (action === "count") {
          if (Number.isInteger(args.nth)) {
            const index = args.nth < 0 ? elements.length + args.nth : args.nth;
            return { count: index >= 0 && index < elements.length ? 1 : 0 };
          }
          return { count: elements.length };
        }
        if (action === "alltextcontents" || action === "texts") {
          const selected = Number.isInteger(args.nth)
            ? (() => {
                const index = args.nth < 0 ? elements.length + args.nth : args.nth;
                return index >= 0 && index < elements.length ? [elements[index]] : [];
              })()
            : elements;
          return { texts: selected.map((element) => element.text ?? "") };
        }
        if (action === "isvisible") {
          if (Number.isInteger(args.nth)) {
            const index = args.nth < 0 ? elements.length + args.nth : args.nth;
            return { visible: index >= 0 && index < elements.length && elements[index].visible !== false };
          }
          return { visible: elements.some((element) => element.visible !== false) };
        }
        if (elements.length === 0) throw new Error(`chrome_locator found no matching element (${action})`);
        const singleElementActions = [
          "isenabled", "getattribute", "innertext", "textcontent", "click", "doubleclick", "fill", "type",
          "press", "presssequentially", "selectoption", "check", "uncheck", "evaluate", "secondaryaction", "scrollintoview",
        ];
        if (args.strict !== false && args.nth === undefined && singleElementActions.includes(action) && elements.length > 1) {
          throw new Error(`strict mode violation: ${JSON.stringify(criteria)} matched ${elements.length} elements; pass nth or strict=false`);
        }
        let index = 0;
        if (Number.isInteger(args.nth)) {
          index = args.nth < 0 ? elements.length + args.nth : args.nth;
        }
        if (index < 0 || index >= elements.length) {
          throw new Error(`locator resolved to ${elements.length} element(s); no element at index ${args.nth ?? 0}`);
        }
        const element = elements[index];
        if (action === "isenabled") return { found: true, enabled: element.disabled !== true };
        if (action === "getattribute") {
          if (args.attribute === undefined) throw new Error("chrome_locator getAttribute needs attribute");
          return bridge.command("page.attribute", { tabId, ref: element.ref, name: args.attribute }, exec.signal);
        }
        if (action === "innertext" || action === "textcontent") {
          return { text: element.text ?? "" };
        }
        if (action === "click" || action === "doubleclick") {
          const hit = await bridge.command(
            "input.clickRef",
            {
              tabId,
              ref: element.ref,
              clickCount: action === "doubleclick" ? 2 : 1,
              ...(args.button !== undefined ? { button: args.button } : {}),
              ...(args.modifiers !== undefined ? { modifiers: args.modifiers } : {}),
              ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
            },
            exec.signal
          );
          return { action, element, hit };
        }
        if (action === "fill") {
          if (args.value === undefined) throw new Error("chrome_locator fill needs value");
          if (element.disabled === true) throw new Error(`element ${element.ref} is disabled`);
          return bridge.command("input.setValueRef", { tabId, ref: element.ref, value: args.value }, exec.signal);
        }
        if (action === "type" || action === "presssequentially") {
          if (args.value === undefined) throw new Error(`chrome_locator ${action} needs value`);
          await bridge.command("input.focusRef", { tabId, ref: element.ref }, exec.signal);
          if (action === "presssequentially") {
            return bridge.command(
              "input.pressSequentially",
              { tabId, text: args.value, delayMs: args.delayMs ?? args.delay ?? 0 },
              exec.signal
            );
          }
          return bridge.command("input.type", { tabId, text: args.value }, exec.signal);
        }
        if (action === "press") {
          if (args.value === undefined) throw new Error("chrome_locator press needs value");
          await bridge.command("input.focusRef", { tabId, ref: element.ref }, exec.signal);
          return bridge.command("input.key", { tabId, key: args.value, duration: args.duration }, exec.signal);
        }
        if (action === "selectoption") {
          const values = args.values !== undefined ? args.values : args.value;
          if (values === undefined) throw new Error("chrome_locator selectOption needs value or values");
          return bridge.command(
            "input.selectOptionRef",
            { tabId, ref: element.ref, values: Array.isArray(values) ? values : [values] },
            exec.signal
          );
        }
        if (action === "check" || action === "uncheck") {
          const wantChecked = action === "check";
          if (element.checked === wantChecked) return { action, element, changed: false };
          await bridge.command("input.clickRef", { tabId, ref: element.ref }, exec.signal);
          return { action, element, changed: true };
        }
        if (action === "scrollintoview") {
          return bridge.command("page.scrollRef", { tabId, ref: element.ref }, exec.signal);
        }
        if (action === "evaluate" || action === "evaluateall") {
          if (typeof args.evaluateSource !== "string" || args.evaluateSource.length === 0) {
            throw new Error(`chrome_locator ${action} needs evaluateSource`);
          }
          return bridge.command(
            "page.evaluateOnRef",
            {
              tabId,
              refs: action === "evaluateall" ? elements.map((entry) => entry.ref) : [element.ref],
              source: args.evaluateSource,
              arg: args.evaluateArg ?? null,
              all: action === "evaluateall",
            },
            exec.signal
          );
        }
        if (action === "secondaryaction") {
          if (typeof args.secondaryAction !== "string") throw new Error("chrome_locator secondaryAction needs secondaryAction");
          return bridge.command(
            "input.secondaryAction",
            { tabId, ref: element.ref, action: args.secondaryAction },
            exec.signal
          );
        }
        throw new Error(`unsupported chrome_locator action ${JSON.stringify(action)}`);
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_js",
      description:
        "Execute JavaScript in a persistent Codex-style browser session. The VM keeps variables and saved handles across calls and exposes agent.browsers, browser.tabs, tab.playwright, tab.ax, tab.cua, tab.dom_cua, tab.clipboard, tab.dev, tab.content and tab.capabilities. Use const/let for stable handles; await browser APIs; call await agent.documentation.get(\"overview\"|\"ax\"|\"playwright\"|\"cua\"|\"clipboard\"|\"capabilities\") for the API guide. Prefer tab.ax.write() to observe, act, then write again.",
      parameters: {
        code: {
          type: "string",
          required: true,
          description: "JavaScript to execute in the persistent browser session.",
        },
        timeoutMs: {
          type: "number",
          description: "Execution timeout in milliseconds; defaults to 30000.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => {
          const blocks = [];
          for (const output of value.outputs ?? []) {
            if (Array.isArray(output)) blocks.push(...output);
          }
          if (value.logs?.length) blocks.push({ type: "text", text: value.logs.join("\n") });
          if (value.value !== null && value.value !== undefined) {
            blocks.push({ type: "text", text: JSON.stringify(value.value, null, 2).slice(0, 16000) });
          }
          return blocks.length > 0 ? blocks : [{ type: "text", text: "(no output)" }];
        },
      },
      async execute(args, exec) {
        if (typeof args.code !== "string" || args.code.trim().length === 0) throw new Error("chrome_js needs code");
        return runBrowserRepl(args.code, exec, { timeoutMs: args.timeoutMs });
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_export_gsuite",
      description: "Export a Google Workspace tab using an explicit GSuite export type.",
      parameters: {
        type: {
          type: "string",
          required: true,
          description: 'Export type: "pdf" | "md" | "xlsx" | "csv" | "docx" | "pptx".',
        },
        tabId: {
          type: "integer",
          description: "Workspace tab to export; omit to use the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: `Started ${value.format} export (download ${value.downloadId}).` }],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        const type = String(args.type ?? "pdf").toLowerCase();
        if (!["pdf", "md", "xlsx", "csv", "docx", "pptx"].includes(type)) {
          throw new Error("chrome_export_gsuite type must be pdf/md/xlsx/csv/docx/pptx");
        }
        return bridge.command("content.exportGsuite", { tabId, type }, exec.signal);
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_export_youtube_transcript",
      description: "Export an HTTPS youtube.com /watch transcript to a UTF-8 .txt file.",
      parameters: {
        tabId: {
          type: "integer",
          description: "YouTube tab; omit to use the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: `Saved transcript to ${value.path} (${value.bytes} bytes).` }],
      },
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error("chrome_export_youtube_transcript requires an agent Session");
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        const result = await bridge.command("content.exportYouTubeTranscript", { tabId }, exec.signal);
        const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
        const dir = join(cwd, "chrome-exports");
        await mkdir(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const path = join(dir, `youtube-${stamp}-tab${tabId}.txt`);
        const bytes = Buffer.from(result.text, "utf8");
        await writeFile(path, bytes);
        return { tabId, path, bytes: bytes.length };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_browser_info",
      description: "Report installed-browser-style diagnostics for the connected extension: platform, browser name/id, extension version, and open windows.",
      parameters: {},
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
      },
      async execute(_args, exec) {
        return bridge.command("host.info", {}, exec.signal);
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_notify",
      description: "Create a browser notification (useful when the agent needs the user's attention).",
      parameters: {
        title: { type: "string", description: "Notification title." },
        message: { type: "string", required: true, description: "Notification body." },
        priority: { type: "string", description: '"normal" (default) or "high".' },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: `Created notification ${value.id}.` }],
      },
      async execute(args, exec) {
        return bridge.command(
          "notification.create",
          { title: args.title, message: args.message, priority: args.priority },
          exec.signal
        );
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_context_menu",
      description: "Create or remove a browser right-click menu item for this extension.",
      parameters: {
        action: { type: "string", description: '"create" (default) or "removeAll".' },
        id: { type: "string", description: "Menu item id for create." },
        title: { type: "string", description: "Menu item title for create." },
        contexts: { type: "array", description: 'Chrome context types, e.g. ["page", "selection"].', items: { type: "string" } },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const action = String(args.action ?? "create").toLowerCase();
        return bridge.command(
          action === "removeall" ? "contextMenu.removeAll" : "contextMenu.create",
          { id: args.id, title: args.title, contexts: args.contexts },
          exec.signal
        );
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_browser_auth",
      description:
        "Secure sign-in handoff: inspect visible login methods and fields without exposing credentials to the model, then ask the user to complete authentication in the browser. Never types passwords or OTPs through model-visible tools.",
      parameters: {
        tabId: { type: "integer", description: "Login tab; omit to use the active tab." },
        message: { type: "string", description: "Short explanation shown to the user." },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [
          {
            type: "text",
            text:
              `Sign-in methods: ${(value.detection?.candidates ?? []).map((item) => item.text).join(" | ") || "(none detected)"}\n` +
              `Credential fields: ${(value.detection?.fields ?? []).map((field) => `${field.type}:${field.autocomplete ?? field.name ?? field.placeholder}`).join(", ") || "(none)"}\n` +
              `Handoff: ${value.completed ? "completed" : "declined"}`,
          },
        ],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        const detection = await bridge.command("auth.detect", { tabId }, exec.signal);
        try {
          await bridge.command("visibility.set", { tabId, visible: true }, exec.signal);
        } catch {
          /* best effort */
        }
        const { answers } = await ctx.userQuestions.ask({
          questions: [
            {
              id: "browser-auth",
              header: "Secure browser sign-in",
              question:
                (args.message ? `${args.message}\n\n` : "") +
                "Complete the sign-in in your browser now. The agent will not read or type your credentials. Confirm when done.",
              options: [
                { label: "完成 Done", description: "Sign-in completed; let the agent verify." },
                { label: "取消 Cancel", description: "Stop this sign-in task." },
              ],
            },
          ],
          agent: exec.agent,
          signal: exec.signal,
        });
        const selected = answers[0]?.selected ?? [];
        const completed = selected.some((label) => String(label).includes("完成") || String(label).includes("Done"));
        if (!completed) throw new Error("User cancelled the secure browser sign-in.");
        return { tabId, detection, completed: true };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_siwc",
      description: "Detect or click Sign in with ChatGPT controls (native account grant is unavailable; this uses a visible control handoff).",
      parameters: {
        action: { type: "string", description: '"detect" (default) or "authenticate".' },
        x: { type: "number", description: "Viewport x of the control for authenticate." },
        y: { type: "number", description: "Viewport y of the control for authenticate." },
        tabId: { type: "integer", description: "Tab to inspect; omit to use the active tab." },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        const action = String(args.action ?? "detect").toLowerCase();
        if (action === "detect") return bridge.command("siwc.detect", { tabId }, exec.signal);
        if (action !== "authenticate") throw new Error('chrome_siwc action must be "detect" or "authenticate"');
        const detection = await bridge.command("siwc.detect", { tabId }, exec.signal);
        const candidate = detection.candidates?.find((item) => item.visibility === "rendered");
        const x = typeof args.x === "number" ? args.x : candidate?.x;
        const y = typeof args.y === "number" ? args.y : candidate?.y;
        if (typeof x !== "number" || typeof y !== "number") {
          return { status: "no_actionable_button", candidates: detection.candidates ?? [] };
        }
        await bridge.command("input.click", { tabId, x, y }, exec.signal);
        return { status: "initiated", x, y };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_bot_detection",
      description: "Report that the current page is blocked by bot detection/CAPTCHA/hard access denial/challenge loop.",
      parameters: {
        reason: {
          type: "string",
          required: true,
          description: '"captcha_failed" | "access_denied" | "challenge_loop" | "sign_in_blocked" | "add_to_cart_blocked" | "purchase_blocked" | "unexpected_bot_error".',
        },
        tabId: { type: "integer", description: "Blocked tab; omit to use the active tab." },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: `Reported bot detection: ${value.reason} on ${value.hostname ?? "unknown"}` }],
      },
      async execute(args, exec) {
        const valid = ["captcha_failed", "access_denied", "challenge_loop", "sign_in_blocked", "add_to_cart_blocked", "purchase_blocked", "unexpected_bot_error"];
        const reason = String(args.reason ?? "").toLowerCase();
        if (!valid.includes(reason)) throw new Error(`chrome_bot_detection reason must be one of ${valid.join(", ")}`);
        const tabId = await resolveTabId(exec, args.tabId);
        const info = await bridge.command("tabs.get", { tabId }, exec.signal);
        let hostname = null;
        try { hostname = new URL(info.url).hostname; } catch { /* ignore */ }
        return { reported: true, reason, hostname };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_tab_mentions",
      description:
        "List open user tabs as explicit tab mentions shaped like plugin://chrome@dsh/mention=tab-v1&... so the user can point the agent at an existing tab.",
      parameters: {},
      output: {
        schema: looseObject,
        render: (_args, value) => [
          {
            type: "text",
            text:
              value.mentions.length === 0
                ? "No unclaimed user tabs."
                : value.mentions.map((item) => `${item.title} — ${item.mention}`).join("\n"),
          },
        ],
      },
      async execute(_args, exec) {
        const status = bridge.status();
        const browserId = status.activeBrowserId ?? "default";
        const tabs = await bridge.command("tabs.list", {}, exec.signal);
        const mentions = tabs
          .filter((tab) => !isTrackedTab(tab.id) && !inAgentGroup(tab.groupTitle ?? ""))
          .map((tab) => {
            const params = new URLSearchParams({
              mention: "tab-v1",
              source: "extension",
              browserId,
              tabId: String(tab.id),
              title: tab.title ?? "",
              url: tab.url ?? "",
            });
            return { tabId: tab.id, title: tab.title, url: tab.url, mention: `plugin://chrome@dsh?${params.toString()}` };
          });
        return { mentions };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_side_panel",
      description: "Open the extension side panel for the window containing a tab.",
      parameters: {
        tabId: { type: "integer", description: "Tab whose window should show the side panel; omit to use the active tab." },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: `Opened side panel in window ${value.windowId}.` }],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        return bridge.command("sidePanel.open", { tabId }, exec.signal);
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_favicon",
      description: "Set or clear the agent-control badge on a tab's favicon (active / deliverable / handoff / none).",
      parameters: {
        badge: { type: "string", required: true, description: '"active" | "deliverable" | "handoff" | "none".' },
        tabId: { type: "integer", description: "Tab to badge; omit to use the active tab." },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: `Favicon badge: ${value.badge}.` }],
      },
      async execute(args, exec) {
        const badge = String(args.badge ?? "none").toLowerCase();
        if (!["active", "deliverable", "handoff", "none"].includes(badge)) {
          throw new Error('chrome_favicon badge must be "active", "deliverable", "handoff", or "none"');
        }
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        return bridge.command("favicon.set", { tabId, badge }, exec.signal);
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_audit_trail",
      description: "Inspect recent model-initiated browser changes, newest first, with their arguments and prior state.",
      parameters: { limit: { type: "number", description: "Maximum entries; defaults to 50." } },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value.changes, null, 2).slice(0, 16000) }],
      },
      async execute(args) {
        return { changes: auditTrail.slice(0, Math.max(1, Math.min(200, Number(args.limit) || 50))) };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_turn_ended",
      description:
        "End the current browser turn: close unmarked agent tabs, release claimed user tabs, clear handoff marks for the next turn, and keep deliverable tabs open.",
      parameters: {},
      output: {
        schema: looseObject,
        render: (_args, value) => [
          {
            type: "text",
            text: `Turn ended: closed ${value.closed.length} agent tab(s), released ${value.released.length} user tab(s), kept ${value.kept.length} marked tab(s).`,
          },
        ],
      },
      async execute(_args, exec) {
        const session = sessionOf(exec);
        await finishCursor(session);
        const { closed, released, kept } = await endTurnTabs(exec);
        recordChange("tabs", "turnEnded", {}, { closed, released, kept });
        return { closed, released, kept };
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_browser_diagnostics",
      description:
        "Discover installed Chromium browsers and profiles, check whether a browser is running, verify the native-host manifest, and (after user approval) launch a browser with the unpacked extension loaded.",
      parameters: {
        action: {
          type: "string",
          description: '"installed" (default), "running", "extension", "nativeHost", "installHost", or "launch".',
        },
        family: { type: "string", description: 'Browser family filter, e.g. "chrome", "edge", "brave".' },
        executable: { type: "string", description: "Executable path for launch." },
        userDataDir: { type: "string", description: "User data dir for launch." },
        url: { type: "string", description: "URL to open on launch; defaults to about:blank." },
        hostPath: { type: "string", description: "Native host executable path for installHost." },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2).slice(0, 16000) }],
      },
      async execute(args, exec) {
        const action = String(args.action ?? "installed").toLowerCase();
        if (action === "installed") {
          const report = await installedBrowsers();
          return args.family === undefined
            ? report
            : { ...report, browsers: report.browsers.filter((browser) => browser.family === args.family) };
        }
        if (action === "running") return chromeIsRunning();
        if (action === "extension") {
          const report = await installedBrowsers();
          return {
            browsers: report.browsers
              .filter((browser) => args.family === undefined || browser.family === args.family)
              .map((browser) => ({
                family: browser.family,
                installed: browser.profiles.some((profile) => profile.extensionInstalled),
                profiles: browser.profiles,
              })),
          };
        }
        if (action === "nativehost") {
          const report = await installedBrowsers();
          return {
            browsers: report.browsers
              .filter((browser) => args.family === undefined || browser.family === args.family)
              .map((browser) => ({ family: browser.family, ...browser.nativeHost })),
          };
        }
        if (action === "installhost") {
          if (typeof args.hostPath !== "string" || args.hostPath.length === 0) {
            throw new Error("chrome_browser_diagnostics installHost needs hostPath");
          }
          return installNativeHostManifest(args.hostPath);
        }
        if (action === "launch") {
          const report = await installedBrowsers();
          const family = args.family === undefined ? report.browsers.find((browser) => browser.executable !== null) : report.browsers.find((browser) => browser.family === args.family);
          const executable = args.executable ?? family?.executable;
          if (typeof executable !== "string") throw new Error("no installed browser executable found; pass executable");
          const { answers } = await ctx.userQuestions.ask({
            questions: [
              {
                id: "launch-browser",
                header: "Launch browser",
                question: `Launch ${family?.name ?? executable} with the DSH Chrome Bridge extension?`,
                options: [
                  { label: "允许 Launch", description: "Open the browser and load the extension." },
                  { label: "取消 Cancel", description: "Do not launch." },
                ],
              },
            ],
            agent: exec.agent,
            signal: exec.signal,
          });
          const selected = answers[0]?.selected ?? [];
          if (!selected.some((label) => String(label).includes("Launch") || String(label).includes("允许"))) {
            throw new Error("User declined to launch the browser.");
          }
          return launchBrowser({ executable, userDataDir: args.userDataDir, url: args.url });
        }
        throw new Error(`unsupported chrome_browser_diagnostics action ${JSON.stringify(action)}`);
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_network",
      description:
        "Set extra HTTP headers, block URL patterns, or clear network overrides for a tab. Uses CDP Network domain; request/response events are also buffered for chrome_cdp action=events.",
      parameters: {
        action: { type: "string", required: true, description: '"setHeaders", "block", or "clear".' },
        headers: { type: "object", description: "Header name → value for setHeaders.", additionalProperties: true },
        urls: { type: "array", description: "URL patterns to block for block.", items: { type: "string" } },
        tabId: { type: "integer", description: "Tab to configure; omit to use the active tab." },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        const action = String(args.action ?? "").toLowerCase();
        if (action === "setheaders") {
          if (args.headers === undefined || typeof args.headers !== "object") throw new Error("chrome_network setHeaders needs headers");
          const headers = Object.fromEntries(Object.entries(args.headers).map(([key, value]) => [String(key), String(value)]));
          return bridge.command("network.setHeaders", { tabId, headers }, exec.signal);
        }
        if (action === "block") {
          if (!Array.isArray(args.urls)) throw new Error("chrome_network block needs urls");
          return bridge.command("network.blockUrls", { tabId, urls: args.urls.map(String) }, exec.signal);
        }
        if (action === "clear") return bridge.command("network.clear", { tabId }, exec.signal);
        throw new Error('chrome_network action must be "setHeaders", "block", or "clear"');
      },
    })
  );

  registerTool(
    defineTool({
      name: "chrome_close_tab",
      description:
        "Close a Chrome tab. Only tabs inside the agent's DSH tab groups can be closed; the user's own tabs are never touched.",
      parameters: {
        tabId: {
          type: "integer",
          required: true,
          description: "Tab to close (must be in a DSH tab group).",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [{ type: "text", text: `Closed tab [${value.tabId}].` }],
      },
      async execute(args, exec) {
        const info = await bridge.command("tabs.get", { tabId: args.tabId }, exec.signal);
        if (!inAgentGroup(info.groupTitle ?? "") && !isTrackedTab(args.tabId)) {
          throw new Error(`refusing to close tab ${args.tabId}: it is not an agent tab`);
        }
        await bridge.command("tabs.close", { tabId: args.tabId }, exec.signal);
        for (const tabs of sessionTabs.values()) tabs.delete(args.tabId);
        for (const [session, entry] of lastTab.entries()) if (entry.tabId === args.tabId) lastTab.delete(session);
        return { tabId: args.tabId };
      },
    })
  );

  ctx.effect(() => () => {
    for (const session of cursorTurns.keys()) void finishCursor(session);
  }, "chrome-bridge.cursor-cleanup");

  // Idle cleanup: close agent tabs the session has not touched for a while,
  // so a long-running profile does not accumulate stale tabs.
  if (config.autoCloseIdleMs > 0) {
    const timer = setInterval(() => {
      void cleanupIdleTabs().catch(() => {});
    }, Math.min(30000, Math.max(5000, Math.floor(config.autoCloseIdleMs / 2))));
    ctx.effect(() => () => clearInterval(timer), "chrome-bridge.idle-cleanup");
  }

  if (typeof ctx.on === "function") {
    ctx.on("agent/disposed", (payload) => {
      const session = payload?.agent?.session;
      if (!session) return;
      void finishCursor(session);
      if (config.autoCloseOnSessionEnd) void closeSessionTabs(session).catch(() => {});
    });
    ctx.on("session/event", (session, event) => {
      if (event.type !== "turn/end") return;
      const turnExec = { agent: { session }, signal: undefined };
      void finishCursor(session)
        .then(() => endTurnTabs(turnExec))
        .catch(() => {});
    });
  }

}

export { Config, apply, inject, name };
