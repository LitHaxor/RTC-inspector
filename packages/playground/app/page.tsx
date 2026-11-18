"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { createInspector, type Inspector } from "@rtc-inspector/sdk";
import { RTCInspector } from "@rtc-inspector/ui";
import { AppNav } from "../src/components/AppNav";
import { SCENARIOS, type Scenario } from "../src/sim/scenarios";
import { Simulation } from "../src/sim/simulation";

interface Run {
  inspector: Inspector;
  sim: Simulation;
}

/** Re-render when the simulation's connections or channels change. */
function useSimulationVersion(sim: Simulation) {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const off = sim.onChange(() => setVersion((v) => v + 1));
    return () => void off();
  }, [sim]);
}

export default function PlaygroundPage() {
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0]!.id);
  const [run, setRun] = useState<Run>();
  const [starting, setStarting] = useState(false);
  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!;
  const supported = useSyncExternalStore(
    () => () => {},
    () => typeof RTCPeerConnection !== "undefined",
    () => true,
  );

  useEffect(() => () => run?.sim.stop(), [run]);

  const start = async (s: Scenario) => {
    run?.sim.stop();
    run?.inspector.dispose();
    const inspector = createInspector({ statsIntervalMs: 1000 });
    const sim = new Simulation(inspector, s);
    setRun({ inspector, sim });
    setStarting(true);
    try {
      await sim.start();
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex h-dvh flex-col bg-ground">
      <AppNav current="/" />
      <section className="flex shrink-0 flex-col gap-3 border-b border-line bg-panel px-4 py-3" aria-label="Scenario controls">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-dim">
            Scenario
            <select className="field min-w-72" aria-label="Scenario" value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>
              {SCENARIOS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="ctl ctl--primary" onClick={() => void start(scenario)} disabled={starting || !supported}>
            {run ? "Run again" : "Run scenario"}
          </button>
          {run && (
            <button type="button" className="ctl" onClick={() => run.sim.stop()}>
              Close all connections
            </button>
          )}
          <div className="min-w-0 flex-1 basis-80 text-sm">
            <p className="text-fg-2">{scenario.summary}</p>
            <p className="text-xs text-dim">Look at: {scenario.lookFor}</p>
          </div>
        </div>
        {!supported && <p className="text-sm text-danger">This browser has no RTCPeerConnection. Use a recent Chrome, Edge, Firefox or Safari.</p>}
        {run && <Controls sim={run.sim} />}
      </section>
      <main className="min-h-0 flex-1">
        {run ? (
          <RTCInspector key={run.inspector.sessionId} session={run.inspector} syncHash title={scenario.title} />
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-3 px-6 py-16">
            <h1 className="text-xl font-medium text-fg">Watch a WebRTC connection happen</h1>
            <p className="text-fg-2">
              Each scenario creates real peer connections in this tab and connects them through a simulated signaling server. The inspector records every
              step: who created the offer, which candidates crossed, when the channel opened, and where it broke.
            </p>
            <p className="text-dim">Pick a scenario above and run it. The failure scenarios each reproduce a bug that real apps ship.</p>
          </div>
        )}
      </main>
    </div>
  );
}

function Controls({ sim }: { sim: Simulation }) {
  useSimulationVersion(sim);
  const channels = sim.openChannels();
  const [target, setTarget] = useState("");
  const [text, setText] = useState("hello");
  const key = (c: { peerId: string; label: string }) => `${c.peerId}|${c.label}`;
  const selected = channels.find((c) => key(c) === target) ?? channels[0];
  const connections = [...sim.connections.values()];

  const send = (count: number) => {
    if (!selected) return;
    for (let i = 0; i < count; i++) sim.send(selected.peerId, selected.label, count > 1 ? `${text} #${i + 1}` : text);
  };

  return (
    <div className="flex flex-wrap items-end gap-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send(1);
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-dim">
          Send on
          <select className="field min-w-56" value={selected ? key(selected) : ""} onChange={(e) => setTarget(e.target.value)} disabled={!channels.length}>
            {!channels.length && <option value="">No open channel</option>}
            {channels.map((c) => (
              <option key={key(c)} value={key(c)}>
                {sim.connections.get(c.peerId)?.label ?? c.peerId}: "{c.label}"
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-dim">
          Message
          <input className="field w-56" value={text} onChange={(e) => setText(e.target.value)} disabled={!channels.length} />
        </label>
        <button type="submit" className="ctl" disabled={!channels.length || !text}>
          Send
        </button>
        <button type="button" className="ctl" disabled={!channels.length || !text} onClick={() => send(20)}>
          Send 20
        </button>
      </form>
      <span className="mx-1 h-8 w-px bg-line" aria-hidden="true" />
      <label className="flex flex-col gap-1 text-xs text-dim">
        Connection
        <select
          className="field min-w-48"
          id="connection-action"
          defaultValue=""
          onChange={(e) => {
            const [action, peerId] = e.target.value.split("|");
            e.target.value = "";
            if (!peerId) return;
            if (action === "close") sim.close(peerId);
            if (action === "restart") void sim.restartIce(peerId);
          }}
        >
          <option value="">Choose an action</option>
          {connections
            .filter((c) => c.pc.signalingState !== "closed")
            .map((c) => (
              <optgroup key={c.peerId} label={c.label}>
                <option value={`close|${c.peerId}`}>Close {c.label}</option>
                {c.initiator && <option value={`restart|${c.peerId}`}>Restart ICE on {c.label}</option>}
              </optgroup>
            ))}
        </select>
      </label>
    </div>
  );
}
