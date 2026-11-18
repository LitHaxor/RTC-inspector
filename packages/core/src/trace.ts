/** Portable trace files: export a session, open it later in the inspector. */

import { EVENT_CATEGORY, type RTCTraceEvent } from "./types";

export const TRACE_FORMAT = "rtc-inspector-trace";
export const TRACE_VERSION = 1;

export interface TraceFile {
  format: typeof TRACE_FORMAT;
  version: number;
  exportedAt: string;
  sessionId: string;
  startedAt: number;
  redacted: boolean;
  userAgent?: string;
  events: RTCTraceEvent[];
}

export function createTrace(
  events: RTCTraceEvent[],
  meta: { sessionId: string; startedAt: number; redacted: boolean; userAgent?: string },
): TraceFile {
  return {
    format: TRACE_FORMAT,
    version: TRACE_VERSION,
    exportedAt: new Date().toISOString(),
    ...meta,
    events: [...events].sort((a, b) => a.timestamp - b.timestamp || a.seq - b.seq),
  };
}

export class TraceFormatError extends Error {
  override name = "TraceFormatError";
}

/** Validate and normalise a parsed or raw JSON trace. */
export function parseTrace(input: string | unknown): TraceFile {
  let data: unknown = input;
  if (typeof input === "string") {
    try {
      data = JSON.parse(input);
    } catch (err) {
      throw new TraceFormatError(`Not valid JSON: ${(err as Error).message}`);
    }
  }
  if (!data || typeof data !== "object") throw new TraceFormatError("Trace must be a JSON object");
  const t = data as Partial<TraceFile>;
  // Accept a bare array of events too (e.g. piped from a custom transport).
  if (Array.isArray(data)) return parseTrace({ format: TRACE_FORMAT, version: TRACE_VERSION, events: data });
  if (t.format !== TRACE_FORMAT) throw new TraceFormatError(`Unknown format "${String(t.format)}"`);
  if (typeof t.version !== "number" || t.version > TRACE_VERSION) {
    throw new TraceFormatError(`Unsupported trace version ${String(t.version)}`);
  }
  if (!Array.isArray(t.events)) throw new TraceFormatError("Trace has no events array");
  const events: RTCTraceEvent[] = [];
  t.events.forEach((e, i) => {
    const ev = e as Partial<RTCTraceEvent>;
    if (typeof ev?.type !== "string" || typeof ev.peerId !== "string" || typeof ev.timestamp !== "number") {
      throw new TraceFormatError(`Event #${i} is missing type, peerId or timestamp`);
    }
    if (!(ev.type in EVENT_CATEGORY)) return; // forward compatible: skip unknown event types
    events.push({
      ...(ev as RTCTraceEvent),
      id: ev.id ?? `imported-${i}`,
      seq: typeof ev.seq === "number" ? ev.seq : i,
      category: EVENT_CATEGORY[ev.type],
      details: ev.details ?? {},
    } as RTCTraceEvent);
  });
  events.sort((a, b) => a.timestamp - b.timestamp || a.seq - b.seq);
  return {
    format: TRACE_FORMAT,
    version: t.version,
    exportedAt: t.exportedAt ?? new Date(0).toISOString(),
    sessionId: t.sessionId ?? "imported",
    startedAt: t.startedAt ?? events[0]?.timestamp ?? 0,
    redacted: t.redacted ?? false,
    ...(t.userAgent && { userAgent: t.userAgent }),
    events,
  };
}
