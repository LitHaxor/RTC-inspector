/**
 * Every tab of one site in one inspector. When peers meet through a signaling
 * server, the two ends of a call are in different tabs, each with its own
 * recording. This polls every tab of the origin and merges what they recorded.
 *
 * Connection ids are namespaced per tab ("Tab 2 pc-1"), so the pc-1 of one tab
 * never collides with the pc-1 of another. Correlation ids are left alone: they
 * come from the SDP itself (the o= session id), so the offer one tab applied is
 * matched with the tab that received it, and the timeline draws the arrow.
 */

import type { RTCTraceEvent } from "@rtc-inspector/core";
import { appendInOrder, type TraceSource } from "@rtc-inspector/ui";
import type { PageReader } from "../readers";
import { PagePoller, type SessionSource } from "./poller";

export interface TabDirectory {
  /** Ids of the tabs currently showing this origin, in any order. */
  list(origin: string): Promise<number[]>;
  reader(tabId: number): PageReader;
}

export interface TabInfo {
  tabId: number;
  /** "Tab 2": assigned once, in order of tab creation, never reused. */
  n: number;
  /** The page has a recording (the extension's script is running in it). */
  recording: boolean;
  /** Still open on this origin. A tab that closed keeps what it recorded. */
  open: boolean;
}

interface Entry {
  tabId: number;
  n: number;
  open: boolean;
  poller: PagePoller;
  source?: SessionSource;
  unsubscribe?: () => void;
}

/** Rewrite one tab's event so its connection and channel ids are unique across tabs. */
export function namespaceEvent(event: RTCTraceEvent, n: number): RTCTraceEvent {
  const key = `tab-${n}`;
  const details = event.details as Record<string, unknown>;
  let next = details;
  if (event.type === "peer.created") {
    next = { ...details, label: `Tab ${n} ${typeof details.label === "string" ? details.label : event.peerId}`, group: `Tab ${n}` };
  } else if (typeof details.channelKey === "string") {
    next = { ...details, channelKey: `${key}/${details.channelKey}` };
  }
  return { ...event, peerId: `${key}/${event.peerId}`, details: next } as RTCTraceEvent;
}

const byTime = (a: RTCTraceEvent, b: RTCTraceEvent) => a.timestamp - b.timestamp || a.seq - b.seq;

export class MultiTabSource implements TraceSource {
  /** Goes up when a tab reloads: its old recording is dropped and the view starts over. */
  generation = 0;
  private readonly entries = new Map<number, Entry>();
  private readonly listeners = new Set<(event: RTCTraceEvent) => void>();
  private merged: RTCTraceEvent[] = [];
  private batch: RTCTraceEvent[] = [];
  private rebuild = false;
  private changed = false;
  private nextN = 1;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;

  constructor(
    private readonly directory: TabDirectory,
    private readonly origin: string,
    /** Called after a poll that changed the tab list or the generation. */
    private readonly onChange: () => void = () => {},
    private readonly intervalMs = 400,
  ) {}

  tabs(): TabInfo[] {
    return [...this.entries.values()].map((e) => ({ tabId: e.tabId, n: e.n, recording: !!e.source, open: e.open }));
  }

  getSnapshot() {
    const events: RTCTraceEvent[] = [];
    const stats: RTCTraceEvent<"stats.sample">[] = [];
    for (const e of this.merged) (e.type === "stats.sample" ? stats : events).push(e as RTCTraceEvent<"stats.sample">);
    return { events, stats };
  }

  subscribe(listener: (event: RTCTraceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    for (const e of this.entries.values()) {
      if (e.open) {
        e.source?.clear();
      } else {
        // A closed tab cannot be reached; forget what it recorded.
        e.unsubscribe?.();
        e.unsubscribe = undefined;
        e.source = undefined;
      }
    }
    this.merged = [];
    this.batch = [];
    this.onChange(); // the count of tabs with a recording may have dropped
  }

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** One round: find the origin's tabs, read what each recorded since last time, merge. */
  async poll(): Promise<void> {
    const ids = new Set(await this.directory.list(this.origin));
    for (const tabId of [...ids].sort((a, b) => a - b)) if (!this.entries.has(tabId)) this.add(tabId);
    for (const e of this.entries.values()) {
      if (e.open !== ids.has(e.tabId)) this.changed = true;
      e.open = ids.has(e.tabId);
    }
    await Promise.all(
      [...this.entries.values()]
        .filter((e) => e.open)
        .map((e) =>
          e.poller.poll().catch(() => {
            e.open = false; // closed between listing and reading
          }),
        ),
    );
    this.flush();
  }

  private add(tabId: number) {
    const n = this.nextN++;
    const entry: Entry = {
      tabId,
      n,
      open: true,
      poller: new PagePoller(this.directory.reader(tabId), (status) => {
        if (status.kind !== "attached") return;
        if (entry.source) this.rebuild = true; // the tab reloaded
        entry.unsubscribe?.();
        entry.source = status.source;
        entry.unsubscribe = status.source.subscribe((event) => this.batch.push(namespaceEvent(event, n)));
        this.changed = true;
      }),
    };
    this.entries.set(tabId, entry);
    this.changed = true;
  }

  private flush() {
    if (this.rebuild) {
      this.rebuild = false;
      this.batch = [];
      const all: RTCTraceEvent[] = [];
      for (const e of this.entries.values()) {
        const snapshot = e.source?.getSnapshot();
        if (snapshot) for (const event of [...snapshot.events, ...snapshot.stats]) all.push(namespaceEvent(event, e.n));
      }
      this.merged = all.sort(byTime);
      this.generation += 1;
      this.changed = true;
    } else if (this.batch.length) {
      const batch = this.batch.sort(byTime);
      this.batch = [];
      this.merged = appendInOrder(this.merged, batch);
      for (const event of batch) for (const l of this.listeners) l(event);
    }
    if (this.changed) {
      this.changed = false;
      this.onChange();
    }
  }

  private async loop() {
    if (this.stopped) return;
    try {
      await this.poll();
    } catch {
      // listing tabs failed (the extension is going away); try again next round
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.loop(), this.intervalMs);
  }
}
