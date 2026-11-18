"use client";

import { useDerived, useInspector } from "../context";
import { Panel } from "../components/primitives";

const STATE_STROKE: Record<string, string> = {
  connected: "var(--color-ok)",
  failed: "var(--color-bad)",
  disconnected: "var(--color-accent)",
  connecting: "var(--color-cool)",
  new: "var(--color-rule-2)",
  closed: "var(--color-rule-2)",
};

/** Mesh view: one node per endpoint, one edge per observed connection pair. */
export function Topology() {
  const { model, focusPeer } = useDerived();
  const focus = useInspector((s) => s.focusPeer);
  const nodeOf = (peerId: string) => model.byId[peerId]?.group ?? peerId;
  const nodes = [...new Set(model.peers.map((p) => nodeOf(p.peerId)))];
  const size = 320;
  const r = nodes.length > 1 ? 112 : 0;
  const pos = new Map(nodes.map((n, i) => {
    const a = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
    return [n, { x: size / 2 + r * Math.cos(a), y: size / 2 + r * Math.sin(a) }] as const;
  }));
  const focusNode = focusPeer ? nodeOf(focusPeer.peerId) : undefined;

  return (
    <Panel title="Topology" aside={<span>{nodes.length} endpoints, {model.links.length} connections</span>}>
      <div className="grid gap-4 p-4 md:grid-cols-[320px_minmax(0,1fr)]">
        <svg viewBox={`0 0 ${size} ${size}`} className="w-full max-w-[320px]" role="img" aria-label="Connection topology">
          {model.links.map((l) => {
            const a = pos.get(nodeOf(l.a));
            const b = pos.get(nodeOf(l.b));
            if (!a || !b) return null;
            const isFocus = focusPeer && (l.a === focusPeer.peerId || l.b === focusPeer.peerId);
            return (
              <line
                key={`${l.a}-${l.b}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={STATE_STROKE[l.state] ?? "var(--color-rule-2)"}
                strokeWidth={isFocus ? 3 : 1.5}
                strokeDasharray={l.state === "connected" ? undefined : "4 4"}
              />
            );
          })}
          {nodes.map((n) => {
            const p = pos.get(n)!;
            return (
              <g key={n}>
                <rect
                  x={p.x - 44}
                  y={p.y - 14}
                  width={88}
                  height={28}
                  rx={6}
                  fill="var(--color-paper-3)"
                  stroke={n === focusNode ? "var(--color-accent)" : "var(--color-rule-2)"}
                />
                <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize="12" fill="var(--color-ink)" fontFamily="var(--font-body)">
                  {n.length > 12 ? `${n.slice(0, 11)}…` : n}
                </text>
              </g>
            );
          })}
        </svg>
        <ul className="flex flex-col gap-1 text-sm">
          {model.links.map((l) => (
            <li key={`${l.a}-${l.b}`} className="flex flex-wrap items-center gap-2">
              <button type="button" className="link" onClick={() => focus(l.a)}>
                {model.byId[l.a]?.label ?? l.a}
              </button>
              <span className="text-dim">and</span>
              <button type="button" className="link" onClick={() => focus(l.b)}>
                {model.byId[l.b]?.label ?? l.b}
              </button>
              <span className="text-dim">{l.state}</span>
            </li>
          ))}
          <li className="mt-2 text-xs text-dim">Solid edges are connected; dashed edges are still connecting, failed or closed.</li>
        </ul>
      </div>
    </Panel>
  );
}
