"use client";

import { useEffect, useId, useMemo } from "react";
import { describeEvent, type PeerModel, type RTCTraceEvent } from "@rtc-inspector/core";
import { useDerived, useInspector } from "../context";
import { TIMELINE_CATEGORIES } from "../store";
import { fmtMs, relTime } from "../format";
import { ROW_H, useVirtualRows } from "../components/useVirtualRows";
import { EmptyState, Segmented, StateChip, cx } from "../components/primitives";

const TIME_W = 140;

interface Lane {
  key: string;
  label: string;
  peers: PeerModel[];
}

function useFilteredEvents() {
  const events = useDerived().visibleEvents;
  const hidden = useInspector((s) => s.hiddenPeers);
  const categories = useInspector((s) => s.categories);
  const showMessages = useInspector((s) => s.showMessages);
  const search = useInspector((s) => s.search);
  return useMemo(() => {
    const q = search.trim().toLowerCase();
    return events.filter((e) => {
      if (hidden.includes(e.peerId) || !categories.includes(e.category)) return false;
      if (!showMessages && e.type === "datachannel.message") return false;
      if (!q) return true;
      const d = describeEvent(e);
      return `${e.type} ${e.peerId} ${d.title} ${d.summary}`.toLowerCase().includes(q);
    });
  }, [events, hidden, categories, showMessages, search]);
}

export function Timeline() {
  const { model } = useDerived();
  const view = useInspector((s) => s.timelineView);
  const setView = useInspector((s) => s.setTimelineView);
  const laneBy = useInspector((s) => s.laneBy);
  const setLaneBy = useInspector((s) => s.setLaneBy);
  const hidden = useInspector((s) => s.hiddenPeers);
  const togglePeer = useInspector((s) => s.togglePeer);
  const categories = useInspector((s) => s.categories);
  const toggleCategory = useInspector((s) => s.toggleCategory);
  const showMessages = useInspector((s) => s.showMessages);
  const setShowMessages = useInspector((s) => s.setShowMessages);
  const search = useInspector((s) => s.search);
  const setSearch = useInspector((s) => s.setSearch);
  const filtered = useFilteredEvents();

  if (!model.peers.length) {
    return (
      <EmptyState title="Nothing recorded yet">
        Every offer, candidate, state change and message appears here as it happens. Create a connection to start.
      </EmptyState>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Timeline view"
          value={view}
          onChange={setView}
          options={[
            { value: "sequence", label: "Sequence" },
            { value: "list", label: "List" },
          ]}
        />
        {view === "sequence" && model.groups.length > 1 && model.groups.length < model.peers.length && (
          <Segmented
            label="Lanes"
            value={laneBy}
            onChange={setLaneBy}
            options={[
              { value: "peer", label: "Lane per connection" },
              { value: "group", label: "Lane per endpoint" },
            ]}
          />
        )}
        <input
          className="field w-56"
          type="search"
          placeholder="Filter events"
          aria-label="Filter events"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="measured text-xs text-dim" aria-live="polite">
          {filtered.length} shown
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Event categories">
        {TIMELINE_CATEGORIES.map((c) => (
          <button key={c.key} type="button" className="ctl min-h-7 px-2 text-xs" aria-pressed={categories.includes(c.key)} onClick={() => toggleCategory(c.key)}>
            {c.label}
          </button>
        ))}
        <button type="button" className="ctl min-h-7 px-2 text-xs" aria-pressed={showMessages} onClick={() => setShowMessages(!showMessages)}>
          Messages
        </button>
        {model.peers.length > 1 && <span className="mx-2 h-5 w-px bg-line" aria-hidden="true" />}
        {model.peers.length > 1 &&
          model.peers.map((p) => (
            <button key={p.peerId} type="button" className="ctl min-h-7 px-2 text-xs" aria-pressed={!hidden.includes(p.peerId)} onClick={() => togglePeer(p.peerId)}>
              {p.label}
            </button>
          ))}
      </div>
      {view === "sequence" ? <SequenceView events={filtered} /> : <ListView events={filtered} />}
    </div>
  );
}

function SequenceView({ events }: { events: RTCTraceEvent[] }) {
  const { model, flows, origin } = useDerived();
  const live = useInspector((s) => s.live);
  const laneBy = useInspector((s) => s.laneBy);
  const hidden = useInspector((s) => s.hiddenPeers);
  const selectedId = useInspector((s) => s.selectedEventId);
  const selectEvent = useInspector((s) => s.selectEvent);
  const markerId = `arrow-${useId().replace(/:/g, "")}`;

  const lanes = useMemo<Lane[]>(() => {
    const peers = model.peers.filter((p) => !hidden.includes(p.peerId));
    if (laneBy === "group" && model.groups.length > 1) {
      const byGroup = new Map<string, PeerModel[]>();
      for (const p of peers) byGroup.set(p.group ?? p.peerId, [...(byGroup.get(p.group ?? p.peerId) ?? []), p]);
      return [...byGroup].map(([key, list]) => ({ key, label: key, peers: list }));
    }
    return peers.map((p) => ({ key: p.peerId, label: p.label, peers: [p] }));
  }, [model, hidden, laneBy]);

  const laneIndex = useMemo(() => {
    const map = new Map<string, number>();
    lanes.forEach((l, i) => l.peers.forEach((p) => map.set(p.peerId, i)));
    return map;
  }, [lanes]);

  const { ref, start, end, width, onScroll, scrollTop, viewport } = useVirtualRows(events.length, live);
  const lanesW = Math.max(0, width - TIME_W);
  const n = Math.max(1, lanes.length);
  const laneW = lanesW / n;
  const offset = (i: number) => (n === 1 ? 0.1 : i === 0 ? 0.7 : i === n - 1 ? 0.3 : 0.25);
  const lifelineX = (i: number) => (i + offset(i)) * laneW;
  const labelLeft = (i: number) => n > 1 && i === 0;

  const rowOf = useMemo(() => new Map(events.map((e, i) => [e.id, i])), [events]);
  const selectedFlowIds = useMemo(
    () => new Set(flows.filter((f) => f.fromEventId === selectedId || f.toEventId === selectedId).map((f) => f.id)),
    [flows, selectedId],
  );

  // Keep a selection made elsewhere (e.g. "show evidence") in view.
  useEffect(() => {
    const el = ref.current;
    const row = selectedId ? rowOf.get(selectedId) : undefined;
    if (!el || row === undefined) return;
    const y = row * ROW_H;
    if (y < el.scrollTop || y > el.scrollTop + el.clientHeight - ROW_H) el.scrollTop = Math.max(0, y - el.clientHeight / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const top = scrollTop - ROW_H * 12;
  const bottom = scrollTop + viewport + ROW_H * 12;
  const visibleFlows = flows.filter((f) => {
    const a = rowOf.get(f.fromEventId);
    const b = rowOf.get(f.toEventId);
    if (a === undefined || b === undefined) return false;
    const la = laneIndex.get(f.fromPeerId);
    const lb = laneIndex.get(f.toPeerId);
    if (la === undefined || lb === undefined || la === lb) return false;
    return Math.max(a, b) * ROW_H >= top && Math.min(a, b) * ROW_H <= bottom;
  });

  if (!events.length) return <EmptyState title="No events match these filters" />;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-panel border border-line bg-panel">
      <div className="relative flex h-14 shrink-0 border-b border-line" style={{ paddingRight: 0 }}>
        <div className="flex shrink-0 items-end px-3 pb-2 text-xs text-dim" style={{ width: TIME_W }}>
          Time
        </div>
        <div className="relative flex-1">
          {lanes.map((lane, i) => {
            const peer = lane.peers.length === 1 ? lane.peers[0] : undefined;
            const left = labelLeft(i);
            return (
              <div
                key={lane.key}
                className={cx("absolute top-2 flex flex-col gap-1", left ? "items-end text-right" : "items-start")}
                style={left ? { right: lanesW - lifelineX(i) - 6, maxWidth: lifelineX(i) - 8 } : { left: lifelineX(i) - 6, maxWidth: laneW * 0.7 }}
              >
                <span className="truncate text-sm font-medium text-fg">{lane.label}</span>
                {peer ? <StateChip kind="connection" state={peer.connectionState} /> : <span className="text-xs text-dim">{lane.peers.length} connections</span>}
              </div>
            );
          })}
        </div>
      </div>
      <div ref={ref} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden" tabIndex={0} aria-label="Event sequence">
        <div className="relative" style={{ height: events.length * ROW_H, ["--lane-w" as string]: `${laneW}px` }}>
          {lanes.map((lane, i) => (
            <span key={lane.key} className="seq-lifeline" style={{ left: TIME_W + lifelineX(i) }} aria-hidden="true" />
          ))}
          <svg className="pointer-events-none absolute top-0 z-[1]" style={{ left: TIME_W }} width={lanesW} height={events.length * ROW_H} aria-hidden="true">
            <defs>
              <marker id={markerId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 z" fill="var(--color-cool)" />
              </marker>
              <marker id={`${markerId}-a`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 z" fill="var(--color-accent)" />
              </marker>
            </defs>
            {visibleFlows.map((f) => {
              const y1 = rowOf.get(f.fromEventId)! * ROW_H + ROW_H / 2;
              const y2 = rowOf.get(f.toEventId)! * ROW_H + ROW_H / 2;
              const x1 = lifelineX(laneIndex.get(f.fromPeerId)!);
              const x2 = lifelineX(laneIndex.get(f.toPeerId)!);
              const dir = x2 > x1 ? -1 : 1;
              const active = selectedFlowIds.has(f.id);
              return (
                <line
                  key={f.id}
                  className="seq-flow"
                  data-kind={f.kind}
                  data-active={active}
                  x1={x1}
                  y1={y1}
                  x2={x2 + dir * 6}
                  y2={y2}
                  markerEnd={`url(#${active ? `${markerId}-a` : markerId})`}
                />
              );
            })}
          </svg>
          {events.slice(start, end).map((e, k) => {
            const i = start + k;
            const prev = events[i - 1];
            const lane = laneIndex.get(e.peerId) ?? 0;
            const x = lifelineX(lane);
            const d = describeEvent(e);
            const left = labelLeft(lane);
            const prefix = lanePrefix(lanes[lane], model.byId[e.peerId]);
            const selected = e.id === selectedId;
            return (
              <button
                key={e.id}
                type="button"
                className="row-button seq-row absolute left-0 right-0"
                style={{ top: i * ROW_H }}
                aria-current={selected}
                onClick={() => selectEvent(selected ? undefined : e.id)}
                title={d.summary ? `${d.title}: ${d.summary}` : d.title}
              >
                <span className="absolute left-3 top-1/2 flex -translate-y-1/2 items-baseline gap-2 whitespace-nowrap" style={{ width: TIME_W - 12 }}>
                  <span className="measured text-xs text-reading">{relTime(e.timestamp, origin)}</span>
                  {prev && e.timestamp - prev.timestamp >= 1 && (
                    <span className="measured text-[0.6875rem] text-dim">+{fmtMs(e.timestamp - prev.timestamp)}</span>
                  )}
                </span>
                <span className="seq-marker" data-tone={d.tone} style={{ left: TIME_W + x }} />
                <span
                  className={cx("seq-label", selected ? "text-fg" : "text-fg-2")}
                  style={left ? { right: lanesW - x + 12, maxWidth: x - 20 } : { left: TIME_W + x + 12, maxWidth: Math.max(80, (lane === lanes.length - 1 || n === 1 ? lanesW - x : laneW * (1 - offset(lane))) - 24) }}
                >
                  {prefix}
                  <span className={d.tone === "error" ? "text-danger" : d.tone === "warning" ? "text-person" : undefined}>{d.title}</span>
                  {d.summary && <span className="text-dim"> {d.summary}</span>}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <Legend />
    </div>
  );
}

/** In a lane shared by several connections, name which one ("to bob"). */
function lanePrefix(lane: Lane | undefined, peer: PeerModel | undefined): string {
  if (!lane || lane.peers.length < 2 || !peer) return "";
  const own = `${lane.key} → `;
  return `${peer.label.startsWith(own) ? `to ${peer.label.slice(own.length)}` : peer.label}: `;
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-3 py-2 text-xs text-dim">
      <span className="inline-flex items-center gap-2">
        <svg width="28" height="6" aria-hidden="true">
          <line x1="0" y1="3" x2="28" y2="3" stroke="var(--color-cool)" />
        </svg>
        SDP, candidate or signaling message crossing to the other peer
      </span>
      <span className="inline-flex items-center gap-2">
        <svg width="28" height="6" aria-hidden="true">
          <line x1="0" y1="3" x2="28" y2="3" stroke="var(--color-cool)" strokeDasharray="3 3" />
        </svg>
        DataChannel message
      </span>
      <span>Select an event to see what it means.</span>
    </div>
  );
}

function ListView({ events }: { events: RTCTraceEvent[] }) {
  const { model, origin, flowsByEvent } = useDerived();
  const live = useInspector((s) => s.live);
  const selectedId = useInspector((s) => s.selectedEventId);
  const selectEvent = useInspector((s) => s.selectEvent);
  const { ref, start, end, onScroll } = useVirtualRows(events.length, live);
  if (!events.length) return <EmptyState title="No events match these filters" />;
  const cols = "grid grid-cols-[96px_80px_minmax(0,160px)_minmax(0,220px)_minmax(0,1fr)_96px] items-center gap-3 px-3";
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-panel border border-line bg-panel">
      <div className={cx(cols, "h-9 shrink-0 border-b border-line text-xs text-dim")}>
        <span>Time</span>
        <span>Since prev.</span>
        <span>Connection</span>
        <span>Event</span>
        <span>Details</span>
        <span>Crossed in</span>
      </div>
      <div ref={ref} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto" tabIndex={0} aria-label="Event list">
        <div className="relative" style={{ height: events.length * ROW_H }}>
          {events.slice(start, end).map((e, k) => {
            const i = start + k;
            const d = describeEvent(e);
            const prev = events[i - 1];
            const flow = flowsByEvent.get(e.id)?.find((f) => f.toEventId === e.id);
            return (
              <button
                key={e.id}
                type="button"
                className={cx("row-button absolute left-0 right-0 text-sm", cols)}
                style={{ top: i * ROW_H, height: ROW_H }}
                aria-current={e.id === selectedId}
                onClick={() => selectEvent(e.id === selectedId ? undefined : e.id)}
              >
                <span className="measured text-xs text-reading">{relTime(e.timestamp, origin)}</span>
                <span className="measured text-xs text-dim">{prev ? `+${fmtMs(e.timestamp - prev.timestamp)}` : ""}</span>
                <span className="truncate text-xs text-fg-2">{model.byId[e.peerId]?.label ?? e.peerId}</span>
                <span className={cx("truncate", d.tone === "error" ? "text-danger" : d.tone === "warning" ? "text-person" : "text-fg")}>{d.title}</span>
                <span className="truncate text-xs text-dim">{d.summary}</span>
                <span className="measured text-xs text-dim">{flow ? fmtMs(flow.latencyMs) : ""}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
