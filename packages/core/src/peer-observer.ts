/**
 * The Event Hooker: observes one RTCPeerConnection.
 *
 * - Native events are observed with addEventListener, so `pc.onX = …`
 *   handlers set by the application keep working untouched.
 * - API methods (createOffer, setLocalDescription, addIceCandidate,
 *   createDataChannel, close…) are wrapped on the *instance*, never on the
 *   prototype, and resolve/reject/return exactly what the originals do.
 * - Nothing the inspector does can throw into application code.
 */

import { observeDataChannel, type PayloadCapture } from "./datachannel-observer";
import { candidateCorrelationKey, parseCandidate, redactCandidate } from "./ice-parser";
import { safely, toErrorInfo, wrapAsyncMethod, wrapMethod } from "./instrument-utils";
import { redactAddress, redactSdp, redactText } from "./redact";
import { sdpOrigin } from "./sdp-parser";
import { startStatsCollector } from "./stats-collector";
import type {
  CandidateDetails,
  EventDetailsMap,
  PeerConfigurationSnapshot,
  RTCEventType,
  SdpDetails,
  StateSnapshot,
} from "./types";

export interface PeerObserverOptions {
  peerId: string;
  label?: string;
  group?: string;
  /** Redact IP addresses and ICE passwords. Default true. */
  redact: boolean;
  /** getStats() polling interval; 0 disables polling. */
  statsIntervalMs: number;
  payload: PayloadCapture;
  previewLength: number;
  captureMessages: boolean;
}

export interface PeerObserverContext {
  emit: <T extends RTCEventType>(type: T, details: EventDetailsMap[T], correlationId?: string) => void;
  channelKey: () => string;
  now: () => number;
}

export function sdpCorrelationId(type: string, sdp: string): string | undefined {
  const origin = sdpOrigin(sdp);
  return origin && type !== "rollback" ? `sdp:${origin.sessionId}:${origin.sessionVersion}:${type}` : undefined;
}

export function snapshotConfiguration(pc: RTCPeerConnection): PeerConfigurationSnapshot | undefined {
  if (typeof pc.getConfiguration !== "function") return undefined;
  const config = pc.getConfiguration();
  return {
    iceServers: (config.iceServers ?? []).map((s) => ({
      urls: Array.isArray(s.urls) ? [...s.urls] : [s.urls],
      ...(s.username && { username: s.username }),
      hasCredential: !!s.credential,
    })),
    ...(config.iceTransportPolicy && { iceTransportPolicy: config.iceTransportPolicy }),
    ...(config.bundlePolicy && { bundlePolicy: config.bundlePolicy }),
    ...(config.rtcpMuxPolicy && { rtcpMuxPolicy: config.rtcpMuxPolicy }),
    ...(config.iceCandidatePoolSize !== undefined && { iceCandidatePoolSize: config.iceCandidatePoolSize }),
  };
}

export function snapshotState(pc: RTCPeerConnection): StateSnapshot {
  return {
    signalingState: pc.signalingState,
    iceGatheringState: pc.iceGatheringState,
    iceConnectionState: pc.iceConnectionState,
    connectionState: pc.connectionState ?? "unknown",
  };
}

export function observePeerConnection(
  pc: RTCPeerConnection,
  options: PeerObserverOptions,
  ctx: PeerObserverContext,
): () => void {
  const { emit, now } = ctx;
  const disposers: (() => void)[] = [];
  let stopStats: (() => void) | undefined;
  let lastSelectedPairId: string | undefined;
  let closed = false;

  const sdpOut = (sdp: string) => (options.redact ? redactSdp(sdp) : sdp);
  const sdpDetails = (type: string, sdp: string, startedAt?: number): SdpDetails => {
    const origin = sdpOrigin(sdp);
    return {
      type,
      sdp: sdpOut(sdp),
      ...(origin && { sessionId: origin.sessionId, sessionVersion: origin.sessionVersion }),
      ...(startedAt !== undefined && { durationMs: now() - startedAt }),
    };
  };
  const candidateDetails = (
    init: { candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null } | null | undefined,
  ): { details: CandidateDetails; correlationId?: string } => {
    const raw = init?.candidate ?? "";
    const parsed = raw ? parseCandidate(raw) : null;
    const details: CandidateDetails = {
      candidate: options.redact ? redactText(raw) : raw,
      sdpMid: init?.sdpMid ?? null,
      sdpMLineIndex: init?.sdpMLineIndex ?? null,
      ...(init?.usernameFragment !== undefined && { usernameFragment: init.usernameFragment }),
      ...(parsed && { parsed: options.redact ? redactCandidate(parsed) : parsed }),
      ...(!raw && { endOfCandidates: true }),
    };
    return { details, ...(parsed && { correlationId: candidateCorrelationKey(parsed) }) };
  };

  const listen = (type: string, handler: (event: Event) => void) => {
    const wrapped = (event: Event) => safely(() => handler(event));
    pc.addEventListener(type, wrapped);
    disposers.push(() => pc.removeEventListener(type, wrapped));
  };

  const channelCtx = {
    emit,
    channelKey: ctx.channelKey,
    payload: options.payload,
    previewLength: options.previewLength,
    captureMessages: options.captureMessages,
  };

  // --- Initial snapshot -----------------------------------------------------
  const state = snapshotState(pc);
  const attachedLate =
    state.signalingState !== "stable" ||
    !!pc.localDescription ||
    !!pc.remoteDescription ||
    (state.connectionState !== "new" && state.connectionState !== "unknown");
  const configuration = snapshotConfiguration(pc);
  emit("peer.created", {
    ...(options.label && { label: options.label }),
    ...(options.group && { group: options.group }),
    state,
    ...(configuration && { configuration }),
    ...(attachedLate && { attachedLate }),
  });
  if (attachedLate) {
    if (pc.localDescription) {
      const d = pc.localDescription;
      emit("sdp.local.set", sdpDetails(d.type, d.sdp), sdpCorrelationId(d.type, d.sdp));
    }
    if (pc.remoteDescription) {
      const d = pc.remoteDescription;
      emit("sdp.remote.set", sdpDetails(d.type, d.sdp), sdpCorrelationId(d.type, d.sdp));
    }
  }

  // --- Native state events --------------------------------------------------
  const last = { ...state };
  listen("signalingstatechange", () => {
    emit("signaling.state", { state: pc.signalingState, previous: last.signalingState });
    last.signalingState = pc.signalingState;
  });
  listen("icegatheringstatechange", () => {
    emit("ice.gathering.state", { state: pc.iceGatheringState, previous: last.iceGatheringState });
    last.iceGatheringState = pc.iceGatheringState;
  });
  listen("iceconnectionstatechange", () => {
    emit("ice.connection.state", { state: pc.iceConnectionState, previous: last.iceConnectionState });
    last.iceConnectionState = pc.iceConnectionState;
  });
  listen("connectionstatechange", () => {
    emit("connection.state", { state: pc.connectionState, previous: last.connectionState });
    last.connectionState = pc.connectionState;
    if (pc.connectionState === "closed") stopStats?.();
  });
  listen("negotiationneeded", () => emit("negotiation.needed", {}));
  listen("icecandidate", (event) => {
    const candidate = (event as RTCPeerConnectionIceEvent).candidate;
    if (!candidate || !candidate.candidate) return; // end-of-gathering is covered by ice.gathering.state
    const { details, correlationId } = candidateDetails(candidate);
    emit("ice.candidate.discovered", details, correlationId);
  });
  listen("icecandidateerror", (event) => {
    const e = event as RTCPeerConnectionIceErrorEvent & { hostCandidate?: string };
    emit("ice.candidate.error", {
      errorCode: e.errorCode,
      errorText: e.errorText,
      ...(e.url && { url: e.url }),
      address: options.redact ? (redactAddress(e.address) ?? null) : (e.address ?? null),
      port: e.port ?? null,
    });
  });
  listen("datachannel", (event) => {
    disposers.push(observeDataChannel((event as RTCDataChannelEvent).channel, "remote", channelCtx));
  });
  listen("track", (event) => {
    const e = event as RTCTrackEvent;
    emit("track.received", {
      kind: e.track.kind,
      trackId: e.track.id,
      streamIds: (e.streams ?? []).map((s) => s.id),
      mid: e.transceiver?.mid ?? null,
    });
  });

  // --- Intercepted API methods ----------------------------------------------
  const apiError = (method: string) => (error: unknown, args: unknown[]) => {
    const first = args[0] as { type?: string; candidate?: string } | undefined;
    let argSummary: unknown;
    if (first && typeof first === "object") {
      if (typeof first.type === "string") argSummary = { type: first.type };
      else if (typeof first.candidate === "string")
        argSummary = { candidate: options.redact ? redactText(first.candidate) : first.candidate };
    }
    emit("api.error", { method, ...(argSummary !== undefined && { args: argSummary }), error: toErrorInfo(error) });
  };

  for (const method of ["createOffer", "createAnswer"] as const) {
    disposers.push(
      wrapAsyncMethod(pc, method, now, {
        onResolve: (value, _args, startedAt) => {
          const desc = (value as RTCSessionDescriptionInit | undefined) ?? undefined;
          if (!desc?.sdp) return; // legacy callback form resolves with undefined
          emit(method === "createOffer" ? "offer.created" : "answer.created", sdpDetails(desc.type ?? "", desc.sdp, startedAt));
        },
        onReject: apiError(method),
      }),
    );
  }

  disposers.push(
    wrapAsyncMethod(pc, "setLocalDescription", now, {
      onResolve: (_value, args, startedAt) => {
        const desc = pc.localDescription ?? (args[0] as RTCSessionDescriptionInit | undefined);
        const type = (args[0] as RTCSessionDescriptionInit | undefined)?.type === "rollback" ? "rollback" : desc?.type ?? "";
        const sdp = type === "rollback" ? "" : desc?.sdp ?? "";
        emit("sdp.local.set", sdpDetails(type, sdp, startedAt), sdpCorrelationId(type, sdp));
      },
      onReject: apiError("setLocalDescription"),
    }),
    wrapAsyncMethod(pc, "setRemoteDescription", now, {
      onResolve: (_value, args, startedAt) => {
        const arg = args[0] as RTCSessionDescriptionInit | undefined;
        const desc = arg?.type === "rollback" ? arg : pc.remoteDescription ?? arg;
        const type = desc?.type ?? "";
        const sdp = type === "rollback" ? "" : desc?.sdp ?? "";
        emit("sdp.remote.set", sdpDetails(type, sdp, startedAt), sdpCorrelationId(type, sdp));
      },
      onReject: apiError("setRemoteDescription"),
    }),
    wrapAsyncMethod(pc, "addIceCandidate", now, {
      onResolve: (_value, args) => {
        const { details, correlationId } = candidateDetails(args[0] as RTCIceCandidateInit | null | undefined);
        emit("ice.candidate.added", details, correlationId);
      },
      onReject: apiError("addIceCandidate"),
    }),
    wrapMethod(pc, "createDataChannel", (original) =>
      function (this: RTCPeerConnection, ...args: unknown[]) {
        const channel = original.apply(this, args) as RTCDataChannel;
        safely(() => disposers.push(observeDataChannel(channel, "local", channelCtx)));
        return channel;
      },
    ),
    wrapMethod(pc, "addTrack", (original) =>
      function (this: RTCPeerConnection, ...args: unknown[]) {
        const sender = original.apply(this, args);
        safely(() => {
          const track = args[0] as MediaStreamTrack;
          const streams = args.slice(1) as MediaStream[];
          emit("track.added", { kind: track.kind, trackId: track.id, streamIds: streams.map((s) => s.id) });
        });
        return sender;
      },
    ),
    wrapMethod(pc, "restartIce", (original) =>
      function (this: RTCPeerConnection, ...args: unknown[]) {
        const result = original.apply(this, args);
        safely(() => emit("ice.restart", {}));
        return result;
      },
    ),
    wrapMethod(pc, "close", (original) =>
      function (this: RTCPeerConnection, ...args: unknown[]) {
        const result = original.apply(this, args);
        safely(() => {
          if (closed) return;
          closed = true;
          stopStats?.();
          // close() does not fire connectionstatechange, so record it ourselves.
          emit("peer.closed", {});
        });
        return result;
      },
    ),
  );

  // --- Stats ----------------------------------------------------------------
  if (options.statsIntervalMs > 0 && typeof pc.getStats === "function") {
    stopStats = startStatsCollector(pc, {
      intervalMs: options.statsIntervalMs,
      redact: options.redact,
      now,
      onSample: (sample) => {
        emit("stats.sample", sample);
        const selected = sample.selectedPair;
        if (selected && selected.id !== lastSelectedPairId) {
          emit("ice.pair.selected", {
            pair: selected,
            ...(lastSelectedPairId && { previousPairId: lastSelectedPairId }),
          });
          lastSelectedPairId = selected.id;
        }
      },
    });
  }

  return () => {
    stopStats?.();
    for (const dispose of disposers.splice(0).reverse()) dispose();
  };
}
