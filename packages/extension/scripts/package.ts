/**
 * Turns dist/ into the zip you upload to the Chrome Web Store:
 *
 *   pnpm package:extension        (from the repository root; builds first)
 *   → packages/extension/release/rtc-inspector-<version>.zip
 *
 * The development manifest has a "key" so that an unpacked build always gets the
 * same extension ID (the end-to-end suite relies on it). The Web Store assigns its
 * own key and rejects packages that contain one, so it is removed here.
 *
 * Before anything is written the package is checked: the store's limits on name
 * and description, a valid version that matches package.json, a 128 px icon, every
 * file the manifest names, and no page or stylesheet loading from the network.
 * Timestamps are fixed, so the same build always produces the same bytes.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

export interface Manifest {
  manifest_version?: number;
  name?: string;
  version?: string;
  description?: string;
  key?: string;
  icons?: Record<string, string>;
  action?: { default_popup?: string; default_icon?: string | Record<string, string> };
  background?: { service_worker?: string };
  devtools_page?: string;
  content_scripts?: { js?: string[]; css?: string[] }[];
  [field: string]: unknown;
}

export const LIMITS = { name: 75, description: 132 } as const;

/** The manifest as uploaded: the development-only "key" removed. */
export function storeManifest(manifest: Manifest): Manifest {
  const { key: _key, ...rest } = manifest;
  return rest;
}

/** Every file the manifest refers to, as package paths. */
export function referencedFiles(manifest: Manifest): string[] {
  const files = new Set<string>();
  const add = (file: unknown) => {
    if (typeof file === "string" && file) files.add(file.replace(/^\.?\//, ""));
  };
  Object.values(manifest.icons ?? {}).forEach(add);
  const icon = manifest.action?.default_icon;
  if (typeof icon === "string") add(icon);
  else Object.values(icon ?? {}).forEach(add);
  add(manifest.action?.default_popup);
  add(manifest.background?.service_worker);
  add(manifest.devtools_page);
  for (const script of manifest.content_scripts ?? []) [...(script.js ?? []), ...(script.css ?? [])].forEach(add);
  return [...files].sort();
}

const VERSION = /^\d+(\.\d+){0,3}$/;
const REMOTE_IN_HTML = /<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']?(?:https?:)?\/\/[^\s"'>]+/i;
const REMOTE_IN_CSS = /(?:@import\s+(?:url\()?|url\()\s*["']?(?:https?:)?\/\/[^\s"')]+/i;
const decode = (data: Uint8Array) => new TextDecoder().decode(data);

/** Everything that would get the package rejected by the store, or make it differ from the tested build. */
export function checkPackage(manifest: Manifest, files: ReadonlyMap<string, Uint8Array>, packageVersion: string): string[] {
  const problems: string[] = [];
  if (manifest.manifest_version !== 3) problems.push("manifest_version must be 3");
  for (const field of ["name", "description"] as const) {
    const value = manifest[field];
    if (!value) problems.push(`${field} is missing`);
    else if (value.length > LIMITS[field]) problems.push(`${field} is ${value.length} characters; the store allows ${LIMITS[field]}`);
  }
  const version = manifest.version ?? "";
  if (!VERSION.test(version) || version.split(".").some((part) => Number(part) > 65535 || (part.length > 1 && part.startsWith("0")))) {
    problems.push(`version "${version}" must be one to four dot-separated integers from 0 to 65535, without leading zeros`);
  } else if (version !== packageVersion) {
    problems.push(`manifest version ${version} differs from package.json version ${packageVersion}; bump both`);
  }
  if ("key" in manifest) problems.push('the manifest has a "key"; the store rejects packages that contain one');
  if (!manifest.icons?.["128"]) problems.push("icons must include a 128 x 128 icon");
  for (const file of referencedFiles(manifest)) {
    if (!files.has(file)) problems.push(`the manifest refers to ${file}, which is not in the package`);
  }
  for (const [name, data] of files) {
    const pattern = name.endsWith(".html") ? REMOTE_IN_HTML : name.endsWith(".css") ? REMOTE_IN_CSS : undefined;
    const remote = pattern?.exec(decode(data));
    if (remote) problems.push(`${name} loads from the network (${remote[0]}); bundle it instead`);
  }
  return problems;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const UTF8_NAMES = 0x0800;

/** A ZIP archive: deflate (or stored, when deflate does not help), UTF-8 names, fixed timestamps. */
export function zip(entries: readonly ZipEntry[]): Buffer {
  if (entries.length > 0xffff) throw new Error("too many files for a ZIP without ZIP64");
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const path = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    const method = deflated.length < data.length ? 8 : 0;
    const body = method === 8 ? deflated : Buffer.from(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(path.length, 26);
    parts.push(local, path, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(path.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, path);

    offset += local.length + path.length + body.length;
    if (offset > 0xffffffff) throw new Error("archive larger than 4 GB needs ZIP64");
  }
  const dir = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

/** Files under `dir`, as sorted forward-slash paths. */
export function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== ".DS_Store")
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/"))
    .sort();
}

export interface PackageResult {
  file: string;
  version: string;
  files: number;
  bytes: number;
}

export function packageExtension({ dist, outDir, packageVersion }: { dist: string; outDir: string; packageVersion: string }): PackageResult {
  const files = new Map<string, Uint8Array>();
  for (const name of listFiles(dist)) files.set(name, readFileSync(join(dist, name)));
  const raw = files.get("manifest.json");
  if (!raw) throw new Error(`${dist} has no manifest.json; build the extension first`);

  const manifest = storeManifest(JSON.parse(decode(raw)) as Manifest);
  files.set("manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  const problems = checkPackage(manifest, files, packageVersion);
  if (problems.length) throw new Error(`Not packaged:\n${problems.map((p) => `  - ${p}`).join("\n")}`);

  // manifest.json first, the rest in a stable order.
  const names = ["manifest.json", ...[...files.keys()].filter((n) => n !== "manifest.json")];
  const archive = zip(names.map((name) => ({ name, data: files.get(name)! })));
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `rtc-inspector-${manifest.version}.zip`);
  writeFileSync(file, archive);
  return { file, version: manifest.version!, files: names.length, bytes: archive.length };
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "..");
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  try {
    const result = packageExtension({ dist: join(root, "dist"), outDir: join(root, "release"), packageVersion: version });
    console.log(`${relative(process.cwd(), result.file)}: version ${result.version}, ${result.files} files, ${Math.round(result.bytes / 1024)} KB`);
    console.log("Upload it in the Chrome Web Store Developer Dashboard: https://chrome.google.com/webstore/devconsole");
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
