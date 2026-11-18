import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { checkPackage, listFiles, packageExtension, referencedFiles, storeManifest, zip, type Manifest } from "../scripts/package";

const root = resolve(import.meta.dirname, "..");
const shipped = JSON.parse(readFileSync(join(root, "public/manifest.json"), "utf8")) as Manifest;
const { version: packageVersion } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };

/** Reads an archive back through its central directory, the way unzip and the store do. */
function unzip(archive: Buffer) {
  const end = archive.length - 22;
  expect(archive.readUInt32LE(end)).toBe(0x06054b50);
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const entries: { name: string; method: number; flags: number; data: Buffer }[] = [];
  for (let i = 0; i < count; i++) {
    expect(archive.readUInt32LE(at)).toBe(0x02014b50);
    const method = archive.readUInt16LE(at + 10);
    const crc = archive.readUInt32LE(at + 16);
    const compressed = archive.readUInt32LE(at + 20);
    const size = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const local = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString("utf8");

    expect(archive.readUInt32LE(local)).toBe(0x04034b50);
    expect(archive.subarray(local + 30, local + 30 + nameLength).toString("utf8")).toBe(name);
    const start = local + 30 + nameLength + archive.readUInt16LE(local + 28);
    const body = archive.subarray(start, start + compressed);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    expect(data.length).toBe(size);
    expect(crc32(data)).toBe(crc);
    entries.push({ name, method, flags: archive.readUInt16LE(at + 8), data });
    at += 46 + nameLength + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
  }
  return entries;
}

const valid = (): Manifest => ({
  manifest_version: 3,
  name: "RTC Inspector",
  version: "1.2.3",
  description: "Inspect WebRTC.",
  icons: { "16": "icons/a-16.png", "128": "icons/a-128.png" },
  action: { default_popup: "popup.html", default_icon: { "16": "icons/b-16.png" } },
  background: { service_worker: "background.js" },
  devtools_page: "devtools.html",
  content_scripts: [{ js: ["inject.js"] }, { js: ["relay.js"], css: ["./page.css"] }],
});

const filesFor = (manifest: Manifest, extra: Record<string, string> = {}) =>
  new Map<string, Uint8Array>([...referencedFiles(manifest).map((f) => [f, Buffer.from("x")] as const), ...Object.entries(extra).map(([f, s]) => [f, Buffer.from(s)] as const)]);

describe("storeManifest", () => {
  it("drops the development key and keeps everything else", () => {
    const dev = { ...valid(), key: "MIIB..." };
    expect(storeManifest(dev)).toEqual(valid());
    expect(dev.key).toBe("MIIB..."); // input untouched
  });
});

describe("referencedFiles", () => {
  it("collects icons, popup, worker, devtools page and content scripts, without leading ./", () => {
    expect(referencedFiles(valid())).toEqual(["background.js", "devtools.html", "icons/a-128.png", "icons/a-16.png", "icons/b-16.png", "inject.js", "page.css", "popup.html", "relay.js"]);
  });

  it("accepts a single default_icon path and an empty manifest", () => {
    expect(referencedFiles({ action: { default_icon: "/icon.png" } })).toEqual(["icon.png"]);
    expect(referencedFiles({})).toEqual([]);
  });
});

describe("checkPackage", () => {
  it("passes a complete package", () => {
    expect(checkPackage(valid(), filesFor(valid()), "1.2.3")).toEqual([]);
  });

  it("passes the manifest this extension ships, once the key is removed", () => {
    const manifest = storeManifest(shipped);
    expect(checkPackage(manifest, filesFor(manifest), packageVersion)).toEqual([]);
    expect(checkPackage(shipped, filesFor(shipped), packageVersion)).toEqual(['the manifest has a "key"; the store rejects packages that contain one']);
  });

  it("enforces the store's text limits", () => {
    const m = { ...valid(), name: "n".repeat(76), description: "d".repeat(133) };
    expect(checkPackage(m, filesFor(m), "1.2.3")).toEqual(["name is 76 characters; the store allows 75", "description is 133 characters; the store allows 132"]);
    const missing = { ...valid(), name: "", description: undefined };
    expect(checkPackage(missing, filesFor(missing), "1.2.3")).toEqual(["name is missing", "description is missing"]);
  });

  it.each(["", "1.2.3.4.5", "1.02", "70000", "1.2-beta", "v1"])("rejects version %j", (version) => {
    const m = { ...valid(), version };
    expect(checkPackage(m, filesFor(m), version)).toEqual([expect.stringMatching(/^version ".*" must be one to four/)]);
  });

  it("requires the manifest and package.json versions to match", () => {
    expect(checkPackage(valid(), filesFor(valid()), "1.2.4")).toEqual(["manifest version 1.2.3 differs from package.json version 1.2.4; bump both"]);
  });

  it("requires manifest version 3 and a 128 px icon", () => {
    const m = { ...valid(), manifest_version: 2, icons: { "48": "icons/a-48.png" } };
    expect(checkPackage(m, filesFor(m), "1.2.3")).toEqual(["manifest_version must be 3", "icons must include a 128 x 128 icon"]);
  });

  it("finds files the manifest names but the package lacks", () => {
    const files = filesFor(valid());
    files.delete("relay.js");
    files.delete("icons/a-128.png");
    expect(checkPackage(valid(), files, "1.2.3")).toEqual([
      "the manifest refers to icons/a-128.png, which is not in the package",
      "the manifest refers to relay.js, which is not in the package",
    ]);
  });

  it("rejects pages and stylesheets that load from the network", () => {
    const problems = (name: string, content: string) => checkPackage(valid(), filesFor(valid(), { [name]: content }), "1.2.3");
    expect(problems("popup.html", '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X" />')).toEqual([
      'popup.html loads from the network (<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X); bundle it instead',
    ]);
    expect(problems("a.html", "<script src=//cdn.example/x.js></script>")).toHaveLength(1);
    expect(problems("a.css", '@import "https://fonts.example/a.css";')).toHaveLength(1);
    expect(problems("a.css", "body{background:url(http://img.example/a.png)}")).toHaveLength(1);
    // Local resources and plain links are fine.
    expect(problems("a.html", '<script type="module" src="./assets/a.js"></script><link href="./a.css" rel="stylesheet"><a href="https://example.com">x</a>')).toEqual([]);
    expect(problems("a.css", 'body{font-family:x;src:url("./assets/f.woff2")}')).toEqual([]);
    expect(problems("a.js", 'fetch("https://example.com")')).toEqual([]); // scripts are not scanned
  });
});

describe("zip", () => {
  const entries = [
    { name: "manifest.json", data: Buffer.from(JSON.stringify({ a: "b".repeat(500) })) },
    { name: "icons/ä-16.png", data: Buffer.from([0x89, 0x50]) },
    { name: "empty.txt", data: new Uint8Array() },
  ];

  it("round-trips through the central directory, compressing only what shrinks", () => {
    const out = unzip(zip(entries));
    expect(out.map((e) => e.name)).toEqual(["manifest.json", "icons/ä-16.png", "empty.txt"]);
    expect(out.map((e) => e.method)).toEqual([8, 0, 0]);
    expect(out.every((e) => e.flags === 0x0800)).toBe(true);
    out.forEach((e, i) => expect(e.data.equals(Buffer.from(entries[i]!.data))).toBe(true));
  });

  it("is reproducible: same files, same bytes", () => {
    expect(zip(entries).equals(zip(entries))).toBe(true);
  });

  it("writes a valid empty archive", () => {
    expect(unzip(zip([]))).toEqual([]);
  });
});

describe("packageExtension", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const build = (files: Record<string, string>) => {
    dir = mkdtempSync(join(tmpdir(), "rtc-package-"));
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, "dist", name)), { recursive: true });
      writeFileSync(join(dir, "dist", name), content);
    }
    return { dist: join(dir, "dist"), outDir: join(dir, "release") };
  };

  const dist = () => {
    const manifest = { ...valid(), key: "MIIB-dev-only" };
    return Object.fromEntries([["manifest.json", JSON.stringify(manifest)], ...referencedFiles(manifest).map((f) => [f, `/* ${f} */`]), ["assets/app.js", "1"], [".DS_Store", "x"]]);
  };

  it("writes the store zip: manifest first, key removed, every built file included", () => {
    const paths = build(dist());
    const result = packageExtension({ ...paths, packageVersion: "1.2.3" });
    expect(result).toMatchObject({ file: join(paths.outDir, "rtc-inspector-1.2.3.zip"), version: "1.2.3", files: 11 });
    const out = unzip(readFileSync(result.file));
    expect(result.bytes).toBe(readFileSync(result.file).length);
    expect(out[0]!.name).toBe("manifest.json");
    const manifest = JSON.parse(out[0]!.data.toString("utf8")) as Manifest;
    expect(manifest.key).toBeUndefined();
    expect(manifest.name).toBe("RTC Inspector");
    expect(out.map((e) => e.name).sort()).toEqual(listFiles(paths.dist).sort());
    expect(out.map((e) => e.name)).not.toContain(".DS_Store");
  });

  it("refuses to package when a check fails, and lists every problem", () => {
    const files = dist();
    delete files["relay.js"];
    const paths = build(files);
    expect(() => packageExtension({ ...paths, packageVersion: "9.9.9" })).toThrow(
      "Not packaged:\n  - manifest version 1.2.3 differs from package.json version 9.9.9; bump both\n  - the manifest refers to relay.js, which is not in the package",
    );
  });

  it("asks for a build when dist has no manifest", () => {
    const paths = build({ "a.js": "" });
    expect(() => packageExtension({ ...paths, packageVersion: "1.2.3" })).toThrow(/has no manifest\.json; build the extension first/);
  });
});
