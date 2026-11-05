# DSH Chrome Bridge 对齐 Codex 官方浏览器插件执行计划

制定日期为 2026-11-05。当前实现版本为 0.0.6。本文供下一轮开发和验收直接执行。

目标是让 DSH 插件在官方浏览器扩展支持的任务中，达到一致的接口语义、页面操作、指针表现、标签生命周期和任务完成体验。每项完成状态都必须附有官方对照结果及 DSH 验证记录。

本次交付为执行计划。以下待办均需在后续开发中实施。

## 1. 对齐范围和完成条件

对照对象包含官方浏览器扩展、配套 Browser Use 运行时、模型使用说明和桌面端与扩展之间的交互。覆盖导航、AX 状态、DOM 定位、鼠标键盘、滚动、截图、文件、对话框、剪贴板、标签管理、侧栏、用户接管及已宣告的 capability。

先在当前 Linux 环境的 Chrome 和 Edge 建立可复现基线，再补齐官方扩展支持的其他浏览器及操作系统组合。每个组合单独记录验证状态。

DSH 宿主需要实现的适配包括模型工具注册、上下文与图片回传、会话标识、用户输入、权限配置及侧栏聊天。涉及 OpenAI 账户、专有认证服务或其他官方后端的能力，逐项记录依赖和可接入方式，保持“待依赖”状态直至验证完成。内置 Browser、MCP Apps、Dot 等独立后端单列能力范围，并标明与本地浏览器扩展的关系。

允许工具入口适配 DSH 的命名和宿主协议。所有已提供的对应能力必须满足官方可观察行为，包括输入、返回值、异常、状态变化、视觉反馈和结束清理。

宣布整体完成须同时满足下列条件。

- 官方能力清单逐项有对应实现、验证记录和结果。
- 本文确认的语义差距全部关闭。
- 官方与 DSH 在相同测试页面、初始状态和操作序列下通过对照验收。
- 真实 DSH 模型通过自主操作验收，包括必须滚动才能继续的任务。
- 更新、重连、取消、人工接管和多个会话交错执行均通过验收。
- 发布记录明确列出已验证的浏览器、系统、模型和版本。任何待验证项或待依赖项都会使整体完成状态保持开放。

## 2. 固定对照版本

| 对象 | 当前基线 | 用途 |
|---|---|---|
| DSH 插件工作区 | 0.0.6，含未提交修改 | 后续开发起点 |
| Git HEAD | dd85e38dd64fdd079da445ec9c9c0d529385bfac | 追溯已提交历史，工作区内容另行留档 |
| 本机官方浏览器扩展 | 1.26.1102.11740 | 指针实现、消息协议、扩展侧状态和交互 |
| 官方 chrome 插件 | 26.1027.51404 | Browser Use API、运行时和使用说明 |
| 官方 unified-computer-use 插件 | 26.1027.51404 | Stop、Interrupt、SubagentStop 等宿主生命周期 |

官方模型入口可能同时存在封装后的 cua API 和打包文档中的 agent.browsers API。执行时记录实际暴露的入口及映射，按相同版本核对语义。

以下材料组成当前基线。升级官方版本时重新生成能力差异，并重测受影响场景。

| 编号 | 对照材料 |
|---|---|
| O1 | [官方 API 定义](/home/yelin/.codex/plugins/cache/openai-bundled/chrome/26.1027.51404/docs/api.json) |
| O2 | [官方 AX 工作流](/home/yelin/.codex/plugins/cache/openai-bundled/chrome/26.1027.51404/docs/accessibility.md) |
| O3 | [官方 API 使用说明](/home/yelin/.codex/plugins/cache/openai-bundled/chrome/26.1027.51404/docs/api-use-behavior.md) |
| O4 | [官方指针内容脚本](/home/yelin/.config/microsoft-edge/Default/Extensions/hehggadaopoacecdllhhajmbjkdcmajg/1.26.1102.11740_0/content-scripts/codex.js) |
| O5 | [官方浏览器运行时](/home/yelin/.codex/plugins/cache/openai-bundled/chrome/26.1027.51404/scripts/browser-service.mjs) |
| O6 | [用户标签接管规则](/home/yelin/.codex/plugins/cache/openai-bundled/chrome/26.1027.51404/docs/tab-claiming-chrome.md) |
| O7 | [标签结束清理规则](/home/yelin/.codex/plugins/cache/openai-bundled/chrome/26.1027.51404/docs/tab-cleanup-chrome.md) |
| O8 | [官方 capability 文档目录](/home/yelin/.codex/plugins/cache/openai-bundled/chrome/26.1027.51404/docs/capabilities) |
| O9 | [官方宿主结束钩子](/home/yelin/.codex/plugins/cache/openai-bundled/unified-computer-use/26.1027.51404/.codex-plugin/plugin.json) |

当前官方文件的 SHA-256 如下。

~~~text
O1  5c417409700ce642d08851b962fbb5b5579286e69597d660e8f5aebce929d380
O4  168b307ff1e936bcfdc9344f4e668b4767cf91b6ac8d7dd868e927c9474c9221
O5  7e819058b5435822cfefb37e5ba5a3ed95bea9975e1544b673821e783d1df12a
~~~

之前的分析文档包含截至 0.0.5 的完成声明。后续开发以本文的验证状态为准，历史内容用于追溯。[历史分析](/home/yelin/cil_work/dsh-BrowserControl/codex-extension-parity-analysis.md)

## 3. 当前基础和已确认差距

0.0.6 已修复按元素翻页时丢失距离、DOM 滚动丢失目标、指针读页显示及回合结束收起等问题。现有日志记录了 59 项单元、协议、服务及客户端检查，以及 64 项真实 Chrome 检查通过。该记录覆盖 DSH 工具到浏览器的调用链，官方逐项对照和真实模型任务仍待执行。日志目前位于临时目录，阶段 M0 需保存可追溯副本。[测试记录](/tmp/dsh-parity-tests.log) [浏览器检查记录](/tmp/dsh-parity-e2e.log)

下面的“已确认”表示已从当前源码确认差距。最终实现语义以官方基线为准。

| 编号 | 当前证据 | 下一步结果 | 实现位置 |
|---|---|---|---|
| G01 | 指针使用固定 420ms CSS 过渡，官方包含弹簧运动和曲线路径 | 对齐运动轨迹、速度、朝向、缩放、到达时机及思考动画 | [cursor.js](/home/yelin/cil_work/dsh-BrowserControl/dsh-chrome-bridge/extension/cursor.js) |
| G02 | AX get/write 调用同一快照函数，chrome_js 主要输出最终 JSON | write 自动向模型输出状态和图片，get 返回可编程状态；批量调用保留各次应输出的观察 | [repl.js](/home/yelin/cil_work/dsh-BrowserControl/dsh-chrome-bridge/repl.js) |
| G03 | AX pressKey 忽略元素编号，paste 只写剪贴板，selectText 使用当前焦点，secondaryAction 固定点击 | 实现目标聚焦、实际粘贴、指定文字选择和具名次级动作 | [repl.js](/home/yelin/cil_work/dsh-BrowserControl/dsh-chrome-bridge/repl.js) |
| G04 | AX 快照为筛选后的扁平列表，每次重建编号，diff 以 role/name 匹配且 changed 主要比较 value | 对齐层级、可见状态、编号有效期和增量输出，正确区分同名控件 | [sw.js](/home/yelin/cil_work/dsh-BrowserControl/dsh-chrome-bridge/extension/sw.js) |
| G05 | locator 的 and/or 使用相同合并逻辑，链式 selector 会覆盖原条件 | 实现交集、并集、父子作用域及官方匹配语义 | [repl.js](/home/yelin/cil_work/dsh-BrowserControl/dsh-chrome-bridge/repl.js) |
| G06 | locator count/isVisible 等返回工具对象，selectOption 取数组首项，evaluate 缺少 locator 与 tab 绑定 | 对齐返回类型、多选、元素回调和固定 tab 上下文 | [repl.js](/home/yelin/cil_work/dsh-BrowserControl/dsh-chrome-bridge/repl.js) |
| G07 | chrome_locator 的查询条件遗漏 has/hasNot，nth 越界被夹到现有元素，waitFor 未实现各状态 | 完整传递条件，正确处理越界、hidden/detached 等等待和动作超时 | [index.js](/home/yelin/cil_work/dsh-BrowserControl/dsh-chrome-bridge/index.js) |
| G08 | networkidle 使用 readyState complete 加固定等待；expectNavigation 先执行动作 | 事件监听覆盖快速导航和请求生命周期，正确返回超时及取消 | [sw.js](/home/yelin/cil_work/dsh-BrowserControl/dsh-chrome-bridge/extension/sw.js) [repl.js](/home/yelin/cil_work/dsh-BrowserControl/dsh-chrome-bridge/repl.js) |
| G09 | browser/tab 对象依赖可变的全局 activeBrowserId | 句柄固定绑定 browser/profile，交错调用和结束清理均路由到原浏览器 | [repl.js](/home/yelin/cil_work/dsh-BrowserControl/dsh-chrome-bridge/repl.js) [bridge.js](/home/yelin/cil_work/dsh-BrowserControl/dsh-chrome-bridge/bridge.js) |
| G10 | REPL 按行正则重写声明和最后表达式；VM 超时覆盖同步执行；已保存句柄会捕获旧 exec | 对齐持久变量、异步取消、输出顺序、句柄生命周期和当前回合信号 | [repl.js](/home/yelin/cil_work/dsh-BrowserControl/dsh-chrome-bridge/repl.js) |
| G11 | 自动 turn/end 钩子主要清理指针；显式 turn_ended 没有完整实施官方临时标签清理 | 自动完成整个回合清理，正确处理用户页、交付页及跨回合 handoff | [index.js](/home/yelin/cil_work/dsh-BrowserControl/dsh-chrome-bridge/index.js) |
| G12 | 文档 API 返回简短占位文本，domSnapshot 返回 outerHTML | 提供实际可用的 API 文档和对应状态表示，引导模型按观察、操作、复查完成任务 | [repl.js](/home/yelin/cil_work/dsh-BrowserControl/dsh-chrome-bridge/repl.js) |
| G13 | 扩展侧栏当前主要显示桥接状态 | 完成页面上下文、标签引用、聊天输入、流式回复和桌面会话衔接 | [sidepanel.js](/home/yelin/cil_work/dsh-BrowserControl/dsh-chrome-bridge/extension/sidepanel.js) |
| G14 | capability list 固定返回名称，未知能力仍返回文档对象；认证能力存在用户接管适配 | 按实际可用性和官方契约报告能力、状态与错误，逐项补齐依赖 | [repl.js](/home/yelin/cil_work/dsh-BrowserControl/dsh-chrome-bridge/repl.js) [index.js](/home/yelin/cil_work/dsh-BrowserControl/dsh-chrome-bridge/index.js) |
| G15 | 已有跨源 iframe、closed shadow、下载等局部测试 | 完成正常入口下的 frame、嵌套滚动、遮挡、导航后失效和文件事件对照 | [e2e.chrome.test.mjs](/home/yelin/cil_work/dsh-BrowserControl/dsh-chrome-bridge/test/e2e.chrome.test.mjs) |
| G16 | 实际 DSH 模型主动翻页和恢复任务尚待复测 | 以自然语言任务驱动模型，记录工具选择、状态检查和最终结果 | 后续模型验收记录 |

## 4. 执行顺序

每个阶段交付实现、针对差距的回归验证和更新后的能力状态。一个阶段验收通过后进入下一阶段。完整能力盘点从 M0 开始，发现的新差距补入对应阶段。

| 阶段 | 目标 | 主要差距 | 阶段出口 |
|---|---|---|---|
| M0 | 固定版本和建立官方对照 | 全部 | 能力台账、基线证据、可复用测试页面 |
| M1 | 修正运行时、浏览器绑定及会话清理 | G09、G10、G11 | 多会话交错运行、持久句柄和取消清理通过 |
| M2 | 补齐 AX 操作、模型观察和使用说明 | G02、G03、G04、G12、G16 | 实际 DSH 模型完成首个自主翻页任务 |
| M3 | 对齐指针运动和滚动体验 | G01、G15 | 可见浏览器下的轨迹及滚动对照通过 |
| M4 | 完成定位、等待和复杂页面操作 | G05、G06、G07、G08、G15 | 定位及事件语义对照通过 |
| M5 | 补齐其余能力和宿主交互 | G13、G14及台账余项 | 全部能力具备可验收状态 |
| M6 | 完整任务验收、安装升级及发布 | G16及全部 | 最终完成条件逐项关闭 |

下一轮从 M0 开始执行，紧接 M1 和 M2。M2 必须产出真实模型滚动证据。M3 按官方参数和状态机实现动画，避免继续增加未经对照的过渡效果。

### M0 — 官方能力清单和证据

- [ ] 留档当前工作区差异及新增文件，将 0.0.6 工作区内容与 Git HEAD 一并标识。
- [ ] 核对官方扩展、运行时和文档的版本与指纹，记录实际已加载版本。
- [ ] 从 O1 的所有 interface、method、type 及 O8 的 capability 文档建立逐项台账。
- [ ] 额外盘点侧栏、标签引用、右键入口、权限、指针和宿主结束钩子等交互。
- [ ] 为每项记录参数、默认值、返回类型、状态变化、异常、取消、恢复行为和来源。
- [ ] 通过官方工具运行确定性的本地页面，保存关键动作前后的状态、返回值和画面。
- [ ] 将现有测试日志和官方基线保存到可追溯记录，注明执行时间及配置。

阶段出口是全部已知能力具有编号和来源。状态仅使用“待核对”“已确认差距”“实现中”“待官方对照”“待模型验收”“待依赖”“已验收”。“已验收”必须关联证据。

### M1 — 固定句柄、REPL 和结束清理

主要修改 bridge.js、service.js、repl.js 和 index.js。

- [ ] Browser 句柄绑定明确的 browser/profile 身份，Tab 句柄继续携带该身份。
- [ ] 管理、导航、观察、输入和清理统一采用句柄的路由。切换默认浏览器只影响后续获取的默认句柄。
- [ ] 统一逐域名授权、标签接管和当前页身份检查，使直接 chrome_* 与 chrome_js 入口执行同一套检查。
- [ ] 用户标签引用同时验证浏览器、标签身份及获取时的 URL/title，处理标签 ID 重用和过期引用。
- [ ] 修正 REPL 对同一行多声明、解构、多行表达式、重复声明和异常后的持久状态处理，按官方支持范围验收。
- [ ] 已保存句柄每次调用取得当前执行上下文和取消信号。回合切换后验证旧句柄可用性。
- [ ] 同步和异步执行都受超时、取消约束。取消后等待中的浏览器动作、定时器、事件监听和输出得到收尾。
- [ ] 对可能已执行的点击、提交、下载建立“结果不确定”的恢复路径，通过新观察确认后续动作，限制自动重放的范围。
- [ ] Stop、Interrupt、错误结束和正常结束都触发完整回合清理。
- [ ] 根据 O7 实施临时页关闭、用户页释放、deliverable 保留及 handoff 跨回合处理。
- [ ] LRU、空闲清理、插件卸载和断线恢复遵守标签来源及会话归属。

阶段验收至少覆盖两浏览器交错调用、两会话操作同一浏览器、取消等待后进入下一回合、标签 ID 过期、扩展重连及用户页保留。操作错误浏览器、错误标签或重复提交会直接阻止阶段通过。

### M2 — AX 观察与实际模型翻页

主要修改 repl.js、index.js、extension/sw.js，以及 DSH 的工具说明与宿主输出适配。

- [ ] 按 O2/O3 提供首次使用文档和可查询 API 说明，保持 DSH 工具入口与实际实现一致。
- [ ] AX write 自动发出模型可见的文本、增量和图片内容。AX get 保留可编程返回值。
- [ ] 批量调用中的多次 write 和截图都按执行顺序回传，并经过 DSH 正常附件管线。
- [ ] 实现快照层级、控件状态、编号有效范围和跨文档失效行为。同名控件及重复行保持可区分。
- [ ] 更新 diff 时覆盖 checked、selected、disabled、expanded、pressed、可见结构及节点变化。
- [ ] 修正 pressKey 的目标聚焦和按键语法、paste 的插入行为、selectText 的目标和匹配范围。
- [ ] secondaryAction 使用当前状态公开的动作，逐项验证支持的动作与错误。
- [ ] 对齐 setValue/typeText、焦点、输入事件、组合键及长按参数。
- [ ] 模型默认依据最新页面状态选择动作，并在需要判断结果时取得新的状态。
- [ ] 在懒加载列表上运行真实 DSH 模型，任务目标放在首屏之外且需要滚动加载。
- [ ] 保留整页文本提取的实际用途，同时让交互式任务能取得视口和滚动区域的信息。

阶段出口是模型在普通自然语言任务下，自主选择目标区域、滚动、读取新内容并给出正确结果。验收记录包含使用的模型、配置、完整工具轨迹和结果截图。

### M3 — 指针动画和滚动逐项对照

主要修改 extension/cursor.js、extension/sw.js，以及输入参数适配。

- [ ] 从 O4/O5 记录官方短距离移动、长距离移动、转向、旋转、缩放、思考、出现和消失的参数及状态转换。
- [ ] 实现对应弹簧与曲线路径计算，使用官方参数验证边界、反向移动和连续新目标。
- [ ] 校准图片尺寸、锚点、外层旋转、阴影及最终落点。
- [ ] 指针到达确认后发送实际点击，取消、后台标签及页面跳转有确定的结束行为。
- [ ] 对齐指针与 session/turn 的关系，验证刷新、返回、手工接管和多会话结束。
- [ ] AX 滚动使用目标框宽高及最小距离规则，坐标目标使用视口尺寸，方向与 pages 完整传递。
- [ ] 像素滚动对照官方 Chrome 的原生鼠标手势参数。分别检查滚动方向、距离、节奏和结束反馈。
- [ ] 目标点验证包括可见区域、遮挡、滚动容器、iframe 坐标换算、页面缩放和设备像素比。
- [ ] 运行可见浏览器测试并保存连续帧或录屏。无头测试继续用于确定性回归。

阶段出口包括同一页面、同一坐标序列的官方与 DSH 轨迹记录，并验证指针在延迟、CSP、站点样式和导航下的可见性。

### M4 — 定位器和动态页面语义

主要修改 repl.js、index.js、extension/sw.js。

- [ ] 实现 locator 链式作用域、and/or、has/hasNot、文本匹配和 frameLocator 的官方契约。
- [ ] 修正 count、isVisible、isEnabled、getAttribute、textContent 等方法的返回类型和值。
- [ ] 实现多选及传入函数的参数、元素绑定和返回值处理。
- [ ] 严格匹配与 nth 越界遵循官方语义。
- [ ] click、fill、type 等动作使用统一的可操作性检查，覆盖存在、可见、启用、稳定和可命中。
- [ ] waitFor 按目标状态等待，并覆盖默认值、超时和取消。
- [ ] 导航、下载、文件选择器等事件在触发动作前建立监听，处理事件先到达的竞态。
- [ ] 用页面及网络事件实现对应加载状态，对长连接、后台请求和多帧行为逐项比对。
- [ ] iframe 与 shadow DOM 贯通观察、定位、点击、填表、滚动和导航后重新定位。
- [ ] 验证用户已经打开的页面中既有的 closed shadow 内容，以及新创建的 shadow 内容。
- [ ] SPA、节点替换和虚拟列表回收之后，旧引用按官方规则失效或重新解析。

阶段出口是相关 API 契约和复杂页面用例全部通过，超时及错误信息能指导模型采取下一步操作。

### M5 — 能力、侧栏和宿主交互

此阶段处理能力台账中的全部剩余项，逐项安排实现与验证。

| 能力组 | 必须核对的行为 |
|---|---|
| 文件与下载 | 本地路径、文件选择器、多文件、下载归属、等待完成、失败、取消和结果回传 |
| 剪贴板与对话框 | 文本及声明支持的 MIME 类型、焦点、alert/confirm/prompt/beforeunload 的状态与操作 |
| 内容与截图 | AX/DOM 表示、可视区域与整页截图、裁剪、页面资产、导出、字幕、日志 |
| 浏览器管理 | 标签、窗口、标签组、历史、书签、会话恢复、交付标记和操作审计 |
| 浏览器连接 | Chrome/Edge/profile 选择、重启重连、版本诊断和安装引导 |
| 侧栏与引用 | 与当前页面绑定的聊天、选中文本、右键入口、标签引用、会话恢复和双向衔接 |
| 能力发现 | 动态可用性、参数说明、错误类型、CDP 事件和 WebMCP 工具发现与调用 |
| 身份验证与人工接管 | 官方 capability 的输入、状态、返回值、恢复流程及所需宿主服务 |

- [ ] 对每个 capability 先确认实际浏览器后端是否支持，再验证其调用结果。
- [ ] 已暴露的方法采用完整契约，遇到不可用依赖返回明确状态。
- [ ] 认证、侧栏聊天和官方账户相关服务逐项定位到 DSH 宿主可实现的适配，保留待依赖记录直到完成验证。
- [ ] 核对网站授权的存储范围、重定向、frame、用户接管与工具调用之间的关系，遵循实际官方交互基线。
- [ ] 以正常用户入口完成任务，验证扩展页面、DSH 界面、Host 服务和模型工具获得一致的当前状态。
- [ ] 保留来源和资源许可说明，对外分发所需材料随版本同步维护。

阶段出口是台账中每项都有实际验证结果。待依赖项继续阻止“整体一致”的完成声明。

### M6 — 实际模型任务与发布

- [ ] 在真实 DSH Host 中加载候选版本，确认模型看到最新工具、文档和图片输出。
- [ ] 在浏览器中重新加载候选扩展，确认 Host 与扩展均报告候选版本。
- [ ] 执行第 6 节的自然语言任务，按模型版本分别记录结果。
- [ ] 在相同初始条件下执行官方任务，解释由插件实现、宿主集成或模型选择产生的差异。
- [ ] 执行安装、旧版升级、浏览器重启、扩展重载、宿主重挂载和版本不匹配检查。
- [ ] 完成台账、变更记录、安装说明和已验证平台列表。
- [ ] 将代码、测试、基线和验收记录对应到明确版本，保存可恢复的前一版本。
- [ ] 按第 1 节逐项核对最终完成条件。

## 5. 对照方法和验收标准

官方与 DSH 使用相同页面数据、浏览器版本、视口、缩放、设备像素比和初始焦点。分别在独立会话中执行，运行前恢复页面状态。登录和带副作用的用例使用测试账户、测试数据及可恢复页面。

先对照同一操作序列的插件行为，再比较自然语言任务的整体体验。模型、提示、工具说明和宿主差异均写入记录，以便定位失败原因。

以下数值是本项目的初始验收阈值。M0 完成测量后，可依据官方重复运行的波动调整，并保留调整理由。

| 验收对象 | 初始要求 |
|---|---|
| API 契约 | 已暴露能力的参数、返回类型、状态和异常用例全部通过 |
| 确定性行为 | 第 6 节每个适用场景重复 10 次，目标结果和状态转换全部正确 |
| 指针落点 | 在相同坐标系下，最终锚点与官方偏差不超过 1 CSS px |
| 指针运动 | 对齐起始时刻后，轨迹位置 p95 偏差不超过 2 CSS px，朝向偏差不超过 5°，到达时间偏差不超过 2 帧；记录官方自身波动 |
| 视觉显示 | 活跃回合中的读取、等待、导航和输入均符合官方显示时机，结束后完成对应收起 |
| 任务结果 | 20 个场景在每个声明支持的模型配置下各运行 3 次，逐次通过；失败项修复后复测相关场景 |
| 路由与副作用 | 错误浏览器、错误标签、错误输入目标、重复提交和误关用户页的次数为零 |
| 延迟 | 排除模型生成时间，每条关键操作路径预热后采样至少 30 次；p50 不高于官方 1.25 倍，p95 不高于 1.5 倍，异常样本注明原因 |

官方基线自身出现失败时，记录触发条件并完成复现分析。该能力保持待核对状态，直到形成可执行、可验证的预期行为。

## 6. 必跑场景

“真实模型”表示用自然语言给出任务，由 DSH 模型自行选择工具。代码层回归与模型验收分别记录。

| 场景 | 初始页面或任务 | 关键验收点 |
|---|---|---|
| B01 | 阅读普通长页面并找到指定段落 | 正确读取、指针显示、需要视觉确认时检查对应页面 |
| B02 | 找到滚动后才加载的第 30 条结果 | 模型主动滚动，读取新内容，按需继续并正确停止 |
| B03 | 外层固定、右侧列表独立滚动 | 滚动作用于目标列表，外层位置符合预期 |
| B04 | 带横向列的表格 | 横向方向与距离正确，指定列可见 |
| B05 | 带边界的内嵌滚动区 | 到达边界后检查状态，选择正确的后续动作 |
| B06 | 短距离、长距离、反向和连续移动 | 指针轨迹、角度、落点与点击顺序对照通过 |
| B07 | 模型思考、页面刷新、回合结束 | 指针显示、恢复和收起与官方一致 |
| B08 | CSP 页面、强站点 CSS、浏览器缩放 | 指针可见，截图和输入坐标一致 |
| B09 | 弹层覆盖、动画移动及暂时禁用的按钮 | 正确等待、命中或报告明确失败 |
| B10 | 多个同名控件、复用列表行、节点替换 | 严格匹配、作用域和旧引用处理正确 |
| B11 | 同源及跨源嵌套 iframe | 观察、点击、填表、滚动和坐标换算正确 |
| B12 | 已存在和新创建的 open/closed shadow 内容 | 观察和操作通过完整入口验证 |
| B13 | 多输入框、编辑器、多选控件 | 聚焦、paste、pressKey、selectText 和状态返回正确 |
| B14 | 快速跳转、SPA 导航、延迟请求与长连接 | 事件等待及超时行为一致 |
| B15 | 文件选择器、上传及下载 | 事件归属、结果内容、成功与失败状态正确 |
| B16 | confirm、prompt、beforeunload | 正确发现并处理对话框，操作后检查状态 |
| B17 | 两浏览器、两 profile、交错使用持久句柄 | 路由稳定，指定页面收到全部操作 |
| B18 | 用户原有页、临时页、deliverable 与 handoff | 接管、结束清理、下回合恢复符合官方规则 |
| B19 | 操作中取消、服务断线、扩展重载、人工接管 | 恢复后状态明确，副作用次数正确 |
| B20 | 侧栏提问、选中文本、标签引用及登录接管 | 上下文准确，会话衔接和任务恢复完成 |

B02 的自然语言任务只描述业务目标，例如“找出第 30 条商品的名称和价格”。测试页面保证目标需要滚动加载。记录模型是否选择正确的滚动区域，以及是否在获得目标后停止。

额外记录无待完成事件时连续读取同一状态、滚动无效后重复原动作、频繁切换标签、跳过结果确认等行为，逐项与官方任务轨迹比较。

## 7. 每项任务的交付记录

每个差距关闭时填写以下信息，证据文件在执行阶段生成。

| 字段 | 必填内容 |
|---|---|
| 能力编号 | G 编号、官方接口或交互名称 |
| 官方基线 | 扩展版本、运行时版本、来源文件和指纹 |
| 初始条件 | 浏览器/profile、测试页面、数据、视口、焦点 |
| 官方结果 | 返回值、异常、状态变化、截图或轨迹 |
| DSH 修改 | 文件、变更内容和兼容性处理 |
| 入口覆盖 | 正常工具、chrome_js、侧栏等适用入口 |
| 验证结果 | 回归、官方对照、实际模型任务及日志路径 |
| 当前状态 | 已验收或待处理状态，以及剩余问题 |

同一能力以“操作结果正确”“模型接收到正确反馈”“用户可观察体验一致”三个维度验收。接口数量、名称和单次演示作为实现信息记录。

## 8. 执行入口

从当前工作区开始，先查看和留档现有修改。

~~~bash
cd /home/yelin/cil_work/dsh-BrowserControl/dsh-chrome-bridge
git status --short
git diff --stat
~~~

每次实现后运行与修改有关的验证，阶段完成时运行现有基线。

~~~bash
npm test
npm run test:e2e
git diff --check
~~~

真实浏览器测试当前依赖仓库中的 .tools/chrome-linux64/chrome，并使用独立测试 profile 和本地端口。执行前确认测试端口可用。可见动画对照另行记录显示环境及帧率。

下一轮执行按以下顺序开始。

1. 完成 M0 的能力台账、官方基线和当前工作区留档。
2. 修正 M1 的固定浏览器句柄、REPL 回合上下文和结束清理。
3. 修正 M2 的 AX 输出、聚焦与粘贴，并完成 B02 的真实 DSH 模型验收。
4. 完成 M3 的指针动画与滚动对照，再依次实施 M4 至 M6。
5. 全部出口条件满足后，更新版本和完成声明，并附上可复核的验收记录。


## 9. 本轮执行记录（2026-11-05）

本轮工作区版本为 0.1.0（基线 0.0.6），按 M0 → M1 → M2 → M3 的顺序推进，详细证据和未关闭项见 [执行状态](parity/EXECUTION_STATUS.md)。

- M0：生成 [能力台账](parity/capability-ledger.md)、[基线留档](parity/baseline.md)，记录官方 O1/O4/O5 指纹与本机 Chrome/Edge 版本。
- M1：完成 G09（句柄绑定 browserId、跨浏览器路由）、G10（REPL 解析/超时/当前 exec）、G11（turn/end 完整清理及 deliverable/handoff）。
- M2：完成 G02（ax.get/ax.write 输出拆分、chrome_act 观察块）、G03（目标聚焦、paste、selectText、secondaryAction、xdotool 组合键）、G04（AX 层级/稳定引用/富 diff）、G12（API 文档入口）；G05-G08 的定位与等待语义同步修正。
- M3：G01 按官方 spring/curve 参数重写 `extension/cursor.js`，E2E 增加路径中间帧和 1 CSS px 落点断言；G15 的 iframe/shadow/滚动场景继续沿用并扩充 E2E。

以下项目仍未关闭，保持原状态：官方逐项对照记录、B02 真实 DSH 模型滚动任务、侧栏聊天/官方账户依赖、跨浏览器与操作系统组合、M4-M6 的完整验收。

验证入口：

~~~bash
npm run parity:ledger   # 重新生成能力台账
npm run parity:baseline # 重新留档 Git/版本/指纹
npm test
npm run test:e2e
~~~
