# 执行状态（2026-11-05）

对照计划：[CODEX_PARITY_EXECUTION_PLAN.md](../CODEX_PARITY_EXECUTION_PLAN.md)

本文件记录本轮实际完成情况。状态使用计划规定的口径；没有官方逐项对照证据的项目不会标为“已验收”。

## 阶段状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| M0 | 已建立 | 已生成能力台账、基线留档、官方指纹和测试日志目录；侧栏/右键/权限/指针/宿主钩子已盘点 |
| M1 | 实现完成，待官方对照 | G09 浏览器句柄绑定、G10 REPL 重写、G11 回合清理已实现并有单元/E2E 证据；双浏览器/双会话的官方对照记录仍待补 |
| M2 | 实现完成，待官方对照/模型验收 | G02/G03/G04/G12 已实现；AX 文本、diff、动作、批量输出有 E2E 证据；B02 真实 DSH 模型自主滚动任务尚待执行 |
| M3 | 实现中 | G01 已移植官方弹簧/曲线/思考动画并按落点验证；滚动参数有 E2E 覆盖；官方逐帧轨迹对照尚待补 |
| M4 | 部分 | G05/G06/G07/G08 已实现并测试；复杂页面、shadow/iframe 边界仍待官方对照 |
| M5 | 部分 | G13 侧栏页面上下文/标签引用已补；G14 capability 错误与返回值已收紧；其余能力台账项仍开放 |
| M6 | 未开始 | 真实模型任务、安装升级与发布记录待执行 |

## 差距台账

| 编号 | 状态 | 本轮实现与证据 |
|---|---|---|
| G01 | 待官方对照 | `extension/cursor.js` 使用官方参数移植弹簧模拟、短距 scoot、长距 Bezier 弧线、思考摆动、44° 旋转/23×24 资源；E2E 验证路径中间帧与 1px 落点 |
| G02 | 待官方对照 | `tab.ax.write()` 通过 `chrome_js`/`chrome_act` 输出文本和图片；`tab.ax.get()` 返回字符串状态；`chrome_act` 保留每次观察块顺序 |
| G03 | 待官方对照 | `ax.pressKey` 聚焦目标并支持 xdotool 组合键/长按；`ax.paste` 写入虚拟剪贴板并插入；`ax.selectText` 支持 prefix/suffix/selectionType；`performSecondaryAction` 仅接受 Expand/Collapse |
| G04 | 待官方对照 | AX 快照含层级、可见状态、稳定 backend 引用、文档导航失效、富 diff（checked/selected/disabled/expanded/pressed/visible）；同名控件按 backend id 区分 |
| G05 | 待官方对照 | locator `and`/`or`/`scope`/`has`/`hasNot`/frame 链与严格匹配已实现；E2E 覆盖链式作用域和组合条件 |
| G06 | 待官方对照 | `count`/`isVisible`/`isEnabled`/`getAttribute`/`textContent` 返回原生值；`selectOption` 支持多选和 descriptor；locator evaluate/evaluateAll 绑定元素与 tab |
| G07 | 待官方对照 | `chrome_locator` 完整传递 has/hasNot/and/or/scope；nth 越界报错；waitFor 支持 visible/hidden/attached/detached；动作带超时 |
| G08 | 待官方对照 | `networkidle` 基于 Network 在途请求静默窗口；`expectNavigation` 在动作前建立监听并处理快速导航 |
| G09 | 待官方对照 | REPL 浏览器/标签句柄携带 browserId，命令按句柄路由；会话标签记录浏览器身份；双 fake 浏览器测试通过 |
| G10 | 待官方对照 | REPL 支持解构、多声明、函数/类、重复声明、多行尾表达式；同步 VM 超时 + 异步 deadline/cancel；句柄调用绑定当前 exec |
| G11 | 待官方对照 | `turn/end` 自动执行完整清理：关闭未标记 agent tab、释放 claimed user tab、保留 deliverable、handoff 留到下一回合；显式 `chrome_turn_ended` 同一路径 |
| G12 | 实现中 | `agent.documentation.get()` / `browser.documentation.get()` 提供 overview/ax/playwright/cua/clipboard/content/capabilities 说明；仍需补更完整参数文档和官方对照 |
| G13 | 实现中 | 侧栏显示连接、浏览器、当前页面、选区、标签列表并可复制 tab mention；聊天输入及桌面会话流式衔接仍待宿主适配 |
| G14 | 实现中 | 能力列表/未知能力错误已收紧；认证类仍为待依赖；逐能力实际可用性验证仍待补 |
| G15 | 待官方对照 | E2E 覆盖同源/跨源 iframe、closed shadow、滚动容器、文件选择；更多遮挡/动画/虚拟列表场景待补 |
| G16 | 待模型验收 | 尚未在真实 DSH 模型会话中执行 B02 懒加载列表任务 |

## 验证记录

- 最终单元/协议/服务/客户端：`npm test` 通过 72 项、0 失败；日志 `docs/parity/logs/npm-test-20261105-121633.log`
- 最终真实 Chrome E2E：`npm run test:e2e` 通过 80 项、0 失败；日志 `docs/parity/logs/npm-e2e-20261105-121707.log`
- 环境：Node v26.13.0；Chrome for Testing 157.0.8103.38，headless；连接扩展版本 0.1.0
- 能力台账：`npm run parity:ledger` → [capability-ledger.md](capability-ledger.md)
- 基线留档：`npm run parity:baseline` → [baseline.md](baseline.md)

## 本轮未关闭的验收项

1. 官方逐项对照（O1/O2/O4/O5 的行为记录）尚未形成逐用例证据。
2. 真实 DSH 模型的自然语言滚动任务（B02）尚未执行。
3. 侧栏聊天、官方账户/认证后端、跨浏览器/系统组合仍是待依赖或待验证。
4. 指针轨迹、延迟、动画帧率尚未与官方做同坐标序列的数值对照。
