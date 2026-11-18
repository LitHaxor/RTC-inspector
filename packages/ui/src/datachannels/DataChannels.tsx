"use client";

import { useMemo, useState } from "react";
import type { ChannelModel, RTCTraceEvent } from "@rtc-inspector/core";
import { useDerived, useInspector } from "../context";
import { fmtBytes, fmtMs, relTime } from "../format";
import { Chip, EmptyState, Panel, cx } from "../components/primitives";

const STATE_TONE: Record<string, "success" | "info" | "neutral" | "warning"> = {
  open: "success",
  connecting: "info",
  closing: "warning",
  closed: "neutral",
};

function reliability(c: ChannelModel): string {
  if (c.maxRetransmits !== null && c.maxRetransmits !== undefined) return `up to ${c.maxRetransmits} retransmits`;
  if (c.maxPacketLifeTime !== null && c.maxPacketLifeTime !== undefined) return `${c.maxPacketLifeTime} ms lifetime`;
  return "reliable";
}

export function DataChannels() {
  const { model } = useDerived();
  const channels = model.peers.flatMap((p) => p.channels);
  if (!channels.length) {
    return (
      <EmptyState title="No data channels yet">
        Channels appear when <code className="measured text-fg">createDataChannel()</code> is called, or when the remote peer opens one (the{" "}
        <code className="measured text-fg">datachannel</code> event).
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <ChannelTable channels={channels} />
      <MessageLog channels={channels} />
    </div>
  );
}

function ChannelTable({ channels }: { channels: ChannelModel[] }) {
  const { model, origin } = useDerived();
  const selectEvent = useInspector((s) => s.selectEvent);
  return (
    <Panel title="Channels" aside={<span>{channels.filter((c) => c.state === "open").length} of {channels.length} open</span>}>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Connection</th>
              <th scope="col">Label</th>
              <th scope="col">Stream id</th>
              <th scope="col">Opened by</th>
              <th scope="col">Delivery</th>
              <th scope="col">State</th>
              <th scope="col">Created</th>
              <th scope="col">Time to open</th>
              <th scope="col">Sent</th>
              <th scope="col">Received</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((c) => (
              <tr key={c.channelKey}>
                <td className="text-fg-2">{model.byId[c.peerId]?.label ?? c.peerId}</td>
                <td className="text-fg">"{c.label}"{c.protocol ? <span className="text-dim"> ({c.protocol})</span> : null}</td>
                <td className="measured">{c.id ?? "n/a"}</td>
                <td className="text-dim">{c.negotiated ? "both sides (negotiated)" : c.origin === "local" ? "this peer" : "remote peer"}</td>
                <td className="text-dim">
                  {c.ordered === false ? "unordered" : "ordered"}, {reliability(c)}
                </td>
                <td>
                  <span className="flex items-center gap-1">
                    <Chip tone={STATE_TONE[c.state] ?? "neutral"}>{c.state}</Chip>
                    {c.errors.length > 0 && <Chip tone="error">{c.errors.length} error{c.errors.length > 1 ? "s" : ""}</Chip>}
                  </span>
                </td>
                <td>
                  <button type="button" className="link measured whitespace-nowrap text-xs text-reading" onClick={() => selectEvent(c.createdEventId)}>
                    {relTime(c.createdAt, origin)}
                  </button>
                </td>
                <td className="measured">{c.openedAt !== undefined ? fmtMs(c.openedAt - c.createdAt) : "n/a"}</td>
                <td className="measured">
                  {c.sent} <span className="text-dim">({fmtBytes(c.bytesSent)})</span>
                </td>
                <td className="measured">
                  {c.received} <span className="text-dim">({fmtBytes(c.bytesReceived)})</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function MessageLog({ channels }: { channels: ChannelModel[] }) {
  const events = useDerived().visibleEvents;
  const selectEvent = useInspector((s) => s.selectEvent);
  const selectedId = useInspector((s) => s.selectedEventId);
  const { model, origin, flowsByEvent } = useDerived();
  const [channelKey, setChannelKey] = useState<string>("");
  const messages = useMemo(
    () =>
      (events.filter((e) => e.type === "datachannel.message") as RTCTraceEvent<"datachannel.message">[]).filter(
        (m) => !channelKey || m.details.channelKey === channelKey,
      ),
    [events, channelKey],
  );
  const shown = messages.slice(-500);
  return (
    <Panel
      title="Messages"
      aside={
        <label className="inline-flex items-center gap-2">
          Channel
          <select className="field" value={channelKey} onChange={(e) => setChannelKey(e.target.value)}>
            <option value="">All channels</option>
            {channels.map((c) => (
              <option key={c.channelKey} value={c.channelKey}>
                {model.byId[c.peerId]?.label ?? c.peerId}: "{c.label}"
              </option>
            ))}
          </select>
        </label>
      }
    >
      {shown.length === 0 ? (
        <EmptyState title="No messages yet">Messages sent with send() and received in the message event show here, with their size and delivery time.</EmptyState>
      ) : (
        <div className="max-h-[480px] overflow-auto">
          {messages.length > shown.length && <p className="px-4 py-2 text-xs text-dim">Showing the latest {shown.length} of {messages.length} messages.</p>}
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Connection</th>
                <th scope="col">Channel</th>
                <th scope="col">Direction</th>
                <th scope="col">Size</th>
                <th scope="col">Content</th>
                <th scope="col">Delivered in</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => {
                const flow = flowsByEvent.get(m.id)?.[0];
                return (
                  <tr key={m.id} className={cx(m.id === selectedId && "bg-well")}>
                    <td>
                      <button type="button" className="link measured whitespace-nowrap text-xs text-reading" onClick={() => selectEvent(m.id)}>
                        {relTime(m.timestamp, origin)}
                      </button>
                    </td>
                    <td className="text-fg-2">{model.byId[m.peerId]?.label ?? m.peerId}</td>
                    <td className="text-fg-2">"{m.details.label}"</td>
                    <td className={m.details.direction === "outgoing" ? "text-fg" : "text-fg-2"}>
                      {m.details.direction === "outgoing" ? "sent" : "received"} <span className="measured text-dim">#{m.details.seq}</span>
                    </td>
                    <td className="measured">{fmtBytes(m.details.size)}</td>
                    <td className="measured max-w-[360px] truncate text-xs text-fg">{m.details.preview ?? <span className="text-dim">{m.details.dataType}</span>}</td>
                    <td className="measured text-xs text-dim">{flow ? fmtMs(Math.abs(flow.latencyMs)) : "n/a"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
