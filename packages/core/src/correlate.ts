/**
 * Flows: pairs of events on two different peers that represent one thing
 * crossing the wire (an offer, a candidate, a DataChannel message…). These
 * become the arrows in the sequence-diagram timeline.
 */

import type { SessionModel } from "./projection";
import type { AnyTraceEvent, RTCTraceEvent } from "./types";

export type FlowKind = "signaling" | "sdp" | "candidate" | "message";

export interface Flow {
  id: string;
  kind: FlowKind;
  label: string;
  fromEventId: string;
  toEventId: string;
  fromPeerId: string;
  toPeerId: string;
  latencyMs: number;
  /** True when inferred from content rather than an explicit app annotation. */
  inferred: boolean;
}

const SEND_TYPES = new Set(["sdp.local.set", "ice.candidate.discovered", "signaling.message"]);
const RECEIVE_TYPES = new Set(["sdp.remote.set", "ice.candidate.added", "signaling.message"]);

export function buildFlows(input: readonly RTCTraceEvent[], model: SessionModel): Flow[] {
  const events = (input as readonly AnyTraceEvent[]).filter((e) => e.type !== "stats.sample");
  const flows: Flow[] = [];
  const groups = new Map<string, AnyTraceEvent[]>();
  for (const e of events) {
    if (!e.correlationId) continue;
    const list = groups.get(e.correlationId);
    if (list) list.push(e);
    else groups.set(e.correlationId, [e]);
  }

  const push = (kind: FlowKind, label: string, from: AnyTraceEvent, to: AnyTraceEvent, inferred: boolean) => {
    flows.push({
      id: `${from.id}>${to.id}`,
      kind,
      label,
      fromEventId: from.id,
      toEventId: to.id,
      fromPeerId: from.peerId,
      toPeerId: to.peerId,
      latencyMs: to.timestamp - from.timestamp,
      inferred,
    });
  };

  // Which peer pairs already have explicit signaling annotations, by kind.
  const annotated = new Set<string>();

  for (const [corr, list] of groups) {
    if (corr.startsWith("sig:")) {
      const sent = list.find((e) => e.type === "signaling.message" && e.details.direction === "sent");
      if (!sent || sent.type !== "signaling.message") continue;
      for (const r of list) {
        if (r.type === "signaling.message" && r.details.direction === "received" && r.peerId !== sent.peerId) {
          push("signaling", sent.details.kind, sent, r, false);
          const kind = sent.details.kind === "ice-candidate" ? "candidate" : sent.details.kind;
          annotated.add(`${sent.peerId}|${r.peerId}|${kind}`);
        }
      }
    }
  }

  for (const [corr, list] of groups) {
    if (corr.startsWith("sig:")) continue;
    const isSdp = corr.startsWith("sdp:");
    const from = list.find((e) => SEND_TYPES.has(e.type) && e.type !== "signaling.message");
    if (!from) continue;
    for (const to of list) {
      if (to.peerId === from.peerId || !RECEIVE_TYPES.has(to.type) || to.type === "signaling.message") continue;
      const kind = isSdp ? (to.type === "sdp.remote.set" ? to.details.type : "sdp") : "candidate";
      if (annotated.has(`${from.peerId}|${to.peerId}|${kind}`)) continue;
      push(isSdp ? "sdp" : "candidate", isSdp ? kind : "candidate", from, to, true);
    }
  }

  // DataChannel messages: nth outgoing on A's channel ↔ nth incoming on B's
  // channel with the same label and stream id, for paired peers.
  const incoming = new Map<string, AnyTraceEvent>();
  for (const e of events) {
    if (e.type === "datachannel.message" && e.details.direction === "incoming") {
      incoming.set(`${e.peerId}|${e.details.label}|${e.details.channelId}|${e.details.seq}`, e);
    }
  }
  for (const e of events) {
    if (e.type !== "datachannel.message" || e.details.direction !== "outgoing") continue;
    const remote = model.byId[e.peerId]?.remotePeerId;
    if (!remote) continue;
    const to = incoming.get(`${remote}|${e.details.label}|${e.details.channelId}|${e.details.seq}`);
    if (to && to.type === "datachannel.message" && to.details.size === e.details.size) {
      push("message", e.details.label, e, to, true);
    }
  }

  return flows.sort((a, b) => a.latencyMs - b.latencyMs);
}
