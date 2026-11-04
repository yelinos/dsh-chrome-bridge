# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.2.x   | Yes       |
| < 0.2   | No        |

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Report privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository (Security → Report a vulnerability), or contact the
maintainer listed in `package.json`.

Include:

- affected version(s) and platform,
- a description of the issue and its impact,
- reproduction steps or a proof of concept,
- any suggested mitigation.

You can expect an acknowledgement within 7 days and a status update within
30 days. Please give us a reasonable window to ship a fix before public
disclosure.

## Security model

`dsh-chrome-bridge` is a **local** bridge between a DSH Host process and a
Chromium-based browser:

- The extension only makes outbound WebSocket connections to
  `ws://127.0.0.1:<port>`; it never listens on a port and no web page can
  reach it.
- The Host server binds `127.0.0.1` by default. Any local process can connect
  to that port, so deployments that care about local-process isolation should
  set `authToken` in the `chrome-bridge` service config and match it in the
  extension popup.
- The extension attaches to pages with `chrome.debugger` (CDP). Chromium shows
  the usual "is debugging this browser" banner while attached.
- Domain approval gates navigation and page interaction; `blockedDomains`
  always wins. "Always allow" writes to the plugin's `allowedDomains`.
- `chrome_close_tab` only closes tabs inside the agent's DSH tab groups.

Known limitations are documented in the README; they are not vulnerabilities
by themselves. Report anything else privately.
