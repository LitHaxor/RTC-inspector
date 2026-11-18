import { afterEach, describe, expect, it, vi } from "vitest";
import { InspectorSession, type AnyTraceEvent, type RTCEventType, type RTCTraceEvent } from "../src";
import { FakeDataChannel, FakePeerConnection, HOST_CANDIDATE, SRFLX_CANDIDATE, asPc, makeSdp } from "./fakes";

function setup(options: ConstructorParameters<typeof InspectorSession>[0] = {}, config: RTCConfiguration = {}) {
  const session = new InspectorSession({ statsIntervalMs: 0, ...options });
  const fake = new FakePeerConnection(config);
  const handle = session.observe(asPc(fake), { peerId: "alice", label: "Alice", group: "alice" });
  const ofType = <T extends RTCEventType>(type: T) =>
    session.getEvents().filter((e): e is RTCTraceEvent<T> => e.type === type) as RTCTraceEvent<T>[];
  return { session, fake, handle, ofType, pc: asPc(fake) };
}

afterEach(() => vi.useRealTimers());

describe("observePeerConnection: lifecycle", () => {
  it("records creation with a redacted configuration snapshot", () => {
    const { ofType } = setup({}, {
      iceServers: [{ urls: "stun:stun.example.org" }, { urls: ["turn:turn.example.org"], username: "u", credential: "secret" }],
      iceTransportPolicy: "relay",
    });
    const [created] = ofType("peer.created");
    expect(created!.details).toMatchObject({
      label: "Alice",
      group: "alice",
      state: { signalingState: "stable", iceGatheringState: "new", iceConnectionState: "new", connectionState: "new" },
      configuration: {
        iceTransportPolicy: "relay",
        iceServers: [
          { urls: ["stun:stun.example.org"], hasCredential: false },
          { urls: ["turn:turn.example.org"], username: "u", hasCredential: true },
        ],
      },
    });
    expect(JSON.stringify(created)).not.toContain("secret");
    expect(created!.details.attachedLate).toBeUndefined();
  });

  it("records state transitions with the previous state", async () => {
    const { fake, ofType } = setup();
    fake.setIce("checking");
    fake.setIce("connected");
    fake.setConnection("connecting");
    fake.setConnection("connected");
    expect(ofType("ice.connection.state").map((e) => e.details)).toEqual([
      { state: "checking", previous: "new" },
      { state: "connected", previous: "checking" },
    ]);
    expect(ofType("connection.state").map((e) => e.details.state)).toEqual(["connecting", "connected"]);
  });

  it("snapshots existing descriptions when attaching late", async () => {
    const fake = new FakePeerConnection();
    await fake.setLocalDescription(await fake.createOffer());
    const session = new InspectorSession({ statsIntervalMs: 0 });
    session.observe(asPc(fake));
    const types = session.getEvents().map((e) => e.type);
    expect(types).toEqual(["peer.created", "sdp.local.set"]);
    expect((session.getEvents()[0] as RTCTraceEvent<"peer.created">).details.attachedLate).toBe(true);
  });

  it("lists a connection in getPeers() already when its peer.created event fires", () => {
    const session = new InspectorSession({ statsIntervalMs: 0 });
    const counts: number[] = [];
    session.subscribe((e) => {
      if (e.type === "peer.created") counts.push(session.getPeers().length);
    });
    session.observe(asPc(new FakePeerConnection()));
    session.observe(asPc(new FakePeerConnection()));
    expect(counts).toEqual([1, 2]);
  });

  it("records close() since browsers fire no event for it", () => {
    const { pc, ofType } = setup();
    pc.close();
    pc.close();
    expect(ofType("peer.closed")).toHaveLength(1);
  });

  it("assigns stable ids, unique peer ids and returns the same handle twice", () => {
    const session = new InspectorSession({ statsIntervalMs: 0 });
    const fake = new FakePeerConnection();
    const a = session.observe(asPc(fake), { peerId: "x" });
    expect(session.observe(asPc(fake))).toBe(a);
    const b = session.observe(asPc(new FakePeerConnection()), { peerId: "x" });
    expect(b.peerId).not.toBe("x");
    const c = session.observe(asPc(new FakePeerConnection()));
    expect(c.peerId).toMatch(/^pc-\d+$/);
    const seqs = session.getEvents().map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((p, q) => p - q));
    expect(new Set(session.getEvents().map((e) => e.id)).size).toBe(seqs.length);
  });
});

describe("observePeerConnection: signaling methods", () => {
  it("records offer creation and local description with correlation id and duration", async () => {
    const { pc, ofType } = setup();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const [created] = ofType("offer.created");
    const [local] = ofType("sdp.local.set");
    expect(created!.details.type).toBe("offer");
    expect(created!.details.durationMs).toBeGreaterThanOrEqual(0);
    expect(local!.details).toMatchObject({ type: "offer", sessionVersion: "2" });
    expect(local!.correlationId).toBe(`sdp:${local!.details.sessionId}:2:offer`);
    expect(local!.details.sdp).toContain("a=ice-pwd:[redacted]");
    expect(ofType("signaling.state")[0]!.details).toEqual({ state: "have-local-offer", previous: "stable" });
  });

  it("returns exactly what the original method returns", async () => {
    const fake = new FakePeerConnection();
    const offer = { type: "offer" as const, sdp: makeSdp() };
    fake.createOffer = async () => offer;
    const session = new InspectorSession({ statsIntervalMs: 0 });
    session.observe(asPc(fake));
    expect(await asPc(fake).createOffer()).toBe(offer);
    expect(await asPc(fake).setLocalDescription(offer)).toBeUndefined();
    expect(asPc(fake).createDataChannel("x")).toBe(fake.channels[0]);
  });

  it("supports implicit setLocalDescription() and answers", async () => {
    const offerer = setup();
    const answerer = setup();
    await offerer.pc.setLocalDescription();
    await answerer.pc.setRemoteDescription(offerer.fake.localDescription!);
    await answerer.pc.setLocalDescription();
    await offerer.pc.setRemoteDescription(answerer.fake.localDescription!);
    expect(answerer.ofType("sdp.remote.set")[0]!.correlationId).toBe(offerer.ofType("sdp.local.set")[0]!.correlationId);
    expect(answerer.ofType("sdp.local.set")[0]!.details.type).toBe("answer");
    expect(offerer.ofType("sdp.remote.set")[0]!.details.type).toBe("answer");
  });

  it("propagates rejections unchanged and records api.error", async () => {
    const { pc, ofType } = setup();
    await expect(pc.addIceCandidate({ candidate: HOST_CANDIDATE, sdpMid: "0" })).rejects.toMatchObject({ name: "InvalidStateError" });
    await expect(pc.setRemoteDescription({ type: "answer", sdp: "v=0" })).rejects.toThrow(/wrong state/);
    const errors = ofType("api.error");
    expect(errors.map((e) => e.details.method)).toEqual(["addIceCandidate", "setRemoteDescription"]);
    expect(errors[0]!.details.error).toEqual({ name: "InvalidStateError", message: "The remote description was null" });
    expect(JSON.stringify(errors[0]!.details.args)).toContain("192.168.x.x");
    expect(errors[1]!.details.args).toEqual({ type: "answer" });
  });

  it("supports the legacy callback signatures", async () => {
    type Cb = (v?: unknown) => void;
    const fake = new FakePeerConnection();
    // Emulate the browser's legacy overloads: callbacks in, Promise<void> out.
    const legacy = (modern: (...a: unknown[]) => Promise<unknown>, cbIndex: number) =>
      (...args: unknown[]) => {
        const success = args[cbIndex];
        if (typeof success !== "function") return modern(...args);
        modern(...args.slice(0, cbIndex)).then(success as Cb, args[cbIndex + 1] as Cb);
        return Promise.resolve();
      };
    fake.createOffer = legacy(fake.createOffer.bind(fake), 0) as typeof fake.createOffer;
    fake.addIceCandidate = legacy(fake.addIceCandidate.bind(fake) as (...a: unknown[]) => Promise<unknown>, 1) as typeof fake.addIceCandidate;
    const session = new InspectorSession({ statsIntervalMs: 0 });
    session.observe(asPc(fake));
    const pc = fake as unknown as { createOffer: (s: Cb, f: Cb) => Promise<void>; addIceCandidate: (c: unknown, s: Cb, f: Cb) => Promise<void> };

    const result = await new Promise<RTCSessionDescriptionInit>((resolve, reject) => void pc.createOffer(resolve as Cb, reject));
    expect(result.type).toBe("offer");
    const failure = await new Promise((resolve) => void pc.addIceCandidate({ candidate: HOST_CANDIDATE }, () => resolve("ok"), resolve));
    expect((failure as Error).name).toBe("InvalidStateError");
    const types = session.getEvents().map((e) => e.type);
    expect(types).toContain("offer.created");
    expect(types).toContain("api.error");
  });

  it("rethrows synchronous throws from wrapped methods and records them", () => {
    const fake = new FakePeerConnection();
    fake.createOffer = () => {
      throw new TypeError("boom");
    };
    const session = new InspectorSession({ statsIntervalMs: 0 });
    session.observe(asPc(fake));
    expect(() => asPc(fake).createOffer()).toThrow("boom");
    const error = session.getEvents().find((e) => e.type === "api.error") as RTCTraceEvent<"api.error">;
    expect(error.details).toMatchObject({ method: "createOffer", error: { name: "TypeError", message: "boom" } });
  });

  it("records restartIce, negotiationneeded, addTrack and remote tracks", () => {
    const { pc, fake, ofType } = setup();
    pc.restartIce();
    fake.dispatchEvent(new Event("negotiationneeded"));
    // FakePeerConnection has no addTrack; use one that does
    const s2 = new InspectorSession({ statsIntervalMs: 0 });
    const f2 = Object.assign(new FakePeerConnection(), { addTrack: () => ({ sender: true }) });
    s2.observe(asPc(f2));
    expect((f2 as unknown as RTCPeerConnection).addTrack({ kind: "audio", id: "t1" } as MediaStreamTrack, { id: "s1" } as MediaStream)).toEqual({ sender: true });
    f2.dispatchEvent(Object.assign(new Event("track"), { track: { kind: "video", id: "t2" }, streams: [{ id: "s2" }], transceiver: { mid: "1" } }));
    expect(ofType("ice.restart")).toHaveLength(1);
    expect(ofType("negotiation.needed")).toHaveLength(1);
    const s2Events = s2.getEvents() as AnyTraceEvent[];
    expect(s2Events.find((e) => e.type === "track.added")?.details).toEqual({ kind: "audio", trackId: "t1", streamIds: ["s1"] });
    expect(s2Events.find((e) => e.type === "track.received")?.details).toEqual({ kind: "video", trackId: "t2", streamIds: ["s2"], mid: "1" });
  });
});

describe("observePeerConnection: ICE", () => {
  it("records discovered candidates (redacted, parsed, correlated) and keeps app handlers working", () => {
    const { fake, ofType } = setup();
    const appHandler = vi.fn();
    fake.onicecandidate = appHandler;
    fake.gather(SRFLX_CANDIDATE);
    fake.finishGathering();
    expect(appHandler).toHaveBeenCalledTimes(1);
    const [cand] = ofType("ice.candidate.discovered");
    expect(ofType("ice.candidate.discovered")).toHaveLength(1); // null candidate is not an event
    expect(cand!.details.candidate).not.toContain("203.0.113.7");
    expect(cand!.details.parsed).toMatchObject({ type: "srflx", address: "203.x.x.x", relatedAddress: "192.168.x.x", port: 61000 });
    expect(cand!.correlationId).toMatch(/^cand:/);
    expect(ofType("ice.gathering.state").map((e) => e.details.state)).toEqual(["complete"]);
  });

  it("keeps raw addresses when redaction is off", () => {
    const { fake, ofType } = setup({ redact: false });
    fake.gather(SRFLX_CANDIDATE);
    expect(ofType("ice.candidate.discovered")[0]!.details.parsed?.address).toBe("203.0.113.7");
  });

  it("records added remote candidates, including end-of-candidates", async () => {
    const { pc, fake, ofType } = setup();
    const remote = new FakePeerConnection();
    await pc.setRemoteDescription(await remote.createOffer());
    await pc.addIceCandidate({ candidate: HOST_CANDIDATE, sdpMid: "0", sdpMLineIndex: 0 });
    await pc.addIceCandidate(null);
    const added = ofType("ice.candidate.added");
    expect(added[0]!.details).toMatchObject({ sdpMid: "0", parsed: { type: "host", address: "192.168.x.x" } });
    expect(added[1]!.details.endOfCandidates).toBe(true);
    expect(fake.addedCandidates).toHaveLength(2);
  });

  it("records ICE server errors", () => {
    const { fake, ofType } = setup();
    fake.candidateError(701, "stun:stun.invalid:3478");
    expect(ofType("ice.candidate.error")[0]!.details).toEqual({
      errorCode: 701,
      errorText: "STUN host lookup received error.",
      url: "stun:stun.invalid:3478",
      address: "192.168.x.x",
      port: 50000,
    });
  });
});

describe("observePeerConnection: data channels", () => {
  it("tracks local channel lifecycle and outgoing messages", () => {
    const { pc, ofType } = setup();
    const channel = pc.createDataChannel("chat", { ordered: false, maxRetransmits: 3 }) as unknown as FakeDataChannel;
    const appOpen = vi.fn();
    channel.onopen = appOpen;
    channel.open(1);
    channel.send("hello");
    channel.send(new Uint8Array([1, 2, 255]));
    channel.close();
    expect(appOpen).toHaveBeenCalled();
    expect(ofType("datachannel.created")[0]!.details).toMatchObject({ label: "chat", ordered: false, maxRetransmits: 3, id: null });
    expect(ofType("datachannel.open")[0]!.details).toMatchObject({ id: 1, readyState: "open" });
    const msgs = ofType("datachannel.message");
    expect(msgs.map((m) => m.details)).toEqual([
      expect.objectContaining({ direction: "outgoing", dataType: "string", size: 5, seq: 1, preview: "hello", channelId: 1 }),
      expect.objectContaining({ direction: "outgoing", dataType: "binary", size: 3, seq: 2, preview: "01 02 ff" }),
    ]);
    expect(ofType("datachannel.close")).toHaveLength(1);
    const key = ofType("datachannel.created")[0]!.details.channelKey;
    expect(msgs.every((m) => m.details.channelKey === key)).toBe(true);
  });

  it("records send() before open as an error and still throws", () => {
    const { pc, ofType } = setup();
    const channel = pc.createDataChannel("early");
    expect(() => channel.send("too soon")).toThrow(/not 'open'/);
    expect(ofType("datachannel.error")[0]!.details).toMatchObject({ operation: "send", error: { name: "InvalidStateError" } });
    expect(ofType("datachannel.message")).toHaveLength(0);
  });

  it("tracks remote channels and incoming messages with multi-byte sizes", () => {
    const { fake, ofType } = setup();
    const channel = fake.announceChannel("chat", 3);
    channel.receive("héllo ✓");
    channel.receive(new ArrayBuffer(10));
    channel.dispatchEvent(Object.assign(new Event("error"), { error: { name: "OperationError", message: "SCTP failure", errorDetail: "sctp-failure" } }));
    expect(ofType("datachannel.received")[0]!.details).toMatchObject({ label: "chat", id: 3 });
    const msgs = ofType("datachannel.message");
    expect(msgs[0]!.details).toMatchObject({ direction: "incoming", size: 10, seq: 1 });
    expect(msgs[1]!.details).toMatchObject({ dataType: "binary", size: 10, seq: 2 });
    expect(ofType("datachannel.error")[0]!.details.error).toEqual({ name: "OperationError", message: "SCTP failure (sctp-failure)" });
  });

  it("can skip payload previews or messages entirely", () => {
    const a = setup({ payload: "none" });
    const ch = a.pc.createDataChannel("x") as unknown as FakeDataChannel;
    ch.open();
    ch.send("secret");
    expect(a.ofType("datachannel.message")[0]!.details.preview).toBeUndefined();

    const b = setup({ captureMessages: false });
    const ch2 = b.pc.createDataChannel("x") as unknown as FakeDataChannel;
    ch2.open();
    ch2.send("x");
    ch2.receive("y");
    expect(b.ofType("datachannel.message")).toHaveLength(0);
  });

  it("truncates long previews", () => {
    const { pc, ofType } = setup({ previewLength: 4 });
    const ch = pc.createDataChannel("x") as unknown as FakeDataChannel;
    ch.open();
    ch.send("abcdefgh");
    ch.send(new Uint8Array(20));
    expect(ofType("datachannel.message").map((m) => m.details.preview)).toEqual(["abcd…", `${Array(16).fill("00").join(" ")} …`]);
  });
});

describe("dispose and safety", () => {
  it("restores every wrapped method and stops recording", () => {
    const { pc, fake, handle, session } = setup();
    expect(Object.prototype.hasOwnProperty.call(fake, "createOffer")).toBe(true);
    handle.dispose();
    for (const m of ["createOffer", "createAnswer", "setLocalDescription", "setRemoteDescription", "addIceCandidate", "createDataChannel", "close"]) {
      expect(Object.prototype.hasOwnProperty.call(fake, m)).toBe(false);
    }
    const before = session.getEvents().length;
    fake.setIce("checking");
    pc.close();
    expect(session.getEvents()).toHaveLength(before);
    expect(session.getPeers()).toHaveLength(0);
  });

  it("restores a pre-existing own property on dispose", () => {
    const fake = new FakePeerConnection();
    const own = async () => ({ type: "offer" as const, sdp: "custom" });
    fake.createOffer = own;
    const session = new InspectorSession({ statsIntervalMs: 0 });
    session.observe(asPc(fake)).dispose();
    expect(fake.createOffer).toBe(own);
  });

  it("never lets a throwing subscriber break the application", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { session, pc } = setup();
    session.subscribe(() => {
      throw new Error("subscriber bug");
    });
    const offer = await pc.createOffer();
    expect(offer.type).toBe("offer");
    warn.mockRestore();
  });
});

describe("InspectorSession", () => {
  it("replays history to late subscribers and stores stats separately", () => {
    const session = new InspectorSession({ statsIntervalMs: 0 });
    session.annotate("a", "joined room", { room: 1 });
    session.record("a", "stats.sample", { pairs: [], dataChannels: [], media: [] });
    const seen: string[] = [];
    session.subscribe((e) => seen.push(e.type), { replay: true });
    session.signaling("a", { direction: "sent", kind: "offer", messageId: "m1", remote: "b" });
    expect(seen).toEqual(["annotation", "stats.sample", "signaling.message"]);
    expect(session.getEvents().map((e) => e.type)).toEqual(["annotation", "signaling.message"]);
    expect(session.getStatsSamples()).toHaveLength(1);
    expect(session.getEvents()[1]!.correlationId).toBe("sig:m1");
    expect(session.getSnapshot().stats).toHaveLength(1);
  });

  it("evicts old events beyond maxEvents and counts them", () => {
    const session = new InspectorSession({ maxEvents: 10, maxStatsSamples: 5 });
    for (let i = 0; i < 25; i++) session.annotate("a", `e${i}`);
    for (let i = 0; i < 12; i++) session.record("a", "stats.sample", { pairs: [], dataChannels: [], media: [] });
    expect(session.getEvents().length).toBeLessThanOrEqual(10);
    expect(session.droppedEvents).toBeGreaterThan(0);
    expect(session.getStatsSamples().length).toBeLessThanOrEqual(5);
    session.clear();
    expect(session.getAllEvents()).toHaveLength(0);
  });

  it("ingests foreign events, exports a trace and disposes peers", () => {
    const session = new InspectorSession({ statsIntervalMs: 0 });
    session.ingest({ id: "x", seq: 50, timestamp: 1, peerId: "remote", type: "annotation", category: "annotation", details: { label: "hi" } });
    const evt = session.annotate("local", "after");
    expect(evt.seq).toBe(51);
    session.observe(asPc(new FakePeerConnection()));
    const trace = session.exportTrace({ userAgent: "test" });
    expect(trace).toMatchObject({ format: "rtc-inspector-trace", version: 1, redacted: true, userAgent: "test" });
    expect(trace.events[0]!.id).toBe("x");
    session.dispose();
    expect(session.getPeers()).toHaveLength(0);
  });

  it("polls stats and emits pair selection changes", async () => {
    vi.useFakeTimers();
    const session = new InspectorSession({ statsIntervalMs: 100 });
    const fake = new FakePeerConnection();
    session.observe(asPc(fake), { peerId: "p" });
    fake.statsReport = new Map([
      ["T", { id: "T", type: "transport", selectedCandidatePairId: "CP1", bytesSent: 100, bytesReceived: 50, dtlsState: "connected" }],
      ["CP1", { id: "CP1", type: "candidate-pair", state: "succeeded", nominated: true, localCandidateId: "L", remoteCandidateId: "R", currentRoundTripTime: 0.012 }],
      ["L", { id: "L", type: "local-candidate", candidateType: "host", address: "192.168.1.2", port: 1, protocol: "udp" }],
      ["R", { id: "R", type: "remote-candidate", candidateType: "srflx", address: "203.0.113.9", port: 2, protocol: "udp" }],
    ]);
    await vi.advanceTimersByTimeAsync(150); // still "new": skipped
    expect(session.getStatsSamples()).toHaveLength(0);
    fake.setIce("connected");
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(session.getStatsSamples().length).toBeGreaterThanOrEqual(2);
    const selected = session.getEvents().filter((e) => e.type === "ice.pair.selected") as RTCTraceEvent<"ice.pair.selected">[];
    expect(selected).toHaveLength(1);
    expect(selected[0]!.details.pair.remote?.address).toBe("203.x.x.x");
    (fake.statsReport.get("T") as Record<string, unknown>).selectedCandidatePairId = "CP2";
    fake.statsReport.set("CP2", { id: "CP2", type: "candidate-pair", state: "succeeded", localCandidateId: "L", remoteCandidateId: "R" });
    await vi.advanceTimersByTimeAsync(100);
    const changed = session.getEvents().filter((e) => e.type === "ice.pair.selected") as RTCTraceEvent<"ice.pair.selected">[];
    expect(changed[1]!.details.previousPairId).toBe("CP1");
    (asPc(fake)).close();
    const count = session.getStatsSamples().length;
    await vi.advanceTimersByTimeAsync(500);
    expect(session.getStatsSamples()).toHaveLength(count);
  });
});
