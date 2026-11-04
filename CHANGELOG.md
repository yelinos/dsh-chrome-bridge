# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
