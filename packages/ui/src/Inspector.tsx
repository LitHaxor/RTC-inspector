"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Download, Pause, Play, Trash2 } from "lucide-react";
import { createTrace, summarizePeer, type InspectorSession, type TraceFile } from "@rtc-inspector/core";
import { InspectorProvider, useDerived, useInspector } from "./context";
import { TABS, createInspectorStore, staticSource, type InspectorStoreHandle, type TabKey, type TraceSource } from "./store";
import { Button, Chip, StateChip, cx } from "./components/primitives";
import { EventDetail } from "./components/EventDetail";
import { Overview } from "./overview/Overview";
import { Timeline } from "./timeline/Timeline";
import { Signaling } from "./signaling/Signaling";
import { Ice } from "./ice/Ice";
import { DataChannels } from "./datachannels/DataChannels";
import { Statistics } from "./statistics/Statistics";
import { EventLog } from "./events/EventLog";
import { TimeTravelBar } from "./events/TimeTravel";

export interface RTCInspectorProps {
  /** A live session (from @rtc-inspector/sdk or core). */
  session?: InspectorSession;
  /** A recorded trace to view. */
  trace?: TraceFile;
  /** Any other event source. */
  source?: TraceSource;
  title?: ReactNode;
  initialTab?: TabKey;
  /** Mirror the selected tab in location.hash (#timeline). */
  syncHash?: boolean;
  /** Extra controls rendered in the top bar. */
  actions?: ReactNode;
  /** Tighter chrome for small surfaces such as an extension popup: icon-only buttons. */
  compact?: boolean;
  /** Endpoint (connection group) to show first, e.g. the tab the inspector was opened from. */
  focusGroup?: string;
  /** Called when the user switches sections, so a host can reopen on the same one. */
  onTabChange?: (tab: TabKey) => void;
  className?: string;
}

/**
 * The visual inspector. Give it a live session or a trace file; it derives
 * everything else from the event stream.
 */
export function RTCInspector({ session, trace, source, title = "RTC Inspector", initialTab, syncHash, actions, compact, focusGroup, onTabChange, className }: RTCInspectorProps) {
  const resolved = useMemo(() => source ?? session ?? (trace ? staticSource(trace) : undefined), [source, session, trace]);
  const [handle, setHandle] = useState<InspectorStoreHandle>();
  const tabChanged = useRef(onTabChange);
  tabChanged.current = onTabChange;

  // The store subscribes to the source, so it is created (and disposed) in an
  // effect: one store per source, no leaked subscriptions under StrictMode.
  useEffect(() => {
    if (!resolved) return;
    const h = createInspectorStore(resolved, { ...(initialTab && { initialTab }), ...(focusGroup && { preferGroup: focusGroup }) });
    const unsubscribe = h.store.subscribe((state, previous) => {
      if (state.tab !== previous.tab) tabChanged.current?.(state.tab);
    });
    setHandle(h);
    return () => {
      unsubscribe();
      h.dispose();
      setHandle(undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved]);

  if (!handle) return null;
  return (
    <InspectorProvider store={handle.store}>
      <Shell title={title} actions={actions} className={className} syncHash={!!syncHash} compact={!!compact} />
    </InspectorProvider>
  );
}

function useHashSync(enabled: boolean) {
  const tab = useInspector((s) => s.tab);
  const setTab = useInspector((s) => s.setTab);
  useEffect(() => {
    if (!enabled) return;
    const read = () => {
      const key = window.location.hash.slice(1) as TabKey;
      if (TABS.some((t) => t.key === key)) setTab(key);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [enabled, setTab]);
  useEffect(() => {
    if (enabled && window.location.hash.slice(1) !== tab) history.replaceState(null, "", `#${tab}`);
  }, [enabled, tab]);
}

function Shell({ title, actions, className, syncHash, compact }: { title: ReactNode; actions?: ReactNode; className?: string; syncHash: boolean; compact: boolean }) {
  const tab = useInspector((s) => s.tab);
  const setTab = useInspector((s) => s.setTab);
  const selectedId = useInspector((s) => s.selectedEventId);
  const { findings } = useDerived();
  useHashSync(syncHash);
  const errors = findings.filter((f) => f.severity === "error").length;

  return (
    <div className={cx("rtc-inspector flex h-full min-h-0 flex-col bg-ground font-sans text-sm text-fg", className)}>
      <TopBar title={title} actions={actions} compact={compact} />
      <div className="flex min-h-0 flex-1">
        <PeerRail />
        <div className="flex min-w-0 flex-1 flex-col">
          <ConnectionStrip />
          <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-3" role="tablist" aria-label="Inspector sections">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                id={`rtc-tab-${t.key}`}
                aria-selected={tab === t.key}
                aria-controls="rtc-tabpanel"
                className="tab"
                onClick={() => setTab(t.key)}
              >
                {t.label}
                {t.key === "overview" && errors > 0 && <Chip tone="error">{errors}</Chip>}
              </button>
            ))}
          </nav>
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            <div
              id="rtc-tabpanel"
              role="tabpanel"
              aria-labelledby={`rtc-tab-${tab}`}
              className={cx("min-h-0 min-w-0 flex-1 p-4", tab === "timeline" || tab === "events" ? "flex flex-col overflow-hidden" : "overflow-y-auto")}
            >
              {tab === "overview" && <Overview />}
              {tab === "events" && <EventLog />}
              {tab === "timeline" && <Timeline />}
              {tab === "signaling" && <Signaling />}
              {tab === "ice" && <Ice />}
              {tab === "datachannels" && <DataChannels />}
              {tab === "stats" && <Statistics />}
            </div>
            {selectedId && tab !== "events" && <EventDetail />}
          </div>
          <TimeTravelBar compact={compact} />
        </div>
      </div>
    </div>
  );
}

function download(trace: TraceFile) {
  const blob = new Blob([JSON.stringify(trace, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `rtc-trace-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function TopBar({ title, actions, compact }: { title: ReactNode; actions?: ReactNode; compact: boolean }) {
  const live = useInspector((s) => s.live);
  const paused = useInspector((s) => s.paused);
  const pending = useInspector((s) => s.pending);
  const setPaused = useInspector((s) => s.setPaused);
  const clear = useInspector((s) => s.clear);
  const events = useInspector((s) => s.events);
  const stats = useInspector((s) => s.stats);
  const setTravel = useInspector((s) => s.setTravel);
  const { model, travelIndex } = useDerived();

  return (
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-panel px-4 py-2">
      <div className="flex items-center gap-3">
        <h1 className="text-base font-medium text-fg">{title}</h1>
        {live ? (
          <Chip tone={paused ? "warning" : "info"}>{paused ? `paused, ${pending} waiting` : "live"}</Chip>
        ) : (
          <Chip>recorded trace</Chip>
        )}
        {travelIndex !== undefined && (
          <button type="button" className="chip chip--warning cursor-pointer" onClick={() => setTravel(undefined)} title="Return to the latest state">
            viewing event {travelIndex + 1} of {events.length}
          </button>
        )}
      </div>
      {!compact && (
        <span className="measured text-xs text-dim">
          {model.peers.length} connection{model.peers.length === 1 ? "" : "s"}, {events.length} events, {stats.length} samples
        </span>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {actions}
        {live && (
          <Button onClick={() => setPaused(!paused)} aria-pressed={paused} aria-label={paused ? "Resume" : "Pause"} title={paused ? "Resume" : "Pause"}>
            {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
            {!compact && (paused ? "Resume" : "Pause")}
          </Button>
        )}
        {live && (
          <Button onClick={clear} disabled={!events.length} aria-label="Clear" title="Clear">
            <Trash2 size={14} aria-hidden="true" />
            {!compact && "Clear"}
          </Button>
        )}
        <Button
          disabled={!events.length}
          aria-label="Export trace"
          title="Export trace"
          onClick={() =>
            download(
              createTrace([...events, ...stats], {
                sessionId: "ui-export",
                startedAt: events[0]?.timestamp ?? 0,
                redacted: true,
                ...(typeof navigator !== "undefined" && { userAgent: navigator.userAgent }),
              }),
            )
          }
        >
          <Download size={14} aria-hidden="true" />
          {!compact && "Export trace"}
        </Button>
      </div>
    </header>
  );
}

/**
 * Below the lg breakpoint (the popup, a docked DevTools panel) the rail is
 * hidden, so this row keeps every connection one click away.
 */
function ConnectionStrip() {
  const { model, focusPeer } = useDerived();
  const focus = useInspector((s) => s.focusPeer);
  const current = useRef<HTMLButtonElement>(null);
  const focusId = focusPeer?.peerId;

  useEffect(() => {
    // Keep the focused connection in view without scrolling the host page.
    const el = current.current;
    const row = el?.parentElement;
    if (!el || !row) return;
    if (el.offsetLeft < row.scrollLeft || el.offsetLeft + el.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = el.offsetLeft - 12;
  }, [focusId]);

  if (model.peers.length < 2) return null;
  return (
    <nav className="relative flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line px-3 py-1.5 lg:hidden" aria-label="Connections">
      {model.peers.map((p) => {
        const isFocus = p.peerId === focusId;
        return (
          <button
            key={p.peerId}
            ref={isFocus ? current : undefined}
            type="button"
            className="peer-pill"
            aria-current={isFocus}
            title={summarizePeer(p)}
            onClick={() => focus(p.peerId)}
          >
            {p.label}
            <StateChip kind="connection" state={p.connectionState} />
          </button>
        );
      })}
    </nav>
  );
}

function PeerRail() {
  const { model, findings, focusPeer } = useDerived();
  const focus = useInspector((s) => s.focusPeer);
  if (!model.peers.length) return null;
  const groups = new Map<string, typeof model.peers>();
  for (const p of model.peers) groups.set(p.group ?? "", [...(groups.get(p.group ?? "") ?? []), p]);
  return (
    <aside className="hidden w-64 shrink-0 flex-col overflow-y-auto border-r border-line bg-panel lg:flex" aria-label="Connections">
      <h2 className="px-4 pb-1 pt-3 text-xs font-medium text-dim">Connections</h2>
      {[...groups].map(([group, peers]) => (
        <div key={group || "_"} className="flex flex-col">
          {group && model.groups.length > 1 && <h3 className="px-4 pb-1 pt-3 text-xs text-dim">{group}</h3>}
          <ul>
            {peers.map((p) => {
              const errs = findings.filter((f) => f.peerId === p.peerId && f.severity === "error").length;
              return (
                <li key={p.peerId}>
                  <button type="button" className="row-button flex flex-col gap-1 px-4 py-2" aria-current={p.peerId === focusPeer?.peerId} onClick={() => focus(p.peerId)}>
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="truncate text-sm text-fg">{p.label}</span>
                      <StateChip kind="connection" state={p.connectionState} />
                    </span>
                    <span className="line-clamp-2 text-xs text-dim">{summarizePeer(p)}</span>
                    {errs > 0 && <Chip tone="error">{errs} error{errs > 1 ? "s" : ""}</Chip>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </aside>
  );
}
