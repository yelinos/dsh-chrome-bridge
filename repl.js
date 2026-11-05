/**
 * Persistent JavaScript browser session, modeled after the Codex browser-use
 * `js` tool. The VM context is kept per DSH session so handles and variables
 * survive across calls; each call is rebound to the current agent/session/exec
 * signal and to the browser a handle was created from.
 *
 * Handles are deliberately stable across turns:
 *  - `browser` / `agent.browsers.getDefault()` bind the browser that was
 *    selected when the handle was created.
 *  - `tab` handles carry both the tab id and the browser id, so a later
 *    `chrome_use_browser` cannot retarget an existing handle.
 *  - Methods look up the *current* execution context when they run, so an old
 *    saved handle still observes the current turn's abort signal.
 */
import vm from "node:vm";

function sessionKeyOf(exec) {
  const session = exec?.agent?.session;
  return String(session?.id ?? session ?? "global");
}

function jsonValue(value) {
  if (value === undefined) return null;
  if (typeof value === "bigint") return String(value);
  return value;
}

/** Copy a definition and bind tool execution to one browser. */
function scopedExec(exec, browserId) {
  if (browserId === undefined || browserId === null) return exec;
  return { ...exec, chromeBrowserId: String(browserId) };
}

/** Format a snapshot result into model-facing blocks using its tool renderer. */
function snapshotBlocks(definition, result, args = {}) {
  if (definition?.output?.render === undefined) {
    return [{ type: "text", text: String(result?.text ?? JSON.stringify(result)) }];
  }
  return definition.output.render(args, result);
}

/** Build one Codex-shaped API bound to the current execution/entry state. */
function makeApi({ bridge, definitions, getState, resolveTabId }) {
  const execNow = () => getState().exec ?? {};
  const outputsNow = () => getState().outputs ?? [];
  function emit(blocks) {
    if (!Array.isArray(blocks) || blocks.length === 0) return;
    outputsNow().push({ blocks });
  }
  const command = (cmd, params = {}, browserId) => {
    const exec = execNow();
    return bridge.command(cmd, params, exec.signal, browserId ?? exec.chromeBrowserId);
  };
  const call = (tool, args = {}, browserId) => {
    const definition = definitions.get(tool);
    if (definition === undefined) throw new Error(`unknown browser tool ${tool}`);
    return definition.execute(args, scopedExec(execNow(), browserId));
  };

  function makeLocator(criteria, browserId, tabId) {
    const wire = (extra = {}) => ({
      ...criteria,
      ...(browserId !== undefined ? { __browserId: browserId } : {}),
      ...(tabId !== undefined ? { tabId } : {}),
      ...extra,
    });
    const run = (action, extra = {}) => {
      const args = { action, ...wire(extra) };
      for (const key of Object.keys(args)) if (args[key] === undefined) delete args[key];
      return call("chrome_locator", args, browserId);
    };
    const derive = (delta) => makeLocator({ ...criteria, ...delta }, browserId, tabId);
    const api = {
      count: async () => (await run("count")).count,
      click: async (options = {}) => {
        await run("click", options);
      },
      dblclick: async (options = {}) => {
        await run("doubleClick", options);
      },
      fill: async (value, options = {}) => {
        await run("fill", { value, ...options });
      },
      type: async (value, options = {}) => {
        await run("type", { value, ...options });
      },
      press: async (value, options = {}) => {
        await run("press", { value, ...options });
      },
      pressSequentially: async (value, options = {}) => {
        await run("pressSequentially", { value, ...options });
      },
      selectOption: async (value, options = {}) => {
        const payload = Array.isArray(value) ? { values: value } : { value };
        return (await run("selectOption", { ...payload, ...options })).selected;
      },
      check: async (options = {}) => {
        await run("check", options);
      },
      uncheck: async (options = {}) => {
        await run("uncheck", options);
      },
      setChecked: async (checked, options = {}) => {
        await run(checked ? "check" : "uncheck", options);
      },
      isVisible: async () => (await run("isVisible")).visible,
      isEnabled: async () => (await run("isEnabled")).enabled,
      getAttribute: async (attribute, options = {}) => (await run("getAttribute", { attribute, ...options })).value,
      innerText: async (options = {}) => (await run("innerText", options)).text,
      textContent: async (options = {}) => (await run("textContent", options)).text,
      allTextContents: async (options = {}) => (await run("allTextContents", options)).texts,
      waitFor: async (options = {}) => {
        await run("waitFor", options);
      },
      nth: (nth) => derive({ nth }),
      first: () => derive({ nth: 0 }),
      last: () => derive({ nth: -1 }),
      all: async () => {
        const count = (await run("count")).count ?? 0;
        return Array.from({ length: count }, (_unused, nth) => derive({ nth }));
      },
      and: (other) =>
        makeLocator(
          { ...criteria, and: [...(criteria.and ?? []), other?.criteria ?? other ?? {}] },
          browserId,
          tabId
        ),
      or: (other) =>
        makeLocator(
          { ...criteria, or: [...(criteria.or ?? []), other?.criteria ?? other ?? {}] },
          browserId,
          tabId
        ),
      locator: (selector, options = {}) => {
        const parentSelector = criteria.selector;
        const { selector: _parent, ...rest } = criteria;
        return makeLocator(
          {
            ...rest,
            selector,
            ...(parentSelector !== undefined ? { scope: [...(rest.scope ?? []), parentSelector] } : {}),
            ...(options.has !== undefined ? { has: options.has } : {}),
            ...(options.hasNot !== undefined ? { hasNot: options.hasNot } : {}),
          },
          browserId,
          tabId
        );
      },
      frameLocator: (selector) => derive({ frame: [...(criteria.frame ?? []), selector] }),
      getByRole: (role, options = {}) => derive({ role, ...options }),
      getByText: (text, options = {}) => derive({ text, ...options }),
      getByLabel: (label, options = {}) => derive({ label, ...options }),
      getByPlaceholder: (placeholder, options = {}) => derive({ placeholder, ...options }),
      getByTestId: (testId) => derive({ testId }),
      getByAltText: (alt, options = {}) => derive({ alt, ...options }),
      getByTitle: (title, options = {}) => derive({ title, ...options }),
      filter: (options = {}) => {
        const filterOf = (value) =>
          typeof value === "string" ? { selector: value } : value?.criteria ?? (value?.selector ? { selector: value.selector } : null);
        const has = filterOf(options.has);
        const hasNot = filterOf(options.hasNot);
        return derive({
          ...(options.hasText !== undefined ? { hasText: options.hasText } : {}),
          ...(options.hasNotText !== undefined ? { hasNotText: options.hasNotText } : {}),
          ...(has !== null ? { has } : {}),
          ...(hasNot !== null ? { hasNot } : {}),
          ...(options.visible !== undefined ? { visible: options.visible } : {}),
        });
      },
      evaluate: async (pageFunction, arg, options = {}) => {
        const result = await run("evaluate", {
          evaluateSource: String(pageFunction),
          evaluateArg: arg === undefined ? null : arg,
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        });
        return result.value;
      },
      evaluateAll: async (pageFunction, arg, options = {}) => {
        const result = await run("evaluateAll", {
          evaluateSource: String(pageFunction),
          evaluateArg: arg === undefined ? null : arg,
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        });
        return result.value;
      },
      criteria,
    };
    return api;
  }

  function makeTab(id, browserId) {
    const numericId = Number(id);
    const bound = (tool, args = {}) => call(tool, { tabId: numericId, ...args }, browserId);
    const cmd = (commandName, params = {}) => command(commandName, { tabId: numericId, ...params }, browserId);
    const axGet = async (mode = "state", options = {}) => {
      const snapshot = await bound("chrome_snapshot", {
        mode: mode === "screenshot" || mode === "axStateAndScreenshot" ? (mode === "axStateAndScreenshot" ? "both" : "screenshot") : mode === "both" ? "both" : "state",
        ...options,
      });
      if (mode === "screenshot") return snapshot.attachment;
      if (mode === "both") return { state: snapshot.text ?? "", screenshot: snapshot.attachment };
      return snapshot.text ?? "";
    };
    const axWrite = async (mode = "state", options = {}) => {
      const args = {
        mode: mode === "screenshot" || mode === "axStateAndScreenshot" ? (mode === "axStateAndScreenshot" ? "both" : "screenshot") : mode === "both" ? "both" : "state",
        ...options,
      };
      const snapshot = await bound("chrome_snapshot", args);
      emit(snapshotBlocks(definitions.get("chrome_snapshot"), snapshot, args));
    };
    const tab = {
      id: String(numericId),
      tabId: numericId,
      browserId,
      url: async () => (await cmd("tabs.get")).url,
      title: async () => (await cmd("tabs.get")).title,
      info: async () => cmd("tabs.get"),
      goto: (url) => bound("chrome_navigate", { url }),
      back: () => cmd("page.back"),
      forward: () => cmd("page.forward"),
      reload: () => cmd("page.reload"),
      close: () => bound("chrome_close_tab"),
      markDeliverable: () => bound("chrome_mark_tab", { status: "deliverable" }),
      markHandoff: () => bound("chrome_mark_tab", { status: "handoff" }),
      screenshot: async (options = {}) => {
        const result = await bound("chrome_screenshot", options);
        return result.attachment;
      },
      read: () => bound("chrome_read_page"),
      evaluate: (expression) => bound("chrome_eval", { expression }),
      click: (options = {}) => bound("chrome_click", options),
      type: (options = {}) => bound("chrome_type", options),
      key: (options = {}) => bound("chrome_key", options),
      scroll: (options = {}) => bound("chrome_scroll", options),
      move: (options = {}) => bound("chrome_move", options),
      drag: (options = {}) => bound("chrome_drag", options),
      upload: (options = {}) => bound("chrome_upload", options),
      getJsDialog: () => bound("chrome_dialog", { action: "get" }),
      handleJsDialog: (action, promptText) => bound("chrome_dialog", { action: "handle", handleAction: action, promptText }),
      requestUserTakeover: (reason = "other") => bound("chrome_user_takeover", { reason }),
      requestManualHandoff: (reason = "user_requested") => bound("chrome_user_takeover", { reason }),
      playwright: {
        domSnapshot: async () => (await bound("chrome_eval", { expression: "document.documentElement.outerHTML" })).value,
        evaluate: (pageFunction, arg, options = {}) => {
          if (typeof pageFunction === "function") {
            return bound("chrome_eval", {
              expression: `(async () => { const __fn = (${String(pageFunction)}); return await __fn(${JSON.stringify(arg ?? null)}); })()`,
            }).then((result) => result.value);
          }
          return bound("chrome_eval", { expression: String(pageFunction) }).then((result) => result.value);
        },
        locator: (selector, options = {}) => makeLocator({ selector, ...options }, browserId, numericId),
        getByRole: (role, options = {}) => makeLocator({ role, ...options }, browserId, numericId),
        getByText: (text, options = {}) => makeLocator({ text, ...options }, browserId, numericId),
        getByLabel: (label, options = {}) => makeLocator({ label, ...options }, browserId, numericId),
        getByPlaceholder: (placeholder, options = {}) => makeLocator({ placeholder, ...options }, browserId, numericId),
        getByTestId: (testId) => makeLocator({ testId }, browserId, numericId),
        getByAltText: (alt, options = {}) => makeLocator({ alt, ...options }, browserId, numericId),
        getByTitle: (title, options = {}) => makeLocator({ title, ...options }, browserId, numericId),
        frameLocator: (selector) => makeLocator({ frame: [selector] }, browserId, numericId),
        waitForLoadState: (state = "load", options = {}) => {
          const actualState = typeof state === "object" && state !== null ? state.state ?? "load" : state;
          const actualOptions = typeof state === "object" && state !== null ? state : options;
          return cmd("page.waitForLoadState", { state: actualState, ...actualOptions });
        },
        waitForTimeout: async (timeoutMs) => {
          await new Promise((resolve) => setTimeout(resolve, timeoutMs));
        },
        waitForURL: (url, options = {}) => cmd("page.waitForURL", { url, ...options }),
        expectNavigation: async (action, options = {}) => {
          // Start listening before the action; the extension records changes
          // that happen while the action is in flight, closing the race where
          // a fast navigation is already complete before the wait begins.
          const waiter = cmd("page.expectNavigation", {
            url: options.url,
            waitUntil: options.waitUntil ?? "load",
            timeoutMs: options.timeoutMs,
          });
          try {
            const result = await action();
            await waiter;
            return result;
          } catch (error) {
            void waiter.catch(() => {});
            throw error;
          }
        },
        waitForEvent: async (event, options = {}) => {
          if (event === "download") return command("downloads.wait", { tabId: numericId, ...options }, browserId);
          if (event === "filechooser") {
            const chooser = await command("filechooser.wait", { tabId: numericId, ...options }, browserId);
            return {
              ...chooser,
              isMultiple: () => chooser.mode === "selectMultiple",
              setFiles: (files) => command("filechooser.setFiles", { tabId: numericId, backendNodeId: chooser.backendNodeId, files }, browserId),
            };
          }
          throw new Error(`unsupported Playwright event ${event}`);
        },
      },
      ax: {
        get: axGet,
        write: axWrite,
        click: (target, options = {}) => {
          const at =
            typeof target === "number"
              ? { ref: `e${target}` }
              : typeof target === "string"
                ? { ref: target }
                : { x: target[0], y: target[1] };
          const { mouseButton, key, ...rest } = options;
          const chordParts = typeof key === "string" ? key.split("+").map((part) => part.trim()).filter(Boolean) : [];
          const modifiers = [
            ...(Array.isArray(rest.modifiers) ? rest.modifiers : []),
            ...(chordParts.length > 1 ? chordParts.slice(0, -1) : chordParts),
          ];
          return bound("chrome_click", {
            ...at,
            ...rest,
            ...(mouseButton !== undefined ? { button: mouseButton } : {}),
            ...(modifiers.length > 0 ? { modifiers } : {}),
          });
        },
        setValue: (index, value) => bound("chrome_set_value", { ref: typeof index === "number" ? `e${index}` : String(index), value }),
        typeText: (index, text) => bound("chrome_type", { ...(index === null ? {} : { ref: typeof index === "number" ? `e${index}` : String(index) }), text }),
        pressKey: (index, key, options = {}) => bound("chrome_key", { ...(index === null ? {} : { ref: typeof index === "number" ? `e${index}` : String(index) }), key, ...options }),
        scroll: (target, direction, pages = 1) => {
          const at =
            typeof target === "number"
              ? { ref: `e${target}` }
              : typeof target === "string"
                ? { ref: target }
                : { x: target[0], y: target[1] };
          return bound("chrome_scroll", { ...at, direction, pages });
        },
        drag: (from, to) => bound("chrome_drag", { fromX: from[0], fromY: from[1], toX: to[0], toY: to[1] }),
        paste: (index, text, options = {}) => bound("chrome_clipboard", { ...(index === null ? {} : { ref: `e${index}` }), action: "paste", text, ...options }),
        selectText: (index, text, options = {}) =>
          bound("chrome_set_value", { action: "selectText", ref: typeof index === "number" ? `e${index}` : String(index), text, ...options }),
        performSecondaryAction: (index, action) =>
          bound("chrome_locator", { action: "secondaryAction", ref: typeof index === "number" ? `e${index}` : String(index), secondaryAction: action }),
      },
      cua: {
        click: (options) => bound("chrome_click", options),
        double_click: (options) => bound("chrome_click", { ...options, clickCount: 2 }),
        move: (options) => bound("chrome_move", options),
        drag: (options) => bound("chrome_drag", options),
        scroll: (options) => bound("chrome_scroll", { deltaX: options.scrollX, deltaY: options.scrollY, x: options.x, y: options.y, modifiers: options.keypress }),
        type: (options) => bound("chrome_type", { text: options.text }),
        keypress: (options) => bound("chrome_key", { key: options.keys?.[0] ?? "Enter", modifiers: options.keys?.slice(1) }),
        downloadMedia: (options) => bound("chrome_click", { ...options, waitForDownload: true }),
      },
      dom_cua: {
        get_visible_dom: () => bound("chrome_find", { limit: 200 }),
        click: (options) => bound("chrome_click", { ref: options.node_id }),
        double_click: (options) => bound("chrome_click", { ref: options.node_id, clickCount: 2 }),
        type: (options) => bound("chrome_type", { text: options.text }),
        keypress: (options) => bound("chrome_key", { key: options.keys?.[0] ?? "Enter" }),
        scroll: (options) => bound("chrome_scroll", { ref: options.node_id, deltaX: options.x, deltaY: options.y }),
        downloadMedia: (options) => bound("chrome_click", { ...options, waitForDownload: true }),
      },
      clipboard: {
        read: async () => {
          const result = await bound("chrome_clipboard", { action: "read" });
          return [{ entries: [{ mime_type: "text/plain", text: result.text ?? "" }] }];
        },
        readText: async () => (await bound("chrome_clipboard", { action: "read" })).text,
        write: (items) => {
          const entries = items?.[0]?.entries ?? items ?? [];
          const text = entries.map((entry) => entry.text ?? "").join("");
          return bound("chrome_clipboard", { action: "write", text });
        },
        writeText: (text) => bound("chrome_clipboard", { action: "write", text }),
      },
      dev: { logs: async (options = {}) => (await bound("chrome_logs", options)).logs },
      content: {
        export: (format = "text") => bound("chrome_export", { format }),
        exportGsuite: (type = "pdf") => bound("chrome_export_gsuite", { type }),
        exportYouTubeTranscript: () => bound("chrome_export_youtube_transcript"),
      },
      capabilities: {
        get: async (id) => {
          if (id === "cdp")
            return {
              send: (method, params) => bound("chrome_cdp", { action: "send", method, params }),
              readEvents: (options) => bound("chrome_cdp", { action: "events", ...options }),
            };
          if (id === "pageAssets")
            return {
              list: () => bound("chrome_page_assets"),
              bundle: (options) => bound("chrome_page_assets", { bundle: true, ...options }),
            };
          if (id === "webmcp")
            return {
              fetchTools: () => bound("chrome_webmcp", { action: "list" }),
              call: (registrationId, input, options = {}) => bound("chrome_webmcp", { action: "invoke", registrationId, input, ...options }),
            };
          if (id === "siwc")
            return {
              detect: () => bound("chrome_siwc", { action: "detect" }),
              authenticate: (options = {}) => bound("chrome_siwc", { action: "authenticate", ...options }),
            };
          if (id === "botDetection") return { report: (reason) => bound("chrome_bot_detection", { reason }) };
          if (id === "browserAuth") return { request: (message) => bound("chrome_browser_auth", { message }) };
          if (id === "viewport")
            return {
              set: (options) => bound("chrome_viewport", options),
              reset: () => bound("chrome_viewport", { reset: true }),
            };
          if (id === "visibility")
            return { get: () => bound("chrome_visibility"), set: (visible) => bound("chrome_visibility", { visible }) };
          if (id === "network")
            return {
              setHeaders: (headers) => bound("chrome_network", { action: "setHeaders", headers }),
              block: (urls) => bound("chrome_network", { action: "block", urls }),
              clear: () => bound("chrome_network", { action: "clear" }),
            };
          throw new Error(`Unknown tab capability ${JSON.stringify(id)}; available: cdp, pageAssets, webmcp, siwc, botDetection, browserAuth, viewport, visibility, network`);
        },
        list: async () => ["cdp", "pageAssets", "webmcp", "siwc", "botDetection", "browserAuth", "viewport", "visibility", "network"],
      },
    };
    return tab;
  }

  function makeBrowser(browserId) {
    const bound = (tool, args = {}) => call(tool, args, browserId);
    const cmd = (commandName, params = {}) => command(commandName, params, browserId);
    return {
      get browserId() {
        return browserId ?? execNow().chromeBrowserId ?? bridge.status().activeBrowserId;
      },
      tabs: {
        list: async () => (await bound("chrome_tabs", { all: true })).tabs,
        new: async () => makeTab((await cmd("tabs.new", { url: "about:blank" })).id, browserId ?? bridge.status().activeBrowserId),
        get: async (id) => {
          const tab = await cmd("tabs.get", { tabId: Number(id) });
          return makeTab(tab.id, browserId);
        },
        selected: async () => makeTab((await cmd("tabs.active", {})).id, browserId),
        content: (options) =>
          bound("chrome_read_urls", {
            urls: options.urls,
            format: options.contentType === "html" || options.contentType === "domSnapshot" ? "html" : "text",
            timeoutMs: options.timeoutMs,
          }),
      },
      user: {
        openTabs: async () => (await bound("chrome_open_tabs")).tabs,
        claimTab: async (tab) => {
          const tabId = Number(tab?.id ?? tab?.providerTabId ?? tab?.tabId ?? tab);
          const claimed = await bound("chrome_claim_tab", {
            tabId,
            ...(tab?.url !== undefined ? { url: tab.url } : {}),
            ...(tab?.title !== undefined ? { title: tab.title } : {}),
          });
          return makeTab(claimed.tabId, browserId);
        },
        getTabContext: async (tab) => {
          const tabId = Number(tab?.id ?? tab);
          const [info, page] = await Promise.all([cmd("tabs.get", { tabId }), bound("chrome_read_page", { tabId })]);
          return { ...info, text: page.text ?? "", truncated: page.truncated === true };
        },
      },
      history: async (options = {}) => (await bound("chrome_history", options)).value ?? [],
      nameSession: (name) => bound("chrome_group", { name }),
      documentation: async () => "DSH Chrome Bridge browser-use API. Use browser.tabs, tab.playwright, tab.ax, tab.cua, tab.clipboard, tab.dev and tab.capabilities.",
      capabilities: {
        get: async (id) => {
          if (id === "management") {
            const namespace = (name) =>
              new Proxy(
                {},
                {
                  get: (_target, method) => async (...args) => {
                    const result = await bound("chrome_management", { namespace: name, method, args });
                    return result?.value ?? result;
                  },
                }
              );
            return {
              tabs: namespace("tabs"),
              tabGroups: namespace("tabGroups"),
              windows: namespace("windows"),
              bookmarks: namespace("bookmarks"),
              history: namespace("history"),
              getAuditTrail: (options = {}) => bound("chrome_audit_trail", options),
            };
          }
          if (id === "visibility") return { get: () => bound("chrome_visibility"), set: (visible) => bound("chrome_visibility", { visible }) };
          if (id === "viewport") return { set: (options) => bound("chrome_viewport", options), reset: () => bound("chrome_viewport", { reset: true }) };
          throw new Error(`Unknown browser capability ${JSON.stringify(id)}; available: management, visibility, viewport`);
        },
        list: async () => ["management", "visibility", "viewport"],
      },
    };
  }

  const activeBrowserId = () => bridge.status().activeBrowserId;
  const browser = makeBrowser(activeBrowserId());
  const agent = {
    browsers: {
      list: async () => bridge.status().browsers ?? [],
      get: async (id) => {
        if (id === undefined || id === null) return makeBrowser(activeBrowserId());
        const exists = (bridge.status().browsers ?? []).some((browser) => String(browser.id) === String(id));
        if (!exists) throw new Error(`unknown browser ${JSON.stringify(id)}`);
        return makeBrowser(String(id));
      },
      getDefault: async () => makeBrowser(activeBrowserId()),
      getForUrl: async () => makeBrowser(activeBrowserId()),
    },
    documentation: {
      get: async (name = "overview") => documentationFor(name),
    },
  };
  function documentationFor(name) {
    const text = {
      overview:
        "Browser Use API. Prefer tab.ax.write() to observe accessibility state, perform one or more actions, then call tab.ax.write() again. " +
        "Use const for stable handles. tab.ax.get() returns state as a string without emitting it; tab.ax.write() emits text and (with screenshot/both) image output into the tool result. " +
        "Element refs are stable for the current document; a main-frame navigation invalidates them. Batch actions with tab.ax.write() or chrome_act.",
      ax:
        "tab.ax (element indices come from the latest AX state):\n" +
        "- get(mode?: 'state'|'screenshot'|'both', options?: {disableDiffing?}) -> string (or {state,screenshot} for both)\n" +
        "- write(mode?: 'state'|'screenshot'|'both', options?: {disableDiffing?}) -> void, emits model-visible text/image\n" +
        "- click(target: number|string|[x,y], options?: {clickCount?, duration?, key?, mouseButton?})\n" +
        "- setValue(index, value); typeText(index|null, text); pressKey(index|null, key, {duration?})\n" +
        "- paste(index|null, text, {format?: 'text'|'md'|'html'}); selectText(index, text, {prefix?, suffix?, selectionType?: 'text'|'cursor_before'|'cursor_after'})\n" +
        "- scroll(target, 'up'|'down'|'left'|'right', pages?); performSecondaryAction(index, 'Expand'|'Collapse')",
      playwright:
        "tab.playwright:\n" +
        "- locator(selector), getByRole(role,{name,exact}), getByLabel, getByPlaceholder, getByText, getByTestId, getByAltText, getByTitle, frameLocator\n" +
        "- evaluate(pageFunction,arg?), domSnapshot(), waitForLoadState(state), waitForURL(url), expectNavigation(action,options), waitForEvent('download'|'filechooser')\n" +
        "Locator: count/isVisible/isEnabled/getAttribute/innerText/textContent/allTextContents/fill/type/press/pressSequentially/selectOption/check/uncheck/setChecked/waitFor/filter/and/or/nth/first/last/all/evaluate/evaluateAll. " +
        "Strict mode is on for single-element actions unless nth is supplied.",
      cua: "tab.cua provides click/double_click/move/drag/scroll/type/keypress/downloadMedia using real mouse and keyboard input.",
      clipboard: "tab.clipboard: read() -> TabClipboardEntry[], readText() -> string, write(items), writeText(text).",
      content: "tab.content: export(format), exportGsuite(type), exportYouTubeTranscript().",
      capabilities: "tab.capabilities.get(id) for cdp, pageAssets, webmcp, siwc, botDetection, browserAuth, viewport, visibility, network. Unknown ids throw.",
    };
    return text[name] ?? `DSH Chrome Bridge documentation: ${name}`;
  }

  return { agent, browser, browsers: agent.browsers, tab: makeTab, tabs: browser.tabs, call, command, makeTab };
}

/* ------------------------------------------------------------------ */
/* Top-level declaration handling                                      */
/* ------------------------------------------------------------------ */

const STATEMENT_KEYWORDS = new Set([
  "const", "let", "var", "function", "class", "if", "for", "while", "do", "switch", "try",
  "catch", "finally", "throw", "return", "break", "continue", "import", "export",
]);

function isIdentifierStart(ch) {
  return /[A-Za-z_$]/.test(ch);
}
function isIdentifierPart(ch) {
  return /[A-Za-z0-9_$]/.test(ch);
}

/** Skip a string/template/comment starting at index; returns the new index. */
function skipLiteralOrComment(code, index) {
  const ch = code[index];
  const next = code[index + 1];
  if (ch === "/" && next === "/") {
    const end = code.indexOf("\n", index + 2);
    return end === -1 ? code.length : end;
  }
  if (ch === "/" && next === "*") {
    const end = code.indexOf("*/", index + 2);
    return end === -1 ? code.length : end + 2;
  }
  if (ch === '"' || ch === "'") {
    let i = index + 1;
    while (i < code.length) {
      if (code[i] === "\\") i += 2;
      else if (code[i] === ch) return i + 1;
      else i += 1;
    }
    return i;
  }
  if (ch === "`") {
    let i = index + 1;
    while (i < code.length) {
      if (code[i] === "\\") i += 2;
      else if (code[i] === "`") return i + 1;
      else if (code[i] === "$" && code[i + 1] === "{") {
        i = findMatching(code, i + 1, "{", "}") + 1;
      } else i += 1;
    }
    return i;
  }
  return index;
}

function findMatching(code, index, open, close) {
  let depth = 0;
  let i = index;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipLiteralOrComment(code, i);
      continue;
    }
    if (ch === "/" && (code[i + 1] === "/" || code[i + 1] === "*")) {
      i = skipLiteralOrComment(code, i);
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return code.length - 1;
}

/** Split `code[start..end)` by commas at nesting depth zero. */
function splitTopLevelCommas(code, start, end) {
  const parts = [];
  let depth = 0;
  let partStart = start;
  let i = start;
  while (i < end) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipLiteralOrComment(code, i);
      continue;
    }
    if (ch === "/" && (code[i + 1] === "/" || code[i + 1] === "*")) {
      i = skipLiteralOrComment(code, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push([partStart, i]);
      partStart = i + 1;
    }
    i += 1;
  }
  parts.push([partStart, end]);
  return parts.filter(([from, to]) => code.slice(from, to).trim().length > 0);
}

/** Find the `=` that separates a destructuring/identifier pattern from its initializer. */
function findDeclaratorEquals(code, start, end) {
  let depth = 0;
  let i = start;
  while (i < end) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipLiteralOrComment(code, i);
      continue;
    }
    if (ch === "/" && (code[i + 1] === "/" || code[i + 1] === "*")) {
      i = skipLiteralOrComment(code, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    else if (ch === "=" && depth === 0) {
      const prev = code[i - 1];
      const next = code[i + 1];
      if (next === ">" || next === "=" || prev === "=" || prev === "!" || prev === "<" || prev === ">") {
        i += 1;
        continue;
      }
      return i;
    }
    i += 1;
  }
  return -1;
}

/** Rewrite one top-level `const|let|var` declaration block into assignments. */
function rewriteDeclaration(code, keywordStart, keywordEnd) {
  // Find the end of the declaration: top-level semicolon or EOF.
  let depth = 0;
  let i = keywordEnd;
  let end = code.length;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipLiteralOrComment(code, i);
      continue;
    }
    if (ch === "/" && (code[i + 1] === "/" || code[i + 1] === "*")) {
      i = skipLiteralOrComment(code, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    else if (ch === ";" && depth === 0) {
      end = i;
      break;
    }
    i += 1;
  }
  const parts = splitTopLevelCommas(code, keywordEnd, end);
  const statements = [];
  for (const [from, to] of parts) {
    const equals = findDeclaratorEquals(code, from, to);
    if (equals === -1) {
      // `const x;` is invalid JS, but a bare identifier without init can be
      // promoted as undefined.
      const name = code.slice(from, to).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) statements.push(`${name} = undefined;`);
      continue;
    }
    const pattern = code.slice(from, equals).trim();
    const initializer = code.slice(equals + 1, to).trim();
    if (/^[A-Za-z_$][\w$]*$/.test(pattern)) {
      statements.push(`${pattern} = ${initializer};`);
    } else if (pattern.startsWith("{") || pattern.startsWith("[")) {
      statements.push(`(${pattern} = ${initializer});`);
    } else {
      statements.push(`${pattern} = ${initializer};`);
    }
  }
  return { text: statements.join("\n"), end: end + 1 <= code.length && code[end] === ";" ? end + 1 : end };
}

/** Rewrite top-level function/class declarations as persistable assignments. */
function rewriteFunctionOrClass(code, start, keywordEnd, kind) {
  let i = keywordEnd;
  // Find the name (skip `async` is handled by caller as part of kind).
  while (i < code.length && /\s/.test(code[i])) i += 1;
  let name = "";
  while (i < code.length && isIdentifierPart(code[i])) {
    name += code[i];
    i += 1;
  }
  if (name.length === 0) return null;
  if (kind === "class") {
    const brace = code.indexOf("{", i);
    if (brace === -1) return null;
    const close = findMatching(code, brace, "{", "}");
    return {
      text: `${name} = ${code.slice(start, close + 1)};`,
      end: close + 1,
    };
  }
  const brace = code.indexOf("{", i);
  if (brace === -1) return null;
  const close = findMatching(code, brace, "{", "}");
  return {
    text: `${name} = ${code.slice(start, close + 1)};`,
    end: close + 1,
  };
}

/**
 * Promote top-level declarations to global assignments so the async wrapper
 * cannot hide them, while leaving nested declarations untouched.
 */
export function transformTopLevelDeclarations(code) {
  let out = "";
  let i = 0;
  let depth = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const next = skipLiteralOrComment(code, i);
      out += code.slice(i, next);
      i = next;
      continue;
    }
    if (ch === "/" && (code[i + 1] === "/" || code[i + 1] === "*")) {
      const next = skipLiteralOrComment(code, i);
      out += code.slice(i, next);
      i = next;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      out += ch;
      i += 1;
      continue;
    }
    if (depth === 0 && isIdentifierStart(ch)) {
      let word = "";
      let j = i;
      while (j < code.length && isIdentifierPart(code[j])) {
        word += code[j];
        j += 1;
      }
      // `async function` / `async class`? Only function is valid.
      if (word === "async") {
        let k = j;
        while (k < code.length && /\s/.test(code[k])) k += 1;
        if (code.slice(k, k + 8) === "function") {
          const rewritten = rewriteFunctionOrClass(code, i, k + 8, "async function");
          if (rewritten !== null) {
            out += rewritten.text;
            i = rewritten.end;
            continue;
          }
        }
      }
      if (word === "const" || word === "let" || word === "var") {
        const rewritten = rewriteDeclaration(code, i, j);
        out += rewritten.text;
        i = rewritten.end;
        continue;
      }
      if (word === "function" || word === "class") {
        const rewritten = rewriteFunctionOrClass(code, i, j, word);
        if (rewritten !== null) {
          out += rewritten.text;
          i = rewritten.end;
          continue;
        }
      }
      out += word;
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Find the last top-level semicolon (outside strings/comments/nesting). */
function lastTopLevelSemicolon(code) {
  let depth = 0;
  let last = -1;
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipLiteralOrComment(code, i);
      continue;
    }
    if (ch === "/" && (code[i + 1] === "/" || code[i + 1] === "*")) {
      i = skipLiteralOrComment(code, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    else if (ch === ";" && depth === 0) last = i;
    i += 1;
  }
  return last;
}

/**
 * Split a trailing expression statement off so its completion value can be
 * returned after the declaration/statement body has run.
 */
function isExpressionSource(source) {
  const firstWord = source.match(/^[A-Za-z_$][\w$]*/)?.[0] ?? "";
  if (STATEMENT_KEYWORDS.has(firstWord)) return false;
  if (/[{}]\s*$/.test(source) && !/^[({[]/.test(source)) return false;
  try {
    // Compile only; no execution happens here.
    new vm.Script(`(async () => (${source}))`);
    return true;
  } catch {
    return false;
  }
}

/** Split a trailing expression statement off the end of the source. */
export function splitTrailingExpression(code) {
  if (isExpressionSource(String(code).trim())) {
    return { body: "", expression: String(code).trim() };
  }
  const index = lastTopLevelSemicolon(code);
  if (index !== -1) {
    const tail = code.slice(index + 1).trim();
    if (tail.length === 0) return { body: code, expression: null };
    if (isExpressionSource(tail)) return { body: code.slice(0, index + 1), expression: tail };
  }
  // No top-level semicolon (or an invalid tail): find a statement boundary at
  // a top-level closing brace or newline whose suffix is an expression.
  const boundaries = [];
  let depth = 0;
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipLiteralOrComment(code, i);
      continue;
    }
    if (ch === "/" && (code[i + 1] === "/" || code[i + 1] === "*")) {
      i = skipLiteralOrComment(code, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0 && ch === "}") boundaries.push(i);
    } else if (ch === "\n" && depth === 0) {
      boundaries.push(i);
    }
    i += 1;
  }
  for (const boundary of boundaries.reverse()) {
    const tail = code.slice(boundary + 1).trim();
    if (tail.length === 0 || !isExpressionSource(tail)) continue;
    const body = code.slice(0, boundary + 1);
    try {
      new vm.Script(`(async () => {\n${transformTopLevelDeclarations(body)}\n})()`);
    } catch {
      continue;
    }
    return { body, expression: tail };
  }
  return { body: code, expression: null };
}

/**
 * Turn REPL source into an async wrapper. Top-level declarations are promoted
 * to persistent globals and the trailing expression is returned separately.
 */
export function prepareReplSource(code) {
  const source = String(code);
  const split = splitTrailingExpression(source);
  const body = transformTopLevelDeclarations(split.body);
  return {
    body: `(async () => {\n${body}\n})()`,
    expression: split.expression === null ? null : `(async () => (${split.expression}))()`,
  };
}

/** Create a persistent runner. Contexts are retained by DSH session id. */
export function createBrowserRepl({ bridge, definitions, resolveTabId }) {
  const contexts = new Map();
  return async function run(code, exec, options = {}) {
    const key = sessionKeyOf(exec);
    let entry = contexts.get(key);
    if (entry === undefined) {
      const logs = [];
      const console = {
        log: (...args) => logs.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")),
        info: (...args) => console.log(...args),
        warn: (...args) => console.log(...args),
        error: (...args) => console.log(...args),
      };
      const context = vm.createContext({
        console,
        URL,
        URLSearchParams,
        JSON,
        Math,
        Date,
        Promise,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        Uint8Array,
        ArrayBuffer,
        TextEncoder,
        TextDecoder,
        Buffer,
      });
      entry = { context, logs, exec: null, outputs: [] };
      contexts.set(key, entry);
    }
    entry.exec = exec;
    entry.outputs = [];
    entry.logs.length = 0;
    // Re-bind the API on every call so the current turn's abort signal and
    // browser selection are used; user-defined globals stay in the VM.
    Object.assign(entry.context, makeApi({ bridge, definitions, getState: () => entry, resolveTabId }));
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 30000);
    const deadline = Date.now() + timeoutMs;
    const { body, expression } = prepareReplSource(code);
    const script = new vm.Script(body, { filename: `chrome-repl-${key}.js` });
    const signal = exec?.signal;
    let timer;
    let abortListener;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`chrome_js timed out after ${timeoutMs}ms`)), timeoutMs);
      if (signal !== undefined) {
        abortListener = () => reject(signal.reason ?? new Error("chrome_js aborted"));
        if (signal.aborted) abortListener();
        else signal.addEventListener("abort", abortListener, { once: true });
      }
    });
    try {
      const syncResult = script.runInContext(entry.context, { timeout: Math.max(1, deadline - Date.now()) });
      const value = await Promise.race([Promise.resolve(syncResult), timeout]);
      let finalValue = value;
      if (expression !== null) {
        const expressionScript = new vm.Script(expression, { filename: `chrome-repl-${key}-tail.js` });
        const expressionResult = expressionScript.runInContext(entry.context, { timeout: Math.max(1, deadline - Date.now()) });
        finalValue = await Promise.race([Promise.resolve(expressionResult), timeout]);
      }
      return {
        value: jsonValue(finalValue),
        logs: [...entry.logs],
        outputs: entry.outputs.map((output) => output.blocks),
        browserId: bridge.status().activeBrowserId,
      };
    } finally {
      clearTimeout(timer);
      if (signal !== undefined && abortListener !== undefined) signal.removeEventListener("abort", abortListener);
      entry.exec = null;
    }
  };
}
