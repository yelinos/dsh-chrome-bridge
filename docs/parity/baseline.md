# M0 基线留档

- 生成时间：2026-11-05T05:02:43.130Z
- 工作区：/home/yelin/cil_work/dsh-BrowserControl/dsh-chrome-bridge
- Git HEAD：`dd85e38dd64fdd079da445ec9c9c0d529385bfac`
- DSH 插件版本：0.1.1
- 扩展 manifest 版本：0.1.1
- Node：v26.13.0
- 平台：linux x64
- Chrome for Testing：Google Chrome for Testing 157.0.8103.38
- 官方浏览器扩展：1.26.1102.11740（/home/yelin/.config/microsoft-edge/Default/Extensions/hehggadaopoacecdllhhajmbjkdcmajg/1.26.1102.11740_0）
- 官方 chrome 插件：26.1027.51404（/home/yelin/.codex/plugins/cache/openai-bundled/chrome/26.1027.51404）

## Git 状态

```text
M CHANGELOG.md
 M README.en.md
 M README.md
 M THIRD_PARTY_NOTICES.md
 M bridge.js
 M extension/manifest.json
 M extension/sw.js
 M index.js
 M package.json
 M scripts/check.mjs
 M service.js
 M test/e2e.chrome.test.mjs
 M test/helpers.mjs
 M test/protocol.test.mjs
 M test/tools.test.mjs
?? browsers.js
?? docs/CODEX_PARITY_EXECUTION_PLAN.md
?? docs/parity/
?? extension/cursor.js
?? extension/images/
?? extension/sidepanel.html
?? extension/sidepanel.js
?? repl.js
?? scripts/parity-baseline.mjs
?? scripts/parity-ledger.mjs
?? test/browsers.test.mjs

CHANGELOG.md             |  125 +++
 README.en.md             |   47 +-
 README.md                |   45 +-
 THIRD_PARTY_NOTICES.md   |    8 +
 bridge.js                |  104 +-
 extension/manifest.json  |   52 +-
 extension/sw.js          | 2286 +++++++++++++++++++++++++++++++++++++----
 index.js                 | 2525 +++++++++++++++++++++++++++++++++++++++++++---
 package.json             |   14 +-
 scripts/check.mjs        |    4 +
 service.js               |    9 +-
 test/e2e.chrome.test.mjs |  411 +++++++-
 test/helpers.mjs         |    4 +-
 test/protocol.test.mjs   |   32 +
 test/tools.test.mjs      |  383 ++++++-
 15 files changed, 5667 insertions(+), 382 deletions(-)
```

## 官方材料指纹

| 编号 | 文件 | SHA-256 |
|---|---|---|
| O1 api.json | `/home/yelin/.codex/plugins/cache/openai-bundled/chrome/26.1027.51404/docs/api.json` | 5c417409700ce642d08851b962fbb5b5579286e69597d660e8f5aebce929d380 (66608 bytes) |
| O2 accessibility.md | `/home/yelin/.codex/plugins/cache/openai-bundled/chrome/26.1027.51404/docs/accessibility.md` | 25e1aa573ad8e26d5a11754b32f75b20787fb98a39a8f532f6bfedbeda04e1be (5570 bytes) |
| O3 api-use-behavior.md | `/home/yelin/.codex/plugins/cache/openai-bundled/chrome/26.1027.51404/docs/api-use-behavior.md` | 9f602b5e5904ff08d53bc684f29a70c5a81cd14dd5a7af3e6bca00a44fb2b710 (3815 bytes) |
| O4 content-scripts/codex.js | `/home/yelin/.config/microsoft-edge/Default/Extensions/hehggadaopoacecdllhhajmbjkdcmajg/1.26.1102.11740_0/content-scripts/codex.js` | 168b307ff1e936bcfdc9344f4e668b4767cf91b6ac8d7dd868e927c9474c9221 (35191 bytes) |
| O5 scripts/browser-service.mjs | `/home/yelin/.codex/plugins/cache/openai-bundled/chrome/26.1027.51404/scripts/browser-service.mjs` | 7e819058b5435822cfefb37e5ba5a3ed95bea9975e1544b673821e783d1df12a (1610454 bytes) |
| O6 tab-claiming-chrome.md | `/home/yelin/.codex/plugins/cache/openai-bundled/chrome/26.1027.51404/docs/tab-claiming-chrome.md` | 9cd2b24253ff7376e317f39cac4dd8ba276ea2a98385d9d3f7f12349ba5706aa (2170 bytes) |
| O7 tab-cleanup-chrome.md | `/home/yelin/.codex/plugins/cache/openai-bundled/chrome/26.1027.51404/docs/tab-cleanup-chrome.md` | d20b4073125929f2b61960b1513ecd9e0fb261c88a4d8077e34f22520e7a1de8 (1104 bytes) |

## 本轮验证记录

- 单元/协议/服务/客户端：`docs/parity/logs/npm-test-<timestamp>.log`
- 真实 Chrome E2E：`docs/parity/logs/npm-e2e-<timestamp>.log`
- 能力台账：`docs/parity/capability-ledger.md`（`npm run parity:ledger`）
