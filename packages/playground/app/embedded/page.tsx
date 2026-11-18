"use client";

import { useEffect, useRef, useState } from "react";
import { getGlobalInspector, installGlobalInspector } from "@rtc-inspector/sdk";
import { RTCInspector } from "@rtc-inspector/ui";
import { AppNav } from "../../src/components/AppNav";

// Embedded mode: one line, before the app creates any RTCPeerConnection.
// From here on every connection in the page is observed, with no app changes.
if (typeof window !== "undefined" && typeof RTCPeerConnection !== "undefined") {
  installGlobalInspector({
    patch: { name: (i) => (i % 2 === 1 ? { peerId: `caller-${(i + 1) / 2}`, label: "caller", group: "caller" } : { peerId: `callee-${i / 2}`, label: "callee", group: "callee" }) },
  });
}

/**
 * A tiny loopback chat written as plain WebRTC code. It knows nothing about
 * the inspector: no observe() calls, no annotations.
 */
function useLoopbackChat() {
  const [log, setLog] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const channel = useRef<RTCDataChannel | null>(null);
  const pcs = useRef<RTCPeerConnection[]>([]);

  const connect = async () => {
    pcs.current.forEach((pc) => pc.close());
    setReady(false);
    const caller = new RTCPeerConnection();
    const callee = new RTCPeerConnection();
    pcs.current = [caller, callee];
    caller.onicecandidate = (e) => e.candidate && callee.addIceCandidate(e.candidate);
    callee.onicecandidate = (e) => e.candidate && caller.addIceCandidate(e.candidate);
    callee.ondatachannel = (e) => {
      e.channel.onmessage = (m) => {
        setLog((l) => [...l, `callee got: ${m.data}`]);
        e.channel.send(`echo: ${m.data}`);
      };
    };
    const dc = caller.createDataChannel("chat");
    dc.onopen = () => setReady(true);
    dc.onmessage = (m) => setLog((l) => [...l, `caller got: ${m.data}`]);
    channel.current = dc;
    await caller.setLocalDescription();
    await callee.setRemoteDescription(caller.localDescription!);
    await callee.setLocalDescription();
    await caller.setRemoteDescription(callee.localDescription!);
  };

  useEffect(() => () => pcs.current.forEach((pc) => pc.close()), []);
  return { log, ready, connect, send: (text: string) => channel.current?.send(text) };
}

export default function EmbeddedPage() {
  const chat = useLoopbackChat();
  const [text, setText] = useState("ping");
  const [inspector, setInspector] = useState<ReturnType<typeof getGlobalInspector>>();
  useEffect(() => setInspector(getGlobalInspector()), []);

  return (
    <div className="flex h-dvh flex-col bg-ground">
      <AppNav current="/embedded" />
      <section className="grid shrink-0 gap-4 border-b border-line bg-panel px-4 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" aria-label="Host application">
        <div className="flex flex-col gap-3">
          <h1 className="text-base font-medium text-fg">Your app, unchanged</h1>
          <p className="text-sm text-dim">This chat is plain WebRTC code. The inspector below watches it because the page installed it once, before any connection existed.</p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="ctl ctl--primary" onClick={() => void chat.connect()}>
              Connect
            </button>
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                chat.send(text);
              }}
            >
              <input className="field w-48" aria-label="Message" value={text} onChange={(e) => setText(e.target.value)} disabled={!chat.ready} />
              <button type="submit" className="ctl" disabled={!chat.ready}>
                Send
              </button>
            </form>
          </div>
          <ol className="measured max-h-24 overflow-auto text-xs text-fg-2" aria-label="Chat log">
            {chat.log.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ol>
        </div>
        <pre className="measured overflow-auto rounded-ctl border border-line bg-well p-3 text-xs text-fg-2">{`import { installGlobalInspector } from "@rtc-inspector/sdk";
import { RTCInspector } from "@rtc-inspector/ui";

// once, before your app creates connections
const inspector = installGlobalInspector();

// anywhere in your React tree
<RTCInspector session={inspector} />

// or without React: log to the console, export a trace
inspector.logToConsole();
inspector.downloadTrace();`}</pre>
      </section>
      <main className="min-h-0 flex-1">{inspector && <RTCInspector session={inspector} title="Inspector (embedded)" initialTab="timeline" />}</main>
    </div>
  );
}
