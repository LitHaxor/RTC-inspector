import { describe, expect, it } from "vitest";
import {
  InspectorSession,
  TraceFormatError,
  buildFlows,
  describeEvent,
  diagnose,
  diagnosePeer,
  explainApiError,
  explainCandidateError,
  isRemoteCloseAbort,
  lifecycle,
  parseCandidate,
  parseTrace,
  projectSession,
  stateTone,
  summarizePeer,
  summarizeStats,
  type RTCTraceEvent,
} from "../src";
import { FakeDataChannel, FakePeerConnection, HOST_CANDIDATE, RELAY_CANDIDATE, SRFLX_CANDIDATE, asPc } from "./fakes";

/** Drive two fake peers through a full trickle-ICE negotiation inside one session. */
async function connectedPair(opts: { annotate?: boolean; dropCandidates?: boolean; channelAfterOffer?: boolean } = {}) {
  let t = 1_000;
  const session = new InspectorSession({ statsIntervalMs: 0, now: () => (t += 10) });
  const a = new FakePeerConnection({ iceServers: [{ urls: "stun:stun.example.org" }] });
  const b = new FakePeerConnection({ iceServers: [{ urls: "stun:stun.example.org" }] });
  session.observe(asPc(a), { peerId: "alice", group: "alice" });
  session.observe(asPc(b), { peerId: "bob", group: "bob" });
  const pa = asPc(a);
  const pb = asPc(b);
  const send = (from: string, to: string, kind: string, id: string) => {
    if (!opts.annotate) return;
    session.signaling(from, { direction: "sent", kind, messageId: id, remote: to });
    session.signaling(to, { direction: "received", kind, messageId: id, remote: from });
  };

  const chat = opts.channelAfterOffer ? undefined : (pa.createDataChannel("chat") as unknown as FakeDataChannel);
  const offer = await pa.createOffer();
  const late = opts.channelAfterOffer ? (pa.createDataChannel("chat") as unknown as FakeDataChannel) : undefined;
  await pa.setLocalDescription(offer);
  send("alice", "bob", "offer", "m1");
  await pb.setRemoteDescription(offer);
  const answer = await pb.createAnswer();
  await pb.setLocalDescription(answer);
  send("bob", "alice", "answer", "m2");
  await pa.setRemoteDescription(answer);

  const candidates = [HOST_CANDIDATE, SRFLX_CANDIDATE];
  for (const [i, c] of candidates.entries()) {
    a.gather(c);
    if (!opts.dropCandidates) {
      send("alice", "bob", "candidate", `c${i}`);
      await pb.addIceCandidate({ candidate: c, sdpMid: "0", sdpMLineIndex: 0 });
    }
  }
  b.gather(HOST_CANDIDATE.replace("54321", "54400").replace("842163049", "999"));
  if (!opts.dropCandidates) await pa.addIceCandidate({ candidate: HOST_CANDIDATE.replace("54321", "54400").replace("842163049", "999"), sdpMid: "0" });
  a.finishGathering();
  b.finishGathering();
  return { session, a, b, pa, pb, chat, late, now: () => t };
}

describe("projectSession", () => {
  it("builds per-peer models, pairs peers and matches candidates", async () => {
    const { session, a, b, chat } = await connectedPair();
    a.setIce("checking");
    a.setIce("connected");
    a.setConnection("connected");
    b.setConnection("connected");
    chat!.open(1);
    const remote = b.announceChannel("chat", 1);
    chat!.peer = remote as FakeDataChannel;
    chat!.send("hi bob");
    await new Promise((r) => setTimeout(r, 5));

    const model = projectSession(session.getEvents());
    const alice = model.byId.alice!;
    const bob = model.byId.bob!;
    expect(model.peers.map((p) => p.peerId)).toEqual(["alice", "bob"]);
    expect(model.groups).toEqual(["alice", "bob"]);
    expect(alice).toMatchObject({ role: "offerer", signalingState: "stable", iceConnectionState: "connected", connectionState: "connected", remotePeerId: "bob" });
    expect(bob).toMatchObject({ role: "answerer", remotePeerId: "alice" });
    expect(model.links).toEqual([{ a: "alice", b: "bob", state: "connected" }]);
    expect(alice.localCandidates).toHaveLength(2);
    expect(alice.localCandidates.every((c) => c.matchedPeerId === "bob")).toBe(true);
    expect(bob.remoteCandidates.every((c) => c.matchedPeerId === "alice")).toBe(true);
    expect(alice.history.ice.map((h) => h.state)).toEqual(["checking", "connected"]);
    expect(alice.descriptions.map((d) => `${d.source}:${d.type}`)).toEqual(["created:offer", "local:offer", "remote:answer"]);

    const aliceChat = alice.channels[0]!;
    expect(aliceChat).toMatchObject({ label: "chat", origin: "local", state: "open", id: 1, sent: 1, bytesSent: 6 });
    expect(bob.channels[0]).toMatchObject({ origin: "remote", received: 1, bytesReceived: 6 });
    expect(model.channelsByKey[aliceChat.channelKey]).toBe(aliceChat);
    expect(summarizePeer(alice)).toBe("Connected, 1/1 channel(s) open.");
  });

  it("handles rollback, close and stats samples", () => {
    const ev = (type: string, details: unknown, timestamp: number, peerId = "p"): RTCTraceEvent =>
      ({ id: `${type}-${timestamp}`, seq: timestamp, timestamp, peerId, type, category: "lifecycle", details }) as RTCTraceEvent;
    const model = projectSession(
      [
        ev("sdp.local.set", { type: "offer", sdp: "v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\n", sessionId: "1" }, 1),
        ev("sdp.local.set", { type: "rollback", sdp: "" }, 2),
        ev("stats.sample", { pairs: [], dataChannels: [], media: [], roundTripTimeMs: 12, selectedPair: { id: "x", selected: true } }, 3),
        ev("datachannel.created", { channelKey: "k", label: "c", id: null }, 4),
        ev("peer.closed", {}, 5),
      ],
      { maxStatsPoints: 1 },
    );
    const p = model.byId.p!;
    expect(p.localDescription).toBeUndefined();
    expect(p.statsSeries).toEqual([{ at: 3, rttMs: 12 }]);
    expect(p.selectedPair?.id).toBe("x");
    expect(p.channels[0]).toMatchObject({ state: "closed", closedAt: 5 });
    expect(p.connectionState).toBe("closed");
    expect(summarizePeer(p)).toBe("Closed.");
  });
});

describe("closed connections", () => {
  const sctpError = (message: string) =>
    Object.assign(new Event("error"), { error: Object.assign(new Error(message), { name: "OperationError", errorDetail: "sctp-failure" }) });

  it("shows how far a closed connection got, and a remote close is not an error", async () => {
    const { session, a, b, pa, pb, chat, now } = await connectedPair();
    for (const p of [a, b]) {
      p.setIce("checking");
      p.setIce("connected");
      p.setConnection("connected");
    }
    chat!.open(1);
    // What Chrome fires on a channel when the other side calls close().
    chat!.dispatchEvent(sctpError("User-Initiated Abort, reason=Close called"));
    pb.close();
    pa.close();

    const events = session.getEvents();
    const model = projectSession(events);
    const alice = model.byId.alice!;
    expect(alice.connectionState).toBe("closed");
    expect(alice.beforeClose).toEqual({ signalingState: "stable", iceConnectionState: "connected", connectionState: "connected" });
    const steps = Object.fromEntries(lifecycle(alice, now(), model.byId.bob).map((s) => [s.key, s.status]));
    expect(steps).toEqual({ signaling: "done", gathering: "done", exchange: "done", connectivity: "done", dtls: "done", datachannels: "done" });

    expect(alice.channels[0]!.errors).toEqual([]);
    expect(diagnose(model, now()).filter((f) => f.id.startsWith("dc-error"))).toEqual([]);
    const abort = events.find((e) => e.type === "datachannel.error")!;
    expect(describeEvent(abort)).toMatchObject({ title: "DataChannel closed by the other side", tone: "neutral" });
  });

  it("still reports real channel errors", async () => {
    const { session, now, chat } = await connectedPair();
    chat!.dispatchEvent(sctpError("Message too large"));
    const model = projectSession(session.getEvents());
    expect(model.byId.alice!.channels[0]!.errors).toHaveLength(1);
    expect(diagnose(model, now()).map((f) => f.id)).toContain("dc-error:alice/dc-1");
    expect(isRemoteCloseAbort({ name: "OperationError", message: "Message too large (sctp-failure)" })).toBe(false);
    expect(isRemoteCloseAbort({ name: "OperationError", message: "User-Initiated Abort, reason=Close called (sctp-failure)" })).toBe(true);
  });

  it("keeps a connection closed mid-negotiation in the state it reached", () => {
    const ev = (type: string, details: unknown, timestamp: number): RTCTraceEvent =>
      ({ id: `${type}-${timestamp}`, seq: timestamp, timestamp, peerId: "p", type, category: "lifecycle", details }) as RTCTraceEvent;
    const model = projectSession([
      ev("sdp.local.set", { type: "offer", sdp: "v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\n", sessionId: "1" }, 1),
      ev("signaling.state", { state: "have-local-offer", previous: "stable" }, 2),
      ev("peer.closed", {}, 3),
      ev("peer.closed", {}, 4),
    ]);
    const p = model.byId.p!;
    expect(p.beforeClose?.signalingState).toBe("have-local-offer");
    const signaling = lifecycle(p, 60_000)[0]!;
    // Time stops at close(): not "waiting for 60 s".
    expect(signaling).toMatchObject({ status: "active", detail: "Offer applied locally 2 ms ago. Waiting for the remote answer." });
  });
});

describe("endpoint order and ICE server errors", () => {
  const ev = (type: string, details: unknown, timestamp: number, peerId: string): RTCTraceEvent =>
    ({ id: `${peerId}-${type}-${timestamp}`, seq: timestamp, timestamp, peerId, type, category: "lifecycle", details }) as RTCTraceEvent;

  it("orders endpoints by name, keeping creation order inside one", () => {
    const created = (peerId: string, group: string, t: number) => ev("peer.created", { group, state: {} }, t, peerId);
    const model = projectSession([created("b1", "Tab 2", 1), created("a1", "Tab 10", 2), created("c1", "Tab 1", 3), created("b2", "Tab 2", 4)]);
    expect(model.groups).toEqual(["Tab 1", "Tab 2", "Tab 10"]);
    expect(model.peers.map((p) => p.peerId)).toEqual(["c1", "b1", "b2", "a1"]);
  });

  it("calls a STUN error harmless when server-reflexive candidates came anyway", () => {
    const error = ev("ice.candidate.error", { url: "stun:stun2.example.org:19302", errorCode: 701, errorText: "STUN host lookup received error." }, 2, "p");
    const gathered = (candidate: string, t: number) => ev("ice.candidate.discovered", { candidate, sdpMid: "0", parsed: parseCandidate(candidate) }, t, "p");
    const severity = (events: RTCTraceEvent[]) => diagnose(projectSession(events), 10).find((f) => f.id.startsWith("ice-server-error"))?.severity;
    expect(severity([gathered(HOST_CANDIDATE, 1), error])).toBe("warning");
    expect(severity([gathered(HOST_CANDIDATE, 1), gathered(SRFLX_CANDIDATE, 3), error])).toBe("info");
  });
});

describe("buildFlows", () => {
  it("infers SDP, candidate and message flows between paired peers", async () => {
    const { session, chat, b } = await connectedPair();
    chat!.open(1);
    const remote = b.announceChannel("chat", 1);
    chat!.peer = remote as FakeDataChannel;
    chat!.send("one");
    chat!.send("two");
    await new Promise((r) => setTimeout(r, 5));
    const events = session.getEvents();
    const flows = buildFlows(events, projectSession(events));
    const kinds = flows.map((f) => `${f.kind}:${f.label}:${f.fromPeerId}>${f.toPeerId}`).sort();
    expect(kinds).toEqual(
      [
        "candidate:candidate:alice>bob",
        "candidate:candidate:alice>bob",
        "candidate:candidate:bob>alice",
        "message:chat:alice>bob",
        "message:chat:alice>bob",
        "sdp:answer:bob>alice",
        "sdp:offer:alice>bob",
      ].sort(),
    );
    expect(flows.every((f) => f.inferred && f.latencyMs > 0)).toBe(true);
  });

  it("prefers explicit signaling annotations over inferred flows", async () => {
    const { session } = await connectedPair({ annotate: true });
    const events = session.getEvents();
    const flows = buildFlows(events, projectSession(events));
    expect(flows.filter((f) => f.kind === "signaling").map((f) => f.label).sort()).toEqual(["answer", "candidate", "candidate", "offer"]);
    expect(flows.filter((f) => f.kind === "sdp")).toHaveLength(0);
    // bob's candidate was not annotated, so it is still inferred
    expect(flows.filter((f) => f.kind === "candidate").map((f) => f.fromPeerId)).toEqual(["bob"]);
  });
});

describe("diagnostics", () => {
  it("explains ICE failure after successful negotiation", async () => {
    const { session, a, now } = await connectedPair();
    a.setIce("checking");
    a.setIce("failed");
    a.setConnection("failed");
    const findings = diagnose(projectSession(session.getEvents()), now());
    const f = findings.find((x) => x.id === "ice-failed")!;
    expect(f.peerId).toBe("alice");
    expect(f.severity).toBe("error");
    expect(f.explanation).toMatch(/SDP negotiation completed successfully.*ICE connectivity checks failed/);
    expect(f.suggestions[0]).toMatch(/Neither side has a relay candidate/);
    expect(f.evidence).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    const steps = lifecycle(projectSession(session.getEvents()).byId.alice!, now());
    expect(steps.find((s) => s.key === "connectivity")?.status).toBe("failed");
    expect(steps.find((s) => s.key === "signaling")?.status).toBe("done");
  });

  it("detects candidates that were never exchanged", async () => {
    const { session, a, now } = await connectedPair({ dropCandidates: true });
    a.setIce("checking");
    const model = projectSession(session.getEvents());
    const later = now() + 10_000;
    const ids = diagnosePeer(model.byId.bob!, later).map((f) => f.id);
    expect(ids).toContain("no-remote-candidates");
    const steps = lifecycle(model.byId.bob!, later);
    expect(steps.find((s) => s.key === "exchange")).toMatchObject({ status: "warning" });
    a.setIce("failed");
    const failed = diagnosePeer(projectSession(session.getEvents()).byId.alice!, later);
    expect(failed.find((f) => f.id === "no-remote-candidates")?.severity).toBe("error");
    expect(failed.some((f) => f.id === "ice-failed")).toBe(false);
  });

  it("does not blame candidate exchange when ICE connected through a peer-reflexive pair", async () => {
    const { session, a, now } = await connectedPair({ dropCandidates: true });
    a.setIce("checking");
    a.setIce("connected");
    const alice = projectSession(session.getEvents()).byId.alice!;
    expect(diagnosePeer(alice, now() + 10_000).map((f) => f.id)).not.toContain("no-remote-candidates");
    expect(lifecycle(alice, now() + 10_000).find((s) => s.key === "exchange")).toMatchObject({ status: "done", detail: expect.stringMatching(/peer-reflexive/) });
  });

  it("blames the real root cause instead of candidate forwarding", async () => {
    // A candidate rejected because it arrived before the remote description:
    const session = new InspectorSession({ statsIntervalMs: 0 });
    const a = new FakePeerConnection();
    session.observe(asPc(a), { peerId: "a" });
    await asPc(a).addIceCandidate({ candidate: HOST_CANDIDATE }).catch(() => {});
    await asPc(a).setRemoteDescription(await new FakePeerConnection().createOffer());
    const peer = projectSession(session.getEvents()).byId.a!;
    const later = Date.now() + 10_000;
    expect(diagnosePeer(peer, later).map((f) => f.id)).not.toContain("no-remote-candidates");
    expect(lifecycle(peer, later).find((s) => s.key === "exchange")).toMatchObject({ status: "failed", detail: expect.stringMatching(/rejected/) });

    // A remote that gathered nothing (e.g. relay-only without TURN):
    const silent = { ...peer, apiErrors: [], label: "a" };
    const remote = { ...peer, peerId: "r", label: "remote", iceGatheringState: "complete", localCandidates: [] };
    expect(diagnosePeer(silent, later, { remote }).map((f) => f.id)).not.toContain("no-remote-candidates");
    expect(lifecycle(silent, later, remote).find((s) => s.key === "exchange")?.detail).toMatch(/remote gathered no candidates/);
    expect(diagnosePeer(silent, later).map((f) => f.id)).toContain("no-remote-candidates");
  });

  it("detects a missing answer and an unanswered offer", async () => {
    let t = 0;
    const session = new InspectorSession({ statsIntervalMs: 0, now: () => (t += 1) });
    const a = new FakePeerConnection();
    const b = new FakePeerConnection();
    session.observe(asPc(a), { peerId: "a" });
    session.observe(asPc(b), { peerId: "b" });
    const offer = await asPc(a).createOffer();
    await asPc(a).setLocalDescription(offer);
    await asPc(b).setRemoteDescription(offer);
    const model = projectSession(session.getEvents());
    expect(diagnosePeer(model.byId.a!, t + 6000).map((f) => f.id)).toContain("answer-missing");
    expect(diagnosePeer(model.byId.b!, t + 6000).map((f) => f.id)).toContain("answer-not-created");
    expect(diagnosePeer(model.byId.a!, t + 100).map((f) => f.id)).not.toContain("answer-missing");
    expect(lifecycle(model.byId.a!, t + 6000)[0]).toMatchObject({ status: "warning" });
    expect(lifecycle(model.byId.b!, t + 100)[0]).toMatchObject({ status: "active" });
    expect(summarizePeer(model.byId.a!)).toMatch(/waiting for the answer/);
    expect(summarizePeer(model.byId.b!)).toMatch(/answer pending/);
  });

  it("detects a DataChannel created after the offer without renegotiation", async () => {
    const { session, a, b, now } = await connectedPair({ channelAfterOffer: true });
    a.setConnection("connected");
    b.setConnection("connected");
    const model = projectSession(session.getEvents());
    const finding = diagnosePeer(model.byId.alice!, now() + 6000).find((f) => f.id.startsWith("dc-after-offer"));
    expect(finding?.title).toBe('DataChannel "chat" was created after negotiation');
    const step = lifecycle(model.byId.alice!, now() + 6000).find((s) => s.key === "datachannels");
    expect(step?.status).toBe("failed");
  });

  it("detects send() before open and addIceCandidate before remote description", async () => {
    const session = new InspectorSession({ statsIntervalMs: 0 });
    const a = new FakePeerConnection();
    session.observe(asPc(a), { peerId: "a" });
    const ch = asPc(a).createDataChannel("early");
    expect(() => ch.send("x")).toThrow();
    await asPc(a).addIceCandidate({ candidate: HOST_CANDIDATE }).catch(() => {});
    await asPc(a).addIceCandidate({ candidate: SRFLX_CANDIDATE }).catch(() => {});
    const findings = diagnosePeer(projectSession(session.getEvents()).byId.a!, Date.now());
    expect(findings.map((f) => f.title)).toEqual(expect.arrayContaining(['send() failed on "early"', "addIceCandidate() failed (2×)"]));
    expect(findings.find((f) => f.id.startsWith("api-error"))?.suggestions[0]).toMatch(/Buffer incoming candidates/);
  });

  it("covers gathering problems: relay-only, host-only, server errors, slow gathering", () => {
    const base = (peerId: string, config: object): RTCTraceEvent[] => [
      { id: `${peerId}1`, seq: 1, timestamp: 0, peerId, type: "peer.created", category: "lifecycle", details: { state: { signalingState: "stable", iceGatheringState: "new", iceConnectionState: "new", connectionState: "new" }, configuration: config } },
      { id: `${peerId}2`, seq: 2, timestamp: 1, peerId, type: "ice.gathering.state", category: "ice", details: { state: "gathering", previous: "new" } },
    ] as RTCTraceEvent[];
    const complete = (peerId: string): RTCTraceEvent => ({ id: `${peerId}9`, seq: 9, timestamp: 5, peerId, type: "ice.gathering.state", category: "ice", details: { state: "complete", previous: "gathering" } }) as RTCTraceEvent;
    const host = (peerId: string): RTCTraceEvent => ({ id: `${peerId}3`, seq: 3, timestamp: 2, peerId, type: "ice.candidate.discovered", category: "ice", details: { candidate: HOST_CANDIDATE, sdpMid: "0", sdpMLineIndex: 0, parsed: { type: "host" } } }) as RTCTraceEvent;
    const err = (peerId: string, code: number, url: string): RTCTraceEvent => ({ id: `${peerId}e${code}`, seq: 4, timestamp: 3, peerId, type: "ice.candidate.error", category: "ice", details: { errorCode: code, errorText: "x", url } }) as RTCTraceEvent;

    const events = [
      ...base("relay", { iceServers: [], iceTransportPolicy: "relay" }), complete("relay"),
      ...base("nostun", { iceServers: [] }), host("nostun"), complete("nostun"),
      ...base("badstun", { iceServers: [{ urls: ["stun:x"], hasCredential: false }, { urls: ["turn:y"], hasCredential: true }] }), host("badstun"), err("badstun", 701, "stun:x"), err("badstun", 401, "turn:y"), complete("badstun"),
      ...base("slow", { iceServers: [] }),
    ];
    const model = projectSession(events);
    const ids = (p: string) => diagnosePeer(model.byId[p]!, 20_000).map((f) => `${f.id}:${f.severity}`);
    expect(ids("relay")).toContain("no-local-candidates:error");
    expect(diagnosePeer(model.byId.relay!, 0)[0]!.suggestions[0]).toMatch(/Add a TURN server/);
    expect(ids("nostun")).toContain("host-only:info");
    const connected = { ...model.byId.nostun!, connectionState: "connected" };
    expect(diagnosePeer(connected, 20_000).map((f) => f.id)).not.toContain("host-only");
    expect(ids("badstun")).toEqual(expect.arrayContaining(["host-only:warning", "ice-server-error:stun:x|701:warning", "ice-server-error:turn:y|401:warning"]));
    expect(ids("slow")).toContain("gathering-slow:info");
    expect(lifecycle(model.byId.relay!, 20_000).find((s) => s.key === "gathering")?.status).toBe("failed");
    expect(lifecycle(model.byId.badstun!, 20_000).find((s) => s.key === "gathering")?.status).toBe("warning");
    expect(lifecycle(model.byId.slow!, 20_000).find((s) => s.key === "gathering")?.status).toBe("warning");
  });

  it("reports quality issues, relayed traffic and disconnections", () => {
    const events = [
      { id: "1", seq: 1, timestamp: 0, peerId: "p", type: "connection.state", category: "connection", details: { state: "connected" } },
      { id: "2", seq: 2, timestamp: 1, peerId: "p", type: "ice.connection.state", category: "ice", details: { state: "disconnected" } },
      {
        id: "3", seq: 3, timestamp: 2, peerId: "p", type: "stats.sample", category: "stats",
        details: { pairs: [], dataChannels: [], media: [], roundTripTimeMs: 450, packetLossPercent: 9, selectedPair: { id: "x", selected: true, local: { id: "l", candidateType: "relay" }, remote: { id: "r", candidateType: "host" } } },
      },
    ] as RTCTraceEvent[];
    const ids = diagnosePeer(projectSession(events).byId.p!, 10).map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(["relayed", "high-rtt", "packet-loss", "ice-disconnected"]));
  });
});

describe("describeEvent", () => {
  it("produces a title, summary and explanation for every captured event", async () => {
    const { session, a, chat } = await connectedPair({ annotate: true });
    a.setIce("checking");
    a.setConnection("connected");
    a.candidateError(701, "stun:x");
    chat!.open();
    chat!.send("hello");
    asPc(a).restartIce();
    asPc(a).close();
    session.annotate("alice", "custom marker");
    for (const e of session.getAllEvents()) {
      const d = describeEvent(e);
      expect(d.title, e.type).toBeTruthy();
      expect(typeof d.explain).toBe("string");
    }
    const msg = session.getEvents().find((e) => e.type === "datachannel.message")!;
    expect(describeEvent(msg)).toMatchObject({ title: "Message sent", summary: '"chat", 5 B, hello' });
    expect(stateTone("failed")).toBe("error");
    expect(stateTone(undefined)).toBe("neutral");
  });

  it("explains ICE server error codes and API errors", () => {
    expect(explainCandidateError(701)).toMatch(/could not be reached/);
    expect(explainCandidateError(401)).toMatch(/authentication/);
    expect(explainCandidateError(500)).toMatch(/error response/);
    expect(explainCandidateError(0)).toMatch(/ICE agent/);
    expect(explainApiError("setRemoteDescription", "InvalidStateError", "")).toMatch(/signaling state/);
    expect(explainApiError("setLocalDescription", "InvalidModificationError", "")).toMatch(/modified/);
    expect(explainApiError("setRemoteDescription", "OperationError", "")).toMatch(/malformed/);
    expect(explainApiError("createOffer", "Error", "")).toMatch(/rejected/);
  });
});

describe("summarizeStats", () => {
  const report = new Map<string, Record<string, unknown>>([
    ["T", { id: "T", type: "transport", selectedCandidatePairId: "CP", bytesSent: 10_000, bytesReceived: 20_000, dtlsState: "connected" }],
    ["CP", { id: "CP", type: "candidate-pair", state: "succeeded", nominated: true, localCandidateId: "L", remoteCandidateId: "R", currentRoundTripTime: 0.05, availableOutgoingBitrate: 300_000, requestsSent: 4, responsesReceived: 4 }],
    ["CP2", { id: "CP2", type: "candidate-pair", state: "failed", localCandidateId: "L", remoteCandidateId: "R2" }],
    ["L", { id: "L", type: "local-candidate", candidateType: "srflx", address: "203.0.113.7", port: 1000, protocol: "udp", networkType: "wifi" }],
    ["R", { id: "R", type: "remote-candidate", candidateType: "relay", ip: "198.51.100.1", port: 2000, protocol: "udp", relayProtocol: "udp" }],
    ["D", { id: "D", type: "data-channel", label: "chat", dataChannelIdentifier: 1, state: "open", messagesSent: 3, messagesReceived: 2, bytesSent: 30, bytesReceived: 20 }],
    ["IA", { id: "IA", type: "inbound-rtp", kind: "audio", packetsReceived: 90, packetsLost: 10, bytesReceived: 9000, jitter: 0.004 }],
    ["OV", { id: "OV", type: "outbound-rtp", kind: "video", packetsSent: 100, bytesSent: 50000 }],
    ["RI", { id: "RI", type: "remote-inbound-rtp", localId: "OV", fractionLost: 0.02 }],
  ]);

  it("summarises the selected pair, rates, loss, channels and media", () => {
    const { sample, cursor } = summarizeStats(report, { timestamp: 0, bytesSent: 0, bytesReceived: 10_000 }, { redact: true, timestamp: 1000 });
    expect(sample.selectedPair).toMatchObject({ id: "CP", selected: true, currentRoundTripTimeMs: 50, requestsSent: 4 });
    expect(sample.selectedPair?.local).toMatchObject({ candidateType: "srflx", address: "203.x.x.x", networkType: "wifi" });
    expect(sample.selectedPair?.remote).toMatchObject({ candidateType: "relay", address: "198.x.x.x", relayProtocol: "udp" });
    expect(sample.pairs).toHaveLength(2);
    expect(sample.pairs[1]).toMatchObject({ state: "failed", selected: false });
    expect(sample).toMatchObject({ roundTripTimeMs: 50, availableOutgoingBitrate: 300_000, sendBitrate: 80_000, receiveBitrate: 80_000, packetLossPercent: 10, dtlsState: "connected" });
    expect(sample.dataChannels).toEqual([{ label: "chat", id: 1, state: "open", messagesSent: 3, messagesReceived: 2, bytesSent: 30, bytesReceived: 20 }]);
    expect(sample.media).toEqual([
      { kind: "audio", direction: "inbound", bytes: 9000, packets: 90, packetsLost: 10, jitterMs: 4 },
      { kind: "video", direction: "outbound", bytes: 50000, packets: 100, fractionLost: 0.02 },
    ]);
    expect(cursor).toEqual({ timestamp: 1000, bytesSent: 10_000, bytesReceived: 20_000 });
  });

  it("falls back to Firefox-style selection and works without a previous sample", () => {
    const ff = [
      { id: "P", type: "candidate-pair", selected: true, state: "succeeded", bytesSent: 5, bytesReceived: 6, localCandidateId: "L" },
      { id: "L", type: "local-candidate", candidateType: "host", address: "10.0.0.1" },
    ];
    const { sample } = summarizeStats(ff, undefined, { redact: false, timestamp: 1 });
    expect(sample.selectedPair?.id).toBe("P");
    expect(sample.selectedPair?.local?.address).toBe("10.0.0.1");
    expect(sample.bytesSent).toBe(5);
    expect(sample.sendBitrate).toBeUndefined();
    const nominated = summarizeStats([{ id: "N", type: "candidate-pair", nominated: true, state: "succeeded" }], undefined, { redact: true, timestamp: 1 });
    expect(nominated.sample.selectedPair?.id).toBe("N");
  });
});

describe("trace files", () => {
  it("round-trips through JSON", async () => {
    const { session } = await connectedPair();
    const trace = parseTrace(JSON.stringify(session.exportTrace()));
    expect(trace.events).toHaveLength(session.getAllEvents().length);
    expect(projectSession(trace.events).links).toHaveLength(1);
  });

  it("accepts bare event arrays and skips unknown event types", () => {
    const trace = parseTrace([
      { type: "annotation", peerId: "p", timestamp: 2, details: { label: "b" } },
      { type: "future.event", peerId: "p", timestamp: 1 },
      { type: "annotation", peerId: "p", timestamp: 1, details: { label: "a" } },
    ]);
    expect(trace.events.map((e) => (e.details as { label: string }).label)).toEqual(["a", "b"]);
    expect(trace.events[0]).toMatchObject({ category: "annotation", id: "imported-2" });
  });

  it.each([
    ["{", /Not valid JSON/],
    ["42", /must be a JSON object/],
    [JSON.stringify({ format: "other" }), /Unknown format/],
    [JSON.stringify({ format: "rtc-inspector-trace", version: 99, events: [] }), /Unsupported trace version/],
    [JSON.stringify({ format: "rtc-inspector-trace", version: 1 }), /no events array/],
    [JSON.stringify({ format: "rtc-inspector-trace", version: 1, events: [{ type: "x" }] }), /missing type, peerId or timestamp/],
  ])("rejects %s", (input, message) => {
    expect(() => parseTrace(input)).toThrow(TraceFormatError);
    expect(() => parseTrace(input)).toThrow(message);
  });
});

describe("relay candidates", () => {
  it("parses relay candidates from a gathered event into the model", () => {
    const session = new InspectorSession({ statsIntervalMs: 0 });
    const a = new FakePeerConnection();
    session.observe(asPc(a), { peerId: "a" });
    a.gather(RELAY_CANDIDATE);
    const model = projectSession(session.getEvents());
    expect(model.byId.a!.localCandidates[0]!.parsed).toMatchObject({ type: "relay", address: "198.x.x.x" });
  });
});
