/**
 * Periodic getStats() sampling, reduced to the handful of numbers a human
 * debugging a connection actually looks at.
 */

import { redactAddress } from "./redact";
import type {
  StatsCandidate,
  StatsCandidatePair,
  StatsDataChannel,
  StatsMediaSummary,
  StatsSampleDetails,
} from "./types";

// getStats() entries are loosely typed dictionaries; read them defensively.
type RawStat = Record<string, unknown> & { id: string; type: string; timestamp?: number };

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export interface StatsCursor {
  timestamp: number;
  bytesSent?: number;
  bytesReceived?: number;
}

function toArray(report: Iterable<unknown> | { forEach: (cb: (v: unknown) => void) => void }): RawStat[] {
  const out: RawStat[] = [];
  if (typeof (report as { forEach?: unknown }).forEach === "function") {
    (report as { forEach: (cb: (v: unknown) => void) => void }).forEach((s) => out.push(s as RawStat));
  } else {
    for (const s of report as Iterable<unknown>) out.push(s as RawStat);
  }
  return out;
}

function candidate(raw: RawStat | undefined, redact: boolean): StatsCandidate | undefined {
  if (!raw) return undefined;
  const address = str(raw.address) ?? str(raw.ip);
  const port = num(raw.port);
  return {
    id: raw.id,
    ...(str(raw.candidateType) && { candidateType: str(raw.candidateType) }),
    ...(str(raw.protocol) && { protocol: str(raw.protocol) }),
    ...(address && { address: redact ? (redactAddress(address) ?? address) : address }),
    ...(port !== undefined && { port }),
    ...(str(raw.relayProtocol) && { relayProtocol: str(raw.relayProtocol) }),
    ...(str(raw.networkType) && { networkType: str(raw.networkType) }),
    ...(str(raw.url) && { url: str(raw.url) }),
  };
}

/** Turn a raw RTCStatsReport into a compact, serialisable sample. */
export function summarizeStats(
  report: Iterable<unknown> | { forEach: (cb: (v: unknown) => void) => void },
  previous: StatsCursor | undefined,
  options: { redact: boolean; timestamp: number },
): { sample: StatsSampleDetails; cursor: StatsCursor } {
  const stats = toArray(report);
  const byId = new Map(stats.map((s) => [s.id, s]));
  const ofType = (t: string) => stats.filter((s) => s.type === t);

  const transports = ofType("transport");
  const rawPairs = ofType("candidate-pair");
  const selectedId =
    transports.map((t) => str(t.selectedCandidatePairId)).find(Boolean) ??
    rawPairs.find((p) => p.selected === true)?.id ??
    rawPairs.find((p) => p.nominated === true && p.state === "succeeded")?.id;

  const pairs: StatsCandidatePair[] = rawPairs.map((p) => {
    const rtt = num(p.currentRoundTripTime);
    const local = candidate(byId.get(str(p.localCandidateId) ?? ""), options.redact);
    const remote = candidate(byId.get(str(p.remoteCandidateId) ?? ""), options.redact);
    return {
      id: p.id,
      ...(str(p.state) && { state: str(p.state) }),
      ...(typeof p.nominated === "boolean" && { nominated: p.nominated }),
      selected: p.id === selectedId,
      ...(local && { local }),
      ...(remote && { remote }),
      ...(rtt !== undefined && { currentRoundTripTimeMs: rtt * 1000 }),
      ...(num(p.requestsSent) !== undefined && { requestsSent: num(p.requestsSent) }),
      ...(num(p.responsesReceived) !== undefined && { responsesReceived: num(p.responsesReceived) }),
      ...(num(p.bytesSent) !== undefined && { bytesSent: num(p.bytesSent) }),
      ...(num(p.bytesReceived) !== undefined && { bytesReceived: num(p.bytesReceived) }),
    };
  });
  const selectedPair = pairs.find((p) => p.selected);
  const selectedRaw = selectedId ? byId.get(selectedId) : undefined;
  const transport = transports[0];

  const bytesSent = num(transport?.bytesSent) ?? selectedPair?.bytesSent;
  const bytesReceived = num(transport?.bytesReceived) ?? selectedPair?.bytesReceived;

  const dataChannels: StatsDataChannel[] = ofType("data-channel").map((d) => ({
    ...(str(d.label) !== undefined && { label: str(d.label) }),
    ...(num(d.dataChannelIdentifier) !== undefined && { id: num(d.dataChannelIdentifier) }),
    ...(str(d.state) && { state: str(d.state) }),
    ...(num(d.messagesSent) !== undefined && { messagesSent: num(d.messagesSent) }),
    ...(num(d.messagesReceived) !== undefined && { messagesReceived: num(d.messagesReceived) }),
    ...(num(d.bytesSent) !== undefined && { bytesSent: num(d.bytesSent) }),
    ...(num(d.bytesReceived) !== undefined && { bytesReceived: num(d.bytesReceived) }),
  }));

  const remoteInbound = ofType("remote-inbound-rtp");
  const media: StatsMediaSummary[] = [
    ...ofType("inbound-rtp").map((s) => ({
      kind: str(s.kind) ?? str(s.mediaType) ?? "unknown",
      direction: "inbound" as const,
      ...(num(s.bytesReceived) !== undefined && { bytes: num(s.bytesReceived) }),
      ...(num(s.packetsReceived) !== undefined && { packets: num(s.packetsReceived) }),
      ...(num(s.packetsLost) !== undefined && { packetsLost: num(s.packetsLost) }),
      ...(num(s.jitter) !== undefined && { jitterMs: num(s.jitter)! * 1000 }),
    })),
    ...ofType("outbound-rtp").map((s) => {
      const ri = remoteInbound.find((r) => r.localId === s.id);
      return {
        kind: str(s.kind) ?? str(s.mediaType) ?? "unknown",
        direction: "outbound" as const,
        ...(num(s.bytesSent) !== undefined && { bytes: num(s.bytesSent) }),
        ...(num(s.packetsSent) !== undefined && { packets: num(s.packetsSent) }),
        ...(num(ri?.fractionLost) !== undefined && { fractionLost: num(ri?.fractionLost) }),
      };
    }),
  ];

  const inbound = media.filter((m) => m.direction === "inbound");
  const lost = inbound.reduce((sum, m) => sum + (m.packetsLost ?? 0), 0);
  const received = inbound.reduce((sum, m) => sum + (m.packets ?? 0), 0);
  const packetLossPercent = lost + received > 0 ? (lost / (lost + received)) * 100 : undefined;

  const ts = options.timestamp;
  const elapsed = previous ? (ts - previous.timestamp) / 1000 : 0;
  const rate = (cur?: number, prev?: number) =>
    cur !== undefined && prev !== undefined && elapsed > 0 ? Math.max(0, ((cur - prev) * 8) / elapsed) : undefined;
  const sendBitrate = rate(bytesSent, previous?.bytesSent);
  const receiveBitrate = rate(bytesReceived, previous?.bytesReceived);
  const availableOutgoingBitrate = num(selectedRaw?.availableOutgoingBitrate);
  const dtlsState = str(transport?.dtlsState);

  const sample: StatsSampleDetails = {
    pairs,
    dataChannels,
    media,
    ...(selectedPair && { selectedPair }),
    ...(selectedPair?.currentRoundTripTimeMs !== undefined && { roundTripTimeMs: selectedPair.currentRoundTripTimeMs }),
    ...(availableOutgoingBitrate !== undefined && { availableOutgoingBitrate }),
    ...(bytesSent !== undefined && { bytesSent }),
    ...(bytesReceived !== undefined && { bytesReceived }),
    ...(sendBitrate !== undefined && { sendBitrate }),
    ...(receiveBitrate !== undefined && { receiveBitrate }),
    ...(packetLossPercent !== undefined && { packetLossPercent }),
    ...(dtlsState && { dtlsState }),
  };
  return {
    sample,
    cursor: {
      timestamp: ts,
      ...(bytesSent !== undefined && { bytesSent }),
      ...(bytesReceived !== undefined && { bytesReceived }),
    },
  };
}

export interface StatsCollectorOptions {
  intervalMs: number;
  redact: boolean;
  now: () => number;
  onSample: (sample: StatsSampleDetails) => void;
  onError?: (error: unknown) => void;
}

/** Poll `pc.getStats()`; returns a stop function. */
export function startStatsCollector(pc: RTCPeerConnection, options: StatsCollectorOptions): () => void {
  let cursor: StatsCursor | undefined;
  let inFlight = false;
  let stopped = false;

  const tick = async () => {
    if (inFlight || stopped) return;
    if (pc.signalingState === "closed" || pc.connectionState === "closed") {
      stop();
      return;
    }
    // Nothing interesting exists before ICE starts.
    if (pc.iceConnectionState === "new" && pc.connectionState !== "connecting") return;
    inFlight = true;
    try {
      const report = await pc.getStats();
      if (stopped) return;
      const result = summarizeStats(report, cursor, { redact: options.redact, timestamp: options.now() });
      cursor = result.cursor;
      options.onSample(result.sample);
    } catch (error) {
      options.onError?.(error);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void tick(), options.intervalMs);
  function stop() {
    stopped = true;
    clearInterval(timer);
  }
  return stop;
}
