import { afterEach, describe, expect, it, vi } from "vitest";
import { InspectorSession, buildFlows, projectSession, type RTCTraceEvent } from "@rtc-inspector/core";
import { FakePeerConnection, asPc } from "../../core/test/fakes";
import { BRIDGE_KEY, CLEAR_EXPRESSION, createBridge, exposeBridge, readExpression, type Bridge } from "../src/bridge";
import { PagePoller, type PollStatus } from "../src/panel/poller";
import { chromeTabDirectory, evalReader, originOf, scriptingReader } from "../src/readers";
import { MultiTabSource, namespaceEvent, type TabDirectory } from "../src/panel/tabs";

function pageWith(events = 0) {
  const session = new InspectorSession({ statsIntervalMs: 0 });
  const window: Record<string, unknown> = { location: { href: "https://meet.example/room" } };
  const bridge = exposeBridge(session, window);
  for (let i = 0; i < events; i++) session.annotate("p", `e${i}`);
  return { session, window, bridge };
}

/** Mimics inspectedWindow.eval: runs our known expressions against a fake page, JSON round trip included. */
function evaluator(page: { window: Record<string, unknown> }) {
  return vi.fn(async (expression: string) => {
    const bridge = page.window[BRIDGE_KEY] as Bridge | undefined;
    if (expression === CLEAR_EXPRESSION) {
      bridge?.clear();
      return true;
    }
    const m = /read\((\d+),(\d+)\)/.exec(expression);
    if (!m) throw new Error(`unexpected expression ${expression}`);
    return JSON.parse(JSON.stringify(bridge ? bridge.read(Number(m[1]), Number(m[2])) : null));
  });
}

afterEach(() => vi.useRealTimers());

describe("bridge", () => {
  it("reads events after a cursor, in pages", () => {
    const { bridge, session } = pageWith(5);
    session.record("p", "stats.sample", { pairs: [], dataChannels: [], media: [] });
    const first = bridge.read(0, 4);
    expect(first.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(first).toMatchObject({ more: true, url: "https://meet.example/room", sessionId: session.sessionId, dropped: 0 });
    const rest = bridge.read(4, 4);
    expect(rest.events.map((e) => e.type)).toEqual(["annotation", "stats.sample"]);
    expect(rest.more).toBe(false);
    expect(bridge.read(99).events).toEqual([]);
  });

  it("is non-enumerable on the page and can clear the page session", () => {
    const { window, bridge, session } = pageWith(2);
    expect(Object.keys(window)).not.toContain(BRIDGE_KEY);
    bridge.clear();
    expect(session.getAllEvents()).toHaveLength(0);
  });

  it("records a real observed connection", async () => {
    const session = new InspectorSession({ statsIntervalMs: 0 });
    const bridge = createBridge(session);
    session.observe(asPc(new FakePeerConnection()), { peerId: "pc-1" });
    expect(bridge.read().events[0]).toMatchObject({ type: "peer.created", peerId: "pc-1" });
    expect(bridge.read().url).toBe("");
  });

  it("counts open and closed connections", () => {
    const session = new InspectorSession({ statsIntervalMs: 0 });
    const bridge = createBridge(session);
    expect(bridge.counts()).toEqual({ open: 0, total: 0 });
    const first = new FakePeerConnection();
    session.observe(asPc(first));
    session.observe(asPc(new FakePeerConnection()));
    expect(bridge.counts()).toEqual({ open: 2, total: 2 });
    asPc(first).close();
    expect(bridge.counts()).toEqual({ open: 1, total: 2 });
  });

  it("builds safe expressions", () => {
    expect(readExpression(12.7, 100)).toContain("read(12,100)");
    expect(readExpression(0)).toContain(BRIDGE_KEY);
  });
});

describe("PagePoller", () => {
  it("waits while the page has no inspector, then attaches and streams", async () => {
    const page: { window: Record<string, unknown> } = { window: {} };
    const statuses: PollStatus[] = [];
    const poller = new PagePoller(evalReader(evaluator(page)), (s) => statuses.push(s));
    await poller.poll();
    await poller.poll();
    expect(statuses).toEqual([{ kind: "waiting" }]);

    const loaded = pageWith(3);
    page.window = loaded.window;
    await poller.poll();
    const attached = statuses[1]!;
    expect(attached.kind).toBe("attached");
    if (attached.kind !== "attached") return;
    const source = attached.source;
    const seen: RTCTraceEvent[] = [];
    source.subscribe((e) => seen.push(e));
    expect(source.getSnapshot().events).toHaveLength(3);

    loaded.session.annotate("p", "later");
    loaded.session.record("p", "stats.sample", { pairs: [], dataChannels: [], media: [] });
    await poller.poll();
    expect(seen.map((e) => e.type)).toEqual(["annotation", "stats.sample"]);
    expect(source.getSnapshot()).toMatchObject({ events: { length: 4 }, stats: { length: 1 } });
  });

  it("drains large backlogs across several reads", async () => {
    const page = pageWith(4500);
    const evaluate = evaluator(page);
    let status: PollStatus | undefined;
    const poller = new PagePoller(evalReader(evaluate), (s) => (status = s));
    await poller.poll();
    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(status?.kind === "attached" && status.source.getSnapshot().events.length).toBe(4500);
  });

  it("starts a fresh source when the page reloads", async () => {
    const page = { window: pageWith(3).window };
    const statuses: PollStatus[] = [];
    const poller = new PagePoller(evalReader(evaluator(page)), (s) => statuses.push(s));
    await poller.poll();
    page.window = pageWith(2).window; // reload: new session, seq starts at 1 again
    await poller.poll();
    const [a, b] = statuses;
    expect(a?.kind === "attached" && b?.kind === "attached" && a.source !== b.source).toBe(true);
    expect(b?.kind === "attached" && b.source.getSnapshot().events).toHaveLength(2);
  });

  it("clears the page session from the panel", async () => {
    const page = pageWith(3);
    let status: PollStatus | undefined;
    const poller = new PagePoller(evalReader(evaluator(page)), (s) => (status = s));
    await poller.poll();
    if (status?.kind !== "attached") throw new Error("not attached");
    status.source.clear();
    await Promise.resolve();
    expect(status.source.getSnapshot().events).toHaveLength(0);
    expect(page.session.getAllEvents()).toHaveLength(0);
  });

  it("reports eval errors and keeps polling on a timer until stopped", async () => {
    vi.useFakeTimers();
    const statuses: PollStatus[] = [];
    const evaluate = vi.fn().mockRejectedValueOnce(new Error("Inspected target navigated")).mockResolvedValue(null);
    const poller = new PagePoller(evalReader(evaluate), (s) => statuses.push(s), 100);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses[0]).toEqual({ kind: "error", message: "Inspected target navigated" });
    await vi.advanceTimersByTimeAsync(100);
    expect(statuses[1]).toEqual({ kind: "waiting" });
    poller.stop();
    const calls = evaluate.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(evaluate.mock.calls.length).toBe(calls);
  });
});

describe("scriptingReader", () => {
  it("reads and clears the page through chrome.scripting in the MAIN world", async () => {
    const page = pageWith(3);
    // Simulate executeScript: run the serialised function with `window` = the fake page.
    const executeScript = vi.fn(async ({ func, args, world, target }: { func: (...a: unknown[]) => unknown; args: unknown[]; world: string; target: { tabId: number } }) => {
      expect(world).toBe("MAIN");
      expect(target.tabId).toBe(7);
      const previous = (globalThis as Record<string, unknown>).window;
      (globalThis as Record<string, unknown>).window = page.window;
      try {
        return [{ result: JSON.parse(JSON.stringify(func(...args) ?? null)) }];
      } finally {
        (globalThis as Record<string, unknown>).window = previous;
      }
    });
    const reader = scriptingReader(7, { executeScript } as never);
    const read = await reader.read(1, 10);
    expect(read?.events.map((e) => e.seq)).toEqual([2, 3]);
    await reader.clear();
    expect(page.session.getAllEvents()).toHaveLength(0);

    const empty = scriptingReader(7, { executeScript: vi.fn(async () => [{ result: null }]) } as never);
    expect(await empty.read(0, 10)).toBeNull();
    const none = scriptingReader(7, { executeScript: vi.fn(async () => []) } as never);
    expect(await none.read(0, 10)).toBeNull();
  });
});

describe("badge messages", () => {
  it("accepts only well-formed page messages", async () => {
    const { isPagePeersMessage, badgeText, PAGE_SOURCE } = await import("../src/messages");
    expect(isPagePeersMessage({ source: PAGE_SOURCE, open: 2, total: 4 })).toBe(true);
    expect(isPagePeersMessage({ source: PAGE_SOURCE, open: 0, total: 0 })).toBe(true);
    expect(isPagePeersMessage({ source: PAGE_SOURCE, open: 3, total: 2 })).toBe(false);
    expect(isPagePeersMessage({ source: PAGE_SOURCE, open: -1, total: 2 })).toBe(false);
    expect(isPagePeersMessage({ source: PAGE_SOURCE, open: 1.5, total: 2 })).toBe(false);
    expect(isPagePeersMessage({ source: PAGE_SOURCE, peers: 2 })).toBe(false);
    expect(isPagePeersMessage({ source: "other", open: 2, total: 2 })).toBe(false);
    expect(isPagePeersMessage({ source: PAGE_SOURCE, open: "2", total: 2 })).toBe(false);
    expect(isPagePeersMessage(null)).toBe(false);
    expect([badgeText(0), badgeText(3), badgeText(150)]).toEqual(["", "3", "99+"]);
  });

  it("is blue on WebRTC pages, counts open connections, and is gray elsewhere", async () => {
    const { tabAppearance } = await import("../src/messages");
    expect(tabAppearance({ open: 0, total: 0 })).toEqual({
      active: false,
      icon: { 16: "icons/inactive-16.png", 32: "icons/inactive-32.png", 48: "icons/inactive-48.png", 128: "icons/inactive-128.png" },
      badge: "",
      title: "RTC Inspector: no WebRTC on this page",
    });
    expect(tabAppearance({ open: 1, total: 1 })).toMatchObject({ active: true, badge: "1", title: "RTC Inspector: 1 open connection on this page", icon: { 16: "icons/active-16.png" } });
    expect(tabAppearance({ open: 2, total: 2 }).title).toBe("RTC Inspector: 2 open connections on this page");
    // Stopped and started again: the badge counts the live ones.
    expect(tabAppearance({ open: 2, total: 6 })).toMatchObject({ badge: "2", title: "RTC Inspector: 2 open connections on this page, 4 closed" });
    // Everything closed: still a WebRTC page with a recording, no number.
    expect(tabAppearance({ open: 0, total: 1 })).toMatchObject({ active: true, badge: "", title: "RTC Inspector: 1 connection recorded, all closed" });
  });
});

describe("all tabs of a site", () => {
  /** Two tabs of one site, each with its own recording, in a call through a signaling server. */
  async function twoTabsInACall() {
    const pages = new Map([
      [11, { window: pageWith().window, session: undefined as InspectorSession | undefined }],
      [12, { window: pageWith().window, session: undefined as InspectorSession | undefined }],
    ]);
    const sessions = [...pages.values()].map((page) => {
      const session = new InspectorSession({ statsIntervalMs: 0 });
      exposeBridge(session, page.window);
      page.session = session;
      return session;
    });
    const a = new FakePeerConnection();
    const b = new FakePeerConnection();
    sessions[0]!.observe(asPc(a)); // pc-1 in tab 11
    sessions[1]!.observe(asPc(b)); // pc-1 in tab 12
    const pa = asPc(a);
    const pb = asPc(b);
    pa.createDataChannel("chat");
    const offer = await pa.createOffer();
    await pa.setLocalDescription(offer);
    await pb.setRemoteDescription(offer); // delivered by the signaling server
    await pb.setLocalDescription(await pb.createAnswer());
    await pa.setRemoteDescription(pb.localDescription!);
    const directory: TabDirectory = {
      list: vi.fn(async () => [...pages.keys()]),
      reader: (tabId) => evalReader(evaluator(pages.get(tabId)!)),
    };
    return { pages, sessions, directory };
  }

  it("merges both ends of a call into one view, paired and with arrows between tabs", async () => {
    const { directory, sessions } = await twoTabsInACall();
    const changes = vi.fn();
    const source = new MultiTabSource(directory, "https://meet.example", changes);
    await source.poll();
    expect(directory.list).toHaveBeenCalledWith("https://meet.example");
    expect(changes).toHaveBeenCalledTimes(1);
    expect(source.tabs()).toEqual([
      { tabId: 11, n: 1, recording: true, open: true },
      { tabId: 12, n: 2, recording: true, open: true },
    ]);

    const { events } = source.getSnapshot();
    const model = projectSession(events);
    // Both tabs call their connection pc-1; merged, they stay apart.
    expect(model.peers.map((p) => [p.peerId, p.label, p.group])).toEqual([
      ["tab-1/pc-1", "Tab 1 pc-1", "Tab 1"],
      ["tab-2/pc-1", "Tab 2 pc-1", "Tab 2"],
    ]);
    expect(model.byId["tab-1/pc-1"]!.remotePeerId).toBe("tab-2/pc-1");
    expect(buildFlows(events, model).filter((f) => f.kind === "sdp").map((f) => `${f.fromPeerId} ${f.label} ${f.toPeerId}`)).toEqual(
      expect.arrayContaining(["tab-1/pc-1 offer tab-2/pc-1", "tab-2/pc-1 answer tab-1/pc-1"]),
    );
    expect(Object.keys(model.channelsByKey)).toEqual(["tab-1/pc-1/dc-1"]);

    // Later events stream in, namespaced, in time order.
    const seen: RTCTraceEvent[] = [];
    source.subscribe((e) => seen.push(e));
    sessions[1]!.annotate("pc-1", "from tab 2");
    sessions[0]!.annotate("pc-1", "from tab 1");
    await source.poll();
    expect(seen.map((e) => [e.peerId, (e.details as { label: string }).label])).toEqual([
      ["tab-2/pc-1", "from tab 2"],
      ["tab-1/pc-1", "from tab 1"],
    ]);
    expect(source.getSnapshot().events.slice(-2)).toEqual(seen);
    expect(changes).toHaveBeenCalledTimes(1); // nothing structural changed
  });

  it("starts over when a tab reloads, keeps a closed tab's recording, and clears every tab", async () => {
    const { directory, pages } = await twoTabsInACall();
    const source = new MultiTabSource(directory, "https://meet.example");
    await source.poll();
    expect(source.generation).toBe(0);

    // Tab 12 reloads: a new page session, nothing recorded yet.
    const reloaded = pageWith(1);
    pages.get(12)!.window = reloaded.window;
    await source.poll();
    expect(source.generation).toBe(1);
    const peers = (ids: RTCTraceEvent[]) => [...new Set(ids.map((e) => e.peerId))];
    expect(peers(source.getSnapshot().events)).toEqual(["tab-1/pc-1", "tab-2/p"]);

    // Tab 11 closes: what it recorded stays, and it is no longer read.
    const tab11 = pages.get(11)!;
    pages.delete(11);
    await source.poll();
    expect(source.tabs().map((t) => [t.n, t.open])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(peers(source.getSnapshot().events)).toContain("tab-1/pc-1");

    // A new tab joins with the next number.
    pages.set(5, { window: pageWith(1).window, session: undefined });
    await source.poll();
    expect(source.tabs().find((t) => t.tabId === 5)?.n).toBe(3);

    source.clear();
    expect(source.getSnapshot().events).toEqual([]);
    expect(reloaded.session.getAllEvents()).toEqual([]);
    expect(tab11.session!.getAllEvents()).not.toEqual([]); // a closed tab is not touched...
    expect(source.tabs().find((t) => t.tabId === 11)?.recording).toBe(false); // ...but forgotten
  });

  it("keeps polling on a timer and survives a failing tab list", async () => {
    vi.useFakeTimers();
    const list = vi.fn().mockRejectedValueOnce(new Error("gone")).mockResolvedValue([]);
    const source = new MultiTabSource({ list, reader: () => evalReader(vi.fn()) }, "https://meet.example", undefined, 100);
    source.start();
    await vi.advanceTimersByTimeAsync(250);
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(3);
    source.stop();
    const calls = list.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(list.mock.calls.length).toBe(calls);
  });

  it("namespaces connection and channel ids, and labels connections by tab", () => {
    const base = { id: "x-1", seq: 1, timestamp: 5, category: "lifecycle" } as const;
    const created = namespaceEvent({ ...base, peerId: "pc-1", type: "peer.created", details: { label: "caller", state: {} } } as RTCTraceEvent, 3);
    expect(created).toMatchObject({ id: "x-1", peerId: "tab-3/pc-1", details: { label: "Tab 3 caller", group: "Tab 3" } });
    const channel = namespaceEvent({ ...base, peerId: "pc-1", type: "datachannel.open", details: { channelKey: "pc-1/dc-1", label: "chat", id: 0 } } as RTCTraceEvent, 3);
    expect(channel.details).toMatchObject({ channelKey: "tab-3/pc-1/dc-1", label: "chat" });
    const sdp = namespaceEvent({ ...base, peerId: "pc-1", type: "sdp.local.set", correlationId: "sdp:1:2:offer", details: { type: "offer", sdp: "" } } as RTCTraceEvent, 3);
    expect(sdp.correlationId).toBe("sdp:1:2:offer"); // global on purpose: it pairs the tabs
  });

  it("lists the tabs of one origin through chrome.tabs", async () => {
    const query = vi.fn(async () => [
      { id: 1, url: "http://localhost:5173/room/1", index: 0, windowId: 1 },
      { id: 2, url: "http://localhost:5174/", index: 1, windowId: 1 },
      { id: 3, url: "http://localhost:5173/", index: 2, windowId: 2 },
      { url: "http://localhost:5173/", index: 3, windowId: 2 },
      { id: 4, url: "not a url", index: 4, windowId: 2 },
    ]);
    const directory = chromeTabDirectory({ query } as never, { executeScript: vi.fn() } as never)!;
    expect(await directory.list("http://localhost:5173")).toEqual([1, 3]);
    expect(directory.reader(1)).toHaveProperty("read");
    expect(chromeTabDirectory(undefined, undefined)).toBeUndefined();
    expect([originOf("https://a.example/x?y"), originOf("data:text/plain,hi"), originOf("nope")]).toEqual(["https://a.example", undefined, undefined]);
  });
});
