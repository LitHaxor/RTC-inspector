/**
 * The connection lifecycle as a sequence of steps a newcomer can follow:
 * offer/answer → gathering → candidate exchange → checks → DTLS → channels.
 */

import type { PeerModel } from "./projection";
import { cachedParseSdp } from "./sdp-parser";

export type StepStatus = "pending" | "active" | "done" | "warning" | "failed" | "skipped";

export interface LifecycleStep {
  key: "signaling" | "gathering" | "exchange" | "connectivity" | "dtls" | "datachannels";
  title: string;
  status: StepStatus;
  detail: string;
  at?: number;
}

const secs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

export function candidateTypeCounts(list: { parsed?: { type: string } }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of list) if (c.parsed) counts[c.parsed.type] = (counts[c.parsed.type] ?? 0) + 1;
  return counts;
}

export const formatCounts = (counts: Record<string, number>) =>
  Object.entries(counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");

/** Remote candidates the ICE agent knows about: trickled + embedded in the remote SDP. */
export function remoteCandidateCount(peer: PeerModel): number {
  const inSdp = peer.remoteDescription ? cachedParseSdp(peer.remoteDescription.sdp).media.reduce((n, m) => n + m.candidates.length, 0) : 0;
  return peer.remoteCandidates.filter((c) => !c.endOfCandidates).length + inSdp;
}

export function lifecycle(peer: PeerModel, now: number, remote?: PeerModel): LifecycleStep[] {
  // A closed connection is shown as it was right before close(), so the steps say how far it got.
  if (peer.beforeClose && peer.closedAt !== undefined) {
    now = Math.min(now, peer.closedAt);
    peer = { ...peer, ...peer.beforeClose };
  }
  const steps: LifecycleStep[] = [];
  const sigErrors = peer.apiErrors.filter((e) => /Description|create(Offer|Answer)/.test(e.method));

  // 1. Offer / answer
  {
    const local = peer.localDescription;
    const remote = peer.remoteDescription;
    let status: StepStatus = "pending";
    let detail = "No offer or answer yet.";
    let at: number | undefined;
    if (sigErrors.length) {
      status = "failed";
      const last = sigErrors[sigErrors.length - 1]!;
      detail = `${last.method}() failed: ${last.error.message}`;
      at = last.at;
    } else if (local && remote && peer.signalingState === "stable") {
      status = "done";
      at = Math.max(local.at, remote.at);
      const first = Math.min(local.at, remote.at);
      detail = `${peer.role === "offerer" ? "Sent offer, received answer" : "Received offer, sent answer"} in ${secs(at - first)}.`;
    } else if (peer.signalingState === "have-local-offer") {
      status = now - (local?.at ?? now) > 5000 ? "warning" : "active";
      detail = `Offer applied locally ${secs(now - (local?.at ?? now))} ago. Waiting for the remote answer.`;
      at = local?.at;
    } else if (peer.signalingState === "have-remote-offer") {
      status = now - (remote?.at ?? now) > 5000 ? "warning" : "active";
      detail = "Remote offer applied. Next: createAnswer() and setLocalDescription().";
      at = remote?.at;
    } else if (peer.descriptions.some((d) => d.source === "created")) {
      status = "active";
      detail = "Offer created but not applied yet (setLocalDescription).";
    }
    steps.push({ key: "signaling", title: "Offer / answer", status, detail, ...(at !== undefined && { at }) });
  }

  // 2. ICE gathering
  {
    const counts = candidateTypeCounts(peer.localCandidates);
    const total = peer.localCandidates.length;
    const complete = peer.history.gathering.find((h) => h.state === "complete");
    const started = peer.history.gathering.find((h) => h.state === "gathering");
    let status: StepStatus = "pending";
    let detail = "Starts when a local description is applied.";
    if (peer.iceGatheringState === "gathering") {
      status = started && now - started.at > 10_000 ? "warning" : "active";
      detail = `Gathering… ${total} candidate(s) so far${total ? ` (${formatCounts(counts)})` : ""}.`;
    } else if (complete || peer.iceGatheringState === "complete") {
      status = total === 0 ? "failed" : peer.candidateErrors.length ? "warning" : "done";
      detail =
        total === 0
          ? "Gathering finished with zero candidates."
          : `${total} candidate(s): ${formatCounts(counts)}${started && complete ? ` in ${secs(complete.at - started.at)}` : ""}.`;
      if (peer.candidateErrors.length) detail += ` ${peer.candidateErrors.length} STUN/TURN error(s).`;
    }
    steps.push({ key: "gathering", title: "ICE gathering", status, detail, ...((complete ?? started) && { at: (complete ?? started)!.at }) });
  }

  // 3. Candidate exchange
  {
    const remoteCount = remoteCandidateCount(peer);
    let status: StepStatus = "pending";
    let detail = "Waiting for the remote description.";
    if (peer.remoteDescription) {
      const iceUp = peer.iceConnectionState === "connected" || peer.iceConnectionState === "completed";
      if (remoteCount === 0 && iceUp) {
        status = "done";
        detail = "No remote candidates were added, but ICE learned a peer-reflexive address from the remote's checks and connected.";
      } else if (remoteCount > 0) {
        status = "done";
        detail = `${remoteCount} remote candidate(s) known (${formatCounts(candidateTypeCounts(peer.remoteCandidates)) || "from SDP"}).`;
      } else {
        const waited = now - peer.remoteDescription.at;
        const rejected = peer.apiErrors.filter((e) => e.method === "addIceCandidate").length;
        status = waited > 3000 ? (peer.iceConnectionState === "failed" ? "failed" : "warning") : "active";
        if (rejected) {
          status = "failed";
          detail = `${rejected} remote candidate(s) arrived but addIceCandidate() rejected them.`;
        } else if (remote && remote.iceGatheringState === "complete" && remote.localCandidates.length === 0) {
          status = "failed";
          detail = `${remote.label} gathered no candidates, so there is nothing to exchange.`;
        } else {
          detail = `No remote candidates for ${secs(waited)}. Are 'icecandidate' events forwarded through signaling?`;
        }
      }
    }
    const first = peer.remoteCandidates[0];
    steps.push({ key: "exchange", title: "Candidate exchange", status, detail, ...(first && { at: first.at }) });
  }

  // 4. Connectivity checks
  {
    const s = peer.iceConnectionState;
    const entered = [...peer.history.ice].reverse().find((h) => h.state === s);
    let status: StepStatus = "pending";
    let detail = "ICE checks start once both sides have candidates.";
    if (s === "checking") {
      status = entered && now - entered.at > 10_000 ? "warning" : "active";
      detail = `Checking candidate pairs${entered ? ` for ${secs(now - entered.at)}` : ""}.`;
    } else if (s === "connected" || s === "completed") {
      status = "done";
      const pair = peer.selectedPair;
      detail = pair
        ? `Selected ${pair.local?.candidateType ?? "?"} ↔ ${pair.remote?.candidateType ?? "?"} (${pair.local?.protocol ?? "?"})${pair.currentRoundTripTimeMs !== undefined ? `, RTT ${pair.currentRoundTripTimeMs.toFixed(0)} ms` : ""}.`
        : "A working candidate pair was found.";
    } else if (s === "disconnected") {
      status = "warning";
      detail = "Checks on the selected pair are failing. It may recover.";
    } else if (s === "failed") {
      status = "failed";
      detail = "Every candidate pair failed.";
    } else if (s === "closed") {
      status = "skipped";
      detail = "Closed.";
    }
    steps.push({ key: "connectivity", title: "Connectivity checks", status, detail, ...(entered && { at: entered.at }) });
  }

  // 5. DTLS / connection
  {
    const s = peer.connectionState;
    const entered = [...peer.history.connection].reverse().find((h) => h.state === s);
    const map: Record<string, [StepStatus, string]> = {
      new: ["pending", "Not started."],
      connecting: ["active", "ICE and DTLS handshake in progress."],
      connected: ["done", "Encrypted transport established (ICE + DTLS)."],
      disconnected: ["warning", "Transport lost connectivity."],
      failed: ["failed", "The transport failed."],
      closed: ["skipped", "Closed."],
    };
    const [status, detail] = map[s] ?? ["pending", s];
    steps.push({ key: "dtls", title: "Secure transport", status, detail, ...(entered && { at: entered.at }) });
  }

  // 6. Data channels
  {
    const channels = peer.channels;
    const hasApplication = [peer.localDescription, peer.remoteDescription].some(
      (d) => d && cachedParseSdp(d.sdp).media.some((m) => m.kind === "application" && !m.rejected),
    );
    let status: StepStatus = "skipped";
    let detail = "No data channels.";
    if (channels.length) {
      const open = channels.filter((c) => c.openedAt !== undefined).length;
      const errors = channels.reduce((n, c) => n + c.errors.length, 0);
      if (open === channels.length) {
        status = errors ? "warning" : "done";
        detail = `${open} channel(s) opened: ${channels.map((c) => `"${c.label}"`).join(", ")}.`;
      } else {
        const waiting = channels.filter((c) => c.openedAt === undefined);
        const stuck = peer.connectionState === "connected" && waiting.some((c) => now - c.createdAt > 5000);
        status = stuck ? "failed" : "active";
        detail = `${open}/${channels.length} open. Waiting: ${waiting.map((c) => `"${c.label}"`).join(", ")}.`;
      }
      if (errors) detail += ` ${errors} error(s).`;
    } else if (hasApplication) {
      status = "pending";
      detail = "Negotiated (m=application) but no channel created yet.";
    }
    const firstOpen = channels.find((c) => c.openedAt !== undefined);
    steps.push({ key: "datachannels", title: "Data channels", status, detail, ...(firstOpen && { at: firstOpen.openedAt! }) });
  }

  return steps;
}
