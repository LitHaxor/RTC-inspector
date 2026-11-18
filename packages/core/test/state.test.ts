import { describe, expect, it } from "vitest";
import { InspectorSession, diffState, eventsUpTo, projectSession, sessionState, stateAfter, type RTCTraceEvent } from "../src";
import { FakeDataChannel, FakePeerConnection, HOST_CANDIDATE, asPc } from "./fakes";

async function recorded() {
  let t = 0;
  const session = new InspectorSession({ statsIntervalMs: 0, now: () => (t += 1) });
  const a = new FakePeerConnection();
  const b = new FakePeerConnection();
  session.observe(asPc(a), { peerId: "a", label: "alice" });
  session.observe(asPc(b), { peerId: "b", label: "bob" });
  const ch = asPc(a).createDataChannel("chat") as unknown as FakeDataChannel;
  const offer = await asPc(a).createOffer();
  await asPc(a).setLocalDescription(offer);
  await asPc(b).setRemoteDescription(offer);
  await asPc(b).setLocalDescription(await asPc(b).createAnswer());
  await asPc(a).setRemoteDescription(b.localDescription!);
  a.gather(HOST_CANDIDATE);
  await asPc(b).addIceCandidate({ candidate: HOST_CANDIDATE, sdpMid: "0" });
  ch.open(1);
  ch.send("hi");
  return { session, events: session.getEvents() };
}

const byType = (events: RTCTraceEvent[], type: string, peerId?: string) => events.find((e) => e.type === type && (!peerId || e.peerId === peerId))!;

describe("sessionState", () => {
  it("summarises every connection in a readable shape", async () => {
    const { events } = await recorded();
    const state = sessionState(projectSession(events)) as Record<string, Record<string, unknown>>;
    expect(Object.keys(state)).toEqual(["alice", "bob"]);
    expect(state.alice).toMatchObject({
      signalingState: "stable",
      role: "offerer",
      remotePeer: "bob",
      localDescription: { type: "offer", version: "2", sections: ["Audio sendrecv", "Video sendrecv", "Data channels"], candidatesInSdp: 0 },
      candidates: { local: ["host udp 192.168.x.x:54321"], remote: [] },
      channels: { chat: { state: "open", id: 1, sent: 1, received: 0, bytesSent: 2, errors: 0 } },
      errors: [],
      closed: false,
    });
    expect(state.bob).toMatchObject({ role: "answerer", candidates: { remote: ["host udp 192.168.x.x:54321"] } });
  });

  it("disambiguates duplicate labels and lists errors", async () => {
    const session = new InspectorSession({ statsIntervalMs: 0 });
    const a = new FakePeerConnection();
    session.observe(asPc(a), { peerId: "p1", label: "caller" });
    session.observe(asPc(new FakePeerConnection()), { peerId: "p2", label: "caller" });
    await asPc(a).addIceCandidate({ candidate: HOST_CANDIDATE }).catch(() => {});
    a.candidateError(701, "stun:x");
    expect(() => asPc(a).createDataChannel("early").send("x")).toThrow();
    const state = sessionState(projectSession(session.getEvents())) as Record<string, Record<string, unknown>>;
    expect(Object.keys(state)).toEqual(["caller (p1)", "caller (p2)"]);
    expect(state["caller (p1)"]!.errors).toEqual(["addIceCandidate(): InvalidStateError", "ICE server 701 (stun:x)", '"early" send: InvalidStateError']);
  });
});

describe("stateAfter / eventsUpTo", () => {
  it("time-travels to the state right after an event", async () => {
    const { events } = await recorded();
    const offerApplied = byType(events, "sdp.local.set", "a");
    const before = stateAfter(events, offerApplied.id) as Record<string, Record<string, unknown>>;
    expect(before.alice!.signalingState).toBe("have-local-offer");
    expect(before.bob!.remoteDescription).toBeNull();
    expect(eventsUpTo(events, "missing")).toHaveLength(events.length);
    const stats = [{ ...events[0]!, id: "s", type: "stats.sample", timestamp: offerApplied.timestamp + 1, details: { pairs: [], dataChannels: [], media: [] } } as RTCTraceEvent];
    expect(eventsUpTo(events, offerApplied.id, stats).some((e) => e.id === "s")).toBe(false);
    expect(eventsUpTo(events, events[events.length - 1]!.id, stats).some((e) => e.id === "s")).toBe(true);
  });
});

describe("diffState", () => {
  it("reports what one event changed, as path-level before/after pairs", async () => {
    const { events } = await recorded();
    const i = events.indexOf(byType(events, "sdp.local.set", "a"));
    const diff = diffState(stateAfter(events, events[i - 1]!.id), stateAfter(events, events[i]!.id));
    expect(diff).toContainEqual({ path: "alice.localDescription", kind: "changed", before: null, after: expect.objectContaining({ type: "offer" }) });

    const open = byType(events, "datachannel.open", "a");
    const j = events.indexOf(open);
    expect(diffState(stateAfter(events, events[j - 1]!.id), stateAfter(events, open.id))).toEqual([
      { path: "alice.channels.chat.state", kind: "changed", before: "connecting", after: "open" },
      { path: "alice.channels.chat.id", kind: "changed", before: null, after: 1 },
    ]);

    const gathered = byType(events, "ice.candidate.discovered", "a");
    const k = events.indexOf(gathered);
    expect(diffState(stateAfter(events, events[k - 1]!.id), stateAfter(events, gathered.id))).toEqual([
      { path: "alice.candidates.local[0]", kind: "added", after: "host udp 192.168.x.x:54321" },
    ]);
  });

  it("handles added and removed keys, array shrink, quoting and no-ops", () => {
    expect(diffState({ a: 1 }, { a: 1 })).toEqual([]);
    expect(diffState(undefined, undefined)).toEqual([]);
    expect(diffState({ "alice → bob": { x: [1, 2] } }, { "alice → bob": { x: [1] }, new: true })).toEqual([
      { path: '["alice → bob"].x[1]', kind: "removed", before: 2 },
      { path: "new", kind: "added", after: true },
    ]);
    expect(diffState({ gone: 1 }, {})).toEqual([{ path: "gone", kind: "removed", before: 1 }]);
    expect(diffState({}, { "pc-1": { s: "new" } })).toEqual([{ path: "pc-1", kind: "added", after: { s: "new" } }]);
    expect(diffState({ v: [1] }, { v: "x" })).toEqual([{ path: "v", kind: "changed", before: [1], after: "x" }]);
  });
});
