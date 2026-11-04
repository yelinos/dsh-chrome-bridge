# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
