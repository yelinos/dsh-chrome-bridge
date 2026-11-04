#!/usr/bin/env node
/**
 * Static checks for the plugin and its extension: JavaScript syntax, JSON
 * validity, and version parity between package.json and the extension
 * manifest. No dependencies; safe to run in CI.
 */
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;

const jsFiles = [
  "index.js",
  "service.js",
  "bridge.js",
  "client.js",
  "extension/sw.js",
  "extension/popup.js",
  ...(await readdir(join(root, "test"))).filter((f) => f.endsWith(".mjs")).map((f) => `test/${f}`),
  ...(await readdir(join(root, "scripts"))).filter((f) => f.endsWith(".mjs")).map((f) => `scripts/${f}`),
];

let failed = 0;
for (const file of jsFiles) {
  try {
    await run(process.execPath, ["--check", join(root, file)]);
    console.log(`ok   syntax ${file}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL syntax ${file}\n${error.stderr ?? error.message}`);
  }
}

const jsonFiles = [
  "package.json",
  "extension/manifest.json",
  "locale/en.json",
  "locale/zh.json",
];
for (const file of jsonFiles) {
  try {
    JSON.parse(await readFile(join(root, file), "utf8"));
    console.log(`ok   json   ${file}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL json   ${file}: ${error.message}`);
  }
}

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(join(root, "extension/manifest.json"), "utf8"));
if (pkg.version === manifest.version) {
  console.log(`ok   version ${pkg.version}`);
} else {
  failed += 1;
  console.error(`FAIL version package.json=${pkg.version} manifest=${manifest.version}`);
}

if (manifest.manifest_version !== 3) {
  failed += 1;
  console.error("FAIL extension manifest must be Manifest V3");
} else {
  console.log("ok   manifest_version 3");
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\nall checks passed (${relative(process.cwd(), root) || "."})`);
