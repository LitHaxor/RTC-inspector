/**
 * Renders the Chrome Web Store listing images from the real extension:
 *
 *   pnpm --filter @rtc-inspector/extension build
 *   node packages/extension/scripts/store-assets.ts
 *
 * It loads dist/ in Chrome for Testing, runs a two-tab video call and a page
 * with a signaling bug, and captures the inspector at the store's sizes:
 *   store/screenshots/*.png   1280 x 800, the five uploaded to the listing
 *   store/screenshots/extra/  more views and the popup, for the README
 *   store/promo/*.png         440 x 280 (small tile), 1400 x 560 (marquee)
 *   store/icon-128.png        listing icon
 * PNGs are written without an alpha channel, as the store requires.
 */

import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");
const out = join(root, "store");
const { id } = JSON.parse(readFileSync(join(root, "e2e/extension-id.json"), "utf8")) as { id: string };

/** Branded Chrome ignores --load-extension, so use Chrome for Testing (as the e2e suite does). */
function chromeForTesting(): string {
  if (process.env.CHROME_FOR_TESTING) return process.env.CHROME_FOR_TESTING;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  const builds = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
  for (const build of builds) {
    const exe = join(cache, build, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
    if (existsSync(exe)) return exe;
  }
  throw new Error("No Chrome for Testing found: run `npx playwright install chromium` or set CHROME_FOR_TESTING");
}

// A video call through a signaling server; each participant is a tab. A
// BroadcastChannel stands in for the server, a canvas and a tone for camera and mic.
const CALL = `<!doctype html><title>Standup</title>
<body style="margin:0;background:#111"><canvas id="cam" width="640" height="360"></canvas><script>
  const server = new BroadcastChannel("standup");
  const me = Math.random().toString(36).slice(2, 7);
  const LINES = ["morning!", "shipping the TURN fix today", "can you see my screen?", "audio is a bit choppy", "back now", "reviewing the SDP diff", "ok, merging", "thanks all"];
  const cam = document.getElementById("cam"), g = cam.getContext("2d");
  let frame = 0;
  setInterval(() => { frame++; g.fillStyle = "hsl(" + (frame * 2) % 360 + " 45% 35%)"; g.fillRect(0, 0, 640, 360); g.fillStyle = "#fff"; g.font = "40px sans-serif"; g.fillText(me + "  " + frame, 40, 190); }, 33);
  const audio = new AudioContext(), tone = audio.createOscillator(), mic = audio.createMediaStreamDestination();
  tone.connect(mic); tone.start();
  const stream = new MediaStream([cam.captureStream(30).getVideoTracks()[0], mic.stream.getAudioTracks()[0]]);

  let pc, peer, pending = [], talking;
  const connect = (remote) => {
    peer = remote;
    pc = new RTCPeerConnection();
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    const chat = pc.createDataChannel("chat", { negotiated: true, id: 0 });
    let n = 0;
    chat.onopen = () => (talking = setInterval(() => chat.readyState === "open" && chat.send(JSON.stringify({ from: me, text: LINES[n++ % LINES.length] })), 900));
    pc.onicecandidate = (e) => e.candidate && server.postMessage({ type: "candidate", to: remote, from: me, candidate: e.candidate.toJSON() });
    pc.onconnectionstatechange = () => (window.connected = pc.connectionState === "connected");
  };
  const remoteSet = async (sdp) => {
    await pc.setRemoteDescription(sdp);
    for (const c of pending.splice(0)) await pc.addIceCandidate(c);
  };
  const handle = async (m) => {
    if (m.to && m.to !== me) return;
    if (m.type === "hello" && !pc) { connect(m.from); await pc.setLocalDescription(); server.postMessage({ type: "offer", to: m.from, from: me, sdp: pc.localDescription.toJSON() }); }
    if (m.type === "offer") { connect(m.from); await remoteSet(m.sdp); await pc.setLocalDescription(); server.postMessage({ type: "answer", to: m.from, from: me, sdp: pc.localDescription.toJSON() }); }
    if (m.type === "answer") await remoteSet(m.sdp);
    if (m.type === "candidate" && pc) pc.remoteDescription ? await pc.addIceCandidate(m.candidate) : pending.push(m.candidate);
  };
  let queue = Promise.resolve();
  server.onmessage = ({ data }) => (queue = queue.then(() => handle(data)).catch(console.error));
  window.join = () => server.postMessage({ type: "hello", from: me });
  window.quiet = () => clearInterval(talking);
</script></body>`;

// The most common WebRTC bug: offer and answer are exchanged, but ICE candidates are never forwarded.
const BROKEN = `<!doctype html><title>Support chat</title><body><script>
  (async () => {
    const a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.createDataChannel("support");
    await a.setLocalDescription(); await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(); await a.setRemoteDescription(b.localDescription);
  })();
</script></body>`;

const SHOT = { width: 1280, height: 800 };

async function launch(): Promise<BrowserContext> {
  if (!existsSync(join(dist, "manifest.json"))) throw new Error("Build the extension first: pnpm --filter @rtc-inspector/extension build");
  const context = await chromium.launchPersistentContext("", {
    executablePath: chromeForTesting(),
    headless: true,
    viewport: SHOT,
    deviceScaleFactor: 1,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--autoplay-policy=no-user-gesture-required"],
  });
  await context.route("https://standup.example/**", (route) => route.fulfill({ contentType: "text/html", body: CALL }));
  await context.route("https://support.example/**", (route) => route.fulfill({ contentType: "text/html", body: BROKEN }));
  if (!context.serviceWorkers().length) await context.waitForEvent("serviceworker");
  return context;
}

const tabIds = (context: BrowserContext, pattern: string) =>
  context.serviceWorkers()[0]!.evaluate(async (url) => (await chrome.tabs.query({ url })).map((t) => t.id!).sort((a, b) => a - b), pattern);

/** Pages have an opaque background, so Chrome writes RGB PNGs (the store rejects alpha). */
async function shot(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }) {
  const path = join(out, name);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  await page.screenshot({ path, ...(clip ? { clip } : {}), omitBackground: false });
  console.log("wrote", path);
  return path;
}

async function openInspector(context: BrowserContext, tabId: number): Promise<Page> {
  const ui = await context.newPage();
  await ui.goto(`chrome-extension://${id}/inspector.html?tabId=${tabId}`);
  await ui.getByRole("tab", { name: "Overview" }).waitFor();
  await ui.evaluate(() => document.fonts.ready);
  return ui;
}

const tab = (ui: Page, name: string) => ui.getByRole("tab", { name, exact: true }).click();

async function screenshots(context: BrowserContext): Promise<void> {
  mkdirSync(join(out, "screenshots/extra"), { recursive: true });

  const ann = await context.newPage();
  await ann.goto("https://standup.example/room/42");
  const ben = await context.newPage();
  await ben.goto("https://standup.example/room/42");
  await ben.evaluate(() => (window as unknown as { join: () => void }).join());
  await ben.waitForFunction(() => (window as unknown as { connected?: boolean }).connected === true, undefined, { timeout: 15_000 });
  await ben.waitForTimeout(12_000); // stats samples and chat messages
  const [, benTab] = await tabIds(context, "https://standup.example/*");

  const ui = await openInspector(context, benTab!);
  await ui.getByRole("button", { name: /^Tab 2 pc-1/ }).first().click();

  await tab(ui, "Overview");
  await shot(ui, "screenshots/2-overview.png");

  await tab(ui, "Stats");
  await ui.waitForTimeout(500);
  await shot(ui, "screenshots/4-stats.png");

  await tab(ui, "Data channels");
  await shot(ui, "screenshots/extra/data-channels.png");

  await tab(ui, "ICE");
  await shot(ui, "screenshots/extra/ice.png");

  await tab(ui, "Signaling");
  await shot(ui, "screenshots/extra/signaling.png");

  // From here on the views must hold still: stop the chat so no new events arrive.
  for (const page of [ann, ben]) await page.evaluate(() => (window as unknown as { quiet: () => void }).quiet());
  await ui.waitForTimeout(1_000);

  // The action log, with what Tab 2 applying the offer changed.
  await tab(ui, "Events");
  const filter = ui.getByRole("searchbox", { name: "Filter events" });
  await filter.fill("sdp.remote.set Tab 2");
  await ui.getByLabel("Events, use arrow keys to move").getByText("sdp.remote.set").first().click();
  await filter.fill("");
  await ui.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await shot(ui, "screenshots/3-events.png");

  // The start of the call: offer, answer and candidates crossing between the two tabs.
  await tab(ui, "Timeline");
  await ui.getByRole("button", { name: "Close event detail" }).click();
  await ui.getByLabel("Event sequence").evaluate((el) => el.scrollTo({ top: 0 }));
  await shot(ui, "screenshots/1-timeline.png");

  // The popup, at Chrome's popup size, for the README.
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 800, height: 600 });
  await popup.goto(`chrome-extension://${id}/popup.html?tabId=${benTab}`);
  await popup.getByRole("tab", { name: "Events", selected: true }).waitFor();
  await popup.evaluate(() => document.fonts.ready);
  await shot(popup, "screenshots/extra/popup.png");

  // A broken page: the inspector names the bug.
  const broken = await context.newPage();
  await broken.goto("https://support.example/");
  await broken.waitForTimeout(4_500); // the "candidates never arrived" rule waits 3 s
  const [brokenTab] = await tabIds(context, "https://support.example/*");
  const diag = await openInspector(context, brokenTab!);
  await diag.getByRole("button", { name: /^pc-2/ }).first().click();
  await tab(diag, "Overview");
  await diag.mouse.move(760, 500);
  await diag.mouse.wheel(0, 200); // the finding, its explanation and what to check
  await shot(diag, "screenshots/5-diagnosis.png");
}

/** The fonts the extension bundles, inlined for the promo tiles. */
function fontFaces(): string {
  const fonts = join(root, "node_modules/@fontsource");
  const face = (family: string, pkg: string, weight: number) =>
    `@font-face{font-family:"${family}";font-weight:${weight};src:url(data:font/woff2;base64,${readFileSync(join(fonts, pkg, "files", `${pkg}-latin-${weight}-normal.woff2`)).toString("base64")}) format("woff2")}`;
  return [face("Host Grotesk", "host-grotesk", 400), face("Host Grotesk", "host-grotesk", 500), face("Atkinson Hyperlegible Mono", "atkinson-hyperlegible-mono", 400)].join("");
}

const ICON = `<svg viewBox="0 0 128 128" width="100%" height="100%"><rect x="4" y="4" width="120" height="120" rx="28" fill="#2b7de9"/><path d="M42 86 L86 42" stroke="#fff" stroke-width="11" stroke-linecap="round"/><circle cx="38" cy="90" r="17" fill="#fff"/><circle cx="90" cy="38" r="17" fill="#fff"/></svg>`;

const TILE_CSS = `
  *{box-sizing:border-box;margin:0}
  html,body{width:100%;height:100%;background:oklch(13.5% 0.007 250);color:oklch(95% 0.005 250);font-family:"Host Grotesk",sans-serif;-webkit-font-smoothing:antialiased}
  .mono{font-family:"Atkinson Hyperlegible Mono",monospace}
  .muted{color:oklch(71% 0.01 250)}
  .accent{color:oklch(82% 0.15 80)}
  .cool{color:oklch(77% 0.12 245)}
  .brand{display:flex;align-items:center}
  .name{font-weight:500;letter-spacing:-0.03em}
`;

/** Two lifelines and the messages between them: the signature of the timeline view. */
function sequence(width: number, height: number): string {
  const rows = [
    ["offer", "accent", 1],
    ["answer", "accent", -1],
    ["candidate", "cool", 1],
    ["candidate", "cool", -1],
    ["connected", "ok", 0],
    ["chat · 42 B", "muted", 1],
  ] as const;
  const left = 36;
  const right = width - 36;
  const top = 34;
  const step = (height - top - 18) / rows.length;
  const color = { accent: "oklch(82% 0.15 80)", cool: "oklch(77% 0.12 245)", ok: "oklch(76% 0.15 150)", muted: "oklch(71% 0.01 250)" } as const;
  const lines = rows
    .map(([label, tone, dir], i) => {
      const y = top + step * (i + 0.6);
      const c = color[tone];
      if (dir === 0) return `<rect x="${left - 4}" y="${y - 9}" width="${right - left + 8}" height="18" rx="4" fill="oklch(24.5% 0.03 150)"/><text x="${(left + right) / 2}" y="${y + 4}" fill="${c}" text-anchor="middle" font-size="11">${label}</text>`;
      const [x1, x2] = dir === 1 ? [left, right] : [right, left];
      const head = dir === 1 ? `M${x2 - 7} ${y - 4} L${x2} ${y} L${x2 - 7} ${y + 4}` : `M${x2 + 7} ${y - 4} L${x2} ${y} L${x2 + 7} ${y + 4}`;
      return `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${c}" stroke-width="1.6"/><path d="${head}" fill="none" stroke="${c}" stroke-width="1.6"/><text x="${(left + right) / 2}" y="${y - 6}" fill="${c}" text-anchor="middle" font-size="11">${label}</text>`;
    })
    .join("");
  return `<svg class="mono" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Atkinson Hyperlegible Mono">
    <text x="${left}" y="16" fill="oklch(83% 0.008 250)" text-anchor="middle" font-size="11">Tab 1</text>
    <text x="${right}" y="16" fill="oklch(83% 0.008 250)" text-anchor="middle" font-size="11">Tab 2</text>
    <line x1="${left}" y1="24" x2="${left}" y2="${height - 6}" stroke="oklch(42% 0.012 250)" stroke-dasharray="3 4"/>
    <line x1="${right}" y1="24" x2="${right}" y2="${height - 6}" stroke="oklch(42% 0.012 250)" stroke-dasharray="3 4"/>
    ${lines}</svg>`;
}

async function promo(context: BrowserContext): Promise<void> {
  mkdirSync(join(out, "promo"), { recursive: true });
  const page = await context.newPage();
  const css = `<style>${fontFaces()}${TILE_CSS}</style>`;

  await page.setViewportSize({ width: 440, height: 280 });
  await page.setContent(`<!doctype html>${css}
    <body style="display:flex;padding:30px 28px;gap:22px;align-items:center">
      <div style="flex:1;display:flex;flex-direction:column;gap:14px">
        <div style="width:52px;height:52px">${ICON}</div>
        <div class="name" style="font-size:30px;line-height:1.05">RTC<br>Inspector</div>
        <div class="muted" style="font-size:14.5px;line-height:1.35">See what every WebRTC connection is doing.</div>
      </div>
      <div style="width:196px">${sequence(196, 210)}</div>
    </body>`);
  await page.evaluate(() => document.fonts.ready);
  await shot(page, "promo/small-440x280.png");

  const timeline = readFileSync(join(out, "screenshots/1-timeline.png")).toString("base64");
  await page.setViewportSize({ width: 1400, height: 560 });
  await page.setContent(`<!doctype html>${css}
    <body style="display:flex;align-items:center;padding:0 0 0 88px;gap:64px;overflow:hidden">
      <div style="width:470px;flex:none;display:flex;flex-direction:column;gap:22px">
        <div class="brand" style="gap:16px"><div style="width:56px;height:56px">${ICON}</div><div class="name" style="font-size:34px">RTC Inspector</div></div>
        <div class="name" style="font-size:46px;line-height:1.08">Every offer, candidate and message, on one timeline.</div>
        <div class="muted" style="font-size:18px;line-height:1.45">Records the WebRTC on any page, explains what went wrong, and keeps it all in your browser.</div>
      </div>
      <div style="flex:none;width:900px;height:562px;margin-top:120px;border:1px solid oklch(42% 0.012 250);border-radius:12px;overflow:hidden;box-shadow:0 30px 80px rgb(0 0 0 / 0.55)">
        <img src="data:image/png;base64,${timeline}" style="display:block;width:900px">
      </div>
    </body>`);
  await page.evaluate(() => document.fonts.ready);
  await shot(page, "promo/marquee-1400x560.png");

  copyFileSync(join(root, "public/icons/active-128.png"), join(out, "icon-128.png"));
  console.log("wrote", join(out, "icon-128.png"));
}

const context = await launch();
try {
  await screenshots(context);
  await promo(context);
} finally {
  await context.close();
}
