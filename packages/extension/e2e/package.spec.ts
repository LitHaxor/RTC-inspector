import { chromium, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packageExtension } from "../scripts/package";
import { chromeForTesting } from "./chrome";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");
const { id: devId } = JSON.parse(readFileSync(join(import.meta.dirname, "extension-id.json"), "utf8")) as { id: string };
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
const executablePath = chromeForTesting();

const PAGE = `<!doctype html><title>call</title><body><script>
  window.done = (async () => {
    const a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    const got = new Promise((r) => (b.ondatachannel = (e) => (e.channel.onmessage = (m) => r(m.data))));
    const ch = a.createDataChannel("chat");
    ch.onopen = () => ch.send("from the store build");
    await a.setLocalDescription(); await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(); await a.setRemoteDescription(b.localDescription);
    return got;
  })();
</script></body>`;

test.skip(!executablePath, "No Chrome for Testing build available (set CHROME_FOR_TESTING)");
test.skip(!existsSync(join(dist, "manifest.json")), "Run `pnpm build` first");

test("the Chrome Web Store zip installs, records WebRTC and makes no network requests of its own", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rtc-store-"));
  const unpacked = join(dir, "unpacked");
  const { file } = packageExtension({ dist, outDir: dir, packageVersion: version });
  execFileSync("unzip", ["-q", file, "-d", unpacked]);

  const context = await chromium.launchPersistentContext("", {
    executablePath,
    headless: true,
    args: [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`],
  });
  try {
    const requests: string[] = [];
    context.on("request", (request) => requests.push(request.url()));
    await context.route("http://store-test.local/**", (route) => route.fulfill({ contentType: "text/html", body: PAGE }));

    const page = await context.newPage();
    await page.goto("http://store-test.local/");
    expect(await page.evaluate(() => (window as unknown as { done: Promise<string> }).done)).toBe("from the store build");

    // Without the development key, Chrome assigns this install its own ID.
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const id = new URL(worker.url()).host;
    expect(id).not.toBe(devId);

    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: "http://store-test.local/*" }))[0]!.id!);
    await expect.poll(() => worker.evaluate((t) => chrome.action.getBadgeText({ tabId: t }), tabId)).toBe("2");

    const popup = await context.newPage();
    const errors: string[] = [];
    popup.on("pageerror", (e) => errors.push(e.message));
    await popup.setViewportSize({ width: 800, height: 600 });
    await popup.goto(`chrome-extension://${id}/popup.html?tabId=${tabId}`);
    await expect(popup.getByRole("tab", { name: "Events", selected: true })).toBeVisible();
    await expect(popup.getByLabel("Events, use arrow keys to move").getByText("datachannel.message").first()).toBeVisible();

    // The typefaces come from the package, not from a font service.
    const loaded = await popup.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/"/g, ""));
    });
    expect(new Set(loaded)).toEqual(new Set(["Host Grotesk", "Atkinson Hyperlegible Mono"]));

    expect(errors).toEqual([]);
    // The popup's own files were requested (so the listener sees its traffic), and nothing else left the browser.
    expect(requests.filter((u) => u.startsWith(`chrome-extension://${id}/assets/`) && u.endsWith(".woff2")).length).toBeGreaterThan(0);
    expect(requests.filter((u) => !/^(chrome-extension:|data:|http:\/\/store-test\.local\/)/.test(u))).toEqual([]);
  } finally {
    await context.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
