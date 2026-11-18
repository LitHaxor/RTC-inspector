"use client";

import { X } from "lucide-react";
import {
  CANDIDATE_TYPE_INFO,
  cachedParseSdp,
  describeEvent,
  sectionTitle,
  type AnyTraceEvent,
  type ParsedCandidate,
} from "@rtc-inspector/core";
import { useDerived, useInspector } from "../context";
import { clockTime, fmtBytes, fmtMs, relTime } from "../format";
import { Button, Chip, JsonView } from "./primitives";

export function EventDetail() {
  const selectedId = useInspector((s) => s.selectedEventId);
  const selectEvent = useInspector((s) => s.selectEvent);
  const { eventsById, model, origin, flowsByEvent, findings } = useDerived();
  const event = selectedId ? (eventsById.get(selectedId) as AnyTraceEvent | undefined) : undefined;
  if (!event) return null;
  const d = describeEvent(event);
  const peer = model.byId[event.peerId];
  const flows = flowsByEvent.get(event.id) ?? [];
  const related = findings.filter((f) => f.evidence.includes(event.id));

  return (
    <aside className="flex max-h-[45%] w-full min-w-0 flex-col border-t border-line bg-panel lg:max-h-none lg:w-[400px] lg:shrink-0 lg:border-l lg:border-t-0" aria-label="Event detail">
      <header className="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-fg">{d.title}</h2>
          <p className="mt-0.5 truncate text-xs text-dim">{peer?.label ?? event.peerId}</p>
        </div>
        <Button variant="quiet" aria-label="Close event detail" onClick={() => selectEvent(undefined)}>
          <X size={16} aria-hidden="true" />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4 text-sm">
        <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
          <dt className="text-dim">Time</dt>
          <dd className="measured text-reading">
            {relTime(event.timestamp, origin)} <span className="text-dim">at {clockTime(event.timestamp)}</span>
          </dd>
          <dt className="text-dim">Event</dt>
          <dd className="measured break-all text-fg-2">{event.type}</dd>
          {d.summary && (
            <>
              <dt className="text-dim">Summary</dt>
              <dd className="break-words text-fg-2">{d.summary}</dd>
            </>
          )}
        </dl>

        {d.explain && <p className="text-fg-2">{d.explain}</p>}

        {flows.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-dim">Seen on the other side</h3>
            {flows.map((f) => {
              const outgoing = f.fromEventId === event.id;
              const otherId = outgoing ? f.toEventId : f.fromEventId;
              const other = model.byId[outgoing ? f.toPeerId : f.fromPeerId];
              return (
                <p key={f.id} className="text-sm text-fg-2">
                  {outgoing ? "Arrived at " : "Sent by "}
                  {other?.label ?? "peer"}{" "}
                  <span className="measured text-reading">{fmtMs(Math.abs(f.latencyMs))}</span> {outgoing ? "later" : "earlier"}
                  {f.inferred ? " (matched by content)" : ""}.{" "}
                  <button type="button" className="link" onClick={() => selectEvent(otherId)}>
                    Show {outgoing ? "arrival" : "origin"}
                  </button>
                </p>
              );
            })}
          </section>
        )}

        <TypeSpecific event={event} />

        {related.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-dim">Part of a finding</h3>
            {related.map((f) => (
              <div key={f.id} className="rounded-ctl border border-line bg-well p-3">
                <div className="flex items-center gap-2">
                  <Chip tone={f.severity === "error" ? "error" : f.severity === "warning" ? "warning" : "info"}>{f.severity}</Chip>
                  <span className="text-sm font-medium text-fg">{f.title}</span>
                </div>
                <p className="mt-1 text-sm text-dim">{f.explanation}</p>
              </div>
            ))}
          </section>
        )}

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-dim">Recorded data</h3>
          <div className="rounded-ctl border border-line bg-well p-3">
            <JsonView value={event.details} />
          </div>
        </section>
      </div>
    </aside>
  );
}

function CandidateTable({ c }: { c: ParsedCandidate }) {
  const rows: [string, string | number | undefined][] = [
    ["Type", `${c.type} (${CANDIDATE_TYPE_INFO[c.type]?.name ?? "unknown"})`],
    ["Protocol", c.protocol + (c.tcpType ? `, ${c.tcpType}` : "")],
    ["Address", `${c.address} (${c.addressKind})`],
    ["Port", c.port],
    ["Priority", c.priority],
    ["Type preference", c.typePreference],
    ["Local preference", c.localPreference],
    ["Component", `${c.component} (${c.componentName})`],
    ["Foundation", c.foundation],
    ["Related address", c.relatedAddress ? `${c.relatedAddress}:${c.relatedPort ?? ""}` : undefined],
    ["Network cost", c.networkCost],
  ];
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-dim">Candidate</h3>
      <p className="text-sm text-fg-2">{CANDIDATE_TYPE_INFO[c.type]?.meaning}</p>
      <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {rows
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-dim">{k}</dt>
              <dd className="measured break-all text-fg">{v}</dd>
            </div>
          ))}
      </dl>
    </section>
  );
}

function TypeSpecific({ event }: { event: AnyTraceEvent }) {
  const openSdp = useInspector((s) => s.openSdp);
  switch (event.type) {
    case "offer.created":
    case "answer.created":
    case "sdp.local.set":
    case "sdp.remote.set": {
      if (!event.details.sdp) return null;
      const parsed = cachedParseSdp(event.details.sdp);
      return (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-dim">Session description</h3>
          <ul className="flex flex-col gap-1">
            {parsed.media.map((m) => (
              <li key={m.index} className="flex flex-wrap items-center gap-2">
                <span className="text-fg">{sectionTitle(m)}</span>
                {m.direction && <Chip>{m.direction}</Chip>}
                {m.rejected && <Chip tone="warning">rejected</Chip>}
                <span className="text-xs text-dim">{m.candidates.length} candidates</span>
              </li>
            ))}
            {!parsed.media.length && <li className="text-person">No media sections. Nothing can be negotiated.</li>}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => openSdp(event.id, "structure")}>Open in SDP inspector</Button>
            <Button onClick={() => openSdp(event.id, "raw")}>View raw SDP</Button>
          </div>
        </section>
      );
    }
    case "ice.candidate.discovered":
    case "ice.candidate.added":
      return event.details.parsed ? <CandidateTable c={event.details.parsed} /> : null;
    case "datachannel.message":
      return (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-dim">Message</h3>
          <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <dt className="text-dim">Channel</dt>
            <dd className="text-fg">"{event.details.label}" (id {event.details.channelId ?? "?"})</dd>
            <dt className="text-dim">Size</dt>
            <dd className="measured text-fg">{fmtBytes(event.details.size)}</dd>
            <dt className="text-dim">Sequence</dt>
            <dd className="measured text-fg">#{event.details.seq}</dd>
            {event.details.bufferedAmount !== undefined && (
              <>
                <dt className="text-dim">Buffered</dt>
                <dd className="measured text-fg">{fmtBytes(event.details.bufferedAmount)}</dd>
              </>
            )}
          </dl>
          {event.details.preview !== undefined && (
            <pre className="measured whitespace-pre-wrap break-all rounded-ctl border border-line bg-well p-3 text-xs text-fg">{event.details.preview}</pre>
          )}
        </section>
      );
    default:
      return null;
  }
}
