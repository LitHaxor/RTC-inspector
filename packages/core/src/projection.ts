/**
 * Projection: fold the event stream into a model of each peer connection.
 * Pure and deterministic, so it works identically for live sessions and for
 * imported trace files.
 */

import type { ParsedCandidate } from "./ice-parser";
import {
  isRemoteCloseAbort,
  type AnyTraceEvent,
  type ErrorInfo,
  type PeerConfigurationSnapshot,
  type RTCTraceEvent,
  type StatsCandidatePair,
  type StatsSampleDetails,
} from "./types";

export interface StateChange {
  state: string;
  previous?: string;
  at: number;
  eventId: string;
}

export interface DescriptionRecord {
  eventId: string;
  at: number;
  source: "created" | "local" | "remote";
  type: string;
  sdp: string;
  sessionId?: string;
  sessionVersion?: string;
  durationMs?: number;
}

export interface CandidateRecord {
  eventId: string;
  at: number;
  side: "local" | "remote";
  candidate: string;
  parsed?: ParsedCandidate;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  correlationId?: string;
  endOfCandidates?: boolean;
  /** Seen on the other end (added by the remote peer / discovered by it). */
  matchedPeerId?: string;
}

export interface ChannelErrorRecord {
  at: number;
  eventId: string;
  error: ErrorInfo;
  operation?: string;
}

export interface ChannelModel {
  channelKey: string;
  peerId: string;
  label: string;
  id: number | null;
  origin: "local" | "remote";
  protocol?: string;
  ordered?: boolean;
  maxRetransmits?: number | null;
  maxPacketLifeTime?: number | null;
  negotiated?: boolean;
  state: string;
  createdAt: number;
  createdEventId: string;
  openedAt?: number;
  closedAt?: number;
  sent: number;
  received: number;
  bytesSent: number;
  bytesReceived: number;
  maxBufferedAmount: number;
  errors: ChannelErrorRecord[];
}

export interface StatsPoint {
  at: number;
  rttMs?: number;
  sendBitrate?: number;
  receiveBitrate?: number;
  availableOutgoingBitrate?: number;
  packetLossPercent?: number;
}

export interface PeerModel {
  peerId: string;
  label: string;
  group?: string;
  createdAt: number;
  closedAt?: number;
  /** The states right before close(), which overwrites them all with "closed". */
  beforeClose?: { signalingState: string; iceConnectionState: string; connectionState: string };
  attachedLate: boolean;
  configuration?: PeerConfigurationSnapshot;
  signalingState: string;
  iceGatheringState: string;
  iceConnectionState: string;
  connectionState: string;
  history: {
    signaling: StateChange[];
    gathering: StateChange[];
    ice: StateChange[];
    connection: StateChange[];
  };
  descriptions: DescriptionRecord[];
  localDescription?: DescriptionRecord;
  remoteDescription?: DescriptionRecord;
  role?: "offerer" | "answerer";
  localSessionId?: string;
  remoteSessionId?: string;
  /** Peer in this session on the other end of the connection, if observed. */
  remotePeerId?: string;
  localCandidates: CandidateRecord[];
  remoteCandidates: CandidateRecord[];
  candidateErrors: (RTCTraceEvent<"ice.candidate.error">["details"] & { at: number; eventId: string })[];
  channels: ChannelModel[];
  apiErrors: { at: number; eventId: string; method: string; error: ErrorInfo; args?: unknown }[];
  negotiationNeeded: number[];
  iceRestarts: number[];
  selectedPair?: StatsCandidatePair;
  selectedPairAt?: number;
  lastStats?: StatsSampleDetails;
  lastStatsAt?: number;
  statsSeries: StatsPoint[];
  tracks: { side: "local" | "remote"; kind: string; trackId: string; at: number }[];
  eventCount: number;
  lastEventAt: number;
}

export interface PeerLink {
  a: string;
  b: string;
  /** Worst of the two sides' connection states. */
  state: string;
}

export interface SessionModel {
  startedAt: number;
  endedAt: number;
  peers: PeerModel[];
  byId: Record<string, PeerModel>;
  links: PeerLink[];
  groups: string[];
  channelsByKey: Record<string, ChannelModel>;
}

function newPeer(peerId: string, at: number): PeerModel {
  return {
    peerId,
    label: peerId,
    createdAt: at,
    attachedLate: false,
    signalingState: "stable",
    iceGatheringState: "new",
    iceConnectionState: "new",
    connectionState: "new",
    history: { signaling: [], gathering: [], ice: [], connection: [] },
    descriptions: [],
    localCandidates: [],
    remoteCandidates: [],
    candidateErrors: [],
    channels: [],
    apiErrors: [],
    negotiationNeeded: [],
    iceRestarts: [],
    statsSeries: [],
    tracks: [],
    eventCount: 0,
    lastEventAt: at,
  };
}

const STATE_RANK: Record<string, number> = {
  failed: 6,
  disconnected: 5,
  closed: 4,
  new: 3,
  connecting: 2,
  checking: 2,
  connected: 1,
  completed: 1,
};

const byName = new Intl.Collator("en", { numeric: true }).compare;

export function projectSession(input: readonly RTCTraceEvent[], options: { maxStatsPoints?: number } = {}): SessionModel {
  const maxStatsPoints = options.maxStatsPoints ?? 600;
  const events = [...input].sort((a, b) => a.timestamp - b.timestamp || a.seq - b.seq);
  const byId: Record<string, PeerModel> = {};
  const peers: PeerModel[] = [];
  const channelsByKey: Record<string, ChannelModel> = {};

  const peerFor = (e: RTCTraceEvent) => {
    let p = byId[e.peerId];
    if (!p) {
      p = newPeer(e.peerId, e.timestamp);
      byId[e.peerId] = p;
      peers.push(p);
    }
    p.eventCount += 1;
    p.lastEventAt = e.timestamp;
    return p;
  };

  for (const raw of events) {
    const e = raw as AnyTraceEvent;
    const p = peerFor(e);
    const at = e.timestamp;
    switch (e.type) {
      case "peer.created": {
        const d = e.details;
        p.createdAt = at;
        if (d.label) p.label = d.label;
        if (d.group) p.group = d.group;
        if (d.configuration) p.configuration = d.configuration;
        p.attachedLate = !!d.attachedLate;
        p.signalingState = d.state.signalingState;
        p.iceGatheringState = d.state.iceGatheringState;
        p.iceConnectionState = d.state.iceConnectionState;
        p.connectionState = d.state.connectionState;
        break;
      }
      case "peer.closed":
        p.closedAt ??= at;
        p.beforeClose ??= { signalingState: p.signalingState, iceConnectionState: p.iceConnectionState, connectionState: p.connectionState };
        p.signalingState = "closed";
        p.connectionState = "closed";
        p.iceConnectionState = "closed";
        for (const c of p.channels) if (c.state !== "closed") { c.state = "closed"; c.closedAt ??= at; }
        break;
      case "signaling.state":
        p.signalingState = e.details.state;
        p.history.signaling.push({ ...e.details, at, eventId: e.id });
        break;
      case "ice.gathering.state":
        p.iceGatheringState = e.details.state;
        p.history.gathering.push({ ...e.details, at, eventId: e.id });
        break;
      case "ice.connection.state":
        p.iceConnectionState = e.details.state;
        p.history.ice.push({ ...e.details, at, eventId: e.id });
        break;
      case "connection.state":
        p.connectionState = e.details.state;
        p.history.connection.push({ ...e.details, at, eventId: e.id });
        break;
      case "offer.created":
      case "answer.created":
      case "sdp.local.set":
      case "sdp.remote.set": {
        const source = e.type === "sdp.local.set" ? "local" : e.type === "sdp.remote.set" ? "remote" : "created";
        const record: DescriptionRecord = { eventId: e.id, at, source, ...e.details };
        p.descriptions.push(record);
        if (source === "local") {
          if (record.type === "rollback") p.localDescription = undefined;
          else {
            p.localDescription = record;
            if (record.sessionId) p.localSessionId = record.sessionId;
            if (!p.role && (record.type === "offer" || record.type === "answer")) {
              p.role = record.type === "offer" ? "offerer" : "answerer";
            }
          }
        } else if (source === "remote") {
          if (record.type === "rollback") p.remoteDescription = undefined;
          else {
            p.remoteDescription = record;
            if (record.sessionId) p.remoteSessionId = record.sessionId;
            if (!p.role && record.type === "offer") p.role = "answerer";
          }
        }
        break;
      }
      case "ice.candidate.discovered":
      case "ice.candidate.added":
        (e.type === "ice.candidate.discovered" ? p.localCandidates : p.remoteCandidates).push({
          eventId: e.id,
          at,
          side: e.type === "ice.candidate.discovered" ? "local" : "remote",
          candidate: e.details.candidate,
          ...(e.details.parsed && { parsed: e.details.parsed }),
          sdpMid: e.details.sdpMid,
          sdpMLineIndex: e.details.sdpMLineIndex,
          ...(e.correlationId && { correlationId: e.correlationId }),
          ...(e.details.endOfCandidates && { endOfCandidates: true }),
        });
        break;
      case "ice.candidate.error":
        p.candidateErrors.push({ ...e.details, at, eventId: e.id });
        break;
      case "ice.restart":
        p.iceRestarts.push(at);
        break;
      case "negotiation.needed":
        p.negotiationNeeded.push(at);
        break;
      case "ice.pair.selected":
        p.selectedPair = e.details.pair;
        p.selectedPairAt = at;
        break;
      case "stats.sample": {
        const s = e.details;
        p.lastStats = s;
        p.lastStatsAt = at;
        if (s.selectedPair) p.selectedPair = s.selectedPair;
        p.statsSeries.push({
          at,
          ...(s.roundTripTimeMs !== undefined && { rttMs: s.roundTripTimeMs }),
          ...(s.sendBitrate !== undefined && { sendBitrate: s.sendBitrate }),
          ...(s.receiveBitrate !== undefined && { receiveBitrate: s.receiveBitrate }),
          ...(s.availableOutgoingBitrate !== undefined && { availableOutgoingBitrate: s.availableOutgoingBitrate }),
          ...(s.packetLossPercent !== undefined && { packetLossPercent: s.packetLossPercent }),
        });
        if (p.statsSeries.length > maxStatsPoints) p.statsSeries.shift();
        break;
      }
      case "datachannel.created":
      case "datachannel.received": {
        const d = e.details;
        const channel: ChannelModel = {
          channelKey: d.channelKey,
          peerId: p.peerId,
          label: d.label,
          id: d.id,
          origin: e.type === "datachannel.created" ? "local" : "remote",
          ...(d.protocol !== undefined && { protocol: d.protocol }),
          ...(d.ordered !== undefined && { ordered: d.ordered }),
          ...(d.maxRetransmits !== undefined && { maxRetransmits: d.maxRetransmits }),
          ...(d.maxPacketLifeTime !== undefined && { maxPacketLifeTime: d.maxPacketLifeTime }),
          ...(d.negotiated !== undefined && { negotiated: d.negotiated }),
          state: d.readyState ?? "connecting",
          createdAt: at,
          createdEventId: e.id,
          sent: 0,
          received: 0,
          bytesSent: 0,
          bytesReceived: 0,
          maxBufferedAmount: 0,
          errors: [],
        };
        p.channels.push(channel);
        channelsByKey[d.channelKey] = channel;
        break;
      }
      case "datachannel.open":
      case "datachannel.closing":
      case "datachannel.close":
      case "datachannel.error": {
        const c = channelsByKey[e.details.channelKey];
        if (!c) break;
        if (e.details.id !== null && e.details.id !== undefined) c.id = e.details.id;
        if (e.type === "datachannel.open") {
          c.state = "open";
          c.openedAt = at;
        } else if (e.type === "datachannel.closing") c.state = "closing";
        else if (e.type === "datachannel.close") {
          c.state = "closed";
          c.closedAt = at;
        } else if (!isRemoteCloseAbort(e.details.error)) {
          c.errors.push({
            at,
            eventId: e.id,
            error: e.details.error,
            ...(e.details.operation && { operation: e.details.operation }),
          });
        }
        break;
      }
      case "datachannel.message": {
        const c = channelsByKey[e.details.channelKey];
        if (!c) break;
        if (e.details.direction === "outgoing") {
          c.sent += 1;
          c.bytesSent += e.details.size;
          c.maxBufferedAmount = Math.max(c.maxBufferedAmount, e.details.bufferedAmount ?? 0);
        } else {
          c.received += 1;
          c.bytesReceived += e.details.size;
        }
        break;
      }
      case "track.added":
      case "track.received":
        p.tracks.push({
          side: e.type === "track.added" ? "local" : "remote",
          kind: e.details.kind,
          trackId: e.details.trackId,
          at,
        });
        break;
      case "api.error":
        p.apiErrors.push({
          at,
          eventId: e.id,
          method: e.details.method,
          error: e.details.error,
          ...(e.details.args !== undefined && { args: e.details.args }),
        });
        break;
      default:
        break;
    }
  }

  // Pair peers: my remote description's o= session id is your local one.
  const bySession = new Map<string, PeerModel>();
  for (const p of peers) if (p.localSessionId) bySession.set(p.localSessionId, p);
  const links: PeerLink[] = [];
  for (const p of peers) {
    const other = p.remoteSessionId ? bySession.get(p.remoteSessionId) : undefined;
    if (!other || other === p) continue;
    p.remotePeerId = other.peerId;
    if (p.peerId < other.peerId || other.remoteSessionId !== p.localSessionId) {
      const worst = (STATE_RANK[p.connectionState] ?? 0) >= (STATE_RANK[other.connectionState] ?? 0) ? p : other;
      links.push({ a: p.peerId, b: other.peerId, state: worst.connectionState });
    }
  }

  // Match candidates across peers by correlation id.
  const remoteByCorr = new Map<string, CandidateRecord & { peerId: string }>();
  for (const p of peers) for (const c of p.remoteCandidates) if (c.correlationId) remoteByCorr.set(c.correlationId, { ...c, peerId: p.peerId });
  const localByCorr = new Map<string, string>();
  for (const p of peers) for (const c of p.localCandidates) if (c.correlationId) localByCorr.set(c.correlationId, p.peerId);
  for (const p of peers) {
    for (const c of p.localCandidates) {
      const m = c.correlationId ? remoteByCorr.get(c.correlationId) : undefined;
      if (m && m.peerId !== p.peerId) c.matchedPeerId = m.peerId;
    }
    for (const c of p.remoteCandidates) {
      const owner = c.correlationId ? localByCorr.get(c.correlationId) : undefined;
      if (owner && owner !== p.peerId) c.matchedPeerId = owner;
    }
  }

  // Endpoints in name order ("Tab 1" before "Tab 2", alice before bob); connections
  // keep their creation order within an endpoint. Array sort is stable.
  const groups = [...new Set(peers.map((p) => p.group).filter((g): g is string => !!g))].sort(byName);
  if (groups.length > 1) peers.sort((a, b) => byName(a.group ?? "", b.group ?? ""));
  return {
    startedAt: events[0]?.timestamp ?? 0,
    endedAt: events[events.length - 1]?.timestamp ?? 0,
    peers,
    byId,
    links,
    groups,
    channelsByKey,
  };
}
