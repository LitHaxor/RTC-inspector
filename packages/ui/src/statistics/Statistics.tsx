"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { PeerModel, StatsPoint } from "@rtc-inspector/core";
import { useDerived, useInspector } from "../context";
import { fmtBitrate, fmtBytes, fmtMs } from "../format";
import { Chip, EmptyState, Panel, PeerSelect, Reading } from "../components/primitives";

type Metric = {
  key: keyof Omit<StatsPoint, "at">;
  title: string;
  format: (v: number | undefined) => string;
  help: string;
};

const METRICS: Metric[] = [
  { key: "rttMs", title: "Round-trip time", format: fmtMs, help: "currentRoundTripTime of the selected candidate pair (STUN consent checks)." },
  { key: "sendBitrate", title: "Outgoing bitrate", format: fmtBitrate, help: "Bytes sent on the transport per second, all media and data." },
  { key: "receiveBitrate", title: "Incoming bitrate", format: fmtBitrate, help: "Bytes received on the transport per second." },
  { key: "availableOutgoingBitrate", title: "Available outgoing bitrate", format: fmtBitrate, help: "The congestion controller's estimate of how much this peer could send." },
  { key: "packetLossPercent", title: "Packet loss", format: (v) => (v === undefined ? "n/a" : `${v.toFixed(1)}%`), help: "Lost / (lost + received) over inbound RTP streams. Media only." },
];

export function Statistics() {
  const { model, focusPeer } = useDerived();
  const focus = useInspector((s) => s.focusPeer);
  if (!focusPeer) return <EmptyState title="No connections yet" />;
  const peer = focusPeer;
  const s = peer.lastStats;
  const withStats = model.peers.filter((p) => p.statsSeries.length > 1);
  return (
    <div className="flex flex-col gap-4">
      <PeerSelect peers={model.peers} value={peer.peerId} onChange={focus} />
      {!s ? (
        <Panel title="Statistics">
          <EmptyState title="No getStats() samples yet">
            Samples start once ICE begins checking, every second by default (the <code className="measured text-fg">statsIntervalMs</code> option).
          </EmptyState>
        </Panel>
      ) : (
        <>
          <section className="panels grid-cols-2 md:grid-cols-3 xl:grid-cols-6" aria-label="Latest readings">
            <Reading label="Round trip" value={fmtMs(s.roundTripTimeMs)} />
            <Reading label="Sending" value={fmtBitrate(s.sendBitrate)} />
            <Reading label="Receiving" value={fmtBitrate(s.receiveBitrate)} />
            <Reading label="Bytes sent / received" value={`${fmtBytes(s.bytesSent)} / ${fmtBytes(s.bytesReceived)}`} />
            <Reading label="Packet loss" value={s.packetLossPercent === undefined ? "no media" : `${s.packetLossPercent.toFixed(1)}%`} />
            <Reading label="DTLS" value={s.dtlsState ?? "n/a"} />
          </section>
          <div className="grid gap-4 lg:grid-cols-2">
            {METRICS.filter((m) => peer.statsSeries.some((p) => p[m.key] !== undefined)).map((m) => (
              <MetricChart key={m.key} metric={m} series={peer.statsSeries} />
            ))}
          </div>
          {s.dataChannels.length > 0 && (
            <Panel title="Data channels (from getStats)">
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Label</th>
                      <th scope="col">Stream id</th>
                      <th scope="col">State</th>
                      <th scope="col">Messages sent</th>
                      <th scope="col">Messages received</th>
                      <th scope="col">Bytes sent</th>
                      <th scope="col">Bytes received</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.dataChannels.map((d, i) => (
                      <tr key={`${d.label}-${d.id ?? i}`}>
                        <td className="text-fg">"{d.label}"</td>
                        <td className="measured">{d.id ?? "n/a"}</td>
                        <td><Chip tone={d.state === "open" ? "success" : "neutral"}>{d.state ?? "?"}</Chip></td>
                        <td className="measured">{d.messagesSent ?? "n/a"}</td>
                        <td className="measured">{d.messagesReceived ?? "n/a"}</td>
                        <td className="measured">{fmtBytes(d.bytesSent)}</td>
                        <td className="measured">{fmtBytes(d.bytesReceived)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </>
      )}
      {withStats.length > 1 && <RttMultiples peers={withStats} />}
    </div>
  );
}

function ChartTooltip({ active, payload, label, format, origin }: { active?: boolean; payload?: { value?: number }[]; label?: number; format: (v: number | undefined) => string; origin: number }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-ctl border border-line-2 bg-well px-3 py-2 text-xs">
      <div className="measured text-reading">{(((label ?? 0) - origin) / 1000).toFixed(1)} s</div>
      <div className="measured text-fg">{format(payload[0]?.value)}</div>
    </div>
  );
}

function MetricChart({ metric, series, domain, height = 180, title }: { metric: Metric; series: StatsPoint[]; domain?: [number, number]; height?: number; title?: string }) {
  const { origin } = useDerived();
  const data = series.filter((p) => p[metric.key] !== undefined);
  const last = data[data.length - 1]?.[metric.key];
  return (
    <Panel title={title ?? metric.title} aside={<span className="measured text-fg">{metric.format(last)}</span>}>
      <figure className="px-2 pb-2 pt-3">
        <div style={{ height }} title={metric.help}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: 4 }}>
              <CartesianGrid stroke="var(--color-rule)" strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="at"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(v: number) => `${Math.round((v - origin) / 1000)} s`}
                stroke="var(--color-rule-2)"
                tick={{ fill: "var(--color-muted)", fontSize: 11 }}
                tickLine={false}
                minTickGap={32}
              />
              <YAxis
                width={84}
                domain={domain ?? [0, "auto"]}
                tickFormatter={(v: number) => metric.format(v)}
                stroke="var(--color-rule-2)"
                tick={{ fill: "var(--color-muted)", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                cursor={{ stroke: "var(--color-rule-2)", strokeWidth: 1 }}
                content={(props) => <ChartTooltip {...(props as object)} format={metric.format} origin={origin} />}
                isAnimationActive={false}
              />
              <Line
                type="linear"
                dataKey={metric.key}
                stroke="var(--color-cool)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: "var(--color-cool)", stroke: "var(--color-paper-2)", strokeWidth: 2 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <figcaption className="px-2 pt-1 text-xs text-dim">{metric.help}</figcaption>
        <details className="px-2 pt-1 text-xs">
          <summary className="cursor-pointer text-dim">View as table</summary>
          <table className="data-table mt-2">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">{metric.title}</th>
              </tr>
            </thead>
            <tbody>
              {data.slice(-20).map((p) => (
                <tr key={p.at}>
                  <td className="measured text-reading">{((p.at - origin) / 1000).toFixed(1)} s</td>
                  <td className="measured">{metric.format(p[metric.key])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </figure>
    </Panel>
  );
}

/** Round trip for every connection on one shared scale, so they compare honestly. */
function RttMultiples({ peers }: { peers: PeerModel[] }) {
  const rtt = METRICS[0]!;
  const max = Math.max(1, ...peers.flatMap((p) => p.statsSeries.map((s) => s.rttMs ?? 0)));
  return (
    <section className="flex flex-col gap-2" aria-label="Round trip per connection">
      <h2 className="text-sm font-medium text-fg">Round trip, every connection</h2>
      <p className="text-xs text-dim">Same scale on every chart, so heights compare directly.</p>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {peers.map((p) => (
          <MetricChart key={p.peerId} metric={rtt} series={p.statsSeries} domain={[0, Math.ceil(max * 1.1)]} height={120} title={p.label} />
        ))}
      </div>
    </section>
  );
}
