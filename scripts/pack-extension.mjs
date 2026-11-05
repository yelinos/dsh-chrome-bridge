#!/usr/bin/env node
/**
 * Build the store-ready extension package.
 *
 * Usage:
 *   node scripts/pack-extension.mjs [--out <file.zip>]
 *
 * Zips exactly the files the extension needs (manifest, scripts, pages,
 * icons and images) with paths relative to the archive root, which is what
 * the Chrome Web Store and Microsoft Edge Add-ons expect. The output
 * defaults to `dist/dsh-chrome-bridge-extension-<version>.zip`.
 */
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = join(root, "extension");

function option(name, fallback) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
}

const IGNORED = new Set([".DS_Store", "Thumbs.db"]);

async function walk(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (IGNORED.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await walk(absolute, name)));
    } else if (entry.isFile()) {
      files.push({ absolute, name });
    }
  }
  return files;
}

// Minimal STORE zip writer: local file header, deflated data, central
// directory and end-of-central-directory, with the DOS timestamp of each
// source file. Avoids a dependency on the `zip` CLI or an extra package.
import { deflateRawSync, crc32 } from "node:zlib";

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function writeZip(files, sink) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = file.data;
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data) >>> 0;
    const { time, day } = dosDateTime(file.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs
    central.writeUInt32LE(offset, 42);

    localParts.push(local, name, compressed);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  sink.write(Buffer.concat(localParts));
  sink.write(Buffer.concat(centralParts));
  sink.write(end);
}

const manifest = JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8"));
const outPath = resolve(option("out", join(root, "dist", `dsh-chrome-bridge-extension-${manifest.version}.zip`)));

const entries = await walk(extensionDir);
const files = [];
for (const entry of entries) {
  files.push({ ...entry, data: await readFile(entry.absolute), mtime: (await stat(entry.absolute)).mtime });
}

// The store validates that every icon declared in the manifest exists.
for (const [size, path] of Object.entries(manifest.icons ?? {})) {
  if (!files.some((file) => file.name === path)) {
    console.error(`FAIL manifest icon ${size} -> ${path} is missing`);
    process.exit(1);
  }
}

await mkdir(dirname(outPath), { recursive: true });
const sink = createWriteStream(outPath);
await new Promise((done, fail) => {
  sink.on("error", fail);
  sink.on("finish", done);
  writeZip(files, sink);
  sink.end();
});

console.log(`wrote ${relative(root, outPath)} (${files.length} files, version ${manifest.version})`);
for (const file of files) console.log(`  ${file.name}`);