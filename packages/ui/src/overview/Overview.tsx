"use client";

import { lifecycle, summarizePeer, type Finding, type LifecycleStep, type PeerModel, type StepStatus, type Tone } from "@rtc-inspector/core";
import { useDerived, useInspector } from "../context";
import { fmtMs, relTime } from "../format";
import { Button, Chip, EmptyState, Panel, StateChip, cx } from "../components/primitives";
import { Topology } from "./Topology";

const STEP_TONE: Record<StepStatus, Tone> = {
  pending: "neutral",
  active: "info",
  done: "success",
  warning: "warning",
  failed: "error",
  skipped: "neutral",
};

const STEP_LABEL: Record<StepStatus, string> = {
  pending: "Not started",
  active: "In progress",
  done: "Done",
  warning: "Needs attention",
  failed: "Failed",
  skipped: "Not used",
};

const SEVERITY_TONE: Record<Finding["severity"], Tone> = { error: "error", warning: "warning", info: "info" };

export function Overview() {
  const { model, findings, focusPeer } = useDerived();
  if (!model.peers.length || !focusPeer) {
    return (
      <EmptyState title="No peer connections observed yet">
        Start a scenario, or in your app call <code className="measured text-fg">inspector.observe(pc)</code> (or{" "}
        <code className="measured text-fg">inspector.patchGlobal()</code> before creating connections).
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <FocusConnection peer={focusPeer} findings={findings.filter((f) => f.peerId === focusPeer.peerId)} />
      <Diagnosis findings={findings} />
      <ConnectionsTable />
      {model.links.length > 1 && <Topology />}
    </div>
  );
}

function FocusConnection({ peer, findings }: { peer: PeerModel; findings: Finding[] }) {
  const { model, origin } = useDerived();
  const now = useInspector((s) => s.now);
  const focus = useInspector((s) => s.focusPeer);
  const remote = peer.remotePeerId ? model.byId[peer.remotePeerId] : undefined;
  const steps = lifecycle(peer, now, remote);
  const worst = findings[0];
  return (
    <section className="panels grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]" aria-label={`Connection ${peer.label}`}>
      <div className="flex flex-col gap-5 p-5">
        <div className="flex flex-col gap-2">
          <span className="text-xs text-dim">
            {peer.label}
            {remote && (
              <>
                {" with "}
                <button type="button" className="link" onClick={() => focus(remote.peerId)} title={`Show ${remote.label}`}>
                  {remote.label}
                </button>
              </>
            )}
            {peer.role ? `, ${peer.role}` : ""}
          </span>
          <p className={cx("reading-value text-[2.25rem]", peer.connectionState === "failed" && "text-danger", peer.connectionState === "connected" && "text-good")}>
            {peer.connectionState}
          </p>
          <p className="text-fg-2">{summarizePeer(peer)}</p>
          {worst && worst.severity !== "info" && (
            <p className="text-sm text-dim">
              {peer.connectionState === "connected" ? "Worth checking" : "Most likely cause"}: <span className={worst.severity === "error" ? "text-danger" : "text-person"}>{worst.title}</span>
            </p>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
          {(
            [
              ["Signaling", "signaling", peer.signalingState],
              ["ICE gathering", "gathering", peer.iceGatheringState],
              ["ICE connection", "ice", peer.iceConnectionState],
              ["Connection", "connection", peer.connectionState],
            ] as const
          ).map(([label, kind, state]) => (
            <div key={label} className="flex flex-col items-start gap-1">
              <dt className="text-dim">{label}</dt>
              <dd>
                <StateChip kind={kind} state={state} />
              </dd>
            </div>
          ))}
        </dl>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
          <div>
            <dt className="text-dim">Selected pair</dt>
            <dd className="measured mt-1 text-sm text-fg">
              {peer.selectedPair ? `${peer.selectedPair.local?.candidateType ?? "?"} ↔ ${peer.selectedPair.remote?.candidateType ?? "?"}` : "n/a"}
            </dd>
          </div>
          <div>
            <dt className="text-dim">Round trip</dt>
            <dd className="measured mt-1 text-sm text-fg">{fmtMs(peer.lastStats?.roundTripTimeMs ?? peer.selectedPair?.currentRoundTripTimeMs)}</dd>
          </div>
          <div>
            <dt className="text-dim">Data channels open</dt>
            <dd className="measured mt-1 text-sm text-fg">
              {peer.channels.filter((c) => c.state === "open").length} / {peer.channels.length}
            </dd>
          </div>
          <div>
            <dt className="text-dim">Observed for</dt>
            <dd className="measured mt-1 text-sm text-fg">{relTime(peer.closedAt ?? Math.max(now, peer.lastEventAt), peer.createdAt)}</dd>
          </div>
        </dl>
      </div>
      <div className="p-5">
        <h2 className="mb-1 text-sm font-medium text-fg">How this connection got here</h2>
        <p className="mb-4 text-xs text-dim">Every WebRTC connection passes these steps in order. The first one that is not done is where to look.</p>
        <Steps steps={steps} origin={origin} />
      </div>
    </section>
  );
}

function Steps({ steps, origin }: { steps: LifecycleStep[]; origin: number }) {
  return (
    <ol className="relative flex flex-col">
      {steps.map((step, i) => (
        <li key={step.key} className="relative grid grid-cols-[24px_minmax(0,1fr)_auto] gap-x-3 pb-4 last:pb-0">
          {i < steps.length - 1 && <span className="absolute left-[11px] top-6 bottom-0 w-px bg-line-2" aria-hidden="true" />}
          <span
            className={cx(
              "measured z-[1] flex h-6 w-6 items-center justify-center rounded-chip border text-xs",
              step.status === "done" && "border-good text-good",
              step.status === "failed" && "border-danger bg-danger-soft text-danger",
              step.status === "warning" && "border-person text-person",
              step.status === "active" && "border-reading text-reading",
              (step.status === "pending" || step.status === "skipped") && "border-line-2 bg-panel text-dim",
            )}
            aria-hidden="true"
          >
            {i + 1}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cx("text-sm font-medium", step.status === "pending" || step.status === "skipped" ? "text-dim" : "text-fg")}>{step.title}</span>
              <Chip tone={STEP_TONE[step.status]}>{STEP_LABEL[step.status]}</Chip>
            </div>
            <p className="mt-0.5 text-sm text-dim">{step.detail}</p>
          </div>
          <span className="measured pt-0.5 text-xs text-reading">{step.at !== undefined ? relTime(step.at, origin) : ""}</span>
        </li>
      ))}
    </ol>
  );
}

function Diagnosis({ findings }: { findings: Finding[] }) {
  const { model } = useDerived();
  const selectEvent = useInspector((s) => s.selectEvent);
  const setTab = useInspector((s) => s.setTab);
  const problems = findings.filter((f) => f.severity !== "info");
  return (
    <Panel
      title="Diagnosis"
      aside={
        problems.length ? (
          <span>
            {problems.filter((f) => f.severity === "error").length} errors, {problems.filter((f) => f.severity === "warning").length} warnings
          </span>
        ) : (
          <span>No problems found</span>
        )
      }
    >
      {findings.length === 0 ? (
        <p className="px-4 py-4 text-sm text-dim">
          Nothing looks wrong. Findings appear here when a connection fails, stalls, or misbehaves, with an explanation and what to check.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {findings.map((f) => (
            <li key={`${f.peerId}:${f.id}`} className="grid gap-2 px-4 py-4 md:grid-cols-[minmax(0,1fr)_auto]">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={SEVERITY_TONE[f.severity]}>{f.severity}</Chip>
                  <h3 className="text-sm font-medium text-fg">{f.title}</h3>
                  <span className="text-xs text-dim">{model.byId[f.peerId]?.label ?? f.peerId}</span>
                </div>
                <p className="mt-2 max-w-[80ch] text-sm text-fg-2">{f.explanation}</p>
                {f.suggestions.length > 0 && (
                  <ul className="mt-2 flex max-w-[80ch] list-disc flex-col gap-1 pl-5 text-sm text-dim">
                    {f.suggestions.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                )}
              </div>
              {f.evidence[0] && (
                <div>
                  <Button
                    onClick={() => {
                      selectEvent(f.evidence[0]);
                      setTab("timeline");
                    }}
                  >
                    Show in timeline
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ConnectionsTable() {
  const { model, findings, focusPeer } = useDerived();
  const focus = useInspector((s) => s.focusPeer);
  return (
    <Panel title="Connections" aside={<span>{model.peers.length} observed</span>}>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Connection</th>
              <th scope="col">Role</th>
              <th scope="col">Signaling</th>
              <th scope="col">ICE</th>
              <th scope="col">Connection</th>
              <th scope="col">Channels</th>
              <th scope="col">Round trip</th>
              <th scope="col">Findings</th>
            </tr>
          </thead>
          <tbody>
            {model.peers.map((p) => {
              const errors = findings.filter((f) => f.peerId === p.peerId && f.severity === "error").length;
              const warnings = findings.filter((f) => f.peerId === p.peerId && f.severity === "warning").length;
              return (
                <tr key={p.peerId} className={p.peerId === focusPeer?.peerId ? "bg-well" : undefined}>
                  <td>
                    <button type="button" className="link text-left" onClick={() => focus(p.peerId)}>
                      {p.label}
                    </button>
                  </td>
                  <td className="text-dim">{p.role ?? "not yet"}</td>
                  <td>
                    <StateChip kind="signaling" state={p.signalingState} />
                  </td>
                  <td>
                    <StateChip kind="ice" state={p.iceConnectionState} />
                  </td>
                  <td>
                    <StateChip kind="connection" state={p.connectionState} />
                  </td>
                  <td className="measured">
                    {p.channels.filter((c) => c.state === "open").length}/{p.channels.length}
                  </td>
                  <td className="measured">{fmtMs(p.lastStats?.roundTripTimeMs)}</td>
                  <td>
                    <span className="flex gap-1">
                      {errors > 0 && <Chip tone="error">{errors} error{errors > 1 ? "s" : ""}</Chip>}
                      {warnings > 0 && <Chip tone="warning">{warnings} warning{warnings > 1 ? "s" : ""}</Chip>}
                      {!errors && !warnings && <span className="text-dim">none</span>}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
