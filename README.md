# DSH Chrome Bridge

[English](README.en.md) | 中文

[![CI](https://github.com/yelinos/dsh-chrome-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/yelinos/dsh-chrome-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](extension/manifest.json)
[![DSH Plugin](https://img.shields.io/badge/DSH-dsh--plugin-0B5FFF)](https://github.com/topics/dsh-plugin)

让 DeepSeek Harness（DSH）的 Agent 操作你**真实、已登录的 Chromium 浏览器**。
思路对齐 OpenAI Codex 的 Chrome 扩展：浏览器里装一个小扩展作为桥，Agent 通过它在
专用标签组里开页、读页、点击、输入、截图；第一次接触某个域名时先征求你的批准。

- **零依赖扩展**：Manifest V3，只用 `chrome.*` API，不打包第三方运行时。
- **纯插件挂载**：无构建步骤，Host 半身是普通 ESM。
- **本机闭环**：扩展只主动连 `ws://127.0.0.1`，不监听端口、不暴露给网页。

## 功能特性

| 能力 | 说明 |
|---|---|
| 真实浏览器操作 | 打开/导航标签页、读页面文本、执行 JS、截图 |
| 真实鼠标键盘 | 选择器或坐标点击（支持双击/右键）、文本输入、按键与组合键（CDP `Input` 域） |
| 按域名授权 | 首次接触域名弹出「本次会话允许 / 始终允许 / 拒绝」；始终允许经 settings 服务持久化 |
| 会话级标签组 | 每个 Agent 会话独立 `DSH · <会话标识>` 标签组，多会话并行互不干扰 |
| 标签页自动回收 | 默认**复用当前会话标签页**；每会话最多保留 `maxSessionTabs` 个，超出按 LRU 自动关闭；空闲超时与会话结束时自动清理 |
| 标签组配色与命名 | 每个会话按哈希分配固定颜色；组名默认取首个页面标题，Agent 可用 `chrome_group` 改为简短目的名 |
| 截图直回对话 | PNG 经附件管线作为图像内容块直接给模型；无附件服务时回退为工作区文件 |
| 侧栏面板 | 右侧栏「+」菜单 → Chrome 桥接：连接状态、安装引导、域名名单 |
| 安全边界 | `blockedDomains` 永远拒绝；只能关闭 Agent 标签组内的页 |

## 架构

```
DSH Host 进程                         你的 Chrome / Edge
┌──────────────────────────┐          ┌────────────────────────────┐
│ chrome-bridge (service)  │  WS JSON │ DSH Chrome Bridge (MV3)    │
│  · WebSocket 服务器       │◄─────────┤  · service worker          │
│  · 命令/超时/keepalive    │ 127.0.0.1 │  · chrome.tabs/tabGroups  │
│  · status() Remote 接口   │ :8765    │  · chrome.debugger (CDP)   │
│ chrome-bridge-tools      │          │  · popup：状态/端口/token  │
│  · chrome_* 工具          │          └────────────────────────────┘
│  · 按域名授权 / 会话标签组 │
│  · 截图 → 附件管线        │          DSH Web UI
│ client.js                │          ┌────────────────────────────┐
│  · 侧栏状态卡/安装引导     │          │ 右侧栏「Chrome 桥接」面板   │
└──────────────────────────┘          └────────────────────────────┘
```

## 安装

### 1. 安装 DSH 插件

在 DSH 会话里让 Agent 执行 `plugin_manager` 的 `install_bundle`，目标为本目录的绝对路径；
或在终端：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-chrome-bridge
```

这会挂载两个 Host 级行：

- `chrome-bridge`：桥接服务（WebSocket 服务器）
- `chrome-bridge-tools`：`chrome_*` 工具

**装好后刷新一次 Web 页面**，右侧栏「+」菜单里才会出现「Chrome 桥接」标签页。

### 2. 安装 Chrome / Edge 扩展

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启「开发者模式」。
2. 点「加载已解压的扩展程序」，选择本包的 `extension/` 目录
   （侧栏面板里可一键复制该路径）。
3. 点扩展图标，确认显示 **Connected to DSH**（端口默认 `8765`，需与服务端一致）。

### 3. 验证

让 Agent 调用 `chrome_status`，应看到：

```
DSH Chrome Bridge connected:
- listening: true
- endpoint: ws://127.0.0.1:8765
- extension: DSH Chrome Bridge 0.4.0
- extension directory: /path/to/dsh-chrome-bridge/extension/
```

## 工具

| 工具 | 说明 |
|---|---|
| `chrome_status` | 桥接状态、扩展信息、扩展目录、域名名单 |
| `chrome_tabs` | 列出标签页（默认仅 Agent 的 DSH 标签组，`all: true` 列全部） |
| `chrome_navigate` | 导航页面：**默认复用本会话当前标签页**，`newTab: true` 才新开；域名门禁 |
| `chrome_read_page` | 读页面 URL/标题/可见文本（截断） |
| `chrome_eval` | 在页面里执行 JS 并返回 JSON 值 |
| `chrome_click` | 真实鼠标点击：CSS 选择器或 x/y 坐标、双击、右键 |
| `chrome_type` | 真实键盘输入：可先按选择器聚焦，支持清空 |
| `chrome_key` | 按键：Enter/Tab/Escape/方向键等，支持 control/alt/shift/meta |
| `chrome_screenshot` | 截图作为附件图像直接返回（不可用时落盘） |
| `chrome_group` | 给本会话标签组起简短目的名（≤24 字符）并改颜色 |
| `chrome_close_tab` | 关闭 Agent 标签组内的标签页（不碰用户自己的页） |

## 配置

`chrome-bridge`（服务行）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 绑定地址 |
| `port` | `8765` | 端口 |
| `authToken` | `""` | 非空时扩展 popup 里需填相同 token |
| `commandTimeoutMs` | `20000` | 单条命令超时 |

`chrome-bridge-tools`（工具行）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `tabGroupTitle` | `DSH` | Agent 标签组标题前缀 |
| `askForNewDomains` | `true` | 遇到新域名先问用户 |
| `allowedDomains` | `[]` | 始终允许的域名；volatile，可被「始终允许」写入并持久化 |
| `blockedDomains` | `[]` | 拒绝的域名 |
| `maxSnapshotChars` | `24000` | 页面文本截断长度 |
| `maxSessionTabs` | `3` | 每会话最多保留的 Agent 标签页；超出时关闭最久未用的 |
| `autoCloseIdleMs` | `180000` | 标签页空闲多久后自动关闭（0 关闭空闲清理） |
| `autoCloseOnSessionEnd` | `true` | Agent 会话结束时关闭其打开的所有标签页 |

修改方式：编辑 profile 的 `cordis.patch.yml`，按 id 覆盖对应行的 `config`；
或直接在对话里选择「始终允许」，由 settings 服务写入 `allowedDomains`。

## 安全模型

- 扩展只出不进：仅主动连 `ws://127.0.0.1:<port>`，不监听端口，网页无法访问它。
- 服务默认仅绑定回环地址；同机任意进程仍可连该端口，介意者请设置 `authToken`。
- `chrome.debugger` 附加时浏览器会显示「正在调试此浏览器」提示条，这是读写页面所必需的。
- 域名门禁在导航与页面交互（读/执行/点击/输入/截图）前执行；`blockedDomains` 永远拒绝。
- Agent 只能关闭 Agent 标签组内的标签页。
- 完整报告方式见 [SECURITY.md](SECURITY.md)。

## 开发与测试

```bash
npm run check      # 语法 / JSON / manifest / 版本一致性
npm run test:unit  # 协议层、工具层、Service 生命周期、Client 注册
npm run test:e2e   # 真实 Chrome for Testing 端到端（需 .tools/chrome-linux64/chrome）
```

单元测试会从 DSH 安装目录解析 `@deepseek-ai/*` 包；不在 DSH 环境时请先让
`node_modules` 指向 DSH 安装（例如符号链接）。

开发约定与提交流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 已知限制

- 依赖浏览器扩展与 `chrome.debugger`，仅支持 Chromium 系（Chrome/Edge/Chromium）。
- 标签组按会话拆分；同一会话内所有标签共用一个组。
- 若附件服务不可用（精简组合），截图回退为工作区文件 + `read_image`。
- 实验性插件；协议为包内私有 v1，可能随版本调整。

## 许可证

[MIT](LICENSE) © 2026 yelinos

第三方依赖声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
