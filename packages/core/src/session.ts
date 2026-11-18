/**
 * InspectorSession: the event collector. Framework independent: it knows
 * nothing about React or any UI. Observers emit into it; UIs, transports and
 * exporters subscribe to it.
 */

import type { PayloadCapture } from "./datachannel-observer";
import { now as defaultNow, randomId, safely } from "./instrument-utils";
import { observePeerConnection } from "./peer-observer";
import { createTrace, type TraceFile } from "./trace";
import {
  EVENT_CATEGORY,
  type EventDetailsMap,
  type PeerMeta,
  type RTCEventType,
  type RTCTraceEvent,
  type SignalingMessageDetails,
} from "./types";

export interface InspectorOptions {
  /** Redact IP addresses and ICE passwords at capture time. Default: true. */
  redact?: boolean;
  /** getStats() polling interval in ms. 0 disables. Default: 1000. */
  statsIntervalMs?: number;
  /** Max non-stats events kept in memory. Default: 20 000. */
  maxEvents?: number;
  /** Max stats samples kept in memory (all peers). Default: 6 000. */
  maxStatsSamples?: number;
  /** Keep a short preview of DataChannel payloads. Default: "preview". */
  payload?: PayloadCapture;
  previewLength?: number;
  /** Record individual DataChannel messages. Default: true. */
  captureMessages?: boolean;
  /** Clock override (tests). */
  now?: () => number;
}

export type TraceListener = (event: RTCTraceEvent) => void;

export interface PeerHandle extends PeerMeta {
  pc: RTCPeerConnection;
  /** Stop observing and restore every wrapped method. */
  dispose: () => void;
}

export interface ObserveOptions {
  peerId?: string;
  label?: string;
  group?: string;
}

export interface SessionSnapshot {
  events: RTCTraceEvent[];
  stats: RTCTraceEvent<"stats.sample">[];
}

export class InspectorSession {
  readonly sessionId = randomId();
  readonly startedAt: number;
  readonly options: Required<Omit<InspectorOptions, "now">>;
  /** Number of events evicted by the ring buffer. */
  droppedEvents = 0;

  private readonly now: () => number;
  private events: RTCTraceEvent[] = [];
  private stats: RTCTraceEvent<"stats.sample">[] = [];
  private readonly listeners = new Set<TraceListener>();
  private readonly handles = new Map<string, PeerHandle>();
  private readonly observed = new WeakMap<RTCPeerConnection, PeerHandle>();
  private seq = 0;
  private channelSeq = 0;
  private peerSeq = 0;
  private readonly idPrefix = randomId().slice(0, 8);

  constructor(options: InspectorOptions = {}) {
    this.now = options.now ?? defaultNow;
    this.startedAt = this.now();
    this.options = {
      redact: options.redact ?? true,
      statsIntervalMs: options.statsIntervalMs ?? 1000,
      maxEvents: options.maxEvents ?? 20_000,
      maxStatsSamples: options.maxStatsSamples ?? 6_000,
      payload: options.payload ?? "preview",
      previewLength: options.previewLength ?? 200,
      captureMessages: options.captureMessages ?? true,
    };
  }

  /** Start observing a peer connection. Observing the same pc twice returns the existing handle. */
  observe(pc: RTCPeerConnection, meta: ObserveOptions = {}): PeerHandle {
    const existing = this.observed.get(pc);
    if (existing) return existing;
    this.peerSeq += 1;
    let peerId = meta.peerId ?? `pc-${this.peerSeq}`;
    if (this.handles.has(peerId)) peerId = `${peerId}#${this.peerSeq}`;

    // Register the handle before observing, so listeners of the very first
    // event (peer.created) already see this connection in getPeers().
    let stop: () => void = () => {};
    const handle: PeerHandle = {
      peerId,
      pc,
      ...(meta.label && { label: meta.label }),
      ...(meta.group && { group: meta.group }),
      dispose: () => {
        stop();
        this.handles.delete(peerId);
        this.observed.delete(pc);
      },
    };
    this.handles.set(peerId, handle);
    this.observed.set(pc, handle);
    stop = observePeerConnection(
      pc,
      {
        peerId,
        ...(meta.label && { label: meta.label }),
        ...(meta.group && { group: meta.group }),
        redact: this.options.redact,
        statsIntervalMs: this.options.statsIntervalMs,
        payload: this.options.payload,
        previewLength: this.options.previewLength,
        captureMessages: this.options.captureMessages,
      },
      {
        emit: (type, details, correlationId) => this.record(peerId, type, details, correlationId),
        channelKey: () => `${peerId}/dc-${++this.channelSeq}`,
        now: this.now,
      },
    );
    return handle;
  }

  /** Low-level: record an event for a peer. */
  record<T extends RTCEventType>(peerId: string, type: T, details: EventDetailsMap[T], correlationId?: string): RTCTraceEvent<T> {
    this.seq += 1;
    const event: RTCTraceEvent<T> = {
      id: `${this.idPrefix}-${this.seq}`,
      seq: this.seq,
      timestamp: this.now(),
      peerId,
      type,
      category: EVENT_CATEGORY[type],
      details,
      ...(correlationId && { correlationId }),
    };
    this.store(event as RTCTraceEvent);
    return event;
  }

  /**
   * Annotate a message travelling over the application's signaling channel.
   * Call with direction "sent" on the sender and "received" on the receiver,
   * using the same `messageId`, and the timeline will draw the arrow.
   */
  signaling(peerId: string, details: SignalingMessageDetails): RTCTraceEvent<"signaling.message"> {
    return this.record(peerId, "signaling.message", details, details.messageId ? `sig:${details.messageId}` : undefined);
  }

  /** Free-form marker on the timeline ("user clicked call", "joined room"…). */
  annotate(peerId: string, label: string, data?: unknown): RTCTraceEvent<"annotation"> {
    return this.record(peerId, "annotation", { label, ...(data !== undefined && { data }) });
  }

  /** Add an event produced elsewhere (remote SDK, imported trace) as-is. */
  ingest(event: RTCTraceEvent): void {
    this.seq = Math.max(this.seq, event.seq);
    this.store(event);
  }

  subscribe(listener: TraceListener, options: { replay?: boolean } = {}): () => void {
    if (options.replay) {
      for (const e of this.getAllEvents()) safely(() => listener(e));
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Non-stats events in recording order. */
  getEvents(): RTCTraceEvent[] {
    return this.events.slice();
  }

  getStatsSamples(): RTCTraceEvent<"stats.sample">[] {
    return this.stats.slice();
  }

  getSnapshot(): SessionSnapshot {
    return { events: this.getEvents(), stats: this.getStatsSamples() };
  }

  /** Every event including stats, ordered by sequence. */
  getAllEvents(): RTCTraceEvent[] {
    return [...this.events, ...this.stats].sort((a, b) => a.seq - b.seq);
  }

  getPeers(): PeerHandle[] {
    return [...this.handles.values()];
  }

  clear(): void {
    this.events = [];
    this.stats = [];
    this.droppedEvents = 0;
  }

  exportTrace(extra: { userAgent?: string } = {}): TraceFile {
    return createTrace(this.getAllEvents(), {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      redacted: this.options.redact,
      ...extra,
    });
  }

  /** Stop observing every peer connection. */
  dispose(): void {
    for (const handle of [...this.handles.values()]) handle.dispose();
    this.listeners.clear();
  }

  private store(event: RTCTraceEvent): void {
    if (event.type === "stats.sample") {
      this.stats.push(event as RTCTraceEvent<"stats.sample">);
      if (this.stats.length > this.options.maxStatsSamples) {
        this.stats.splice(0, Math.ceil(this.options.maxStatsSamples * 0.1));
      }
    } else {
      this.events.push(event);
      if (this.events.length > this.options.maxEvents) {
        const drop = Math.ceil(this.options.maxEvents * 0.1);
        this.events.splice(0, drop);
        this.droppedEvents += drop;
      }
    }
    for (const listener of this.listeners) safely(() => listener(event));
  }
}

export function createInspectorSession(options?: InspectorOptions): InspectorSession {
  return new InspectorSession(options);
}
