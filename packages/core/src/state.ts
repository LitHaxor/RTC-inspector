/**
 * Session state over time: a readable snapshot of every connection at a
 * point in the event stream, and a diff between two snapshots. The snapshot
 * after an event is the state that event produced.
 */

import { describeCandidate } from "./ice-parser";
import { projectSession, type DescriptionRecord, type PeerModel, type SessionModel } from "./projection";
import { cachedParseSdp, sectionTitle } from "./sdp-parser";
import type { RTCTraceEvent } from "./types";

export type StateValue = string | number | boolean | null | StateValue[] | { [key: string]: StateValue };

function description(d: DescriptionRecord | undefined): StateValue {
  if (!d) return null;
  const parsed = cachedParseSdp(d.sdp);
  return {
    type: d.type,
    version: d.sessionVersion ?? null,
    sections: parsed.media.map((m) => `${sectionTitle(m)}${m.direction ? ` ${m.direction}` : ""}${m.rejected ? " (rejected)" : ""}`),
    candidatesInSdp: parsed.media.reduce((n, m) => n + m.candidates.length, 0),
  };
}

function peerState(p: PeerModel, model: SessionModel): { [key: string]: StateValue } {
  const remote = p.remotePeerId ? model.byId[p.remotePeerId] : undefined;
  const channels: { [key: string]: StateValue } = {};
  for (const c of p.channels) {
    const key = p.channels.filter((x) => x.label === c.label).length > 1 ? `${c.label}#${c.id ?? "?"}` : c.label;
    channels[key] = { state: c.state, id: c.id, sent: c.sent, received: c.received, bytesSent: c.bytesSent, bytesReceived: c.bytesReceived, errors: c.errors.length };
  }
  const pair = p.selectedPair;
  const rtt = p.lastStats?.roundTripTimeMs;
  return {
    signalingState: p.signalingState,
    iceGatheringState: p.iceGatheringState,
    iceConnectionState: p.iceConnectionState,
    connectionState: p.connectionState,
    role: p.role ?? null,
    remotePeer: remote?.label ?? null,
    localDescription: description(p.localDescription),
    remoteDescription: description(p.remoteDescription),
    candidates: {
      local: p.localCandidates.map((c) => (c.parsed ? describeCandidate(c.parsed) : c.candidate)),
      remote: p.remoteCandidates.filter((c) => !c.endOfCandidates).map((c) => (c.parsed ? describeCandidate(c.parsed) : c.candidate)),
    },
    selectedPair: pair ? `${pair.local?.candidateType ?? "?"} ↔ ${pair.remote?.candidateType ?? "?"}${pair.local?.protocol ? ` ${pair.local.protocol}` : ""}` : null,
    roundTripMs: rtt === undefined ? null : Math.round(rtt * 10) / 10,
    channels,
    errors: [
      ...p.apiErrors.map((e) => `${e.method}(): ${e.error.name}`),
      ...p.candidateErrors.map((e) => `ICE server ${e.errorCode}${e.url ? ` (${e.url})` : ""}`),
      ...p.channels.flatMap((c) => c.errors.map((e) => `"${c.label}" ${e.operation ?? "error"}: ${e.error.name}`)),
    ],
    closed: p.closedAt !== undefined,
  };
}

/** The state of every connection, keyed by its label (made unique when needed). */
export function sessionState(model: SessionModel): { [peer: string]: StateValue } {
  const state: { [peer: string]: StateValue } = {};
  for (const p of model.peers) {
    const duplicate = model.peers.some((o) => o !== p && o.label === p.label);
    state[duplicate ? `${p.label} (${p.peerId})` : p.label] = peerState(p, model);
  }
  return state;
}

/** State right after the event with this id (or the whole stream when it is not found). */
export function stateAfter(events: readonly RTCTraceEvent[], eventId: string, stats: readonly RTCTraceEvent[] = []): { [peer: string]: StateValue } {
  return sessionState(projectSession(eventsUpTo(events, eventId, stats)));
}

/** Events up to and including `eventId`, plus stats samples recorded until then. */
export function eventsUpTo(events: readonly RTCTraceEvent[], eventId: string, stats: readonly RTCTraceEvent[] = []): RTCTraceEvent[] {
  const index = events.findIndex((e) => e.id === eventId);
  if (index === -1) return [...events, ...stats];
  const until = events[index]!.timestamp;
  return [...events.slice(0, index + 1), ...stats.filter((s) => s.timestamp <= until)];
}

export interface StateDiffEntry {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: StateValue;
  after?: StateValue;
}

// Display paths: plain keys (including ids like "pc-1") stay unquoted; anything else is bracketed.
const IDENTIFIER = /^[A-Za-z_$][\w$-]*$/;
const join = (path: string, key: string | number) =>
  typeof key === "number" ? `${path}[${key}]` : IDENTIFIER.test(key) ? (path ? `${path}.${key}` : key) : `${path}[${JSON.stringify(key)}]`;

function isObject(v: StateValue | undefined): v is { [key: string]: StateValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Path-level differences between two states, in a stable order. */
export function diffState(before: StateValue | undefined, after: StateValue | undefined, path = ""): StateDiffEntry[] {
  if (before === undefined && after === undefined) return [];
  if (before === undefined) return [{ path, kind: "added", after: after! }];
  if (after === undefined) return [{ path, kind: "removed", before }];
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys.flatMap((k) => diffState(before[k], after[k], join(path, k)));
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const out: StateDiffEntry[] = [];
    const common = Math.min(before.length, after.length);
    for (let i = 0; i < common; i++) out.push(...diffState(before[i], after[i], join(path, i)));
    for (let i = common; i < after.length; i++) out.push({ path: join(path, i), kind: "added", after: after[i]! });
    for (let i = common; i < before.length; i++) out.push({ path: join(path, i), kind: "removed", before: before[i]! });
    return out;
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  return [{ path, kind: "changed", before, after }];
}
