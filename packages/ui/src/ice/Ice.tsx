"use client";

import {
  CANDIDATE_TYPE_INFO,
  explainCandidateError,
  type CandidateRecord,
  type PeerModel,
  type StatsCandidate,
  type StatsCandidatePair,
} from "@rtc-inspector/core";
import { useDerived, useInspector } from "../context";
import { fmtMs, plural, relTime } from "../format";
import { Chip, EmptyState, Panel, PeerSelect, Reading, StateChip, cx } from "../components/primitives";

const PAIR_STROKE: Record<string, string> = {
  succeeded: "var(--color-ok)",
  "in-progress": "var(--color-cool)",
  failed: "var(--color-bad)",
};

export function Ice() {
  const { model, focusPeer } = useDerived();
  const focus = useInspector((s) => s.focusPeer);
  if (!focusPeer) return <EmptyState title="No connections yet" />;
  const peer = focusPeer;
  const counts = (list: CandidateRecord[]) =>
    Object.entries(
      list.reduce<Record<string, number>>((acc, c) => {
        if (c.parsed) acc[c.parsed.type] = (acc[c.parsed.type] ?? 0) + 1;
        return acc;
      }, {}),
    )
      .map(([k, v]) => `${v} ${k}`)
      .join(", ") || "none";

  return (
    <div className="flex flex-col gap-4">
      <PeerSelect peers={model.peers} value={peer.peerId} onChange={focus} />
      <section className="panels grid-cols-2 md:grid-cols-5" aria-label="ICE readings">
        <div className="flex flex-col gap-1 px-4 py-3">
          <span className="text-xs text-dim">Gathering</span>
          <span><StateChip kind="gathering" state={peer.iceGatheringState} /></span>
        </div>
        <div className="flex flex-col gap-1 px-4 py-3">
          <span className="text-xs text-dim">ICE connection</span>
          <span><StateChip kind="ice" state={peer.iceConnectionState} /></span>
        </div>
        <Reading label="Local candidates" value={`${peer.localCandidates.length} (${counts(peer.localCandidates)})`} />
        <Reading label="Remote candidates added" value={`${peer.remoteCandidates.filter((c) => !c.endOfCandidates).length} (${counts(peer.remoteCandidates)})`} />
        <Reading
          label="Selected pair"
          value={
            peer.selectedPair
              ? `${peer.selectedPair.local?.candidateType ?? "?"} ↔ ${peer.selectedPair.remote?.candidateType ?? "?"}, ${fmtMs(peer.selectedPair.currentRoundTripTimeMs)}`
              : "none yet"
          }
        />
      </section>
      <PairGraph peer={peer} />
      <div className="grid gap-4 2xl:grid-cols-2">
        <CandidateTable title="Local candidates (gathered here)" list={peer.localCandidates} side="local" />
        <CandidateTable title="Remote candidates (added via addIceCandidate)" list={peer.remoteCandidates.filter((c) => !c.endOfCandidates)} side="remote" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <ServerPanel peer={peer} />
        <Legend />
      </div>
    </div>
  );
}

function candidateKey(c?: StatsCandidate) {
  return c?.id ?? "?";
}

/** Candidate pairs from the latest getStats(): what ICE actually tried. */
function PairGraph({ peer }: { peer: PeerModel }) {
  const pairs = peer.lastStats?.pairs ?? [];
  if (!pairs.length) {
    return (
      <Panel title="Connectivity checks">
        <EmptyState title="No candidate pairs yet">
          Once both sides have candidates, ICE pairs every local candidate with every remote one and tests them. Pairs and their states appear here from getStats().
        </EmptyState>
      </Panel>
    );
  }
  const locals = [...new Map(pairs.filter((p) => p.local).map((p) => [candidateKey(p.local), p.local!])).values()];
  const remotes = [...new Map(pairs.filter((p) => p.remote).map((p) => [candidateKey(p.remote), p.remote!])).values()];
  const rowH = 44;
  const height = Math.max(locals.length, remotes.length) * rowH + 16;
  const yOf = (list: StatsCandidate[], c?: StatsCandidate) => list.findIndex((x) => x.id === c?.id) * rowH + rowH / 2 + 8;
  const node = (c: StatsCandidate) => (
    <div className="flex h-[44px] flex-col justify-center">
      <span className="flex items-center gap-2 text-sm">
        <Chip tone={c.candidateType === "relay" ? "warning" : "neutral"}>{c.candidateType ?? "?"}</Chip>
        <span className="measured truncate text-xs text-fg" title={c.address ? undefined : "The browser hides this address (mDNS host candidate)."}>
          {c.address ?? "hidden"}:{c.port ?? "?"}
        </span>
      </span>
      <span className="text-xs text-dim">
        {c.protocol ?? ""}
        {c.networkType ? `, ${c.networkType}` : ""}
        {c.relayProtocol ? `, relay over ${c.relayProtocol}` : ""}
      </span>
    </div>
  );
  return (
    <Panel
      title="Connectivity checks"
      aside={<span>{plural(pairs.length, "pair")} from the latest getStats(); selected pair in amber</span>}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(80px,2fr)_minmax(0,1fr)] gap-2 px-4 py-2">
        <span className="text-xs text-dim">This peer</span>
        <span />
        <span className="text-xs text-dim">Remote peer</span>
        <div className="py-2">{locals.map((c) => <div key={c.id}>{node(c)}</div>)}</div>
        <svg width="100%" height={height} preserveAspectRatio="none" viewBox={`0 0 100 ${height}`} aria-label="Candidate pairs">
          {[...pairs].sort((a, b) => Number(a.selected) - Number(b.selected)).map((p: StatsCandidatePair) => (
            <line
              key={p.id}
              x1={0}
              x2={100}
              y1={yOf(locals, p.local)}
              y2={yOf(remotes, p.remote)}
              stroke={p.selected ? "var(--color-accent)" : PAIR_STROKE[p.state ?? ""] ?? "var(--color-rule-2)"}
              strokeWidth={p.selected ? 3 : 1.25}
              strokeDasharray={p.state === "failed" || p.state === "succeeded" || p.selected ? undefined : "3 3"}
              vectorEffect="non-scaling-stroke"
            >
              <title>{`${p.local?.candidateType} ↔ ${p.remote?.candidateType}: ${p.state ?? "?"}${p.nominated ? ", nominated" : ""}`}</title>
            </line>
          ))}
        </svg>
        <div className="py-2">{remotes.map((c) => <div key={c.id}>{node(c)}</div>)}</div>
      </div>
      <div className="overflow-x-auto border-t border-line">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Local</th>
              <th scope="col">Remote</th>
              <th scope="col">State</th>
              <th scope="col">Nominated</th>
              <th scope="col">Round trip</th>
              <th scope="col">Checks sent / answered</th>
            </tr>
          </thead>
          <tbody>
            {pairs.map((p) => (
              <tr key={p.id} className={p.selected ? "bg-person-soft/40" : undefined}>
                <td className="text-fg-2">{p.local?.candidateType ?? "?"} {p.local?.protocol ?? ""}</td>
                <td className="text-fg-2">{p.remote?.candidateType ?? "?"} {p.remote?.protocol ?? ""}</td>
                <td>
                  <Chip tone={p.state === "succeeded" ? "success" : p.state === "failed" ? "error" : p.state === "in-progress" ? "info" : "neutral"}>
                    {p.state ?? "?"}
                  </Chip>
                  {p.selected && <span className="ml-2 text-xs text-person">selected</span>}
                </td>
                <td className="text-dim">{p.nominated ? "yes" : "no"}</td>
                <td className="measured">{fmtMs(p.currentRoundTripTimeMs)}</td>
                <td className="measured">
                  {p.requestsSent ?? "n/a"} / {p.responsesReceived ?? "n/a"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function CandidateTable({ title, list, side }: { title: string; list: CandidateRecord[]; side: "local" | "remote" }) {
  const { origin, model } = useDerived();
  const selectEvent = useInspector((s) => s.selectEvent);
  const selectedId = useInspector((s) => s.selectedEventId);
  return (
    <Panel title={title} aside={<span>{list.length}</span>}>
      {list.length === 0 ? (
        <EmptyState title={side === "local" ? "Nothing gathered yet" : "No remote candidates added"}>
          {side === "local"
            ? "Gathering starts after setLocalDescription()."
            : "Candidates from the other peer must be passed to addIceCandidate(). If this stays empty, check your signaling."}
        </EmptyState>
      ) : (
        <div className="max-h-[360px] overflow-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Type</th>
                <th scope="col">Protocol</th>
                <th scope="col">Address</th>
                <th scope="col">Priority</th>
                <th scope="col">{side === "local" ? "Reached remote" : "From"}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.eventId} className={c.eventId === selectedId ? "bg-well" : undefined}>
                  <td>
                    <button type="button" className="link measured whitespace-nowrap text-xs text-reading" onClick={() => selectEvent(c.eventId)}>
                      {relTime(c.at, origin)}
                    </button>
                  </td>
                  <td>
                    <Chip tone={c.parsed?.type === "relay" ? "warning" : "neutral"} title={c.parsed ? CANDIDATE_TYPE_INFO[c.parsed.type]?.meaning : undefined}>
                      {c.parsed?.type ?? "?"}
                    </Chip>
                  </td>
                  <td className="text-fg-2">
                    {c.parsed?.protocol ?? "?"}
                    {c.parsed?.tcpType ? ` ${c.parsed.tcpType}` : ""}
                  </td>
                  <td className="measured text-xs text-fg">
                    {c.parsed ? `${c.parsed.address}:${c.parsed.port}` : c.candidate}
                    {c.parsed && <span className="ml-1 text-dim">{c.parsed.addressKind}</span>}
                  </td>
                  <td className="measured text-xs text-dim" title="type preference / local preference">
                    {c.parsed ? `${c.parsed.typePreference} / ${c.parsed.localPreference}` : "n/a"}
                  </td>
                  <td className="text-xs">
                    {c.matchedPeerId ? (
                      <span className="text-good">{side === "local" ? "added by " : ""}{model.byId[c.matchedPeerId]?.label ?? c.matchedPeerId}</span>
                    ) : (
                      <span className="text-dim">{side === "local" ? "not seen" : "outside this session"}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function ServerPanel({ peer }: { peer: PeerModel }) {
  const servers = peer.configuration?.iceServers ?? [];
  return (
    <Panel title="ICE servers and errors" aside={peer.configuration?.iceTransportPolicy === "relay" ? <Chip tone="warning">relay only</Chip> : undefined}>
      <div className="flex flex-col gap-3 px-4 py-3 text-sm">
        {servers.length === 0 ? (
          <p className="text-dim">No STUN or TURN servers configured. Only host candidates can be gathered, so peers must share a network.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {servers.map((s, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                {s.urls.map((u) => (
                  <span key={u} className="measured text-xs text-fg">{u}</span>
                ))}
                {s.username && <span className="text-xs text-dim">user {s.username}</span>}
                {s.hasCredential && <span className="text-xs text-dim">with credential</span>}
              </li>
            ))}
          </ul>
        )}
        {peer.candidateErrors.length > 0 && (
          <ul className="flex flex-col gap-2 border-t border-line pt-3">
            {peer.candidateErrors.map((e) => (
              <li key={e.eventId}>
                <span className="flex flex-wrap items-center gap-2">
                  <Chip tone="warning">{e.errorCode}</Chip>
                  <span className="measured text-xs text-fg">{e.url ?? "unknown server"}</span>
                </span>
                <p className="mt-1 text-dim">{e.errorText ? `${e.errorText}. ` : ""}{explainCandidateError(e.errorCode)}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function Legend() {
  return (
    <Panel title="Candidate types">
      <dl className="flex flex-col gap-2 px-4 py-3 text-sm">
        {Object.entries(CANDIDATE_TYPE_INFO).map(([k, v]) => (
          <div key={k} className="grid grid-cols-[72px_minmax(0,1fr)] gap-3">
            <dt>
              <Chip tone={k === "relay" ? "warning" : "neutral"}>{k}</Chip>
            </dt>
            <dd className={cx("text-dim")}>
              <span className="text-fg">{v.name}.</span> {v.meaning}
            </dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}
