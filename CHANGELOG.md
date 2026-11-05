# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Extension icons (16/32/48/128 px) derived from `icon.svg`, declared in the
  manifest and used by the toolbar button and notifications, so the package
  passes the Microsoft Edge Add-ons / Chrome Web Store icon checks.
- `npm run pack:extension`: builds `dist/dsh-chrome-bridge-extension-<version>.zip`
  with the files relative to the archive root, ready for store upload.
- `docs/privacy.html`: store privacy policy covering data flow, permissions,
  local storage and user controls.

## [0.1.1] - 2026-11-05

### Added

- M0 parity evidence: generated official capability ledger (`npm run parity:ledger`)
  and baseline archive (`npm run parity:baseline`) under `docs/parity/`.
- AX semantic actions: `tab.ax.pressKey` with xdotool chords/held keys,
  `tab.ax.paste`, `tab.ax.selectText` (prefix/suffix/selectionType) and
  `tab.ax.performSecondaryAction`.
- Playwright locator semantics: `and`/`or`, ancestor `scope`, `has`/`hasNot`,
  strict nth (no clamping), `waitFor` attached/detached/visible/hidden,
  element-bound `evaluate`/`evaluateAll`, multi-select option descriptors and
  native return types for count/isVisible/isEnabled/getAttribute/textContent.
- `page.expectNavigation` listener-before-action semantics and a request-aware
  `networkidle` state.
- Browser-bound `chrome_js` handles: browser/profile and tab handles carry
  their browser id, and old saved handles use the current turn's exec context.
- Full turn cleanup: unmarked agent tabs close at turn end, claimed user tabs
  are released, deliverable tabs stay open and handoff marks survive one turn.
- Side panel page context: current title/URL, selected text, open tabs and a
  copyable tab mention.

### Changed

- AX state (`chrome_snapshot`) now returns hierarchy, visibility, stable refs
  and rich diffs; `tab.ax.get()` returns the state string while
  `tab.ax.write()` emits model-visible text and screenshots in order.
- Virtual cursor rewritten around the official spring parameters, short
  "scoot" and bounds-aware Bezier arc paths, 44° asset orientation and the
  1.41s thinking wobble.
- `chrome_type` focuses refs/selectors instead of clicking them; `chrome_key`
  accepts chords, refs and hold duration; clipboard paste inserts reliably.
- Claiming a user tab can validate the snapshot URL/title to fail closed on a
  reused tab id.

### Fixed

- `chrome_js` now persists destructuring/multiple declarations, function and
  class declarations, multiline trailing expressions and duplicate
  declarations; sync VM and pending async work share one deadline.
- Cross-frame locator augmentation no longer adds unscoped iframe matches to a
  scoped locator result.
- `chrome_act` preserves ordered observation blocks, including images.

## [0.0.6] - 2026-11-05

### Fixed

- AX scrolling preserves element targets, direction and page distance.
  Page distance follows the target box size, with a 100px minimum, while
  coordinate targets use the viewport size. DOM scrolling preserves node ids.
- Chrome pixel scrolling uses native CDP mouse gestures with speed 8000 and
  fling disabled. AX page scrolling uses a wheel event.
- Cursor rendering lives in an isolated content script with a closed shadow
  root. Reading activates it, navigation restores it on the controlled origin,
  and the turn-end event hides it. Concurrent turns release their own cursor
  ownership independently.
- Removed the 12-second idle hide and corrected the cursor's resting rotation.
- Browser tool guidance follows inspect, act and inspect for interactive work.

### Changed

- The extension requests HTTP/HTTPS host access for its isolated cursor
  content script and injection into tabs opened before extension installation.
- Verified tool mappings, nested vertical/horizontal scrolling, cursor lifetime,
  CSP rendering, navigation and concurrent-turn cleanup in real Chrome.

## [0.0.5] - 2026-11-04

### Added

- User tab claiming and lifecycle: `chrome_open_tabs`, `chrome_claim_tab`,
  `chrome_release_tab`, `chrome_mark_tab`; deliverable/handoff tabs survive
  LRU, idle, and session-end cleanup.
- File and form operations: `chrome_upload` (file inputs/file chooser),
  `chrome_download` (direct download/list), `chrome_clipboard`,
  `chrome_dialog`, `chrome_find`, `chrome_set_value`, `chrome_select_option`.
- Browser management and observability: `chrome_management`,
  `chrome_history`, `chrome_bookmarks`, `chrome_logs`, `chrome_page_assets`,
  `chrome_export`, `chrome_viewport`, `chrome_visibility`, `chrome_cdp`, and
  `chrome_user_takeover`.
- Multi-browser connections: each extension reports its browser/profile id;
  `chrome_status` lists all connected browsers and `chrome_use_browser`
  switches the active one.
- WebMCP: `chrome_webmcp` lists and invokes page-defined tools through
  `document.modelContext`.
- Persistent `chrome_js` browser session with a Codex-shaped API:
  `agent.browsers`, `browser.tabs`, `tab.playwright`, `tab.ax`, `tab.cua`,
  `tab.dom_cua`, `tab.clipboard`, `tab.dev`, `tab.content`, `tab.capabilities`.
  Top-level `await` and persistent `const`/`let` handles are supported.
- Navigation and waits: `page.back/forward/reload/waitForLoad/waitForURL`,
  `tabs.new`, `downloads.wait`, `filechooser.wait/setFiles`.
- Playwright-style `chrome_locator` (count/click/fill/type/press/select/
  check/getAttribute/waitFor), same-origin iframe traversal plus CDP
  isolated-world lookup for cross-origin iframes, `getByAltText` /
  `getByTitle`, strict mode, and selector auto-wait via `timeoutMs`.
- `chrome_click` accepts modifier keys; `page.assets` reports fonts.
- Locator filters `hasText` / `hasNotText` / `has` / `hasNot`;
  `page.waitForLoadState` now supports `load`, `domcontentloaded`, and
  `networkidle`; `frameLocator` chains work for same-origin nested iframes.
- Content: `chrome_export_gsuite`, `chrome_export_youtube_transcript`,
  `chrome_page_assets bundle`, `page.fetch`.
- Auth and safety: `chrome_browser_auth` secure handoff, `chrome_siwc`,
  `chrome_bot_detection`.
- Browser UI/state: `chrome_browser_info`, `chrome_notify`,
  `chrome_context_menu`, `chrome_side_panel`, `chrome_favicon`,
  `chrome_tab_mentions`, `chrome_turn_ended`, `chrome_audit_trail`.
- Extension side panel, keyboard shortcut, context menu, notifications and
  favicon badge support; manifest permissions expanded to 16.

### Changed

- `chrome_act` now returns observation results inline (`maxResultChars`) so a
  batched call can read page state, not only execute actions.

- Virtual cursor now uses the official ChatGPT/Codex `cursor-chat.png` asset
  with the same 23×24px size, 44° rotation, 12px/-2.5px anchor and blue glow,
  starting at the target instead of swooping in from the viewport center.
- Cursor motion is slower and more human-like: ~0.55s critically-damped
  spring with a 1.6s arrival ceiling (was a 700ms cap).
- `chrome_scroll` now performs smooth native-style wheel scrolling over
  ~0.3–0.9s in small eased steps instead of one `Input.synthesizeScrollGesture`
  jump, and supports a `pages` argument (1 = one viewport height) for natural
  page turning.

## [0.0.4] - 2026-11-04

### Added

- Closed shadow DOM support: a page-side `attachShadow` patch tracks closed
  shadow roots, so `chrome_snapshot` can see (and `chrome_click` can click)
  interactive elements inside them.
- Cursor "thinking" animation: the halo now pulses while the virtual pointer
  is idle, matching the living-cursor feel of the Codex extension.

### Verified

- E2E creates a closed shadow root with a button, finds it in a snapshot, and
  clicks it successfully.

## [0.0.3] - 2026-11-04

### Changed

- Mouse layer rewritten to match the Codex browser extension's behavior:
  - The virtual cursor uses a spring simulation (requestAnimationFrame) and
    clicks are dispatched only after the pointer visually arrives.
  - Scrolling uses `Input.synthesizeScrollGesture` (mouse gesture, no fling,
    speed 8000) instead of a single wheel event.
  - Element click points come from `DOM.getContentQuads` after
    `DOM.scrollIntoViewIfNeeded`, matching how Codex resolves targets.
  - Added `chrome_drag` for real drag-and-drop with an animated pointer path.

## [0.0.2] - 2026-11-04

### Changed

- The virtual cursor stays visible for 12 seconds (was 2.5) and the click
  ripple lasts 0.7 seconds, so users can actually see the model's pointer
  between steps.

## [0.0.1] - 2026-11-04

### Changed

- Public versioning restarts at 0.0.1. This release contains everything from
  the earlier internal 0.1.0-0.6.0 iterations: per-domain approval, session
  tab groups with colors and purpose names, tab reuse and auto-cleanup, real
  mouse/keyboard input, virtual cursor, scrolling, compact AXTree snapshots,
  batched actions, inline screenshots, and the sidebar panel.

## [0.6.0] - 2026-11-04

### Added

- A visible virtual cursor: every mouse move, click, and scroll draws an
  in-page pointer with a click ripple, so the user can see exactly where the
  model is acting.
- `chrome_scroll`: wheel scrolling (`deltaX`/`deltaY`) or scrolling an element
  ref into view.
- `chrome_move`: move the virtual cursor to an element or point without
  clicking (useful for hover menus).

## [0.5.0] - 2026-11-04

### Added

- `chrome_snapshot`: a compact accessibility-tree (AXTree) snapshot of a page
  with stable element refs (`e1`, `e2`, ...), typically an order of magnitude
  fewer tokens than full page text. `chrome_click` and `chrome_type` accept
  these refs directly.
- `chrome_act`: run up to 20 ordered browser actions (navigate / click / type /
  key / snapshot / read / eval) in one tool call, removing a model round trip
  per step and stopping at the first failure.

### Changed

- Tool descriptions now steer the model toward ref-based interaction and
  batched execution for faster browser work.

## [0.4.2] - 2026-11-04

### Changed

- `chrome_tabs` and `chrome_navigate` render each tab group's color (and the
  `agent` marker) so the model can reason about groups.

## [0.4.1] - 2026-11-04

### Fixed

- Sessions now join their own tab group by group id instead of matching the
  group title, so two sessions opening pages with the same title never merge
  into one group.

## [0.4.0] - 2026-11-04

### Added

- Per-session tab-group colors: each session's group gets a stable color from
  Chrome's tab-group palette, so concurrent agent groups are easy to tell
  apart.
- Purpose names for tab groups: a new group defaults to the first page's title
  (at most 24 characters), and the new `chrome_group` tool lets the agent set
  a short purpose label and/or change the color.
- `chrome_tabs` reports `groupColor` and marks session-owned tabs.

### Changed

- Agent-tab membership is now tracked by tab id instead of the `DSH ·` title
  prefix, so renamed groups keep working with listing, reuse, and close
  guards.

## [0.3.0] - 2026-11-04

### Changed

- `chrome_navigate` now **reuses the session's current agent tab by default**
  instead of opening a new tab on every call. Pass `newTab: true` only when a
  page must stay open (for example to compare two pages).

### Added

- Automatic tab recycling: at most `maxSessionTabs` agent tabs per session
  (default 3); the least recently used tab is closed when the limit is
  exceeded.
- Idle cleanup: agent tabs untouched for `autoCloseIdleMs` (default 3 minutes)
  are closed automatically; the session's current tab is kept while the
  session is live.
- Session-end cleanup: when an agent is disposed, every tab its session opened
  through the plugin is closed.
- `chrome_tabs` marks tabs owned by the current session (`session: true`).

## [0.2.1] - 2026-11-04

### Fixed

- `chrome_type` no longer returns a non-JSON `undefined` selector when called
  without one.
- Modifier combinations in `chrome_key` (for example `Ctrl+A`) are sent as raw
  key events, so they act as shortcuts instead of inserting text.

## [0.2.0] - 2026-11-04

### Added

- Real mouse and keyboard control: `chrome_click` (selector or viewport
  coordinates, double click, right/middle button), `chrome_type` (focus a
  selector first, optional clear), and `chrome_key` (named keys and
  modifier combinations) over the Chrome DevTools Protocol `Input` domain.
- Per-session Chrome tab groups: agent tabs open in `DSH · <session label>`,
  so concurrent sessions never share a group.
- Inline screenshots: `chrome_screenshot` admits PNG bytes through the DSH
  attachment pipeline and returns a model-visible image block, with a
  workspace-file fallback when no attachment service is mounted.
- Durable "Always allow" domain approval: answers persist to the plugin's
  `allowedDomains` (volatile config) through the DSH settings service.
- Right-Sidebar "Chrome Bridge" panel: live bridge status, extension install
  directory with copy button, guided setup steps, and the effective domain
  lists.
- Remote `chromeBridge.status()` over the Typert gateway for the panel.

### Changed

- `chrome_status` now reports the bundled extension directory and the live
  allowed/blocked domain lists.
- `chrome_tabs` aggregates every agent tab group by default and labels each
  tab with its group title.
- `chrome_close_tab` refuses tabs outside the agent's DSH tab groups.

### Fixed

- Commands issued without a connected extension now reject asynchronously
  instead of throwing synchronously.
- Bridge disposal terminates live sockets so the Host can rebind promptly.
- Service binding retries briefly on `EADDRINUSE` after live profile reloads.

## [0.1.0] - 2026-11-04

### Added

- Initial release: MV3 Chrome extension bridge over a local WebSocket,
  `chrome_status` / `chrome_tabs` / `chrome_navigate` / `chrome_read_page` /
  `chrome_eval` / `chrome_screenshot` / `chrome_close_tab` tools, and
  Codex-style per-domain approval through DSH user questions.
