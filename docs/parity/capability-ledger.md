# DSH Chrome Bridge 官方能力台账（自动生成）

- 生成时间：2026-11-05T05:02:42.946Z
- DSH 版本：0.1.1（扩展 manifest 0.1.1）
- Git HEAD：`dd85e38dd64fdd079da445ec9c9c0d529385bfac`
- 官方 api.json：`/home/yelin/.codex/plugins/cache/openai-bundled/chrome/26.1027.51404/docs/api.json`
- api.json SHA-256：`5c417409700ce642d08851b962fbb5b5579286e69597d660e8f5aebce929d380`
- 官方接口 22 个，方法 148 个，类型 67 个
- DSH 已注册工具 60 个

状态仅使用“待核对”“已确认差距”“实现中”“待官方对照”“待模型验收”“待依赖”“已验收”；“已验收”必须关联证据。

## 1. 官方接口与方法

| 编号 | 接口.方法 | 官方签名 | 状态 | 证据 |
|---|---|---|---|---|
| API-001 | `Agent.browsers` | browsers: Browsers; // API for finding and selecting browsers. | 待核对 |  |
| API-002 | `Agent.documentation` | documentation: Documentation; // API for reading packaged browser-use documentation by name. | 待核对 |  |
| API-003 | `Browsers.get` | get(id: string): Promise<Browser>; // Get a browser by id or client type. | 待核对 |  |
| API-004 | `Browsers.getDefault` | getDefault(): Promise<Browser>; // Get the default browser from those currently available. | 待核对 |  |
| API-005 | `Browsers.getForUrl` | getForUrl(url: string): Promise<Browser>; // Get the browser best suited to interact with the provided URL. | 待核对 |  |
| API-006 | `Browsers.list` | list(): Promise<Array<{ family?: string; id: string; metadata?: { codexSessionId?: string; extensionInstanceId?: string }; name: string; profileName?: string; type: "iab" \| "extension" \| "cdp" \| "mcpapps" }>>; // List available browsers. | 待核对 |  |
| API-007 | `Browser.browserId` | browserId: string; // Browser id selected by `agent.browsers.get()`. | 待核对 |  |
| API-008 | `Browser.capabilities` | capabilities: BrowserCapabilityCollection; // Browser-scoped optional capabilities advertised by the connected backend; discover IDs with `await browser.capabilities.list()`, then call `await (await browser.capabilities.get(id)).documentation()` for method details. | 待核对 |  |
| API-009 | `Browser.tabs` | tabs: Tabs; // API for interacting with browser tabs. | 待核对 |  |
| API-010 | `Browser.user` | user: BrowserUser; // Context for user-owned browser tabs. | 待核对 |  |
| API-011 | `Browser.documentation` | documentation(): Promise<string>; // Read browser guidance and the core API reference. | 待核对 |  |
| API-012 | `Browser.history` | history(options: BrowserHistoryOptions): Promise<Array<BrowserHistoryEntry>>; // List recent browsing history ordered by `dateVisited` descending. | 待核对 |  |
| API-013 | `Browser.nameSession` | nameSession(name: string): Promise<void>; // Name the current browser automation session. | 待核对 |  |
| API-014 | `BrowserUser.claimTab` | claimTab(tab: string \| BrowserUserTabInfo): Promise<Tab>; // Claim a user tab returned by `openTabs()` and return it as a controllable agent tab. | 待核对 |  |
| API-015 | `BrowserUser.getTabContext` | getTabContext(tab?: string \| BrowserUserTabInfo): Promise<BrowserUserTabContext>; // Read page context from an open user tab without claiming it. | 待核对 |  |
| API-016 | `BrowserUser.openTabs` | openTabs(): Promise<Array<BrowserUserTabInfo>>; // List open top-level tabs across the user's browser windows ordered by `lastOpened` descending. | 待核对 |  |
| API-017 | `Tabs.content` | content(options: TabsContentOptions): Promise<Array<TabsContentResult>>; // Load one or more URLs in temporary background tabs and extract their content without changing the selected tab. | 待核对 |  |
| API-018 | `Tabs.get` | get(id: string): Promise<Tab>; // Get a tab by id. | 待核对 |  |
| API-019 | `Tabs.list` | list(): Promise<Array<TabInfo>>; // List open tabs in the browser. | 待核对 |  |
| API-020 | `Tabs.new` | new(): Promise<Tab>; // Create and return a new tab in the browser. | 待核对 |  |
| API-021 | `Tabs.selected` | selected(): Promise<undefined \| Tab>; // Return the currently selected tab, if any. | 待核对 |  |
| API-022 | `Tab.ax` | ax: AXAPI; // API for interacting with accessibility state and accessibility elements. | 待核对 |  |
| API-023 | `Tab.capabilities` | capabilities: TabCapabilityCollection; // Tab-scoped optional capabilities advertised by the connected backend; discover IDs with `await tab.capabilities.list()`, then call `await (await tab.capabilities.get(id)).documentation()` for method details. | 待核对 |  |
| API-024 | `Tab.clipboard` | clipboard: TabClipboardAPI; // API for interacting with the browser session's clipboard. | 待核对 |  |
| API-025 | `Tab.content` | content: ContentAPI; // API for exporting tab content. | 待核对 |  |
| API-026 | `Tab.cua` | cua: CUAAPI; // API for interacting with the tab via the cua api | 待核对 |  |
| API-027 | `Tab.dev` | dev: TabDevAPI; // API for developer-oriented tab inspection. | 待核对 |  |
| API-028 | `Tab.dom_cua` | dom_cua: DomCUAAPI; // API for interacting with the tab via the dom based cua api | 待核对 |  |
| API-029 | `Tab.id` | id: string; // A tab's unique identifier | 待核对 |  |
| API-030 | `Tab.playwright` | playwright: PlaywrightAPI; // API for interacting with the tab via the playwright api | 待核对 |  |
| API-031 | `Tab.back` | back(): Promise<void>; // Navigate this tab back in history. | 待核对 |  |
| API-032 | `Tab.close` | close(): Promise<void>; // Close this tab. | 待核对 |  |
| API-033 | `Tab.forward` | forward(): Promise<void>; // Navigate this tab forward in history. | 待核对 |  |
| API-034 | `Tab.getJsDialog` | getJsDialog(): Promise<undefined \| Dialog>; // Get the active JavaScript dialog for this tab, if one is currently open. | 待核对 |  |
| API-035 | `Tab.goto` | goto(url: string): Promise<void>; // Open a URL in this tab. | 待核对 |  |
| API-036 | `Tab.markDeliverable` | markDeliverable(): Promise<void>; // Keep this tab as a deliverable after the turn completes. | 待核对 |  |
| API-037 | `Tab.markHandoff` | markHandoff(): Promise<void>; // Keep this tab available for a later turn after the current turn completes. | 待核对 |  |
| API-038 | `Tab.reload` | reload(): Promise<void>; // Reload this tab. | 待核对 |  |
| API-039 | `Tab.requestManualHandoff` | requestManualHandoff(): Promise<void>; | 待核对 |  |
| API-040 | `Tab.requestUserTakeover` | requestUserTakeover(reason?: "authentication" \| "captcha" \| "user_requested" \| "other"): Promise<void>; // Request manual user control of this Cloud Browser tab. | 待核对 |  |
| API-041 | `Tab.screenshot` | screenshot(options: ScreenshotOptions): Promise<Uint8Array>; // Capture a screenshot of this tab. | 待核对 |  |
| API-042 | `Tab.title` | title(): Promise<undefined \| string>; // Get the current title for this tab. | 待核对 |  |
| API-043 | `Tab.url` | url(): Promise<undefined \| string>; // Get the current URL for this tab. | 待核对 |  |
| API-044 | `AXAPI.click` | click(target: number \| AXPoint, options?: AXClickOptions): Promise<void>; // Click an accessibility element or viewport coordinate. | 待核对 |  |
| API-045 | `AXAPI.drag` | drag(from: AXPoint, to: AXPoint): Promise<void>; // Drag between two viewport coordinates. | 待核对 |  |
| API-046 | `AXAPI.get` | get(mode?: "state", options?: AXStateOptions): Promise<string>; // Return accessibility state without displaying it; prefer write() for model-visible observation.<br>get(mode: "screenshot"): Promise<Uint8Array>; // Return screenshot bytes without displaying an image or advancing accessibility state.<br>get(mode: "both", options?: AXStateOptions): Promise<{ screenshot?: Uint8Array; state: string }>; // Return accessibility state and screenshot bytes when available. | 待核对 |  |
| API-047 | `AXAPI.paste` | paste(elementIndex: null \| number, text: string, options?: AXPasteOptions): Promise<void>; // Paste through the browser session's virtual clipboard; null uses current focus. | 待核对 |  |
| API-048 | `AXAPI.performSecondaryAction` | performSecondaryAction(elementIndex: number, action: string): Promise<void>; // Invoke an additional action exposed by an accessibility element. | 待核对 |  |
| API-049 | `AXAPI.pressKey` | pressKey(elementIndex: null \| number, key: string, options?: AXPressKeyOptions): Promise<void>; // If elementIndex is specified, attempt to focus the element prior to key entry. | 待核对 |  |
| API-050 | `AXAPI.scroll` | scroll(target: number \| AXPoint, direction: AXDirection, pages?: number): Promise<void>; // Scroll an accessibility element or a viewport coordinate. | 待核对 |  |
| API-051 | `AXAPI.selectText` | selectText(elementIndex: number, text: string, options?: AXSelectTextOptions): Promise<void>; // Select text or position the cursor within an editable element. | 待核对 |  |
| API-052 | `AXAPI.setValue` | setValue(elementIndex: number, value: string): Promise<void>; // Set the value of an accessibility element. | 待核对 |  |
| API-053 | `AXAPI.typeText` | typeText(elementIndex: null \| number, text: string): Promise<void>; // If elementIndex is specified, attempt to focus the element prior to text entry. | 待核对 |  |
| API-054 | `AXAPI.write` | write(mode?: "state", options?: AXStateOptions): Promise<void>; // Prefer this method to display current accessibility state to the model.<br>write(mode: "screenshot"): Promise<void>; // Display a screenshot without advancing accessibility state.<br>write(mode: "both", options?: AXStateOptions): Promise<void>; // Display accessibility state followed by its corresponding screenshot. | 待核对 |  |
| API-055 | `ContentAPI.export` | export(): Promise<string>; // Export the tab's content to a file on disk using the default asset-loader path. | 待核对 |  |
| API-056 | `ContentAPI.exportGsuite` | exportGsuite(type: "pdf" \| "md" \| "xlsx" \| "csv" \| "docx" \| "pptx"): Promise<string>; // Export a Google Workspace tab using an explicit GSuite export type. | 待核对 |  |
| API-057 | `ContentAPI.exportYouTubeTranscript` | exportYouTubeTranscript(): Promise<string>; // Export an HTTPS youtube.com or www.youtube.com /watch transcript to a UTF-8 .txt file. | 待核对 |  |
| API-058 | `CUAAPI.click` | click(options: ClickOptions): Promise<void>; // Click at a coordinate in the current viewport. | 待核对 |  |
| API-059 | `CUAAPI.double_click` | double_click(options: DoubleClickOptions): Promise<void>; // Double click at a coordinate in the current viewport. | 待核对 |  |
| API-060 | `CUAAPI.downloadMedia` | downloadMedia(options: CuaDownloadMediaOptions): Promise<void>; // Trigger a media download at a viewport coordinate. | 待核对 |  |
| API-061 | `CUAAPI.drag` | drag(options: DragOptions): Promise<void>; // Drag from a point to a point by the provided path. | 待核对 |  |
| API-062 | `CUAAPI.keypress` | keypress(options: KeypressOptions): Promise<void>; // Press control characters at the current focused element (focus it first via click/dblclick). | 待核对 |  |
| API-063 | `CUAAPI.move` | move(options: MoveOptions): Promise<void>; // Move the mouse to a point by the provided x and y coordinates. | 待核对 |  |
| API-064 | `CUAAPI.scroll` | scroll(options: ScrollOptions): Promise<void>; // Scroll by a delta from a specific viewport coordinate. | 待核对 |  |
| API-065 | `CUAAPI.type` | type(options: TypeOptions): Promise<void>; // Type text at the current focus. | 待核对 |  |
| API-066 | `DomCUAAPI.click` | click(options: DomClickOptions): Promise<void>; // Click a DOM node by its id from the visible DOM snapshot. | 待核对 |  |
| API-067 | `DomCUAAPI.double_click` | double_click(options: DomClickOptions): Promise<void>; // Double-click a DOM node by its id. | 待核对 |  |
| API-068 | `DomCUAAPI.downloadMedia` | downloadMedia(options: DomDownloadMediaOptions): Promise<void>; // Trigger a media download for a DOM node. | 待核对 |  |
| API-069 | `DomCUAAPI.get_visible_dom` | get_visible_dom(): Promise<unknown>; // Return a filtered DOM with node ids for interactable elements. | 待核对 |  |
| API-070 | `DomCUAAPI.keypress` | keypress(options: DomKeypressOptions): Promise<void>; // Press control characters at the currently focused element (focus it first via click/dblclick). | 待核对 |  |
| API-071 | `DomCUAAPI.scroll` | scroll(options: DomScrollOptions): Promise<void>; // Scroll either the page or a specific node (if node_id provided) by deltas. | 待核对 |  |
| API-072 | `DomCUAAPI.type` | type(options: DomTypeOptions): Promise<void>; // Type text into the currently focused element (focus via click first). | 待核对 |  |
| API-073 | `PlaywrightAPI.domSnapshot` | domSnapshot(): Promise<string>; // Return a snapshot of the current DOM as a string, including expanded iframe body content when available. | 待核对 |  |
| API-074 | `PlaywrightAPI.elementInfo` | elementInfo(options: ElementInfoOptions): Promise<Array<ElementInfo>>; // Return locator-oriented metadata for elements at a screenshot coordinate. | 待核对 |  |
| API-075 | `PlaywrightAPI.elementScreenshot` | elementScreenshot(options: ElementScreenshotOptions): Promise<Uint8Array>; // Capture a screenshot of the current viewport annotated with matching element bounds and the probed point. | 待核对 |  |
| API-076 | `PlaywrightAPI.evaluate` | evaluate<TResult, TArg>(pageFunction: PlaywrightEvaluateFunction<TArg, TResult>, arg?: TArg, options?: PlaywrightEvaluateOptions): Promise<TResult>; // Evaluate JavaScript in a read-only page scope. | 待核对 |  |
| API-077 | `PlaywrightAPI.expectNavigation` | expectNavigation<T>(action: () => Promise<T>, options: { timeoutMs?: number; url?: string; waitUntil?: LoadState }): Promise<T>; // Expect a navigation triggered by an action. | 待核对 |  |
| API-078 | `PlaywrightAPI.frameLocator` | frameLocator(frameSelector: string): PlaywrightFrameLocator; // Create a frame-scoped locator builder. | 待核对 |  |
| API-079 | `PlaywrightAPI.getByLabel` | getByLabel(text: TextMatcher, options: { exact?: boolean }): PlaywrightLocator; // Find elements by label text within the page. | 待核对 |  |
| API-080 | `PlaywrightAPI.getByPlaceholder` | getByPlaceholder(text: TextMatcher, options: { exact?: boolean }): PlaywrightLocator; // Find elements by placeholder text within the page. | 待核对 |  |
| API-081 | `PlaywrightAPI.getByRole` | getByRole(role: string, options: { exact?: boolean; name?: TextMatcher }): PlaywrightLocator; // Find elements by ARIA role within the page. | 待核对 |  |
| API-082 | `PlaywrightAPI.getByTestId` | getByTestId(testId: string): PlaywrightLocator; // Find elements by test id within the page. | 待核对 |  |
| API-083 | `PlaywrightAPI.getByText` | getByText(text: TextMatcher, options: { exact?: boolean }): PlaywrightLocator; // Find elements by text within the page. | 待核对 |  |
| API-084 | `PlaywrightAPI.locator` | locator(selector: string): PlaywrightLocator; // Create a locator scoped to this tab. | 待核对 |  |
| API-085 | `PlaywrightAPI.waitForEvent` | waitForEvent(event: "download", options?: WaitForEventOptions): Promise<PlaywrightDownload>; // Wait for the next download to complete; call before clicking its download control.<br>waitForEvent(event: "filechooser", options?: WaitForEventOptions): Promise<PlaywrightFileChooser>; // Wait for a file chooser. | 待核对 |  |
| API-086 | `PlaywrightAPI.waitForLoadState` | waitForLoadState(options: PageWaitForLoadStateOptions): Promise<void>; // Wait for the page to reach a specific load state. | 待核对 |  |
| API-087 | `PlaywrightAPI.waitForTimeout` | waitForTimeout(timeoutMs: number): Promise<void>; // Wait for a fixed duration. | 待核对 |  |
| API-088 | `PlaywrightAPI.waitForURL` | waitForURL(url: string, options: PageWaitForURLOptions): Promise<void>; // Wait for the page URL to match the provided value. | 待核对 |  |
| API-089 | `PlaywrightFrameLocator.frameLocator` | frameLocator(frameSelector: string): PlaywrightFrameLocator; // Create a locator scoped to a nested frame. | 待核对 |  |
| API-090 | `PlaywrightFrameLocator.getByLabel` | getByLabel(text: TextMatcher, options: { exact?: boolean }): PlaywrightLocator; // Find elements by label within this frame. | 待核对 |  |
| API-091 | `PlaywrightFrameLocator.getByPlaceholder` | getByPlaceholder(text: TextMatcher, options: { exact?: boolean }): PlaywrightLocator; // Find elements by placeholder within this frame. | 待核对 |  |
| API-092 | `PlaywrightFrameLocator.getByRole` | getByRole(role: string, options: { exact?: boolean; name?: TextMatcher }): PlaywrightLocator; // Find elements by ARIA role within this frame. | 待核对 |  |
| API-093 | `PlaywrightFrameLocator.getByTestId` | getByTestId(testId: string): PlaywrightLocator; // Find elements by test id within this frame. | 待核对 |  |
| API-094 | `PlaywrightFrameLocator.getByText` | getByText(text: TextMatcher, options: { exact?: boolean }): PlaywrightLocator; // Find elements by text within this frame. | 待核对 |  |
| API-095 | `PlaywrightFrameLocator.locator` | locator(selector: string): PlaywrightLocator; // Create a locator scoped to this frame. | 待核对 |  |
| API-096 | `PlaywrightLocator.all` | all(): Promise<Array<PlaywrightLocator>>; // Resolve to a list of locators for each matched element. | 待核对 |  |
| API-097 | `PlaywrightLocator.allTextContents` | allTextContents(options: { timeoutMs?: number }): Promise<Array<string>>; // Return `textContent` for *all* elements matched by this locator. | 待核对 |  |
| API-098 | `PlaywrightLocator.and` | and(locator: PlaywrightLocator): PlaywrightLocator; // Return a locator matching elements that satisfy both this locator and `locator`. | 待核对 |  |
| API-099 | `PlaywrightLocator.check` | check(options: LocatorCheckOptions): Promise<void>; // Check a checkbox or switch-like control. | 待核对 |  |
| API-100 | `PlaywrightLocator.click` | click(options: LocatorClickOptions): Promise<void>; // Click the element matched by this locator. | 待核对 |  |
| API-101 | `PlaywrightLocator.count` | count(): Promise<number>; // Number of elements matching this locator. | 待核对 |  |
| API-102 | `PlaywrightLocator.dblclick` | dblclick(options: LocatorClickOptions): Promise<void>; // Double-click the element matched by this locator. | 待核对 |  |
| API-103 | `PlaywrightLocator.downloadMedia` | downloadMedia(options: LocatorDownloadMediaOptions): Promise<string>; // Download the matched media or file link and return its saved file path. | 待核对 |  |
| API-104 | `PlaywrightLocator.evaluate` | evaluate<TResult, TArg>(pageFunction: LocatorEvaluateFunction<TArg, TResult>, arg?: TArg, options?: PlaywrightEvaluateOptions): Promise<TResult>; // Evaluate JavaScript in a read-only scope; the locator must resolve unambiguously to one element. | 待核对 |  |
| API-105 | `PlaywrightLocator.evaluateAll` | evaluateAll<TResult, TArg>(pageFunction: LocatorEvaluateAllFunction<TArg, TResult>, arg?: TArg, options?: PlaywrightEvaluateOptions): Promise<TResult>; // Evaluate read-only JavaScript against all elements matched by this locator. | 待核对 |  |
| API-106 | `PlaywrightLocator.fill` | fill(value: string, options: { timeoutMs?: number }): Promise<void>; // Replace the element's value with the provided text. | 待核对 |  |
| API-107 | `PlaywrightLocator.filter` | filter(options: LocatorFilterOptions): PlaywrightLocator; // Narrow this locator by additional constraints. | 待核对 |  |
| API-108 | `PlaywrightLocator.first` | first(): PlaywrightLocator; // Return a locator pointing at the first matched element. | 待核对 |  |
| API-109 | `PlaywrightLocator.getAttribute` | getAttribute(name: string, options: { timeoutMs?: number }): Promise<null \| string>; // Return an attribute value from the first matched element. | 待核对 |  |
| API-110 | `PlaywrightLocator.getByLabel` | getByLabel(text: TextMatcher, options: { exact?: boolean }): PlaywrightLocator; // Find elements by label text, scoped to this locator. | 待核对 |  |
| API-111 | `PlaywrightLocator.getByPlaceholder` | getByPlaceholder(text: TextMatcher, options: { exact?: boolean }): PlaywrightLocator; // Find elements by placeholder text, scoped to this locator. | 待核对 |  |
| API-112 | `PlaywrightLocator.getByRole` | getByRole(role: string, options: { exact?: boolean; name?: TextMatcher }): PlaywrightLocator; // Find elements by ARIA role, scoped to this locator. | 待核对 |  |
| API-113 | `PlaywrightLocator.getByTestId` | getByTestId(testId: string): PlaywrightLocator; // Find elements by test id, scoped to this locator. | 待核对 |  |
| API-114 | `PlaywrightLocator.getByText` | getByText(text: TextMatcher, options: { exact?: boolean }): PlaywrightLocator; // Find elements by text content, scoped to this locator. | 待核对 |  |
| API-115 | `PlaywrightLocator.innerText` | innerText(options: { timeoutMs?: number }): Promise<string>; // Return the rendered (visible) text of the first matched element. | 待核对 |  |
| API-116 | `PlaywrightLocator.isEnabled` | isEnabled(): Promise<boolean>; // Whether the first matched element is currently enabled. | 待核对 |  |
| API-117 | `PlaywrightLocator.isVisible` | isVisible(): Promise<boolean>; // Whether the first matched element is currently visible. | 待核对 |  |
| API-118 | `PlaywrightLocator.last` | last(): PlaywrightLocator; // Return a locator pointing at the last matched element. | 待核对 |  |
| API-119 | `PlaywrightLocator.locator` | locator(selector: string, options: LocatorLocatorOptions): PlaywrightLocator; // Create a descendant locator scoped to this locator. | 待核对 |  |
| API-120 | `PlaywrightLocator.nth` | nth(index: number): PlaywrightLocator; // Return a locator pointing at the Nth matched element. | 待核对 |  |
| API-121 | `PlaywrightLocator.or` | or(locator: PlaywrightLocator): PlaywrightLocator; // Return a locator matching elements that satisfy either this locator or `locator`. | 待核对 |  |
| API-122 | `PlaywrightLocator.press` | press(value: string, options: { timeoutMs?: number }): Promise<void>; // Press a keyboard key while this locator is focused. | 待核对 |  |
| API-123 | `PlaywrightLocator.pressSequentially` | pressSequentially(value: string, options: LocatorPressSequentiallyOptions): Promise<void>; // Focus the element and press each character in the text sequentially without clearing its existing value. | 待核对 |  |
| API-124 | `PlaywrightLocator.selectOption` | selectOption(value: SelectOptionInput \| Array<SelectOptionInput>, options: { timeoutMs?: number }): Promise<void>; // Select one or more options on a native `<select>` element. | 待核对 |  |
| API-125 | `PlaywrightLocator.setChecked` | setChecked(checked: boolean, options: LocatorCheckOptions): Promise<void>; // Set a checkbox or switch-like control to a checked/unchecked state. | 待核对 |  |
| API-126 | `PlaywrightLocator.textContent` | textContent(options: { timeoutMs?: number }): Promise<null \| string>; // Return the raw textContent of the first matched element (or null if missing). | 待核对 |  |
| API-127 | `PlaywrightLocator.type` | type(value: string, options: { timeoutMs?: number }): Promise<void>; // Type text into the element without clearing existing content. | 待核对 |  |
| API-128 | `PlaywrightLocator.uncheck` | uncheck(options: LocatorCheckOptions): Promise<void>; // Uncheck a checkbox or switch-like control. | 待核对 |  |
| API-129 | `PlaywrightLocator.waitFor` | waitFor(options: LocatorWaitForOptions): Promise<void>; // Wait for the element to reach a specific state. | 待核对 |  |
| API-130 | `PlaywrightDownload.path` | path(options: { timeoutMs?: number }): Promise<null \| string>; // Return the local path to the downloaded file, if available. | 待核对 |  |
| API-131 | `PlaywrightFileChooser.isMultiple` | isMultiple(): boolean; // Whether the input allows selecting multiple files. | 待核对 |  |
| API-132 | `PlaywrightFileChooser.setFiles` | setFiles(files: FileChooserFiles, options: { timeoutMs?: number }): Promise<void>; // Set the files for this chooser using absolute paths visible to the browser. | 待核对 |  |
| API-133 | `TabClipboardAPI.read` | read(): Promise<Array<TabClipboardItem>>; // Read clipboard items, including text and binary payloads. | 待核对 |  |
| API-134 | `TabClipboardAPI.readText` | readText(): Promise<string>; // Read plain text from the browser clipboard. | 待核对 |  |
| API-135 | `TabClipboardAPI.write` | write(items: Array<TabClipboardItem>): Promise<void>; // Write clipboard items. | 待核对 |  |
| API-136 | `TabClipboardAPI.writeText` | writeText(text: string): Promise<void>; // Write plain text to the browser clipboard. | 待核对 |  |
| API-137 | `TabDevAPI.logs` | logs(options: TabDevLogsOptions): Promise<Array<TabDevLogEntry>>; // Read console log messages captured for this tab. | 待核对 |  |
| API-138 | `AlertDialog.type` | type: "alert"; | 待核对 |  |
| API-139 | `AlertDialog.dismiss` | dismiss(): Promise<void>; | 待核对 |  |
| API-140 | `BeforeUnloadDialog.type` | type: "beforeunload"; | 待核对 |  |
| API-141 | `BeforeUnloadDialog.dismiss` | dismiss(): Promise<void>; | 待核对 |  |
| API-142 | `ConfirmDialog.type` | type: "confirm"; | 待核对 |  |
| API-143 | `ConfirmDialog.accept` | accept(): Promise<void>; | 待核对 |  |
| API-144 | `ConfirmDialog.dismiss` | dismiss(): Promise<void>; | 待核对 |  |
| API-145 | `Documentation.get` | get(name: string): Promise<string>; // Read packaged documentation by its extensionless relative path. | 待核对 |  |
| API-146 | `PromptDialog.type` | type: "prompt"; | 待核对 |  |
| API-147 | `PromptDialog.accept` | accept(text: string): Promise<void>; | 待核对 |  |
| API-148 | `PromptDialog.dismiss` | dismiss(): Promise<void>; | 待核对 |  |

## 2. 官方 capability 文档

| 编号 | 文档 | 状态 | 证据 |
|---|---|---|---|
| CAP-MGMT | `docs/capabilities/browser/management.md` | 待官方对照 | management 代理返回原生值；tab/bookmark/history 测试待补 |
| CAP-VIEWPORT | `docs/capabilities/browser/viewport.md` | 待官方对照 | chrome_viewport 已注册 |
| CAP-VISIBILITY | `docs/capabilities/browser/visibility.md` | 待官方对照 | chrome_visibility 已注册 |
| CAP-BOT | `docs/capabilities/tab/botDetection.md` | 待官方对照 | chrome_bot_detection 已注册 |
| CAP-AUTH | `docs/capabilities/tab/browserAuth.md` | 待依赖 | 原生 OpenAI 账户授权不可用；浏览器内可见控件 + 用户接管等价路径已实现 |
| CAP-CDP | `docs/capabilities/tab/cdp.md` | 待官方对照 | chrome_cdp 已注册 |
| CAP-ASSETS | `docs/capabilities/tab/pageAssets.md` | 待官方对照 | chrome_page_assets 已注册 |
| CAP-SIWC | `docs/capabilities/tab/siwc.md` | 待官方对照 | chrome_siwc 已注册 |
| CAP-WEBMCP | `docs/capabilities/tab/webmcp.md` | 待官方对照 | chrome_webmcp 已注册 |

## 3. DSH 工具入口

| 工具 | 状态 | 证据 |
|---|---|---|
| `chrome_status` | 待核对 |  |
| `chrome_use_browser` | 待核对 |  |
| `chrome_tabs` | 待核对 |  |
| `chrome_active_tab` | 待核对 |  |
| `chrome_open_tabs` | 待核对 |  |
| `chrome_claim_tab` | 待核对 |  |
| `chrome_release_tab` | 待核对 |  |
| `chrome_mark_tab` | 待核对 |  |
| `chrome_navigate` | 待核对 |  |
| `chrome_group` | 待核对 |  |
| `chrome_read_page` | 待核对 |  |
| `chrome_eval` | 待核对 |  |
| `chrome_snapshot` | 待核对 |  |
| `chrome_act` | 待核对 |  |
| `chrome_click` | 待核对 |  |
| `chrome_type` | 待核对 |  |
| `chrome_key` | 待核对 |  |
| `chrome_scroll` | 待核对 |  |
| `chrome_move` | 待核对 |  |
| `chrome_drag` | 待核对 |  |
| `chrome_screenshot` | 待核对 |  |
| `chrome_element_info` | 待核对 |  |
| `chrome_element_screenshot` | 待核对 |  |
| `chrome_upload` | 待核对 |  |
| `chrome_download` | 待核对 |  |
| `chrome_clipboard` | 待核对 |  |
| `chrome_dialog` | 待核对 |  |
| `chrome_management` | 待核对 |  |
| `chrome_logs` | 待核对 |  |
| `chrome_viewport` | 待核对 |  |
| `chrome_visibility` | 待核对 |  |
| `chrome_cdp` | 待核对 |  |
| `chrome_page_assets` | 待核对 |  |
| `chrome_export` | 待核对 |  |
| `chrome_set_value` | 待核对 |  |
| `chrome_select_option` | 待核对 |  |
| `chrome_find` | 待核对 |  |
| `chrome_user_takeover` | 待核对 |  |
| `chrome_history` | 待核对 |  |
| `chrome_bookmarks` | 待核对 |  |
| `chrome_read_urls` | 待核对 |  |
| `chrome_webmcp` | 待核对 |  |
| `chrome_locator` | 待核对 |  |
| `chrome_js` | 待核对 |  |
| `chrome_export_gsuite` | 待核对 |  |
| `chrome_export_youtube_transcript` | 待核对 |  |
| `chrome_browser_info` | 待核对 |  |
| `chrome_notify` | 待核对 |  |
| `chrome_context_menu` | 待核对 |  |
| `chrome_browser_auth` | 待核对 |  |
| `chrome_siwc` | 待核对 |  |
| `chrome_bot_detection` | 待核对 |  |
| `chrome_tab_mentions` | 待核对 |  |
| `chrome_side_panel` | 待核对 |  |
| `chrome_favicon` | 待核对 |  |
| `chrome_audit_trail` | 待核对 |  |
| `chrome_turn_ended` | 待核对 |  |
| `chrome_browser_diagnostics` | 待核对 |  |
| `chrome_network` | 待核对 |  |
| `chrome_close_tab` | 待核对 |  |

## 4. 交互与宿主盘点

| 编号 | 交互 | 状态 | 证据 |
|---|---|---|---|
| INT-SIDEBAR | 扩展侧栏：页面上下文、标签引用、聊天输入、流式回复 | 实现中 | 侧栏已显示页面上下文、选区、标签列表与 tab mention；聊天/流式回复待宿主适配 |
| INT-CONTEXT-MENU | 右键菜单入口 | 待官方对照 | chrome_context_menu 已注册 |
| INT-NOTIFICATIONS | 浏览器通知 | 待官方对照 | chrome_notify 已注册 |
| INT-TAB-MENTIONS | 用户标签页 @ 引用 | 待官方对照 | chrome_tab_mentions + claim 时 URL/title 校验已实现 |
| INT-PERMISSIONS | 扩展权限与网站授权 | 待官方对照 | 扩展 16 项权限；域名审批在 Host 侧 |
| INT-CURSOR | 虚拟指针显示、动画与回合收起 | 待官方对照 | G01：官方弹簧/曲线参数已移植；E2E 路径与落点验证见 docs/parity/EXECUTION_STATUS.md |
| INT-HOST-HOOKS | 宿主 turn/end、Stop、Interrupt、Agent 释放钩子 | 待官方对照 | G11：turn/end 完整清理已实现；E2E 验证 deliverable/handoff |
| INT-INSTALL | 安装引导、浏览器/profile 诊断与重连 | 待官方对照 | chrome_browser_diagnostics / chrome_browser_info 已注册 |

## 5. 生成方式

```bash
npm run parity:ledger
```

状态来源：`docs/parity/status.json`。新增证据时先更新该文件再重新生成。
