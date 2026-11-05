#!/usr/bin/env node
/**
 * Generate the M0 capability ledger from the fixed official baseline.
 *
 * Usage:
 *   node scripts/parity-ledger.mjs [--api <api.json>] [--out <file>]
 *
 * The official api.json documents every Browser Use interface and method.
 * `docs/parity/status.json` maps capability ids to the project's current
 * verification state and evidence; missing ids default to 待核对.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultApi = "/home/yelin/.codex/plugins/cache/openai-bundled/chrome/26.1027.51404/docs/api.json";
const argv = process.argv.slice(2);
function option(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
}
const apiPath = resolve(option("api", process.env.CODEX_CHROME_API ?? defaultApi));
const outPath = resolve(option("out", join(root, "docs/parity/capability-ledger.md")));
if (!existsSync(apiPath)) {
  console.error(`official api.json not found: ${apiPath}`);
  process.exit(1);
}

const api = JSON.parse(await readFile(apiPath, "utf8"));
const statuses = JSON.parse(await readFile(join(root, "docs/parity/status.json"), "utf8"));
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(join(root, "extension/manifest.json"), "utf8"));
const indexSource = await readFile(join(root, "index.js"), "utf8");
const toolNames = [...indexSource.matchAll(/name:\s*"(chrome_[a-z0-9_]+)"/g)].map((match) => match[1]);

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
const apiBytes = await readFile(apiPath);
const statusOf = (id) => statuses[id] ?? { status: "待核对", evidence: "" };
let gitHead = "";
try {
  gitHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
} catch {
  gitHead = "(not a git checkout)";
}

const STATUS_LEGEND =
  "状态仅使用“待核对”“已确认差距”“实现中”“待官方对照”“待模型验收”“待依赖”“已验收”；“已验收”必须关联证据。";

const lines = [];
lines.push("# DSH Chrome Bridge 官方能力台账（自动生成）", "");
lines.push(`- 生成时间：${new Date().toISOString()}`);
lines.push(`- DSH 版本：${packageJson.version}（扩展 manifest ${manifest.version}）`);
lines.push(`- Git HEAD：\`${gitHead}\``);
lines.push(`- 官方 api.json：\`${apiPath}\``);
lines.push(`- api.json SHA-256：\`${sha256(apiBytes)}\``);
lines.push(`- 官方接口 ${Object.keys(api.interfaces).length} 个，方法 ${Object.values(api.interfaces).reduce((sum, value) => sum + Object.keys(value).length, 0)} 个，类型 ${Object.keys(api.types).length} 个`);
lines.push(`- DSH 已注册工具 ${toolNames.length} 个`);
lines.push("", STATUS_LEGEND, "");

lines.push("## 1. 官方接口与方法", "");
lines.push("| 编号 | 接口.方法 | 官方签名 | 状态 | 证据 |");
lines.push("|---|---|---|---|---|");
let index = 0;
for (const [interfaceName, members] of Object.entries(api.interfaces)) {
  for (const [methodName, member] of Object.entries(members)) {
    index += 1;
    const id = `API-${String(index).padStart(3, "0")}`;
    const declarations = (member.declarations ?? []).map((entry) => entry.text.replaceAll("|", "\\|")).join("<br>");
    const status = statusOf(id);
    lines.push(`| ${id} | \`${interfaceName}.${methodName}\` | ${declarations || "—"} | ${status.status} | ${status.evidence ?? ""} |`);
  }
}
lines.push("");

lines.push("## 2. 官方 capability 文档", "");
lines.push("| 编号 | 文档 | 状态 | 证据 |");
lines.push("|---|---|---|---|");
const capabilityDocs = [
  ["browser/management.md", "CAP-MGMT"],
  ["browser/viewport.md", "CAP-VIEWPORT"],
  ["browser/visibility.md", "CAP-VISIBILITY"],
  ["tab/botDetection.md", "CAP-BOT"],
  ["tab/browserAuth.md", "CAP-AUTH"],
  ["tab/cdp.md", "CAP-CDP"],
  ["tab/pageAssets.md", "CAP-ASSETS"],
  ["tab/siwc.md", "CAP-SIWC"],
  ["tab/webmcp.md", "CAP-WEBMCP"],
];
for (const [file, id] of capabilityDocs) {
  const status = statusOf(id);
  lines.push(`| ${id} | \`docs/capabilities/${file}\` | ${status.status} | ${status.evidence ?? ""} |`);
}
lines.push("");

lines.push("## 3. DSH 工具入口", "");
lines.push("| 工具 | 状态 | 证据 |");
lines.push("|---|---|---|");
for (const tool of toolNames) {
  const status = statusOf(`TOOL:${tool}`);
  lines.push(`| \`${tool}\` | ${status.status} | ${status.evidence ?? ""} |`);
}
lines.push("");

lines.push("## 4. 交互与宿主盘点", "");
lines.push("| 编号 | 交互 | 状态 | 证据 |");
lines.push("|---|---|---|---|");
const interactions = [
  ["INT-SIDEBAR", "扩展侧栏：页面上下文、标签引用、聊天输入、流式回复"],
  ["INT-CONTEXT-MENU", "右键菜单入口"],
  ["INT-NOTIFICATIONS", "浏览器通知"],
  ["INT-TAB-MENTIONS", "用户标签页 @ 引用"],
  ["INT-PERMISSIONS", "扩展权限与网站授权"],
  ["INT-CURSOR", "虚拟指针显示、动画与回合收起"],
  ["INT-HOST-HOOKS", "宿主 turn/end、Stop、Interrupt、Agent 释放钩子"],
  ["INT-INSTALL", "安装引导、浏览器/profile 诊断与重连"],
];
for (const [id, label] of interactions) {
  const status = statusOf(id);
  lines.push(`| ${id} | ${label} | ${status.status} | ${status.evidence ?? ""} |`);
}
lines.push("");
lines.push("## 5. 生成方式", "");
lines.push("```bash");
lines.push("npm run parity:ledger");
lines.push("```");
lines.push("");
lines.push("状态来源：`docs/parity/status.json`。新增证据时先更新该文件再重新生成。");
lines.push("");

await writeFile(outPath, lines.join("\n"));
console.log(`wrote ${outPath} (${toolNames.length} tools, ${index} methods)`);
