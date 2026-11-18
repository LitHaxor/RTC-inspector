/**
 * Unified event schema for RTC Inspector.
 *
 * Every observation (an API call, a native event, a stats sample, or an
 * app-provided signaling annotation) becomes one `RTCTraceEvent`. The UI,
 * diagnostics and exporters only ever consume this stream, so it is the single
 * contract between instrumentation and visualisation.
 */

import type { ParsedCandidate } from "./ice-parser";

export type EventCategory =
  | "lifecycle"
  | "signaling"
  | "ice"
  | "connection"
  | "datachannel"
  | "media"
  | "stats"
  | "error"
  | "annotation";

export interface ErrorInfo {
  name: string;
  message: string;
}

/**
 * Chrome fires an 'error' event on a DataChannel when the other side closes the
 * channel or its connection: an RTCError "User-Initiated Abort, reason=Close called"
 * (SCTP cause 12). That is a normal close, not a failure.
 */
export function isRemoteCloseAbort(error: ErrorInfo): boolean {
  return /User-Initiated Abort/i.test(error.message);
}

export interface RedactedIceServer {
  urls: string[];
  username?: string;
  hasCredential: boolean;
}

export interface PeerConfigurationSnapshot {
  iceServers: RedactedIceServer[];
  iceTransportPolicy?: string;
  bundlePolicy?: string;
  rtcpMuxPolicy?: string;
  iceCandidatePoolSize?: number;
}

export interface StateSnapshot {
  signalingState: string;
  iceGatheringState: string;
  iceConnectionState: string;
  connectionState: string;
}

export interface SdpDetails {
  type: string;
  /** SDP text (IP addresses / ICE passwords redacted unless redaction is off). */
  sdp: string;
  /** `o=` line session id, used to pair peers and correlate offers/answers. */
  sessionId?: string;
  sessionVersion?: string;
  durationMs?: number;
}

export interface CandidateDetails {
  /** Redacted candidate attribute string. */
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string | null;
  parsed?: ParsedCandidate;
  endOfCandidates?: boolean;
}

export interface DataChannelInfo {
  /** Inspector-assigned key, stable for the lifetime of the channel object. */
  channelKey: string;
  label: string;
  id: number | null;
  protocol?: string;
  ordered?: boolean;
  maxRetransmits?: number | null;
  maxPacketLifeTime?: number | null;
  negotiated?: boolean;
  readyState?: string;
  binaryType?: string;
}

export interface MessageDetails {
  channelKey: string;
  label: string;
  channelId: number | null;
  direction: "incoming" | "outgoing";
  dataType: "string" | "binary" | "unknown";
  size: number;
  /** Per-channel, per-direction sequence number (1-based). */
  seq: number;
  preview?: string;
  bufferedAmount?: number;
}

export interface SignalingMessageDetails {
  direction: "sent" | "received";
  /** offer | answer | candidate | bye | anything the app uses. */
  kind: string;
  /** Remote party as named by the app. */
  remote?: string;
  messageId?: string;
  size?: number;
}

export interface StatsCandidate {
  id: string;
  candidateType?: string;
  protocol?: string;
  address?: string;
  port?: number;
  relayProtocol?: string;
  networkType?: string;
  url?: string;
}

export interface StatsCandidatePair {
  id: string;
  state?: string;
  nominated?: boolean;
  selected: boolean;
  local?: StatsCandidate;
  remote?: StatsCandidate;
  currentRoundTripTimeMs?: number;
  requestsSent?: number;
  responsesReceived?: number;
  bytesSent?: number;
  bytesReceived?: number;
}

export interface StatsDataChannel {
  label?: string;
  id?: number;
  state?: string;
  messagesSent?: number;
  messagesReceived?: number;
  bytesSent?: number;
  bytesReceived?: number;
}

export interface StatsMediaSummary {
  kind: string;
  direction: "inbound" | "outbound";
  bytes?: number;
  packets?: number;
  packetsLost?: number;
  jitterMs?: number;
  fractionLost?: number;
}

export interface StatsSampleDetails {
  selectedPair?: StatsCandidatePair;
  pairs: StatsCandidatePair[];
  roundTripTimeMs?: number;
  availableOutgoingBitrate?: number;
  bytesSent?: number;
  bytesReceived?: number;
  /** Bits per second, derived from the delta with the previous sample. */
  sendBitrate?: number;
  receiveBitrate?: number;
  packetLossPercent?: number;
  dtlsState?: string;
  dataChannels: StatsDataChannel[];
  media: StatsMediaSummary[];
}

export interface EventDetailsMap {
  "peer.created": {
    label?: string;
    group?: string;
    configuration?: PeerConfigurationSnapshot;
    state: StateSnapshot;
    /** True when the inspector attached to an already-running connection. */
    attachedLate?: boolean;
  };
  "peer.closed": Record<string, never>;
  "negotiation.needed": Record<string, never>;
  "offer.created": SdpDetails;
  "answer.created": SdpDetails;
  "sdp.local.set": SdpDetails;
  "sdp.remote.set": SdpDetails;
  "signaling.state": { state: string; previous?: string };
  "signaling.message": SignalingMessageDetails;
  "ice.candidate.discovered": CandidateDetails;
  "ice.candidate.added": CandidateDetails;
  "ice.candidate.error": {
    errorCode: number;
    errorText: string;
    url?: string;
    address?: string | null;
    port?: number | null;
  };
  "ice.gathering.state": { state: string; previous?: string };
  "ice.connection.state": { state: string; previous?: string };
  "ice.restart": Record<string, never>;
  "ice.pair.selected": { pair: StatsCandidatePair; previousPairId?: string };
  "connection.state": { state: string; previous?: string };
  "datachannel.created": DataChannelInfo;
  "datachannel.received": DataChannelInfo;
  "datachannel.open": DataChannelInfo;
  "datachannel.closing": DataChannelInfo;
  "datachannel.close": DataChannelInfo;
  "datachannel.error": DataChannelInfo & { error: ErrorInfo; operation?: string };
  "datachannel.message": MessageDetails;
  "track.added": { kind: string; trackId: string; streamIds: string[] };
  "track.received": { kind: string; trackId: string; streamIds: string[]; mid?: string | null };
  "api.error": { method: string; args?: unknown; error: ErrorInfo };
  "stats.sample": StatsSampleDetails;
  annotation: { label: string; data?: unknown };
}

export type RTCEventType = keyof EventDetailsMap;

export interface RTCTraceEvent<T extends RTCEventType = RTCEventType> {
  /** Unique event id. */
  id: string;
  /** Monotonic sequence within the session; breaks timestamp ties. */
  seq: number;
  /** Epoch milliseconds with sub-millisecond precision. */
  timestamp: number;
  peerId: string;
  type: T;
  category: EventCategory;
  details: EventDetailsMap[T];
  /**
   * Events on different peers that share a correlation id describe the same
   * thing seen from both ends (an offer leaving A and arriving at B, a
   * candidate gathered by A and added by B, a signaling message...).
   */
  correlationId?: string;
}

/** A union of every concrete event shape, convenient for narrowing on `type`. */
export type AnyTraceEvent = {
  [K in RTCEventType]: RTCTraceEvent<K>;
}[RTCEventType];

export interface PeerMeta {
  peerId: string;
  /** Human label, e.g. "alice → bob". */
  label?: string;
  /** Logical owner (agent / browser / user) for grouping lanes. */
  group?: string;
}

export const EVENT_CATEGORY: Record<RTCEventType, EventCategory> = {
  "peer.created": "lifecycle",
  "peer.closed": "lifecycle",
  "negotiation.needed": "signaling",
  "offer.created": "signaling",
  "answer.created": "signaling",
  "sdp.local.set": "signaling",
  "sdp.remote.set": "signaling",
  "signaling.state": "signaling",
  "signaling.message": "signaling",
  "ice.candidate.discovered": "ice",
  "ice.candidate.added": "ice",
  "ice.candidate.error": "ice",
  "ice.gathering.state": "ice",
  "ice.connection.state": "ice",
  "ice.restart": "ice",
  "ice.pair.selected": "ice",
  "connection.state": "connection",
  "datachannel.created": "datachannel",
  "datachannel.received": "datachannel",
  "datachannel.open": "datachannel",
  "datachannel.closing": "datachannel",
  "datachannel.close": "datachannel",
  "datachannel.error": "datachannel",
  "datachannel.message": "datachannel",
  "track.added": "media",
  "track.received": "media",
  "api.error": "error",
  "stats.sample": "stats",
  annotation: "annotation",
};
