import { afterEach, describe, expect, it, vi } from "vitest";
import { FakePeerConnection } from "../../core/test/fakes";
import { GLOBAL_KEY, createInspector, getGlobalInspector, installGlobalInspector } from "../src";

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
  delete (globalThis as Record<string, unknown>).RTCPeerConnection;
  vi.restoreAllMocks();
});

describe("patchGlobal", () => {
  it("observes every new connection while keeping instanceof and the constructor name", async () => {
    const target = { RTCPeerConnection: FakePeerConnection as unknown as typeof RTCPeerConnection };
    target.RTCPeerConnection;
    const inspector = createInspector({ statsIntervalMs: 0 });
    const unpatch = inspector.patchGlobal({ target, name: (i) => (i === 1 ? "caller" : { peerId: `callee-${i}`, group: "g" }) });

    const Patched = target.RTCPeerConnection;
    expect(Patched).not.toBe(FakePeerConnection);
    expect(Patched.name).toBe("RTCPeerConnection");
    const pc = new Patched({ iceServers: [] });
    const pc2 = new Patched();
    expect(pc).toBeInstanceOf(FakePeerConnection);
    expect(inspector.getPeers().map((p) => p.peerId)).toEqual(["caller", "callee-2"]);
    expect(inspector.getPeers()[1]!.group).toBe("g");
    await pc.createOffer();
    expect(inspector.getEvents().some((e) => e.type === "offer.created" && e.peerId === "caller")).toBe(true);
    expect(pc2).toBeDefined();

    unpatch();
    expect(target.RTCPeerConnection).toBe(FakePeerConnection);
  });

  it("patches webkitRTCPeerConnection alias and refuses to double patch", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const Ctor = FakePeerConnection as unknown as typeof RTCPeerConnection;
    const target: Record<string, unknown> = { RTCPeerConnection: Ctor, webkitRTCPeerConnection: Ctor };
    const a = createInspector({ statsIntervalMs: 0 });
    const unpatch = a.patchGlobal({ target });
    expect(target.webkitRTCPeerConnection).toBe(target.RTCPeerConnection);
    expect(createInspector().patchGlobal({ target })).toBeTypeOf("function");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/already patched/));
    unpatch();
    expect(target.webkitRTCPeerConnection).toBe(Ctor);
    expect(createInspector().patchGlobal({ target: {} })).toBeTypeOf("function");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not available/));
  });

  it("survives a throwing name callback", () => {
    const target = { RTCPeerConnection: FakePeerConnection as unknown as typeof RTCPeerConnection };
    const inspector = createInspector({ statsIntervalMs: 0 });
    inspector.patchGlobal({
      target,
      name: () => {
        throw new Error("bad namer");
      },
    });
    expect(() => new target.RTCPeerConnection()).not.toThrow();
    expect(inspector.getPeers()).toHaveLength(1);
  });
});

describe("global inspector", () => {
  it("installs once on globalThis and patches the global constructor", () => {
    (globalThis as Record<string, unknown>).RTCPeerConnection = FakePeerConnection;
    expect(getGlobalInspector()).toBeUndefined();
    const a = installGlobalInspector({ statsIntervalMs: 0 });
    expect(installGlobalInspector()).toBe(a);
    expect(getGlobalInspector()).toBe(a);
    new (globalThis as unknown as { RTCPeerConnection: typeof RTCPeerConnection }).RTCPeerConnection();
    expect(a.getPeers()).toHaveLength(1);
  });
});

describe("logToConsole", () => {
  it("prints human-readable lines and skips stats by default", () => {
    const inspector = createInspector({ statsIntervalMs: 0 });
    const logger = { log: vi.fn() };
    const stop = inspector.logToConsole({ logger });
    inspector.annotate("alice", "hello");
    inspector.record("alice", "stats.sample", { pairs: [], dataChannels: [], media: [] });
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.log.mock.calls[0]![0]).toMatch(/\[rtc\] \+\s*\d+\.\d{3}s %calice%c hello/);
    stop();
    inspector.annotate("alice", "ignored");
    expect(logger.log).toHaveBeenCalledTimes(1);
  });
});
