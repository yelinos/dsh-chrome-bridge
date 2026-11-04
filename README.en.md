# DSH Chrome Bridge

English | [中文](README.md)

[![CI](https://github.com/yelinos/dsh-chrome-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/yelinos/dsh-chrome-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](extension/manifest.json)
[![DSH Plugin](https://img.shields.io/badge/DSH-dsh--plugin-0B5FFF)](https://github.com/topics/dsh-plugin)

Let DeepSeek Harness (DSH) agents operate your **real, signed-in Chromium
browser**. The design follows OpenAI's Codex Chrome extension: a small
extension in your browser acts as a bridge, and the agent opens pages, reads
them, clicks, types, and takes screenshots in a dedicated tab group — asking
for your approval the first time it touches a new domain.

- **Dependency-free extension**: Manifest V3, only `chrome.*` APIs, no
  third-party runtime bundled.
- **Pure plugin mount**: no build step; the Host half is plain ESM.
- **Local-only loop**: the extension only dials `ws://127.0.0.1`; it never
  listens on a port and no web page can reach it.

## Features

| Capability | Details |
|---|---|
| Real browser control | Open/navigate tabs, read visible text, evaluate JS, screenshots |
| Real mouse & keyboard | Selector or coordinate clicks (double click, right/middle button), text input, key presses with modifiers (CDP `Input` domain) |
| Per-domain approval | First visit to a domain asks "allow this session / always allow / decline"; "always" persists through the DSH settings service |
| Per-session tab groups | Each agent session gets its own `DSH · <session>` group, so concurrent sessions never collide |
| Automatic tab recycling | Reuses the session's current tab by default; keeps at most `maxSessionTabs` tabs per session (LRU eviction), closes idle tabs and everything on session end |
| Group colors and names | Each session gets a stable palette color; the group defaults to the first page's title and the agent can rename it to a short purpose with `chrome_group` |
| Compact snapshots (token-saving) | `chrome_snapshot` returns interactive elements from the accessibility tree with `e1` refs — an order of magnitude smaller than full page text |
| Batched actions (round-trip-saving) | `chrome_act` runs several actions (click/type/key/navigate) in one tool call instead of one LLM round trip per step |
| Virtual cursor | Every mouse move/click/scroll shows an in-page pointer and click ripple so you can see exactly where the model acts |
| Scrolling | `chrome_scroll` supports wheel deltas or scrolling an element ref into view |
| Inline screenshots | PNG bytes are admitted through the attachment pipeline and returned as a model-visible image block; falls back to a workspace file |
| Sidebar panel | Right sidebar "+" menu → Chrome Bridge: live status, install guide, domain lists |
| Safety rails | `blockedDomains` always wins; only agent tab groups can be closed |

## Architecture

```
DSH Host process                        Your Chrome / Edge
┌──────────────────────────┐          ┌────────────────────────────┐
│ chrome-bridge (service)  │  WS JSON │ DSH Chrome Bridge (MV3)    │
│  · WebSocket server       │◄─────────┤  · service worker          │
│  · commands/timeout/ping  │ 127.0.0.1 │  · chrome.tabs/tabGroups  │
│  · status() Remote method │ :8765    │  · chrome.debugger (CDP)   │
│ chrome-bridge-tools      │          │  · popup: status/port/token│
│  · chrome_* tools         │          └────────────────────────────┘
│  · domain approval        │
│  · session tab groups     │          DSH Web UI
│  · screenshots → attach   │          ┌────────────────────────────┐
│ client.js                │          │ Right sidebar "Chrome      │
│  · status card / guide    │          │ Bridge" panel              │
└──────────────────────────┘          └────────────────────────────┘
```

## Install

### 1. Install the DSH plugin

Ask the agent to run `plugin_manager` → `install_bundle` with this directory's
absolute path, or from a terminal:

```bash
dsh plugin --profile web add /absolute/path/to/dsh-chrome-bridge
```

This mounts two Host-level rows:

- `chrome-bridge`: the bridge service (WebSocket server)
- `chrome-bridge-tools`: the `chrome_*` tools

**Refresh the DSH Web page once after installing** so the "Chrome Bridge"
sidebar tab is picked up.

### 2. Install the browser extension

1. Open `chrome://extensions` (or `edge://extensions`) and enable Developer mode.
2. Click "Load unpacked" and select this package's `extension/` directory
   (the sidebar panel can copy the path for you).
3. Open the extension popup and confirm it shows **Connected to DSH**
   (default port `8765`, matching the Host).

### 3. Verify

Ask the agent to call `chrome_status`; it should report:

```
DSH Chrome Bridge connected:
- listening: true
- endpoint: ws://127.0.0.1:8765
- extension: DSH Chrome Bridge 0.6.0
- extension directory: /path/to/dsh-chrome-bridge/extension/
```

## Tools

| Tool | Purpose |
|---|---|
| `chrome_status` | Bridge state, extension info, install directory, domain lists |
| `chrome_tabs` | List tabs (agent DSH groups by default; `all: true` for everything) |
| `chrome_navigate` | Navigate: **reuses the session's current tab by default**; `newTab: true` opens another; domain gate |
| `chrome_read_page` | Read URL, title, and visible text (truncated) |
| `chrome_eval` | Evaluate JavaScript and return a JSON value |
| `chrome_click` | Real mouse click by CSS selector or x/y; double click, right button |
| `chrome_type` | Real keyboard input; optional selector focus and clear |
| `chrome_key` | Press Enter/Tab/Escape/arrows/etc. with modifiers |
| `chrome_screenshot` | Return a PNG as an inline attachment (file fallback) |
| `chrome_group` | Name this session's tab group (≤24 chars) and change its color |
| `chrome_snapshot` | Compact accessibility-tree snapshot with element refs |
| `chrome_act` | Run several actions in one tool call |
| `chrome_scroll` | Wheel-scroll or scroll an element into view |
| `chrome_move` | Move the virtual cursor to an element or point without clicking |
| `chrome_close_tab` | Close a tab inside an agent group only |

## Configuration

`chrome-bridge` (service row):

| Field | Default | Meaning |
|---|---|---|
| `host` | `127.0.0.1` | Bind address |
| `port` | `8765` | Port |
| `authToken` | `""` | When non-empty the extension popup must carry the same token |
| `commandTimeoutMs` | `20000` | Per-command deadline |

`chrome-bridge-tools` (tools row):

| Field | Default | Meaning |
|---|---|---|
| `tabGroupTitle` | `DSH` | Prefix of the agent tab group title |
| `askForNewDomains` | `true` | Ask before touching a new domain |
| `allowedDomains` | `[]` | Always-allowed hostnames; volatile, written by "Always allow" and persisted |
| `blockedDomains` | `[]` | Always-denied hostnames |
| `maxSnapshotChars` | `24000` | Page-text truncation length |
| `maxSessionTabs` | `3` | Max agent tabs kept per session; the least recently used is closed first |
| `autoCloseIdleMs` | `180000` | Close agent tabs idle for this long (0 disables idle cleanup) |
| `autoCloseOnSessionEnd` | `true` | Close all of a session's tabs when its agent is disposed |

Override any field by id in the profile's `cordis.patch.yml`, or simply pick
"Always allow" in the conversation and let the settings service persist it.

## Security model

- The extension is outbound-only: it dials `ws://127.0.0.1:<port>`, never
  listens, and no web page can reach it.
- The server binds loopback by default. Any local process can still connect to
  the port, so set `authToken` if local-process isolation matters.
- While attached via `chrome.debugger`, Chromium shows its standard "is
  debugging this browser" banner; this is required to read and drive pages.
- Domain approval gates navigation and page interaction (read/eval/click/type/
  screenshot); `blockedDomains` always wins.
- Only tabs inside agent DSH tab groups can be closed by the agent.
- See [SECURITY.md](SECURITY.md) for private reporting.

## Development and tests

```bash
npm run check      # syntax / JSON / manifest / version parity
npm run test:unit  # protocol, tools, service lifecycle, client registration
npm run test:e2e   # real Chrome for Testing end-to-end (needs .tools/chrome-linux64/chrome)
```

The unit tests resolve `@deepseek-ai/*` packages from a DSH installation; when
running outside DSH, point `node_modules` at the DSH install (for example with
a symlink).

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and the review process.

## Known limitations

- Requires the browser extension and `chrome.debugger`; Chromium-only
  (Chrome/Edge/Chromium).
- Tab groups are per session; all tabs of one session share a single group.
- Without an attachment service (minimal compositions), screenshots fall back
  to workspace files plus `read_image`.
- Experimental; the private protocol is v1 and may change between releases.

## License

[MIT](LICENSE) © 2026 yelinos

Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
