#!/usr/bin/env node
/**
 * Archive the M0 baseline: git state, versions, official fingerprints and
 * environment. Run before/after a parity round and commit the generated file.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const officialRoot = "/home/yelin/.codex/plugins/cache/openai-bundled/chrome/26.1027.51404";
const officialExtension = "/home/yelin/.config/microsoft-edge/Default/Extensions/hehggadaopoacecdllhhajmbjkdcmajg/1.26.1102.11740_0";
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(join(root, "extension/manifest.json"), "utf8"));

function output(command, args, cwd = root) {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (error) {
    return `(unavailable: ${String(error?.message ?? error).split("\n")[0]})`;
  }
}
async function fingerprint(path) {
  if (!existsSync(path)) return "(missing)";
  const buffer = await readFile(path);
  return `${createHash("sha256").update(buffer).digest("hex")} (${buffer.byteLength} bytes)`;
}

const files = [
  ["O1 api.json", join(officialRoot, "docs/api.json")],
  ["O2 accessibility.md", join(officialRoot, "docs/accessibility.md")],
  ["O3 api-use-behavior.md", join(officialRoot, "docs/api-use-behavior.md")],
  ["O4 content-scripts/codex.js", join(officialExtension, "content-scripts/codex.js")],
  ["O5 scripts/browser-service.mjs", join(officialRoot, "scripts/browser-service.mjs")],
  ["O6 tab-claiming-chrome.md", join(officialRoot, "docs/tab-claiming-chrome.md")],
  ["O7 tab-cleanup-chrome.md", join(officialRoot, "docs/tab-cleanup-chrome.md")],
];
const lines = [];
lines.push("# M0 基线留档", "");
lines.push(`- 生成时间：${new Date().toISOString()}`);
lines.push(`- 工作区：${root}`);
lines.push(`- Git HEAD：\`${output("git", ["rev-parse", "HEAD"])}\``);
lines.push(`- DSH 插件版本：${packageJson.version}`);
lines.push(`- 扩展 manifest 版本：${manifest.version}`);
lines.push(`- Node：${process.version}`);
lines.push(`- 平台：${process.platform} ${process.arch}`);
lines.push(`- Chrome for Testing：${output(join(root, ".tools/chrome-linux64/chrome"), ["--version"])}`);
lines.push(`- 官方浏览器扩展：1.26.1102.11740（${officialExtension}）`);
lines.push(`- 官方 chrome 插件：26.1027.51404（${officialRoot}）`);
lines.push("", "## Git 状态", "", "```text", output("git", ["status", "--short"]), "", output("git", ["diff", "--stat"]), "```", "");
lines.push("## 官方材料指纹", "", "| 编号 | 文件 | SHA-256 |", "|---|---|---|");
for (const [name, path] of files) lines.push(`| ${name} | \`${path}\` | ${await fingerprint(path)} |`);
lines.push("");
lines.push("## 本轮验证记录", "");
lines.push("- 单元/协议/服务/客户端：`docs/parity/logs/npm-test-<timestamp>.log`");
lines.push("- 真实 Chrome E2E：`docs/parity/logs/npm-e2e-<timestamp>.log`");
lines.push("- 能力台账：`docs/parity/capability-ledger.md`（`npm run parity:ledger`）");
lines.push("");
await writeFile(join(root, "docs/parity/baseline.md"), lines.join("\n"));
console.log("wrote docs/parity/baseline.md");
