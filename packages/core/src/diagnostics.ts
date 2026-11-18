/**
 * "Explain this failure": rule-based diagnosis over the projected model.
 *
 * Each rule looks at one peer and returns findings that say what went wrong
 * in plain language, what to check, and which events are the evidence.
 * Rules are independent; add new ones to `RULES`.
 */

import { explainApiError, explainCandidateError } from "./describe";
import { candidateTypeCounts, formatCounts, remoteCandidateCount } from "./lifecycle";
import type { ChannelModel, PeerModel, SessionModel, StateChange } from "./projection";
import { cachedParseSdp, sectionTitle } from "./sdp-parser";

export type Severity = "error" | "warning" | "info";

export interface Finding {
  id: string;
  peerId: string;
  severity: Severity;
  title: string;
  explanation: string;
  suggestions: string[];
  evidence: string[];
}

export type RuleFinding = Omit<Finding, "peerId">;

export interface DiagnosisContext {
  peer: PeerModel;
  /** The peer on the other end, when it is observed in the same session. */
  remote?: PeerModel;
  now: number;
  iceFailed: boolean;
  negotiated: boolean;
  localCounts: Record<string, number>;
  remoteCounts: Record<string, number>;
  remoteCount: number;
  hasStun: boolean;
  hasTurn: boolean;
  relayOnly: boolean;
}

export type DiagnosisRule = (ctx: DiagnosisContext) => RuleFinding[];

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function stateEntered(history: StateChange[], state: string): StateChange | undefined {
  return [...history].reverse().find((h) => h.state === state);
}

function hasApplication(sdp: string | undefined): boolean {
  return !!sdp && cachedParseSdp(sdp).media.some((m) => m.kind === "application" && !m.rejected);
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

// --- Rules -------------------------------------------------------------------

const apiErrors: DiagnosisRule = ({ peer }) =>
  [...groupBy(peer.apiErrors, (e) => `${e.method}|${e.error.name}`)].map(([key, errs]) => {
    const err = errs[0]!;
    const times = errs.length > 1 ? ` (${errs.length}×)` : "";
    return {
      id: `api-error:${key}`,
      severity: "error",
      title: `${err.method}() failed${times}`,
      explanation: `${err.error.name}: ${err.error.message}. ${explainApiError(err.method, err.error.name, err.error.message)}`,
      suggestions:
        err.method === "addIceCandidate"
          ? ["Buffer incoming candidates until setRemoteDescription() resolves, then add them in order."]
          : ["Log the signaling state before each call and make sure offers/answers are applied in order."],
      evidence: errs.map((e) => e.eventId),
    };
  });

const noLocalCandidates: DiagnosisRule = ({ peer, relayOnly, hasTurn }) => {
  if (peer.iceGatheringState !== "complete" || peer.localCandidates.length > 0) return [];
  const gathered = stateEntered(peer.history.gathering, "complete");
  let suggestion = "Check that the browser has a network interface and isn't blocking WebRTC (extensions, enterprise policy).";
  if (relayOnly) {
    suggestion = hasTurn
      ? "Your TURN server did not allocate a relay. Check its URL, port, transport and credentials."
      : "Add a TURN server to iceServers, or remove iceTransportPolicy: 'relay'.";
  }
  return [
    {
      id: "no-local-candidates",
      severity: "error",
      title: relayOnly ? "Relay-only policy, but no relay candidates" : "No local ICE candidates were gathered",
      explanation: relayOnly
        ? "iceTransportPolicy is 'relay', so only TURN candidates are allowed, and none were obtained. Without at least one candidate, this peer cannot be reached."
        : "Gathering completed without producing a single candidate, so the remote peer has no address to reach this peer on.",
      suggestions: [suggestion],
      evidence: gathered ? [gathered.eventId] : [],
    },
  ];
};

const noRemoteCandidates: DiagnosisRule = ({ peer, remote, now, iceFailed, remoteCount }) => {
  if (!peer.remoteDescription || remoteCount > 0) return [];
  if (peer.iceConnectionState === "connected" || peer.iceConnectionState === "completed") return []; // learned prflx
  // Not a forwarding problem when the root cause is elsewhere (and reported by its own rule).
  if (peer.apiErrors.some((e) => e.method === "addIceCandidate")) return [];
  if (remote && remote.iceGatheringState === "complete" && remote.localCandidates.length === 0) return [];
  const waited = now - peer.remoteDescription.at;
  if (!iceFailed && waited <= 3000) return [];
  return [
    {
      id: "no-remote-candidates",
      severity: iceFailed ? "error" : "warning",
      title: "Remote ICE candidates never arrived",
      explanation: `The remote description was applied ${secs(waited)} ago, but it contained no candidates and addIceCandidate() was never called with any. ICE has nothing to check against.`,
      suggestions: [
        "Forward every 'icecandidate' event to the other peer through your signaling channel.",
        "On the receiving side, call pc.addIceCandidate() for each candidate message.",
        "Alternatively, wait for iceGatheringState 'complete' and send pc.localDescription (non-trickle).",
      ],
      evidence: [peer.remoteDescription.eventId],
    },
  ];
};

const iceFailedAfterNegotiation: DiagnosisRule = ({ peer, iceFailed, negotiated, remoteCount, localCounts, remoteCounts }) => {
  if (!iceFailed) return [];
  if (!negotiated) {
    if (peer.remoteDescription && remoteCount === 0) return []; // covered by noRemoteCandidates
    return [
      {
        id: "failed-before-negotiation",
        severity: "error",
        title: "Connection failed before negotiation finished",
        explanation: `The connection failed while signalingState was '${peer.signalingState}'. The offer/answer exchange never completed.`,
        suggestions: ["Check the signaling timeline: was the answer delivered and applied?"],
        evidence: [],
      },
    ];
  }
  if (remoteCount === 0) return [];
  const failedAt = stateEntered(peer.history.ice, "failed") ?? stateEntered(peer.history.connection, "failed");
  const suggestions = [
    "Check STUN/TURN configuration and that the servers are reachable.",
    "Look at the candidate pairs in the ICE tab: which pairs were tried and how did they fail?",
    "Check firewall rules: UDP may be blocked; TURN over TCP/TLS 443 usually gets through.",
  ];
  if (!localCounts.relay && !remoteCounts.relay) {
    suggestions.unshift(
      "Neither side has a relay candidate. Add a TURN server: it is the fallback when direct paths are blocked (symmetric NAT, corporate firewalls).",
    );
  }
  const local = formatCounts(localCounts) || "none";
  const remote = formatCounts(remoteCounts) || "from SDP";
  return [
    {
      id: "ice-failed",
      severity: "error",
      title: "Negotiation succeeded, but no network path was found",
      explanation: `SDP negotiation completed successfully (signalingState: stable), but ICE connectivity checks failed. The peers exchanged session descriptions and candidates (local: ${local}; remote: ${remote}) but could not establish a usable network path.`,
      suggestions,
      evidence: failedAt ? [failedAt.eventId] : [],
    },
  ];
};

const stuckSignaling: DiagnosisRule = ({ peer, now }) => {
  const entered = stateEntered(peer.history.signaling, peer.signalingState);
  if (!entered || now - entered.at <= 5000) return [];
  const ago = secs(now - entered.at);
  if (peer.signalingState === "have-local-offer") {
    return [
      {
        id: "answer-missing",
        severity: "warning",
        title: "The answer never arrived",
        explanation: `This peer applied its offer ${ago} ago and is still in 'have-local-offer'. Either the offer never reached the other side, or its answer never came back.`,
        suggestions: [
          "Verify the offer is delivered by your signaling server and the remote calls setRemoteDescription(offer).",
          "Verify the remote sends back its answer and this side calls setRemoteDescription(answer).",
        ],
        evidence: [entered.eventId],
      },
    ];
  }
  if (peer.signalingState === "have-remote-offer") {
    return [
      {
        id: "answer-not-created",
        severity: "warning",
        title: "Remote offer was never answered",
        explanation: `The remote offer was applied ${ago} ago, but no answer was created and applied.`,
        suggestions: ["After setRemoteDescription(offer), call createAnswer() then setLocalDescription(answer) and send it back."],
        evidence: [entered.eventId],
      },
    ];
  }
  return [];
};

const slowOrInterruptedIce: DiagnosisRule = ({ peer, now, remoteCount }) => {
  const findings: RuleFinding[] = [];
  const checking = peer.iceConnectionState === "checking" ? stateEntered(peer.history.ice, "checking") : undefined;
  if (checking && now - checking.at > 10_000 && remoteCount > 0) {
    findings.push({
      id: "checking-slow",
      severity: "warning",
      title: "Connectivity checks are taking a long time",
      explanation: `ICE has been checking for ${secs(now - checking.at)} without finding a working pair. This usually ends in 'failed'.`,
      suggestions: ["Inspect candidate pair states in the ICE tab.", "Consider adding a TURN server for restrictive networks."],
      evidence: [checking.eventId],
    });
  }
  if (peer.iceConnectionState === "disconnected") {
    const entered = stateEntered(peer.history.ice, "disconnected");
    findings.push({
      id: "ice-disconnected",
      severity: "warning",
      title: "Connection interrupted",
      explanation:
        "Consent checks on the selected candidate pair stopped succeeding. Common causes: network change (Wi-Fi ↔ cellular), sleep, or the remote went away without closing.",
      suggestions: ["Wait a few seconds: 'disconnected' often recovers.", "If it moves to 'failed', call restartIce() and renegotiate."],
      evidence: entered ? [entered.eventId] : [],
    });
  }
  return findings;
};

const slowGathering: DiagnosisRule = ({ peer, now }) => {
  const started = peer.iceGatheringState === "gathering" ? stateEntered(peer.history.gathering, "gathering") : undefined;
  if (!started || now - started.at <= 10_000) return [];
  return [
    {
      id: "gathering-slow",
      severity: "info",
      title: "ICE gathering is slow",
      explanation: `Gathering has been running for ${secs(now - started.at)}. A STUN/TURN server is probably not answering, and the browser is waiting for it to time out.`,
      suggestions: ["Use trickle ICE so connectivity checks can start before gathering completes.", "Remove or fix unreachable ICE server URLs."],
      evidence: [started.eventId],
    },
  ];
};

const iceServerErrors: DiagnosisRule = ({ peer, localCounts }) =>
  [...groupBy(peer.candidateErrors, (e) => `${e.url ?? "?"}|${e.errorCode}`)].map(([key, errs]) => {
    const first = errs[0]!;
    const isTurn = /^turns?:/.test(first.url ?? "");
    // One server (or one network interface, often IPv6) failing is harmless when
    // the same kind of candidate came from elsewhere.
    const covered = ((isTurn ? localCounts.relay : localCounts.srflx) ?? 0) > 0;
    return {
      id: `ice-server-error:${key}`,
      severity: covered ? "info" : "warning",
      title: `ICE server error ${first.errorCode}${first.url ? ` from ${first.url}` : ""}`,
      explanation: `${first.errorText || "Error"}. ${explainCandidateError(first.errorCode)}${
        covered ? ` ${isTurn ? "Relay" : "Server-reflexive"} candidates were still gathered, so this did not cost anything here.` : ""
      }`,
      suggestions: [
        isTurn
          ? "Test the TURN server with the Trickle ICE sample (webrtc.github.io/samples) using the same credentials."
          : "Check the STUN server URL and that outbound UDP to it is allowed.",
      ],
      evidence: errs.map((e) => e.eventId),
    };
  });

const hostOnly: DiagnosisRule = ({ peer, localCounts, relayOnly, hasStun, hasTurn }) => {
  if (peer.iceGatheringState !== "complete" || peer.localCandidates.length === 0) return [];
  if (localCounts.srflx || localCounts.relay || relayOnly) return [];
  const configured = hasStun || hasTurn;
  // Without servers, host-only is expected; only worth saying when the connection is not up.
  if (!configured && peer.connectionState === "connected") return [];
  return [
    {
      id: "host-only",
      severity: configured ? "warning" : "info",
      title: "Only host candidates were gathered",
      explanation: configured
        ? "STUN/TURN servers are configured but produced no server-reflexive or relay candidates, so this peer is only reachable on its local network."
        : "No STUN/TURN servers are configured, so only local-network addresses are offered. Peers on different networks will not be able to connect.",
      suggestions: configured
        ? ["Check that the STUN/TURN servers are reachable from this network."]
        : ["Add a STUN server (and ideally TURN) to iceServers for connections across networks."],
      evidence: peer.localCandidates.slice(0, 1).map((c) => c.eventId),
    },
  ];
};

const rejectedSections: DiagnosisRule = ({ peer }) => {
  const answer = peer.remoteDescription;
  if (!peer.localDescription || !answer || peer.role !== "offerer" || answer.type !== "answer") return [];
  const rejected = cachedParseSdp(answer.sdp).media.filter((m) => m.rejected);
  if (!rejected.length) return [];
  const names = rejected.map((m) => sectionTitle(m) + (m.mid ? ` (mid ${m.mid})` : "")).join(", ");
  return [
    {
      id: "sections-rejected",
      severity: "warning",
      title: `Remote rejected ${rejected.length} media section(s)`,
      explanation: `The answer set port 0 on: ${names}. Nothing will flow on those sections.`,
      suggestions: ["Compare offer vs answer in the Signaling tab to see which side declined and why (codecs, direction)."],
      evidence: [answer.eventId],
    },
  ];
};

function channelCreatedWithoutNegotiation(peer: PeerModel, channel: ChannelModel): boolean {
  if (channel.origin !== "local" || channel.negotiated) return false;
  const localApplied = peer.descriptions.filter((d) => d.source === "local" && d.type !== "rollback");
  const createdAfterOffer = peer.descriptions.some((d) => d.source !== "remote" && d.at <= channel.createdAt);
  return (
    createdAfterOffer &&
    localApplied.length > 0 &&
    !localApplied.some((d) => hasApplication(d.sdp)) &&
    !hasApplication(peer.remoteDescription?.sdp)
  );
}

const channelsNotOpening: DiagnosisRule = ({ peer, now }) => {
  const findings: RuleFinding[] = [];
  const connected = stateEntered(peer.history.connection, "connected");
  for (const channel of peer.channels) {
    if (channel.openedAt !== undefined) continue;
    if (channelCreatedWithoutNegotiation(peer, channel)) {
      findings.push({
        id: `dc-after-offer:${channel.channelKey}`,
        severity: "error",
        title: `DataChannel "${channel.label}" was created after negotiation`,
        explanation:
          "The channel was created after the offer was generated, and the negotiated SDP has no m=application section, so no SCTP transport exists for it. The channel will stay 'connecting' forever unless you renegotiate.",
        suggestions: ["Create the first data channel before calling createOffer(), or", "handle 'negotiationneeded' by creating and sending a new offer."],
        evidence: [channel.createdEventId],
      });
      continue;
    }
    const since = Math.max(channel.createdAt, connected?.at ?? 0);
    if (peer.connectionState === "connected" && now - since > 5000) {
      findings.push({
        id: `dc-not-open:${channel.channelKey}`,
        severity: "warning",
        title: `DataChannel "${channel.label}" never opened`,
        explanation: `The connection has been up for ${secs(now - since)}, but the channel is still '${channel.state}'.`,
        suggestions: channel.negotiated
          ? ["For negotiated: true channels, both sides must call createDataChannel() with the same id."]
          : ["Check that the remote side's SDP includes an m=application section and was answered."],
        evidence: [channel.createdEventId],
      });
    }
  }
  return findings;
};

const channelErrors: DiagnosisRule = ({ peer }) => {
  const findings: RuleFinding[] = [];
  for (const channel of peer.channels) {
    const sendErrors = channel.errors.filter((e) => e.operation === "send");
    const otherErrors = channel.errors.filter((e) => e.operation !== "send");
    if (sendErrors.length) {
      const first = sendErrors[0]!;
      findings.push({
        id: `dc-send-failed:${channel.channelKey}`,
        severity: "error",
        title: `send() failed on "${channel.label}"${sendErrors.length > 1 ? ` (${sendErrors.length}×)` : ""}`,
        explanation: `${first.error.name}: ${first.error.message}. Messages sent before the channel's 'open' event (or after it closed) throw and are lost.`,
        suggestions: ["Wait for channel.onopen (or check channel.readyState === 'open') before calling send()."],
        evidence: sendErrors.map((e) => e.eventId),
      });
    }
    if (otherErrors.length) {
      findings.push({
        id: `dc-error:${channel.channelKey}`,
        severity: "error",
        title: `DataChannel "${channel.label}" reported an error`,
        explanation: `${otherErrors[0]!.error.name}: ${otherErrors[0]!.error.message}`,
        suggestions: ["Check message sizes against the remote max-message-size and the SCTP transport state."],
        evidence: otherErrors.map((e) => e.eventId),
      });
    }
    if (channel.maxBufferedAmount > 1024 * 1024) {
      findings.push({
        id: `dc-backpressure:${channel.channelKey}`,
        severity: "warning",
        title: `"${channel.label}" is buffering a lot of data`,
        explanation: `bufferedAmount reached ${(channel.maxBufferedAmount / 1048576).toFixed(1)} MB. The app is sending faster than the network can deliver; memory grows and latency increases.`,
        suggestions: ["Use bufferedAmountLowThreshold + the 'bufferedamountlow' event to pace sends."],
        evidence: [channel.createdEventId],
      });
    }
  }
  return findings;
};

const connectionQuality: DiagnosisRule = ({ peer }) => {
  if (peer.connectionState !== "connected") return [];
  const findings: RuleFinding[] = [];
  const pair = peer.selectedPair;
  if (pair && (pair.local?.candidateType === "relay" || pair.remote?.candidateType === "relay")) {
    findings.push({
      id: "relayed",
      severity: "info",
      title: "Traffic is relayed through TURN",
      explanation: "The selected candidate pair uses a relay candidate. This works through restrictive networks but adds latency and server bandwidth cost.",
      suggestions: ["Expected behind symmetric NATs/firewalls. If both peers should reach each other directly, check STUN."],
      evidence: [],
    });
  }
  const rtt = peer.lastStats?.roundTripTimeMs;
  if (rtt !== undefined && rtt > 300) {
    findings.push({
      id: "high-rtt",
      severity: "warning",
      title: `High round-trip time (${rtt.toFixed(0)} ms)`,
      explanation: "Latency above ~300 ms is noticeable in calls and interactive apps.",
      suggestions: ["Check whether traffic is relayed via a distant TURN server.", "Check the network path (VPN, congested Wi-Fi)."],
      evidence: [],
    });
  }
  const loss = peer.lastStats?.packetLossPercent;
  if (loss !== undefined && loss > 5) {
    findings.push({
      id: "packet-loss",
      severity: "warning",
      title: `Packet loss ${loss.toFixed(1)}%`,
      explanation: "More than ~5% loss degrades audio/video noticeably.",
      suggestions: ["Check network quality; consider lowering bitrate or enabling FEC/RED."],
      evidence: [],
    });
  }
  return findings;
};

export const RULES: DiagnosisRule[] = [
  apiErrors,
  noLocalCandidates,
  noRemoteCandidates,
  iceFailedAfterNegotiation,
  stuckSignaling,
  slowOrInterruptedIce,
  slowGathering,
  iceServerErrors,
  hostOnly,
  rejectedSections,
  channelsNotOpening,
  channelErrors,
  connectionQuality,
];

export function diagnosisContext(peer: PeerModel, now: number, remote?: PeerModel): DiagnosisContext {
  const servers = peer.configuration?.iceServers ?? [];
  const usesScheme = (re: RegExp) => servers.some((s) => s.urls.some((u) => re.test(u)));
  return {
    peer,
    ...(remote && { remote }),
    now,
    iceFailed: peer.iceConnectionState === "failed" || peer.connectionState === "failed",
    negotiated: !!peer.localDescription && !!peer.remoteDescription && peer.signalingState === "stable",
    localCounts: candidateTypeCounts(peer.localCandidates),
    remoteCounts: candidateTypeCounts(peer.remoteCandidates),
    remoteCount: remoteCandidateCount(peer),
    hasStun: usesScheme(/^stuns?:/),
    hasTurn: usesScheme(/^turns?:/),
    relayOnly: peer.configuration?.iceTransportPolicy === "relay",
  };
}

export interface DiagnoseOptions {
  rules?: DiagnosisRule[];
  remote?: PeerModel;
}

export function diagnosePeer(peer: PeerModel, now: number, options: DiagnoseOptions = {}): Finding[] {
  const ctx = diagnosisContext(peer, now, options.remote);
  return (options.rules ?? RULES).flatMap((rule) => rule(ctx).map((f) => ({ ...f, peerId: peer.peerId })));
}

export function diagnose(model: SessionModel, now: number, rules: DiagnosisRule[] = RULES): Finding[] {
  return model.peers
    .flatMap((p) => {
      const remote = p.remotePeerId ? model.byId[p.remotePeerId] : undefined;
      return diagnosePeer(p, now, { rules, ...(remote && { remote }) });
    })
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** One sentence describing where the peer is right now. */
export function summarizePeer(peer: PeerModel): string {
  if (peer.closedAt !== undefined) return "Closed.";
  if (peer.connectionState === "connected") {
    const pair = peer.selectedPair;
    const open = peer.channels.filter((c) => c.state === "open").length;
    const via = pair ? ` via ${pair.local?.candidateType ?? "?"} ↔ ${pair.remote?.candidateType ?? "?"}` : "";
    const channels = peer.channels.length ? `, ${open}/${peer.channels.length} channel(s) open` : "";
    return `Connected${via}${channels}.`;
  }
  if (peer.connectionState === "failed" || peer.iceConnectionState === "failed") return "Failed. See the diagnosis.";
  if (peer.signalingState === "have-local-offer") return "Offer sent; waiting for the answer.";
  if (peer.signalingState === "have-remote-offer") return "Offer received; answer pending.";
  if (peer.iceConnectionState === "checking") return "Negotiated; running connectivity checks.";
  if (!peer.localDescription && !peer.remoteDescription) return "Created; no negotiation yet.";
  return `Signaling ${peer.signalingState}, ICE ${peer.iceConnectionState}.`;
}
