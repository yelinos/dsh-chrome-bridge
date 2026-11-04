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
  const bridge = ctx.chromeBridge;
  const entryId = ctx.fiber?.entry?.options?.id;

  /** session → Set(hostname) approved for that session only. */
  const sessionApproved = new Map();
  /** Hostnames approved with "Always allow" for this process lifetime. */
  const runtimeAllowed = new Set();
  /** session → Set(tabId) tabs this session opened. */
  const sessionTabs = new Map();
  /** session → last tabId this session used. */
  const lastTab = new Map();

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

  function noteTab(exec, tabId) {
    const session = sessionOf(exec);
    if (session === null) return;
    lastTab.set(session, tabId);
    let tabs = sessionTabs.get(session);
    if (tabs === undefined) {
      tabs = new Set();
      sessionTabs.set(session, tabs);
    }
    tabs.add(tabId);
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
    const last = session === null ? undefined : lastTab.get(session);
    if (last !== undefined) {
      try {
        await bridge.command("tabs.get", { tabId: last }, exec.signal);
        return last;
      } catch {
        if (session !== null) lastTab.delete(session);
      }
    }
    const active = await bridge.command("tabs.active", {}, exec.signal);
    return active.id;
  }

  /** Gate a tab's current page, then return its info. */
  async function gatedTab(exec, tabId) {
    const info = await bridge.command("tabs.get", { tabId }, exec.signal);
    if (typeof info.url === "string" && info.url.length > 0 && /^https?:/i.test(info.url)) {
      await ensureDomainAllowed(exec, info.url);
    }
    noteTab(exec, tabId);
    return info;
  }

  ctx.tools.register(
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

  ctx.tools.register(
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
                    .map((tab) => `${tab.active ? "*" : " "} [${tab.id}] (${tab.groupTitle}) ${tab.title} — ${tab.url}`)
                    .join("\n"),
          },
        ],
      },
      async execute(args, exec) {
        const tabs = await bridge.command("tabs.list", {}, exec.signal);
        const filtered = args.all === true ? tabs : tabs.filter((tab) => inAgentGroup(tab.groupTitle ?? ""));
        return { tabs: filtered, total: tabs.length };
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "chrome_navigate",
      description:
        "Navigate to a URL in the user's signed-in Chrome: in an existing tab when tabId is given, otherwise in a new tab inside this session's DSH tab group. Asks the user for approval the first time a domain is used. Returns the tab id, final URL, and page title.",
      parameters: {
        url: {
          type: "string",
          required: true,
          description: "Absolute http(s) URL to open.",
        },
        tabId: {
          type: "integer",
          description: "Existing tab to navigate; omit to open a new tab in the session's DSH group.",
        },
        background: {
          type: "boolean",
          description: "Open a new tab without focusing it. Defaults to false.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [
          { type: "text", text: `${value.opened ? "Opened" : "Navigated"} tab [${value.tabId}] in ${value.group}: ${value.title} — ${value.url}` },
        ],
      },
      async execute(args, exec) {
        parseHttpUrl(args.url);
        await ensureDomainAllowed(exec, args.url);
        const group = groupTitleFor(exec);
        let info;
        if (args.tabId !== undefined) {
          info = await bridge.command("page.navigate", { tabId: args.tabId, url: args.url }, exec.signal);
        } else {
          info = await bridge.command(
            "tabs.open",
            { url: args.url, active: args.background !== true, groupTitle: group },
            exec.signal
          );
        }
        noteTab(exec, info.id);
        return { opened: args.tabId === undefined, tabId: info.id, url: info.url, title: info.title, group };
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "chrome_read_page",
      description:
        "Read the current page of a Chrome tab: URL, title, and visible text (truncated). Uses the tab the agent used last, or the active tab, unless tabId is given. Asks for approval the first time a domain is interacted with.",
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

  ctx.tools.register(
    defineTool({
      name: "chrome_eval",
      description:
        "Evaluate JavaScript in a Chrome tab and return the JSON value. Use it to click elements, fill forms, extract data, or read page state; prefer chrome_read_page for plain reading. Runs with the user's logged-in session; ask for approval is enforced per domain.",
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


  ctx.tools.register(
    defineTool({
      name: "chrome_click",
      description:
        "Click in a Chrome tab with a real mouse event. Pass a CSS selector to click an element, or x/y viewport coordinates. Uses the agent's last tab or the active tab unless tabId is given.",
      parameters: {
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
        if (args.selector !== undefined) {
          const hit = await bridge.command(
            "input.clickSelector",
            { tabId, selector: args.selector, button: args.button, clickCount: args.clickCount },
            exec.signal
          );
          return { tabId, selector: args.selector, ...hit };
        }
        if (args.x === undefined || args.y === undefined) {
          throw new Error("chrome_click needs either a selector or both x and y");
        }
        await bridge.command(
          "input.click",
          { tabId, x: args.x, y: args.y, button: args.button, clickCount: args.clickCount },
          exec.signal
        );
        return { tabId, x: args.x, y: args.y };
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "chrome_type",
      description:
        "Type text into a Chrome tab with real keyboard input. Pass a selector to focus that element first (clicked with a real mouse event), then the text is inserted; otherwise text goes to the focused element. Uses the agent's last tab or the active tab unless tabId is given.",
      parameters: {
        text: { type: "string", required: true, description: "Text to type." },
        selector: {
          type: "string",
          description: "CSS selector of the field to focus before typing.",
        },
        clear: {
          type: "boolean",
          description: "Select-all and delete the field before typing. Defaults to false.",
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
        if (args.selector !== undefined) {
          await bridge.command("input.clickSelector", { tabId, selector: args.selector }, exec.signal);
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

  ctx.tools.register(
    defineTool({
      name: "chrome_key",
      description:
        "Press a key in a Chrome tab with real keyboard events: Enter, Tab, Escape, Backspace, Delete, arrows, Home, End, PageUp, PageDown, Space, or a single character. Modifiers combine control/alt/shift/meta. Uses the agent's last tab or the active tab unless tabId is given.",
      parameters: {
        key: { type: "string", required: true, description: 'Key name, e.g. "Enter" or "a".' },
        modifiers: {
          type: "array",
          description: 'Modifier names: "control", "alt", "shift", "meta".',
          items: { type: "string" },
        },
        tabId: {
          type: "integer",
          description: "Tab to press the key in; omit to use the agent's last tab or the active tab.",
        },
      },
      output: {
        schema: looseObject,
        render: (_args, value) => [
          { type: "text", text: `Pressed ${value.modifiers.length > 0 ? value.modifiers.join("+") + "+" : ""}${value.key}.` },
        ],
      },
      async execute(args, exec) {
        const tabId = await resolveTabId(exec, args.tabId);
        await gatedTab(exec, tabId);
        const result = await bridge.command(
          "input.key",
          { tabId, key: args.key, modifiers: args.modifiers },
          exec.signal
        );
        return { tabId, ...result };
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "chrome_screenshot",
      description:
        "Capture a PNG screenshot of a Chrome tab; the image is returned inline as a durable attachment (model-visible directly). Uses the agent's last tab or the active tab unless tabId is given.",
      parameters: {
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
        const shot = await bridge.command("page.screenshot", { tabId }, exec.signal);
        const bytes = Buffer.from(shot.dataBase64, "base64");
        if (admitImage !== null) {
          const attachment = await admitImage({
            data: new Uint8Array(bytes),
            mediaType: "image/png",
            name: `chrome-tab${tabId}.png`,
          });
          return { tabId, attachment };
        }
        if (exec.agent === undefined) throw new Error("chrome_screenshot requires an agent Session");
        const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
        const dir = join(cwd, "chrome-screenshots");
        await mkdir(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const path = join(dir, `chrome-${stamp}-tab${tabId}.png`);
        await writeFile(path, bytes);
        return { tabId, path, bytes: bytes.length };
      },
    })
  );

  ctx.tools.register(
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
        if (!inAgentGroup(info.groupTitle ?? "")) {
          throw new Error(`refusing to close tab ${args.tabId}: it is not in a ${config.tabGroupTitle} tab group`);
        }
        await bridge.command("tabs.close", { tabId: args.tabId }, exec.signal);
        for (const tabs of sessionTabs.values()) tabs.delete(args.tabId);
        for (const [session, id] of lastTab.entries()) if (id === args.tabId) lastTab.delete(session);
        return { tabId: args.tabId };
      },
    })
  );
}

export { Config, apply, inject, name };
