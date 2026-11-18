/**
 * UI state. The inspector never talks to RTCPeerConnection: it subscribes to
 * a TraceSource (a live InspectorSession, or a static imported trace) and
 * batches incoming events so a chatty DataChannel can't re-render per message.
 */

import { createStore, type StoreApi } from "zustand/vanilla";
import type { EventCategory, RTCTraceEvent, TraceFile } from "@rtc-inspector/core";

export type TabKey = "overview" | "events" | "timeline" | "signaling" | "ice" | "datachannels" | "stats";

export const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "events", label: "Events" },
  { key: "timeline", label: "Timeline" },
  { key: "signaling", label: "Signaling" },
  { key: "ice", label: "ICE" },
  { key: "datachannels", label: "Data channels" },
  { key: "stats", label: "Stats" },
];

export const TIMELINE_CATEGORIES: { key: EventCategory; label: string }[] = [
  { key: "lifecycle", label: "Lifecycle" },
  { key: "signaling", label: "Signaling" },
  { key: "ice", label: "ICE" },
  { key: "connection", label: "Connection" },
  { key: "datachannel", label: "Data channels" },
  { key: "media", label: "Media" },
  { key: "error", label: "Errors" },
  { key: "annotation", label: "Notes" },
];

/** Anything that can feed the inspector. `InspectorSession` implements it. */
export interface TraceSource {
  getSnapshot(): { events: RTCTraceEvent[]; stats: RTCTraceEvent<"stats.sample">[] };
  subscribe?(listener: (event: RTCTraceEvent) => void): () => void;
  clear?(): void;
}

export function staticSource(trace: TraceFile | RTCTraceEvent[]): TraceSource {
  const all = Array.isArray(trace) ? trace : trace.events;
  const events = all.filter((e) => e.type !== "stats.sample");
  const stats = all.filter((e): e is RTCTraceEvent<"stats.sample"> => e.type === "stats.sample");
  return { getSnapshot: () => ({ events, stats }) };
}

export type SdpView = "structure" | "raw" | "compare";
export type EventView = "diff" | "state" | "event" | "explain";

export interface InspectorState {
  events: RTCTraceEvent[];
  stats: RTCTraceEvent<"stats.sample">[];
  live: boolean;
  paused: boolean;
  pending: number;
  /** Clock used for "stuck for N seconds" diagnostics. */
  now: number;
  tab: TabKey;
  focusPeerId?: string;
  preferGroup?: string;
  selectedEventId?: string;
  hiddenPeers: string[];
  categories: EventCategory[];
  showMessages: boolean;
  search: string;
  timelineView: "sequence" | "list";
  laneBy: "peer" | "group";
  sdpEventId?: string;
  sdpView: SdpView;
  compare: { left?: string; right?: string };
  /** Time travel: when set, every view shows the session right after this event. */
  travelEventId?: string;
  eventView: EventView;

  setTab: (tab: TabKey) => void;
  focusPeer: (peerId: string | undefined) => void;
  selectEvent: (eventId: string | undefined) => void;
  togglePeer: (peerId: string) => void;
  toggleCategory: (category: EventCategory) => void;
  setShowMessages: (show: boolean) => void;
  setSearch: (search: string) => void;
  setTimelineView: (view: "sequence" | "list") => void;
  setLaneBy: (laneBy: "peer" | "group") => void;
  openSdp: (eventId: string, view?: SdpView) => void;
  setSdpView: (view: SdpView) => void;
  setCompare: (side: "left" | "right", eventId: string | undefined) => void;
  setPaused: (paused: boolean) => void;
  clear: () => void;
  /** Jump to the state right after an event; undefined returns to live. */
  setTravel: (eventId: string | undefined) => void;
  /** Move the time-travel cursor by `delta` events (and select that event). */
  stepTravel: (delta: number) => void;
  setEventView: (view: EventView) => void;
}

export interface InspectorStoreHandle {
  store: StoreApi<InspectorState>;
  dispose: () => void;
}

export interface CreateStoreOptions {
  /** Batch window for incoming events. */
  flushMs?: number;
  maxEvents?: number;
  maxStats?: number;
  initialTab?: TabKey;
  /** Endpoint to show first when nothing is selected (see defaultFocus). */
  preferGroup?: string;
}

export function createInspectorStore(source: TraceSource, options: CreateStoreOptions = {}): InspectorStoreHandle {
  const { flushMs = 120, maxEvents = 20_000, maxStats = 6_000 } = options;
  const live = typeof source.subscribe === "function";
  const snapshot = source.getSnapshot();
  const last = (list: RTCTraceEvent[]) => list[list.length - 1]?.timestamp ?? 0;

  const store = createStore<InspectorState>()((set, get) => ({
    events: snapshot.events,
    stats: snapshot.stats,
    live,
    paused: false,
    pending: 0,
    now: live ? Date.now() : Math.max(last(snapshot.events), last(snapshot.stats)),
    tab: options.initialTab ?? "overview",
    ...(options.preferGroup && { preferGroup: options.preferGroup }),
    hiddenPeers: [],
    categories: TIMELINE_CATEGORIES.map((c) => c.key),
    showMessages: true,
    search: "",
    timelineView: "sequence",
    laneBy: "peer",
    sdpView: "structure",
    compare: {},
    eventView: "diff",

    setTab: (tab) => set({ tab }),
    focusPeer: (focusPeerId) => set({ focusPeerId }),
    selectEvent: (selectedEventId) => {
      const event = selectedEventId ? get().events.find((e) => e.id === selectedEventId) : undefined;
      set({ selectedEventId, ...(event && { focusPeerId: event.peerId }) });
    },
    togglePeer: (peerId) =>
      set((s) => ({ hiddenPeers: s.hiddenPeers.includes(peerId) ? s.hiddenPeers.filter((p) => p !== peerId) : [...s.hiddenPeers, peerId] })),
    toggleCategory: (category) =>
      set((s) => ({ categories: s.categories.includes(category) ? s.categories.filter((c) => c !== category) : [...s.categories, category] })),
    setShowMessages: (showMessages) => set({ showMessages }),
    setSearch: (search) => set({ search }),
    setTimelineView: (timelineView) => set({ timelineView }),
    setLaneBy: (laneBy) => set({ laneBy }),
    openSdp: (sdpEventId, view = "structure") => {
      const event = get().events.find((e) => e.id === sdpEventId);
      set({ tab: "signaling", sdpEventId, sdpView: view, ...(event && { focusPeerId: event.peerId }) });
    },
    setSdpView: (sdpView) => set({ sdpView }),
    setCompare: (side, eventId) => set((s) => ({ compare: { ...s.compare, [side]: eventId } })),
    setPaused: (paused) => {
      set({ paused });
      if (!paused) flush();
    },
    clear: () => {
      source.clear?.();
      pending = [];
      set({ events: [], stats: [], pending: 0, selectedEventId: undefined, sdpEventId: undefined, compare: {}, focusPeerId: undefined, travelEventId: undefined });
    },
    setTravel: (travelEventId) => {
      const { events } = get();
      const last = events[events.length - 1];
      set({ travelEventId: travelEventId && travelEventId !== last?.id ? travelEventId : undefined });
    },
    stepTravel: (delta) => {
      const { events, travelEventId, selectedEventId } = get();
      if (!events.length) return;
      const from = travelEventId ?? selectedEventId;
      const current = from ? events.findIndex((e) => e.id === from) : events.length - 1;
      const next = Math.min(events.length - 1, Math.max(0, (current === -1 ? events.length - 1 : current) + delta));
      const id = events[next]!.id;
      set({ travelEventId: next === events.length - 1 ? undefined : id, selectedEventId: id, focusPeerId: events[next]!.peerId });
    },
    setEventView: (eventView) => set({ eventView }),
  }));

  let pending: RTCTraceEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  function flush() {
    timer = undefined;
    if (store.getState().paused) {
      store.setState({ pending: pending.length });
      return;
    }
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    const events: RTCTraceEvent[] = [];
    const stats: RTCTraceEvent<"stats.sample">[] = [];
    for (const e of batch) (e.type === "stats.sample" ? stats : events).push(e as RTCTraceEvent<"stats.sample">);
    store.setState((s) => ({
      pending: 0,
      events: events.length ? trim(appendInOrder(s.events, events), maxEvents) : s.events,
      stats: stats.length ? trim(appendInOrder(s.stats, stats), maxStats) : s.stats,
    }));
  }

  const unsubscribe = source.subscribe?.((event) => {
    pending.push(event);
    timer ??= setTimeout(flush, flushMs);
  });
  const clock = live ? setInterval(() => store.setState({ now: Date.now() }), 1000) : undefined;

  return {
    store,
    dispose: () => {
      unsubscribe?.();
      if (timer) clearTimeout(timer);
      if (clock) clearInterval(clock);
    },
  };
}

const byTime = (a: RTCTraceEvent, b: RTCTraceEvent) => a.timestamp - b.timestamp || a.seq - b.seq;

/**
 * Append a batch, keeping time order. One page delivers in order, but events
 * merged from several pages can arrive slightly late; those are slotted in.
 */
export function appendInOrder<T extends RTCTraceEvent>(list: T[], batch: T[]): T[] {
  const sorted = batch.every((e, i) => i === 0 || byTime(batch[i - 1]!, e) <= 0) ? batch : [...batch].sort(byTime);
  const last = list[list.length - 1];
  if (!last || byTime(last, sorted[0]!) <= 0) return [...list, ...sorted];
  return [...list, ...sorted].sort(byTime);
}

function trim<T>(list: T[], max: number): T[] {
  return list.length > max ? list.slice(list.length - max) : list;
}

/**
 * Until the user picks one, follow the first connection that is still open, so a
 * call that was stopped and started again shows its new connections rather than the
 * first, closed one. When everything is closed, the newest. With `preferGroup`
 * (the tab the inspector was opened from), that endpoint's connections come first.
 */
export function defaultFocus<P extends { closedAt?: number; group?: string }>(peers: readonly P[], preferGroup?: string): P | undefined {
  const mine = preferGroup ? peers.filter((p) => p.group === preferGroup) : [];
  const pool = mine.length ? mine : peers;
  return pool.find((p) => p.closedAt === undefined) ?? pool[pool.length - 1];
}
