"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useStore, type StoreApi } from "zustand";
import {
  buildFlows,
  diagnose,
  projectSession,
  type Finding,
  type Flow,
  type PeerModel,
  type RTCTraceEvent,
  type SessionModel,
} from "@rtc-inspector/core";
import { defaultFocus, type InspectorState } from "./store";

const StoreContext = createContext<StoreApi<InspectorState> | null>(null);

export interface Derived {
  /** Model of the session, as of the time-travel cursor when one is set. */
  model: SessionModel;
  /** Events visible at the cursor (all of them when live). */
  visibleEvents: RTCTraceEvent[];
  /** Index of the cursor in the full event list, or undefined when live. */
  travelIndex?: number;
  flows: Flow[];
  findings: Finding[];
  /** Earliest timestamp, the zero of every relative time. */
  origin: number;
  eventsById: Map<string, RTCTraceEvent>;
  flowsByEvent: Map<string, Flow[]>;
  focusPeer?: PeerModel;
}

const DerivedContext = createContext<Derived | null>(null);

export function useInspector<T>(selector: (s: InspectorState) => T): T {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useInspector must be used inside <InspectorProvider>");
  return useStore(store, selector);
}

export function useDerived(): Derived {
  const derived = useContext(DerivedContext);
  if (!derived) throw new Error("useDerived must be used inside <InspectorProvider>");
  return derived;
}

function DerivedProvider({ children }: { children: ReactNode }) {
  const allEvents = useInspector((s) => s.events);
  const allStats = useInspector((s) => s.stats);
  const liveNow = useInspector((s) => s.now);
  const focusPeerId = useInspector((s) => s.focusPeerId);
  const preferGroup = useInspector((s) => s.preferGroup);
  const travelEventId = useInspector((s) => s.travelEventId);

  // Time travel: everything below is computed from a prefix of the stream.
  const { events, stats, now, travelIndex } = useMemo(() => {
    const index = travelEventId ? allEvents.findIndex((e) => e.id === travelEventId) : -1;
    if (index === -1) return { events: allEvents, stats: allStats, now: liveNow, travelIndex: undefined };
    const until = allEvents[index]!.timestamp;
    return { events: allEvents.slice(0, index + 1), stats: allStats.filter((s) => s.timestamp <= until), now: until, travelIndex: index };
  }, [allEvents, allStats, liveNow, travelEventId]);

  const base = useMemo(() => {
    const model = projectSession(stats.length ? [...events, ...stats] : events);
    const flows = buildFlows(events, model);
    const eventsById = new Map(allEvents.map((e) => [e.id, e]));
    const flowsByEvent = new Map<string, Flow[]>();
    for (const f of flows) {
      flowsByEvent.set(f.fromEventId, [...(flowsByEvent.get(f.fromEventId) ?? []), f]);
      flowsByEvent.set(f.toEventId, [...(flowsByEvent.get(f.toEventId) ?? []), f]);
    }
    // Relative times are measured from the start of the whole recording, so they don't shift while time traveling.
    const first = Math.min(allEvents[0]?.timestamp ?? Infinity, allStats[0]?.timestamp ?? Infinity);
    return { model, flows, eventsById, flowsByEvent, visibleEvents: events, origin: Number.isFinite(first) ? first : 0 };
  }, [events, stats, allEvents, allStats]);

  const findings = useMemo(() => diagnose(base.model, now), [base.model, now]);
  const value = useMemo<Derived>(() => {
    const focusPeer = (focusPeerId && base.model.byId[focusPeerId]) || defaultFocus(base.model.peers, preferGroup);
    return { ...base, findings, ...(travelIndex !== undefined && { travelIndex }), ...(focusPeer && { focusPeer }) };
  }, [base, findings, focusPeerId, preferGroup, travelIndex]);

  return <DerivedContext.Provider value={value}>{children}</DerivedContext.Provider>;
}

export function InspectorProvider({ store, children }: { store: StoreApi<InspectorState>; children: ReactNode }) {
  return (
    <StoreContext.Provider value={store}>
      <DerivedProvider>{children}</DerivedProvider>
    </StoreContext.Provider>
  );
}
