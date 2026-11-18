import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromeForTesting } from "./chrome";

const dist = resolve(import.meta.dirname, "../dist");
const { id } = JSON.parse(readFileSync(resolve(import.meta.dirname, "extension-id.json"), "utf8")) as { id: string };

// A page that uses plain WebRTC and knows nothing about the inspector.
const PAGE = `<!doctype html><title>plain webrtc</title><body><script>
  window.done = (async () => {
    const a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    const got = new Promise((r) => (b.ondatachannel = (e) => (e.channel.onmessage = (m) => r(m.data))));
    const ch = a.createDataChannel("chat");
    ch.onopen = () => ch.send("hello from a page with no SDK");
    await a.setLocalDescription();
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription();
    await a.setRemoteDescription(b.localDescription);
    return got;
  })();
</script></body>`;

// Like the WebRTC samples: nothing happens until the user clicks Start.
const LATER = `<!doctype html><title>start later</title><body><button id="start" onclick="start()">Start</button><script>
  window.start = async () => {
    const a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    a.createDataChannel("chat");
    await a.setLocalDescription(); await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(); await a.setRemoteDescription(b.localDescription);
  };
</script></body>`;

// Like the WebRTC samples' "Transmit text": Start makes two connections and a channel, Stop closes them.
const RESTART = `<!doctype html><title>start stop</title><body>
<button id="start" onclick="start()">Start</button><button id="stop" onclick="stop()">Stop</button><script>
  let a, b, send, receive;
  window.start = async () => {
    a = new RTCPeerConnection(); b = new RTCPeerConnection();
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    send = a.createDataChannel("sendDataChannel");
    const opened = new Promise((r) => (b.ondatachannel = (e) => { receive = e.channel; receive.onopen = r; }));
    await a.setLocalDescription(); await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(); await a.setRemoteDescription(b.localDescription);
    await opened;
  };
  // Close one side, and let the other notice (Chrome fires 'error' on its channel), then close it too.
  window.stop = async () => {
    const noticed = new Promise((r) => { receive.addEventListener("error", r); setTimeout(r, 2000); });
    send.close(); a.close();
    await noticed;
    receive.close(); b.close();
  };
</script></body>`;

// Like an app with a signaling server: each user is a tab, and the two ends of a
// call are in different tabs. A BroadcastChannel stands in for the server.
const CHAT = `<!doctype html><title>chat</title><body><button id="join" onclick="join()">Join</button><script>
  const server = new BroadcastChannel("signaling");
  const me = Math.random().toString(36).slice(2);
  let pc;
  const gathered = () => new Promise((r) => {
    if (pc.iceGatheringState === "complete") return r();
    pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && r());
    setTimeout(r, 2000);
  });
  const connect = () => {
    pc = new RTCPeerConnection();
    const ch = pc.createDataChannel("chat", { negotiated: true, id: 0 });
    ch.onopen = () => ch.send("hi from " + me);
    ch.onmessage = (m) => (window.got = m.data);
  };
  server.onmessage = async ({ data }) => {
    if (data.to && data.to !== me) return;
    const reply = async (type) => {
      await pc.setLocalDescription(); await gathered();
      server.postMessage({ type, to: data.from, from: me, sdp: pc.localDescription.toJSON() });
    };
    if (data.type === "hello") { connect(); await reply("offer"); }
    if (data.type === "offer") { connect(); await pc.setRemoteDescription(data.sdp); await reply("answer"); }
    if (data.type === "answer") await pc.setRemoteDescription(data.sdp);
  };
  window.join = () => server.postMessage({ type: "hello", from: me });
</script></body>`;

let context: BrowserContext;
const executablePath = chromeForTesting();

test.skip(!executablePath, "No Chrome for Testing build available (set CHROME_FOR_TESTING)");
test.skip(!existsSync(join(dist, "manifest.json")), "Run `pnpm build` first");

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext("", {
    executablePath,
    headless: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  await context.route("http://rtc-test.local/**", (route) => route.fulfill({ contentType: "text/html", body: PAGE }));
  await context.route("http://later.local/**", (route) => route.fulfill({ contentType: "text/html", body: LATER }));
  await context.route("http://restart.local/**", (route) => route.fulfill({ contentType: "text/html", body: RESTART }));
  await context.route("http://chat.local/**", (route) => route.fulfill({ contentType: "text/html", body: CHAT }));
  await context.route("http://plain.local/**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>plain</title><p>No WebRTC here.</p>" }));
});

test.afterAll(async () => context?.close());

test("records WebRTC on a page that never imported the SDK, and the panel renders it", async () => {
  const page = await context.newPage();
  await page.goto("http://rtc-test.local/");
  expect(await page.evaluate(() => (window as unknown as { done: Promise<string> }).done)).toBe("hello from a page with no SDK");
  await page.waitForTimeout(300);

  const read = await page.evaluate(() => (window as unknown as { __RTC_INSPECTOR_BRIDGE__: { read: (a: number) => { sessionId: string; url: string; events: { type: string; peerId: string }[] } } }).__RTC_INSPECTOR_BRIDGE__.read(0));
  const types = read.events.map((e) => e.type);
  expect(read.url).toBe("http://rtc-test.local/");
  expect(types.filter((t) => t === "peer.created")).toHaveLength(2);
  // The page uses implicit setLocalDescription(), so there is no createOffer() call to record.
  for (const t of ["sdp.local.set", "sdp.remote.set", "ice.candidate.added", "datachannel.open", "datachannel.message"]) {
    expect(types, t).toContain(t);
  }
  // RTCPeerConnection identity is preserved for the page.
  expect(await page.evaluate(() => new RTCPeerConnection() instanceof RTCPeerConnection && RTCPeerConnection.name)).toBe("RTCPeerConnection");

  // Render the real panel bundle, with chrome.devtools stubbed to serve this recording.
  const panel = await context.newPage();
  await panel.addInitScript((data) => {
    const w = window as unknown as { chrome: Record<string, unknown> };
    w.chrome = w.chrome ?? {};
    w.chrome.devtools = {
      inspectedWindow: {
        tabId: 1,
        eval(expression: string, cb: (result: unknown) => void) {
          const m = /read\((\d+),(\d+)\)/.exec(expression);
          if (!m) return cb(true);
          const after = Number(m[1]);
          cb({ ...data, events: data.events.filter((e: { seq: number }) => e.seq > after), more: false, dropped: 0 });
        },
      },
    };
  }, read);
  const errors: string[] = [];
  panel.on("pageerror", (e) => errors.push(e.message));
  await panel.goto(`chrome-extension://${id}/panel.html`);
  await expect(panel.getByText("rtc-test.local")).toBeVisible();
  await expect(panel.getByRole("tab", { name: "Events", selected: true })).toBeVisible();
  await panel.getByRole("tab", { name: "Overview" }).click();
  await expect(panel.getByRole("region", { name: /^Connection pc-/ }).first()).toBeVisible();
  await panel.getByRole("tab", { name: "Data channels" }).click();
  await expect(panel.getByText("hello from a page with no SDK").first()).toBeVisible();
  await panel.screenshot({ path: resolve(import.meta.dirname, "../test-results/panel.png") });
  expect(errors).toEqual([]);
  // One tab per site from here on, unless a test is about several.
  await page.close();
});

const worker = () => context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${id}/`))!;
const tabIdOf = (url: string) => worker().evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]!.id!, url);

test("badge, popup, event diff, jump, open in window", async () => {
  const page = await context.newPage();
  await page.goto("http://rtc-test.local/?popup");
  expect(await page.evaluate(() => (window as unknown as { done: Promise<string> }).done)).toBe("hello from a page with no SDK");
  if (!context.serviceWorkers().length) await context.waitForEvent("serviceworker");
  const tabId = await tabIdOf("http://rtc-test.local/?popup");

  // Badge and icon: blue with the number of connections on a WebRTC page.
  await expect.poll(() => worker().evaluate((t) => chrome.action.getBadgeText({ tabId: t }), tabId)).toBe("2");
  const iconIsBlue = (t: number) => worker().evaluate((tab) => (globalThis as unknown as { tabState: Map<number, boolean> }).tabState.get(tab), t);
  expect(await iconIsBlue(tabId)).toBe(true);

  // Popup (what the toolbar icon opens), pointed at that tab.
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 800, height: 600 }); // Chrome's popup size
  const errors: string[] = [];
  popup.on("pageerror", (e) => errors.push(e.message));
  await popup.goto(`chrome-extension://${id}/popup.html?tabId=${tabId}`);
  await expect(popup.getByRole("tab", { name: "Events", selected: true })).toBeVisible();
  // Keyboard focus is visible: a 2px solid ring, no transition.
  await popup.keyboard.press("Tab");
  const ring = await popup.evaluate(() => {
    const cs = getComputedStyle(document.activeElement!);
    return { label: document.activeElement!.getAttribute("aria-label"), style: cs.outlineStyle, width: cs.outlineWidth, transition: cs.transitionDuration };
  });
  expect(ring).toEqual({ label: "Open in window", style: "solid", width: "2px", transition: "0s" });
  const list = popup.getByLabel("Events, use arrow keys to move");
  await expect(list.getByText("datachannel.message").first()).toBeVisible();

  // Diff: what opening the channel changed.
  const filter = popup.getByRole("searchbox", { name: "Filter events" });
  await filter.fill("datachannel.open pc-1");
  await list.getByText("datachannel.open").first().click();
  const pane = popup.getByRole("region", { name: "Selected event" });
  await expect(pane.getByText("pc-1.channels.chat.state")).toBeVisible();
  await expect(pane.getByText('"open"').first()).toBeVisible();
  await popup.screenshot({ path: resolve(import.meta.dirname, "../test-results/popup-events.png") });
  await pane.getByRole("button", { name: "State" }).click();
  await expect(pane.getByText("signalingState").first()).toBeVisible();

  // Jump: every tab shows the session as it was right after pc-1 applied its offer.
  await pane.getByRole("button", { name: "Event", exact: true }).click();
  await filter.fill("sdp.local.set pc-1");
  await list.getByText("sdp.local.set").first().click();
  await filter.fill("");
  await pane.getByRole("button", { name: "Jump" }).click();
  await expect(popup.getByText(/^viewing event \d+ of \d+$/)).toBeVisible();
  await popup.getByRole("tab", { name: "Overview" }).click();
  const focus = popup.getByRole("region", { name: /^Connection pc-1/ });
  await expect(focus.getByText("have-local-offer")).toBeVisible();
  await popup.getByRole("button", { name: "Back to live" }).click();
  await expect(focus.getByText("stable", { exact: true })).toBeVisible();

  // Slider: step back one event from live.
  await popup.getByRole("button", { name: "Previous event" }).click();
  await expect(popup.getByText(/^viewing event \d+ of \d+$/)).toBeVisible();
  await popup.screenshot({ path: resolve(import.meta.dirname, "../test-results/popup.png") });

  // Open in window: a separate inspector window for the same tab.
  const opened = context.waitForEvent("page");
  await popup.getByRole("button", { name: "Open in window" }).click();
  const win = await opened;
  await win.waitForLoadState();
  expect(win.url()).toBe(`chrome-extension://${id}/inspector.html?tabId=${tabId}`);
  await expect(win).toHaveTitle("RTC Inspector: rtc-test.local");
  await win.getByRole("tab", { name: "Data channels" }).click();
  await expect(win.getByText("hello from a page with no SDK").first()).toBeVisible();

  // Asking again focuses the same window instead of opening another.
  const again = await worker().evaluate(async (t) => {
    const tab = await chrome.tabs.get(t);
    return (globalThis as unknown as { openInspectorFor: (t: unknown, m: string) => Promise<number> }).openInspectorFor(tab, "window");
  }, tabId);
  expect(context.pages().filter((p) => p.url().includes("inspector.html"))).toHaveLength(1);
  expect(again).toBeGreaterThan(0);
  expect(errors).toEqual([]);
  await page.close();
});

test("open in tab, and a reload starts a fresh recording", async () => {
  const page = await context.newPage();
  await page.goto("http://rtc-test.local/?tab");
  await page.evaluate(() => (window as unknown as { done: Promise<string> }).done);
  const tabId = await tabIdOf("http://rtc-test.local/?tab");
  const opened = context.waitForEvent("page");
  await worker().evaluate(async (t) => {
    const tab = await chrome.tabs.get(t);
    return (globalThis as unknown as { openInspectorFor: (t: unknown) => Promise<number> }).openInspectorFor(tab);
  }, tabId);
  const inspector = await opened;
  await inspector.waitForLoadState();
  await inspector.getByRole("tab", { name: "Overview" }).click();
  await expect(inspector.getByRole("region", { name: /^Connection pc-/ }).getByText("connected", { exact: true }).first()).toBeVisible();
  await page.reload();
  await page.evaluate(() => (window as unknown as { done: Promise<string> }).done);
  await inspector.getByRole("tab", { name: "Overview" }).click();
  await expect(inspector.getByRole("region", { name: /^Connection pc-/ }).getByText("connected", { exact: true }).first()).toBeVisible();
});

test("the icon is gray on pages without WebRTC, and goes gray again after leaving one", async () => {
  const page = await context.newPage();
  await page.goto("http://rtc-test.local/?leave");
  await page.evaluate(() => (window as unknown as { done: Promise<string> }).done);
  const tabId = await tabIdOf("http://rtc-test.local/?leave");
  const iconIsBlue = () => worker().evaluate((tab) => (globalThis as unknown as { tabState: Map<number, boolean> }).tabState.get(tab), tabId);
  await expect.poll(iconIsBlue).toBe(true);

  await page.goto("http://plain.local/"); // same tab, a page that never touches WebRTC
  await expect.poll(iconIsBlue).toBe(false);
  expect(await worker().evaluate((t) => chrome.action.getBadgeText({ tabId: t }), tabId)).toBe("");

  await page.goto("http://rtc-test.local/?back");
  await page.evaluate(() => (window as unknown as { done: Promise<string> }).done);
  await expect.poll(iconIsBlue).toBe(true);

  await page.goto("chrome://version"); // no script can run here; must still reset
  await expect.poll(iconIsBlue).toBe(false);
});

test("explains why chrome:// pages cannot be inspected", async () => {
  // Without the "tabs" permission chrome:// tabs can't be looked up by URL, so open one and keep its id.
  const tabId = await worker().evaluate(async () => (await chrome.tabs.create({ url: "chrome://version", active: false })).id);
  const inspector = await context.newPage();
  await inspector.goto(`chrome-extension://${id}/inspector.html?tabId=${tabId}`);
  await expect(inspector.getByText("Chrome does not allow inspecting this page")).toBeVisible();
});

const blue = (tabId: number) => worker().evaluate((t) => (globalThis as unknown as { tabState: Map<number, boolean> }).tabState.get(t) ?? false, tabId);

test("turns blue when connections are created after the page loaded (clicking Start)", async () => {
  const page = await context.newPage();
  await page.goto("http://later.local/?a");
  await page.waitForLoadState("load");
  const tabId = await tabIdOf("http://later.local/?a");
  await expect.poll(() => blue(tabId)).toBe(false);
  await page.click("#start");
  await expect.poll(() => blue(tabId)).toBe(true);
  expect(await worker().evaluate((t) => chrome.action.getBadgeText({ tabId: t }), tabId)).toBe("2");
});

test("re-attaches to tabs that were already open when the extension was installed or updated", async () => {
  const page = await context.newPage();
  await page.goto("http://later.local/?b");
  await page.waitForLoadState("load");
  const tabId = await tabIdOf("http://later.local/?b");

  // Put the page in the state of a tab opened before the extension existed:
  // the native RTCPeerConnection, no inspector.
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown> & { RTCPeerConnection: typeof RTCPeerConnection };
    w.RTCPeerConnection = Object.getPrototypeOf(w.RTCPeerConnection) as typeof RTCPeerConnection;
    delete w.__RTC_INSPECTOR__;
    delete w.__RTC_INSPECTOR_BRIDGE__;
  });
  expect(await page.evaluate(() => "__RTC_INSPECTOR__" in window)).toBe(false);

  // What runs on install/update.
  await worker().evaluate(() => (globalThis as unknown as { attachToOpenTabs: () => Promise<void> }).attachToOpenTabs());
  expect(await page.evaluate(() => "__RTC_INSPECTOR__" in window)).toBe(true);

  // No page reload: click Start in the page that was open all along.
  await page.click("#start");
  await expect.poll(() => blue(tabId)).toBe(true);
  expect(await worker().evaluate((t) => chrome.action.getBadgeText({ tabId: t }), tabId)).toBe("2");

  // And the inspector can read that tab's recording.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html?tabId=${tabId}`);
  await expect(popup.getByLabel("Events, use arrow keys to move").getByText("sdp.remote.set").first()).toBeVisible();
});

test("Stop, then Start again: every connection is reachable in the popup, and the badge counts the open ones", async () => {
  const page = await context.newPage();
  await page.goto("http://restart.local/");
  const tabId = await tabIdOf("http://restart.local/");
  const run = (fn: "start" | "stop") => page.evaluate((f) => (window as unknown as Record<string, () => Promise<void>>)[f]!(), fn);
  await run("start");
  await run("stop");
  await run("start");

  // Two open, two closed: the badge shows the live ones.
  const badge = () => worker().evaluate((t) => chrome.action.getBadgeText({ tabId: t }), tabId);
  await expect.poll(badge).toBe("2");
  expect(await worker().evaluate((t) => chrome.action.getTitle({ tabId: t }), tabId)).toBe("RTC Inspector: 2 open connections on this page, 2 closed");
  // Chrome reports the other side's close() as a channel 'error' event; it was recorded...
  const read = await page.evaluate(() => (window as unknown as { __RTC_INSPECTOR_BRIDGE__: { read: () => { events: { type: string }[] } } }).__RTC_INSPECTOR_BRIDGE__.read());
  expect(read.events.map((e) => e.type)).toContain("datachannel.error");

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 800, height: 600 }); // the popup: too narrow for the side rail
  const errors: string[] = [];
  popup.on("pageerror", (e) => errors.push(e.message));
  await popup.goto(`chrome-extension://${id}/popup.html?tabId=${tabId}`);
  await popup.getByRole("tab", { name: "Overview" }).click();

  // ...but it is a normal close, not an error finding.
  await expect(popup.getByRole("tab", { name: "Overview" })).toHaveAccessibleName("Overview");

  // Every connection is listed; the new call is in focus, not the first, closed one.
  const strip = popup.getByRole("navigation", { name: "Connections" });
  await expect(strip.getByRole("button")).toHaveText([/^pc-1\s*closed$/, /^pc-2\s*closed$/, /^pc-3\s*connected$/, /^pc-4\s*connected$/]);
  await expect(strip.getByRole("button", { name: /^pc-3/ })).toHaveAttribute("aria-current", "true");
  await expect(popup.getByRole("region", { name: "Connection pc-3" })).toBeVisible();
  await popup.screenshot({ path: resolve(import.meta.dirname, "../test-results/popup-restart.png") });

  // The other side of this connection, from the header link.
  await popup.getByRole("region", { name: "Connection pc-3" }).getByRole("button", { name: "pc-4" }).click();
  await expect(popup.getByRole("region", { name: "Connection pc-4" })).toBeVisible();

  // A closed connection shows how far it got before Stop: every step done.
  await strip.getByRole("button", { name: /^pc-2/ }).click();
  const closed = popup.getByRole("region", { name: "Connection pc-2" });
  await expect(closed.getByText("closed", { exact: true }).first()).toBeVisible();
  await expect(closed.getByText("Done", { exact: true })).toHaveCount(6);

  // The ICE tab follows the same choice.
  await popup.getByRole("tab", { name: "ICE" }).click();
  await expect(popup.getByRole("combobox", { name: "Connection" })).toHaveValue("pc-2");
  expect(errors).toEqual([]);
});

test("a call through a signaling server: both tabs' ends in one view", async () => {
  const ann = await context.newPage();
  await ann.goto("http://chat.local/");
  const ben = await context.newPage();
  await ben.goto("http://chat.local/");
  await ben.click("#join");
  const got = (page: typeof ann) => page.waitForFunction(() => (window as unknown as { got?: string }).got, undefined, { timeout: 10_000 });
  await Promise.all([got(ann), got(ben)]);
  const benTab = await tabIdOf("http://chat.local/");
  const tabs = await worker().evaluate(async () => (await chrome.tabs.query({ url: "http://chat.local/*" })).map((t) => t.id!).sort((a, b) => a - b));
  expect(tabs).toHaveLength(2);
  const benId = tabs[1]!;
  expect([tabs[0], tabs[1]]).toContain(benTab);

  // Each tab on its own has one connection.
  for (const page of [ann, ben]) expect(await page.evaluate(() => (window as unknown as { __RTC_INSPECTOR__: { getPeers(): unknown[] } }).__RTC_INSPECTOR__.getPeers().length)).toBe(1);

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 800, height: 600 });
  const errors: string[] = [];
  popup.on("pageerror", (e) => errors.push(e.message));
  await popup.goto(`chrome-extension://${id}/popup.html?tabId=${benId}`);

  // Merged by default: both ends, labelled by tab, Ben's (tab 2) first.
  const scope = popup.getByRole("group", { name: "Show recordings from" });
  await expect(scope.getByRole("button", { name: "All 2 tabs" })).toHaveAttribute("aria-pressed", "true");
  const strip = popup.getByRole("navigation", { name: "Connections" });
  await expect(strip.getByRole("button")).toHaveText([/^Tab 1 pc-1\s*connected$/, /^Tab 2 pc-1\s*connected$/]);
  await expect(strip.getByRole("button", { name: /^Tab 2 pc-1/ })).toHaveAttribute("aria-current", "true");
  await popup.getByRole("tab", { name: "Overview" }).click();
  const focus = popup.getByRole("region", { name: "Connection Tab 2 pc-1" });
  await expect(focus.getByRole("button", { name: "Tab 1 pc-1" })).toBeVisible(); // paired across tabs

  // The timeline draws what crossed between the tabs (rows are virtualized, so filter to them).
  await popup.getByRole("tab", { name: "Timeline" }).click();
  const filter = popup.getByRole("searchbox", { name: "Filter events" });
  await filter.fill("sdp.");
  await expect(popup.locator(".seq-flow")).toHaveCount(2); // the offer to tab 2, the answer back
  await popup.screenshot({ path: resolve(import.meta.dirname, "../test-results/popup-tabs.png") });
  await filter.fill("datachannel.message");
  await expect(popup.locator(".seq-flow")).toHaveCount(2); // one message each way
  await filter.fill("");

  // Back to one tab (on the same section), and to all of them again.
  await popup.getByRole("tab", { name: "Overview" }).click();
  await scope.getByRole("button", { name: "Tab 2" }).click();
  await expect(popup.getByRole("tab", { name: "Overview", selected: true })).toBeVisible();
  await expect(popup.getByRole("region", { name: "Connection pc-1" })).toBeVisible();
  await expect(strip).toBeHidden();
  await scope.getByRole("button", { name: "All 2 tabs" }).click();
  await expect(strip.getByRole("button")).toHaveCount(2);
  expect(errors).toEqual([]);
});
