# Contributing

Thanks for taking the time to contribute! This document describes the
development workflow, coding conventions, and review process.

## Code of conduct

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting bugs and requesting features

- Search the existing issues first.
- Use the bug report or feature request issue template.
- For security issues, do **not** open a public issue; follow
  [SECURITY.md](SECURITY.md).

## Development setup

Requirements: Node.js 20+ and a Chromium-based browser for end-to-end tests.

```bash
git clone https://github.com/yelinos/dsh-chrome-bridge.git
cd dsh-chrome-bridge

# The plugin is a plain-JS DSH bundle: no build step and no runtime install
# is required for the Host half. `ws` is provided by the DSH installation
# when the bundle runs inside a profile.
```

### Install into a local DSH profile

```bash
dsh plugin --profile web add /absolute/path/to/dsh-chrome-bridge
```

Then load the unpacked extension from `extension/` in `chrome://extensions`
(or `edge://extensions`), and refresh the DSH Web page once so the Sidebar
panel is picked up.

## Tests

```bash
# Syntax and manifest checks
npm run check

# Protocol, tools, service lifecycle, and client registration tests
npm run test:unit

# End-to-end with a real Chrome for Testing build (optional)
npm run test:e2e
```

The unit tests import `@deepseek-ai/*` packages from the DSH installation.
When working outside a DSH profile, point `node_modules` at the DSH install
(for example with a symlink) or run the tests from a checkout that has the
packages available.

## Coding conventions

- Plain ESM JavaScript, two-space indentation, single quotes in new code.
- Keep the Host halves (`index.js`, `service.js`, `bridge.js`) free of DOM
  assumptions; the extension half (`extension/`) must not use Node APIs.
- Register every resource inside `apply` / `[Service.init]` and return its
  disposer; never leak listeners, sockets, or timers.
- Add JSDoc to exported functions and any non-obvious protocol behavior.
- Update `CHANGELOG.md` for user-visible changes.
- Keep the Chrome extension dependency-free (only `chrome.*` APIs).

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add per-session tab groups
fix: reject commands when no extension is connected
docs: document the settings-backed domain allowlist
test: cover real mouse and keyboard input
chore: bump extension version to 0.2.0
```

## Pull requests

- Keep each PR focused on one change.
- Describe the problem, the approach, and how it was verified.
- Include test coverage for behavior changes when feasible.
- Reference related issues (`Closes #123`).
- By opening a PR you agree that your contribution is licensed under the
  repository's MIT license.

## Release process

1. Update `CHANGELOG.md` and bump `version` in `package.json` and
   `extension/manifest.json` (keep them equal).
2. Run `npm run check` and `npm run test:unit`.
3. Commit as `chore(release): vX.Y.Z`, tag `vX.Y.Z`, and push the tag.
4. Attach the packed bundle (`npm pack`) to the GitHub release.
