/**
 * Pulls events from the inspected page and turns each page session into a
 * TraceSource the inspector UI can render. A reload creates a new session.
 */

import type { RTCTraceEvent } from "@rtc-inspector/core";
import type { TraceSource } from "@rtc-inspector/ui";
import type { BridgeRead } from "../bridge";
import type { PageReader } from "../readers";

const PAGE = 2000;

export class SessionSource implements TraceSource {
  private events: RTCTraceEvent[] = [];
  private stats: RTCTraceEvent<"stats.sample">[] = [];
  private readonly listeners = new Set<(event: RTCTraceEvent) => void>();

  constructor(
    readonly sessionId: string,
    readonly url: string,
    private readonly clearRemote: () => void,
  ) {}

  push(events: RTCTraceEvent[]): void {
    for (const e of events) {
      if (e.type === "stats.sample") this.stats.push(e as RTCTraceEvent<"stats.sample">);
      else this.events.push(e);
      for (const l of this.listeners) l(e);
    }
  }

  getSnapshot() {
    return { events: this.events.slice(), stats: this.stats.slice() };
  }

  subscribe(listener: (event: RTCTraceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.events = [];
    this.stats = [];
    this.clearRemote();
  }
}

export type PollStatus = { kind: "waiting" } | { kind: "attached"; source: SessionSource } | { kind: "error"; message: string };

export class PagePoller {
  private source: SessionSource | undefined;
  private cursor = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private lastKind: PollStatus["kind"] | undefined;

  constructor(
    private readonly reader: PageReader,
    private readonly onStatus: (status: PollStatus) => void,
    private readonly intervalMs = 400,
  ) {}

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** One poll: drain everything new from the page. Exposed for tests. */
  async poll(): Promise<void> {
    let read: BridgeRead | null;
    do {
      read = await this.reader.read(this.cursor, PAGE);
      if (!read) {
        this.source = undefined;
        this.cursor = 0;
        this.report({ kind: "waiting" });
        return;
      }
      if (!this.source || this.source.sessionId !== read.sessionId) {
        // New page load (or first contact): start over from the beginning.
        if (this.source && this.cursor > 0) {
          this.cursor = 0;
          read = await this.reader.read(0, PAGE);
          if (!read) return;
        }
        // Clearing a page that just closed fails; there is nothing left to clear then.
        this.source = new SessionSource(read.sessionId, read.url, () => void this.reader.clear().catch(() => {}));
        this.report({ kind: "attached", source: this.source }, true);
      }
      if (read.events.length) {
        this.source.push(read.events);
        this.cursor = read.events[read.events.length - 1]!.seq;
      }
    } while (read.more && !this.stopped);
  }

  private report(status: PollStatus, force = false) {
    if (!force && status.kind === this.lastKind) return;
    this.lastKind = status.kind;
    this.onStatus(status);
  }

  private async loop() {
    if (this.stopped) return;
    try {
      await this.poll();
    } catch (err) {
      this.source = undefined;
      this.cursor = 0;
      this.report({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.loop(), this.intervalMs);
  }
}
