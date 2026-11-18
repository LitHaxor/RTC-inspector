"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { describeEvent, diffState, stateAfter, type RTCTraceEvent, type StateDiffEntry, type StateValue } from "@rtc-inspector/core";
import { useDerived, useInspector } from "../context";
import { fmtMs, relTime } from "../format";
import type { EventView } from "../store";
import { Button, Chip, EmptyState, JsonView, Segmented, cx } from "../components/primitives";
import { ROW_H, useVirtualRows } from "../components/useVirtualRows";

const VIEWS: { value: EventView; label: string }[] = [
  { value: "diff", label: "Diff" },
  { value: "state", label: "State" },
  { value: "event", label: "Event" },
  { value: "explain", label: "Explain" },
];

/**
 * The action log: every WebRTC event in order, the session as it stood right
 * after each one, and what each event changed.
 */
export function EventLog() {
  const events = useInspector((s) => s.events);
  const live = useInspector((s) => s.live);
  const selectedId = useInspector((s) => s.selectedEventId);
  const selectEvent = useInspector((s) => s.selectEvent);
  const { model, origin, travelIndex } = useDerived();
  const [filter, setFilter] = useState("");

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => {
        if (!q) return true;
        const label = model.byId[event.peerId]?.label ?? event.peerId;
        return `${event.type} ${label} ${describeEvent(event).title}`.toLowerCase().includes(q);
      });
  }, [events, filter, model]);

  // Show the latest event when nothing is selected.
  const selected = (selectedId && events.find((e) => e.id === selectedId)) || events[events.length - 1];
  const { ref, start, end, onScroll } = useVirtualRows(rows.length, live && !selectedId);

  useEffect(() => {
    const el = ref.current;
    const row = rows.findIndex((r) => r.event.id === selectedId);
    if (!el || row === -1) return;
    const y = row * ROW_H;
    if (y < el.scrollTop || y > el.scrollTop + el.clientHeight - ROW_H) el.scrollTop = Math.max(0, y - el.clientHeight / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  if (!events.length) {
    return <EmptyState title="No events yet">Every WebRTC call and state change is listed here as it happens.</EmptyState>;
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const at = rows.findIndex((r) => r.event.id === selected?.id);
    const next = rows[Math.min(rows.length - 1, Math.max(0, (at === -1 ? rows.length : at) + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) selectEvent(next.event.id);
  };

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,2fr)_minmax(0,3fr)] gap-3 md:grid-cols-[minmax(240px,340px)_minmax(0,1fr)] md:grid-rows-1">
      <section className="flex min-h-0 flex-col overflow-hidden rounded-panel border border-line bg-panel" aria-label="Event list">
        <div className="flex items-center gap-2 border-b border-line p-2">
          <input
            className="field min-w-0 flex-1"
            type="search"
            placeholder="Filter events"
            aria-label="Filter events"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <span className="measured shrink-0 text-xs text-dim">{rows.length}</span>
        </div>
        <div ref={ref} onScroll={onScroll} onKeyDown={onKeyDown} tabIndex={0} className="relative min-h-0 flex-1 overflow-y-auto" aria-label="Events, use arrow keys to move">
          <div className="relative" style={{ height: rows.length * ROW_H }}>
            {rows.slice(start, end).map(({ event, index }, k) => {
              const d = describeEvent(event);
              const future = travelIndex !== undefined && index > travelIndex;
              const isSelected = event.id === selected?.id;
              return (
                <button
                  key={event.id}
                  type="button"
                  className={cx("row-button absolute left-0 right-0 flex items-center gap-2 px-3", future && "opacity-40")}
                  style={{ top: (start + k) * ROW_H, height: ROW_H }}
                  aria-current={isSelected}
                  onClick={() => selectEvent(event.id)}
                  title={d.summary ? `${d.title}: ${d.summary}` : d.title}
                >
                  <span className={cx("measured min-w-0 flex-1 truncate text-xs", d.tone === "error" ? "text-danger" : d.tone === "warning" ? "text-person" : "text-fg")}>
                    {event.type}
                  </span>
                  <span className="max-w-[35%] shrink-0 truncate text-xs text-dim">{model.byId[event.peerId]?.label ?? event.peerId}</span>
                  <span className="measured w-16 shrink-0 text-right text-xs text-reading">{relTime(event.timestamp, origin)}</span>
                </button>
              );
            })}
          </div>
        </div>
      </section>
      {selected && <EventPane event={selected} />}
    </div>
  );
}

function EventPane({ event }: { event: RTCTraceEvent }) {
  const events = useInspector((s) => s.events);
  const stats = useInspector((s) => s.stats);
  const view = useInspector((s) => s.eventView);
  const setView = useInspector((s) => s.setEventView);
  const setTravel = useInspector((s) => s.setTravel);
  const travelEventId = useInspector((s) => s.travelEventId);
  const { model, origin } = useDerived();
  const d = describeEvent(event);

  const { before, after } = useMemo(() => {
    const index = events.findIndex((e) => e.id === event.id);
    const prev = index > 0 ? events[index - 1] : undefined;
    return {
      before: prev ? stateAfter(events, prev.id, stats) : {},
      after: stateAfter(events, event.id, stats),
    };
    // Stats samples arriving later never change the state at this event, so they are not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, event.id]);
  const diff = useMemo(() => diffState(before, after), [before, after]);
  const travelingHere = travelEventId === event.id;

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-panel border border-line bg-panel" aria-label="Selected event">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium text-fg">{d.title}</h2>
          <p className="truncate text-xs text-dim">
            {model.byId[event.peerId]?.label ?? event.peerId} at <span className="measured text-reading">{relTime(event.timestamp, origin)}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented label="Event view" value={view} onChange={setView} options={VIEWS} />
          <Button onClick={() => setTravel(travelingHere ? undefined : event.id)} aria-pressed={travelingHere} title="Show every tab as it was right after this event">
            {travelingHere ? "Back to live" : "Jump"}
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {view === "diff" && <DiffView diff={diff} />}
        {view === "state" && <JsonView value={after} openDepth={2} />}
        {view === "event" && <EventData event={event} />}
        {view === "explain" && <Explain event={event} />}
      </div>
    </section>
  );
}

function Value({ value }: { value: StateValue | undefined }) {
  if (value !== null && typeof value === "object") return <JsonView value={value} openDepth={1} />;
  return <span className="measured">{JSON.stringify(value)}</span>;
}

function DiffView({ diff }: { diff: StateDiffEntry[] }) {
  if (!diff.length) {
    return (
      <p className="text-sm text-dim">
        This event did not change any connection state. It is a record of something that happened (a message, a sample, a note).
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2 text-xs">
      {diff.map((entry) => (
        <li key={`${entry.kind}:${entry.path}`} className="grid gap-1 rounded-ctl border border-line bg-well px-3 py-2">
          <span className="measured text-fg-2">{entry.path}</span>
          {entry.kind === "changed" && (
            <span className="flex flex-wrap items-baseline gap-2">
              <span className="rounded-chip bg-danger-soft px-1.5 text-danger line-through">
                <Value value={entry.before} />
              </span>
              <span className="text-dim" aria-label="became">→</span>
              <span className="rounded-chip bg-good-soft px-1.5 text-good">
                <Value value={entry.after} />
              </span>
            </span>
          )}
          {entry.kind === "added" && (
            <span className="rounded-chip bg-good-soft px-1.5 text-good">
              <span aria-label="added">+ </span>
              <Value value={entry.after} />
            </span>
          )}
          {entry.kind === "removed" && (
            <span className="rounded-chip bg-danger-soft px-1.5 text-danger line-through">
              <span aria-label="removed">− </span>
              <Value value={entry.before} />
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function EventData({ event }: { event: RTCTraceEvent }) {
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-dim">Type</dt>
        <dd className="measured text-fg">{event.type}</dd>
        <dt className="text-dim">Category</dt>
        <dd className="text-fg-2">{event.category}</dd>
        <dt className="text-dim">Sequence</dt>
        <dd className="measured text-fg-2">#{event.seq}</dd>
        {event.correlationId && (
          <>
            <dt className="text-dim">Correlation</dt>
            <dd className="measured break-all text-fg-2">{event.correlationId}</dd>
          </>
        )}
      </dl>
      <div className="rounded-ctl border border-line bg-well p-3">
        <JsonView value={event.details} openDepth={2} />
      </div>
    </div>
  );
}

function Explain({ event }: { event: RTCTraceEvent }) {
  const { flowsByEvent, model, findings } = useDerived();
  const selectEvent = useInspector((s) => s.selectEvent);
  const d = describeEvent(event);
  const flows = flowsByEvent.get(event.id) ?? [];
  const related = findings.filter((f) => f.evidence.includes(event.id));
  return (
    <div className="flex max-w-[72ch] flex-col gap-4 text-sm">
      {d.summary && <p className="measured text-xs text-fg-2">{d.summary}</p>}
      <p className="text-fg-2">{d.explain || "No explanation for this event type."}</p>
      {flows.map((f) => {
        const outgoing = f.fromEventId === event.id;
        const other = model.byId[outgoing ? f.toPeerId : f.fromPeerId];
        return (
          <p key={f.id} className="text-fg-2">
            {outgoing ? "Arrived at " : "Sent by "}
            {other?.label ?? "peer"} <span className="measured text-reading">{fmtMs(Math.abs(f.latencyMs))}</span> {outgoing ? "later" : "earlier"}.{" "}
            <button type="button" className="link" onClick={() => selectEvent(outgoing ? f.toEventId : f.fromEventId)}>
              Show {outgoing ? "arrival" : "origin"}
            </button>
          </p>
        );
      })}
      {related.map((f) => (
        <div key={f.id} className="rounded-ctl border border-line bg-well p-3">
          <div className="flex items-center gap-2">
            <Chip tone={f.severity === "error" ? "error" : f.severity === "warning" ? "warning" : "info"}>{f.severity}</Chip>
            <span className="font-medium text-fg">{f.title}</span>
          </div>
          <p className="mt-1 text-dim">{f.explanation}</p>
        </div>
      ))}
    </div>
  );
}
