"use client";

import { useMemo, useState } from "react";
import {
  AUXILIARY_CODECS,
  SDP_LINE_HELP,
  cachedParseSdp,
  diffSdp,
  sectionTitle,
  type DescriptionRecord,
  type ParsedSdp,
  type PeerModel,
  type SdpMediaSection,
} from "@rtc-inspector/core";
import { useDerived, useInspector } from "../context";
import { fmtMs, relTime } from "../format";
import { Chip, EmptyState, Panel, PeerSelect, Segmented, cx } from "../components/primitives";

const SOURCE_LABEL: Record<DescriptionRecord["source"], string> = {
  created: "created",
  local: "applied locally",
  remote: "applied from remote",
};

export function Signaling() {
  const { model, focusPeer } = useDerived();
  const focus = useInspector((s) => s.focusPeer);
  if (!focusPeer) return <EmptyState title="No connections yet" />;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <PeerSelect peers={model.peers} value={focusPeer.peerId} onChange={focus} />
        <StatePath peer={focusPeer} />
      </div>
      <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
        <History peer={focusPeer} />
        <SdpInspector peer={focusPeer} />
      </div>
    </div>
  );
}

/** The signaling state machine as the path this peer actually walked. */
function StatePath({ peer }: { peer: PeerModel }) {
  const path = ["stable", ...peer.history.signaling.map((h) => h.state)];
  return (
    <ol className="flex flex-wrap items-center gap-1 text-xs" aria-label="Signaling states visited">
      {path.map((s, i) => (
        <li key={`${s}-${i}`} className="flex items-center gap-1">
          {i > 0 && <span className="text-dim" aria-hidden="true">→</span>}
          <Chip tone={i === path.length - 1 ? "info" : "neutral"}>{s}</Chip>
        </li>
      ))}
    </ol>
  );
}

function History({ peer }: { peer: PeerModel }) {
  const { origin } = useDerived();
  const sdpEventId = useInspector((s) => s.sdpEventId);
  const openSdp = useInspector((s) => s.openSdp);
  const items = [
    ...peer.descriptions.map((d) => ({ kind: "sdp" as const, at: d.at, d })),
    ...peer.history.signaling.map((h) => ({ kind: "state" as const, at: h.at, h })),
    ...peer.apiErrors.filter((e) => /Description|create/.test(e.method)).map((e) => ({ kind: "error" as const, at: e.at, e })),
  ].sort((a, b) => a.at - b.at);
  const current = sdpEventId ?? peer.localDescription?.eventId ?? peer.descriptions[0]?.eventId;

  return (
    <Panel title="Negotiation history" aside={<span>{peer.role ?? "no role yet"}</span>}>
      {items.length === 0 ? (
        <EmptyState title="No offer or answer yet">The offer/answer exchange starts with createOffer() on one side.</EmptyState>
      ) : (
        <ol className="relative flex flex-col py-2">
          <span className="absolute bottom-3 left-[23px] top-3 w-px bg-line-2" aria-hidden="true" />
          {items.map((item, i) => {
            if (item.kind === "state") {
              return (
                <li key={`s${i}`} className="relative flex items-center gap-3 py-1.5 pl-[19px] pr-4">
                  <span className="z-[1] h-2 w-2 rounded-full bg-line-2" aria-hidden="true" />
                  <span className="measured text-xs text-reading">{relTime(item.at, origin)}</span>
                  <span className="text-xs text-dim">signaling state</span>
                  <span className="text-xs text-fg-2">{item.h.state}</span>
                </li>
              );
            }
            if (item.kind === "error") {
              return (
                <li key={`e${i}`} className="relative flex items-start gap-3 py-1.5 pl-[19px] pr-4">
                  <span className="z-[1] mt-1.5 h-2 w-2 rounded-full bg-danger" aria-hidden="true" />
                  <span className="measured text-xs text-reading">{relTime(item.at, origin)}</span>
                  <span className="text-xs text-danger">
                    {item.e.method}() failed: {item.e.error.message}
                  </span>
                </li>
              );
            }
            const d = item.d;
            return (
              <li key={d.eventId}>
                <button
                  type="button"
                  className="row-button relative flex items-start gap-3 py-2 pl-[17px] pr-4"
                  aria-current={d.eventId === current}
                  onClick={() => openSdp(d.eventId)}
                >
                  <span className="z-[1] mt-1 h-3 w-3 rounded-chip border border-reading bg-panel" aria-hidden="true" />
                  <span className="flex min-w-0 flex-col">
                    <span className="flex flex-wrap items-baseline gap-2">
                      <span className="measured text-xs text-reading">{relTime(d.at, origin)}</span>
                      <span className="text-sm font-medium text-fg">
                        {d.type || "description"} {SOURCE_LABEL[d.source]}
                      </span>
                    </span>
                    <span className="text-xs text-dim">
                      {d.sessionVersion ? `version ${d.sessionVersion}` : ""}
                      {d.durationMs !== undefined ? `, took ${fmtMs(d.durationMs)}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

function allDescriptions(peers: PeerModel[]): { record: DescriptionRecord; peer: PeerModel }[] {
  return peers.flatMap((peer) => peer.descriptions.filter((d) => d.sdp).map((record) => ({ record, peer })));
}

function SdpInspector({ peer }: { peer: PeerModel }) {
  const { model } = useDerived();
  const view = useInspector((s) => s.sdpView);
  const setView = useInspector((s) => s.setSdpView);
  const sdpEventId = useInspector((s) => s.sdpEventId);
  const all = useMemo(() => allDescriptions(model.peers), [model]);
  const record =
    all.find((d) => d.record.eventId === sdpEventId && d.peer.peerId === peer.peerId)?.record ??
    peer.localDescription ??
    peer.descriptions.find((d) => d.sdp);

  return (
    <Panel
      title={record ? `${record.type} ${SOURCE_LABEL[record.source]}` : "SDP inspector"}
      aside={
        <Segmented
          label="SDP view"
          value={view}
          onChange={setView}
          options={[
            { value: "structure", label: "Structure" },
            { value: "raw", label: "Raw" },
            { value: "compare", label: "Compare" },
          ]}
        />
      }
    >
      {view === "compare" ? (
        <Compare peer={peer} all={all} />
      ) : !record ? (
        <EmptyState title="No session description yet">Descriptions appear once createOffer() or setRemoteDescription() runs.</EmptyState>
      ) : view === "raw" ? (
        <RawSdp sdp={record.sdp} />
      ) : (
        <Structure parsed={cachedParseSdp(record.sdp)} />
      )}
    </Panel>
  );
}

function Field({ label, children, help }: { label: string; children: React.ReactNode; help?: string }) {
  return (
    <div className="grid grid-cols-[150px_minmax(0,1fr)] gap-3 py-1 text-sm">
      <dt className="text-dim" title={help}>
        {label}
      </dt>
      <dd className="min-w-0 break-words text-fg">{children}</dd>
    </div>
  );
}

function Structure({ parsed }: { parsed: ParsedSdp }) {
  const bundle = parsed.groups.find((g) => g.semantics === "BUNDLE");
  return (
    <div className="flex flex-col">
      <section className="border-b border-line px-4 py-3">
        <h3 className="mb-1 text-sm font-medium text-fg">Session</h3>
        <dl>
          <Field label="Origin" help={SDP_LINE_HELP.o}>
            <span className="measured">
              session {parsed.origin?.sessionId ?? "?"}, version {parsed.origin?.sessionVersion ?? "?"}
            </span>
          </Field>
          <Field label="BUNDLE" help={SDP_LINE_HELP.group}>
            {bundle ? (
              <span>
                {bundle.mids.length} sections share one transport <span className="measured text-dim">(mids {bundle.mids.join(", ")})</span>
              </span>
            ) : (
              <span className="text-person">not bundled: one transport per section</span>
            )}
          </Field>
          {parsed.fingerprint && (
            <Field label="DTLS fingerprint" help={SDP_LINE_HELP.fingerprint}>
              <span className="measured break-all text-xs">{parsed.fingerprint.algorithm} {parsed.fingerprint.value}</span>
            </Field>
          )}
          {parsed.iceLite && <Field label="ICE lite">yes, the remote is an ICE-lite server</Field>}
          {parsed.warnings.length > 0 && (
            <Field label="Parser warnings">
              <ul className="text-person">{parsed.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </Field>
          )}
        </dl>
      </section>
      {parsed.media.length === 0 && <EmptyState title="No media sections">An offer without m= sections negotiates nothing: no ICE, no DTLS, no data channels.</EmptyState>}
      {parsed.media.map((m) => (
        <MediaSection key={m.index} m={m} sessionFingerprint={!!parsed.fingerprint} sessionSetup={parsed.setup} />
      ))}
    </div>
  );
}

const SETUP_TEXT: Record<string, string> = {
  actpass: "actpass: either role; the answerer decides",
  active: "active: this side is the DTLS client",
  passive: "passive: this side is the DTLS server",
  holdconn: "holdconn: no DTLS connection yet",
};

function MediaSection({ m, sessionFingerprint, sessionSetup }: { m: SdpMediaSection; sessionFingerprint: boolean; sessionSetup?: string }) {
  const setup = m.setup ?? sessionSetup;
  return (
    <section className="border-b border-line px-4 py-3 last:border-b-0">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-fg">{sectionTitle(m)}</h3>
        {m.mid !== undefined && <span className="measured text-xs text-dim">mid {m.mid}</span>}
        {m.direction && <Chip tone={m.direction === "inactive" ? "warning" : "neutral"}>{m.direction}</Chip>}
        {m.rejected && <Chip tone="warning">rejected (port 0)</Chip>}
        {m.bundleOnly && <Chip>bundle-only</Chip>}
      </div>
      <dl>
        <Field label="Transport" help={SDP_LINE_HELP.m}>
          <span className="measured">{m.protocol}</span>
        </Field>
        {m.kind === "application" ? (
          <>
            <Field label="SCTP port" help={SDP_LINE_HELP["sctp-port"]}>
              <span className="measured">{m.sctpPort ?? "n/a"}</span>
            </Field>
            <Field label="Max message size" help={SDP_LINE_HELP["max-message-size"]}>
              <span className="measured">{m.maxMessageSize !== undefined ? `${m.maxMessageSize.toLocaleString()} bytes` : "not stated (64 KB assumed)"}</span>
            </Field>
          </>
        ) : (
          <Field label="Codecs" help={SDP_LINE_HELP.rtpmap}>
            <span className="flex flex-wrap gap-1">
              {m.codecs.map((c) => (
                <span
                  key={c.payloadType}
                  className={cx("chip", AUXILIARY_CODECS.has(c.name) && "opacity-60")}
                  title={`payload ${c.payloadType}${Object.keys(c.fmtp).length ? `, ${Object.entries(c.fmtp).map(([k, v]) => `${k}=${v}`).join(";")}` : ""}${c.rtcpFeedback.length ? `, feedback: ${c.rtcpFeedback.join(", ")}` : ""}`}
                >
                  {c.name}
                  {c.clockRate ? <span className="measured text-dim">/{c.clockRate}</span> : null}
                </span>
              ))}
            </span>
          </Field>
        )}
        <Field label="ICE credentials" help={SDP_LINE_HELP["ice-ufrag"]}>
          <span className="measured">ufrag {m.iceUfrag ?? "n/a"}</span>
          <span className="text-dim">, password {m.icePwd ? (m.icePwd.includes("redacted") ? "redacted" : "present") : "n/a"}</span>
        </Field>
        <Field label="DTLS role" help={SDP_LINE_HELP.setup}>
          {setup ? SETUP_TEXT[setup] ?? setup : "n/a"}
          {!m.fingerprint && !sessionFingerprint && <span className="text-person"> (no fingerprint)</span>}
        </Field>
        <Field label="Candidates in SDP" help={SDP_LINE_HELP.candidate}>
          <span className="measured">{m.candidates.length}</span>
          <span className="text-dim">
            {m.candidates.length === 0 ? " (sent separately via trickle ICE, or none)" : ` (${[...new Set(m.candidates.map((c) => c.type))].join(", ")})`}
          </span>
        </Field>
        {m.kind !== "application" && (
          <Field label="RTP details">
            <span className="text-dim">
              {m.rtcpMux ? "rtcp-mux" : "separate RTCP"}, {m.extmaps.length} header extensions, {m.ssrcs.length} SSRCs
              {m.simulcast ? `, simulcast ${m.simulcast}` : ""}
            </span>
          </Field>
        )}
      </dl>
    </section>
  );
}

function RawSdp({ sdp }: { sdp: string }) {
  const parsed = cachedParseSdp(sdp);
  const [selected, setSelected] = useState<number | undefined>();
  const line = parsed.lines.find((l) => l.lineNumber === selected);
  const helpKey = line ? (line.key === "a" ? line.value.split(":")[0]! : line.key) : undefined;
  return (
    <div className="grid lg:grid-cols-[minmax(0,1fr)_280px]">
      <ol className="measured max-h-[640px] overflow-auto bg-well py-2 text-xs" aria-label="Raw SDP lines">
        {parsed.lines.map((l) => (
          <li key={l.lineNumber} className={cx(l.key === "m" && "mt-2 border-t border-line pt-2")}>
            <button
              type="button"
              className="row-button flex gap-3 px-3 py-0.5"
              aria-current={l.lineNumber === selected}
              onClick={() => setSelected(l.lineNumber === selected ? undefined : l.lineNumber)}
            >
              <span className="w-8 shrink-0 text-right text-dim">{l.lineNumber}</span>
              <span className={cx("min-w-0 break-all", l.key === "m" ? "text-reading" : "text-fg-2")}>{l.text}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="border-t border-line p-4 text-sm lg:border-l lg:border-t-0">
        {line ? (
          <>
            <p className="measured mb-2 break-all text-xs text-fg">{line.text}</p>
            <p className="text-fg-2">{(helpKey && SDP_LINE_HELP[helpKey]) || "No description for this attribute."}</p>
            <p className="mt-2 text-xs text-dim">{line.section === -1 ? "Session level: applies to every section." : `Media section ${line.section}.`}</p>
          </>
        ) : (
          <p className="text-dim">Select a line to see what it means.</p>
        )}
      </div>
    </div>
  );
}

function defaultPair(peer: PeerModel): [string | undefined, string | undefined] {
  const offer = peer.descriptions.find((d) => d.type === "offer" && d.source !== "created");
  const answer = peer.descriptions.find((d) => d.type === "answer" && d.source !== "created");
  return [offer?.eventId, answer?.eventId];
}

function Compare({ peer, all }: { peer: PeerModel; all: { record: DescriptionRecord; peer: PeerModel }[] }) {
  const { origin } = useDerived();
  const compare = useInspector((s) => s.compare);
  const setCompare = useInspector((s) => s.setCompare);
  const [defLeft, defRight] = defaultPair(peer);
  const leftId = compare.left ?? defLeft;
  const rightId = compare.right ?? defRight;
  const left = all.find((d) => d.record.eventId === leftId);
  const right = all.find((d) => d.record.eventId === rightId);
  const diff = useMemo(() => (left && right ? diffSdp(cachedParseSdp(left.record.sdp), cachedParseSdp(right.record.sdp)) : undefined), [left, right]);
  const label = (d: { record: DescriptionRecord; peer: PeerModel }) =>
    `${d.peer.label}: ${d.record.type} ${SOURCE_LABEL[d.record.source]} at ${relTime(d.record.at, origin)}`;
  const picker = (side: "left" | "right", value: string | undefined) => (
    <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-dim">
      {side === "left" ? "Left" : "Right"}
      <select className="field" value={value ?? ""} onChange={(e) => setCompare(side, e.target.value || undefined)}>
        <option value="">Choose a description</option>
        {all.map((d) => (
          <option key={d.record.eventId} value={d.record.eventId}>
            {label(d)}
          </option>
        ))}
      </select>
    </label>
  );
  const STATUS_CLASS: Record<string, string> = {
    same: "text-dim",
    different: "text-fg",
    "only-left": "text-person",
    "only-right": "text-person",
    warning: "text-person",
  };
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap gap-3 border-b border-line p-4">
        {picker("left", leftId)}
        {picker("right", rightId)}
      </div>
      {!diff ? (
        <EmptyState title="Pick two descriptions">By default this compares the offer with its answer, which is where most negotiation problems show.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Section</th>
                <th scope="col">Field</th>
                <th scope="col">Left</th>
                <th scope="col">Right</th>
                <th scope="col">What it means</th>
              </tr>
            </thead>
            <tbody>
              {diff.rows.map((r, i) => (
                <tr key={i} className={r.status === "warning" ? "bg-person-soft/40" : r.status === "different" ? "bg-well" : undefined}>
                  <td className="whitespace-nowrap text-dim">{r.section}</td>
                  <td className="whitespace-nowrap text-fg-2">{r.field}</td>
                  <td className={cx("measured text-xs", STATUS_CLASS[r.status])}>{r.left ?? "n/a"}</td>
                  <td className={cx("measured text-xs", STATUS_CLASS[r.status])}>{r.right ?? "n/a"}</td>
                  <td className="text-sm text-dim">{r.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
