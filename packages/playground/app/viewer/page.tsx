"use client";

import { useState, type DragEvent } from "react";
import { parseTrace, type TraceFile } from "@rtc-inspector/core";
import { RTCInspector } from "@rtc-inspector/ui";
import { AppNav } from "../../src/components/AppNav";

type State = { kind: "empty" } | { kind: "loading"; name: string } | { kind: "error"; name: string; message: string } | { kind: "loaded"; name: string; trace: TraceFile };

export default function ViewerPage() {
  const [state, setState] = useState<State>({ kind: "empty" });
  const [dragging, setDragging] = useState(false);

  const load = async (file: File) => {
    setState({ kind: "loading", name: file.name });
    try {
      setState({ kind: "loaded", name: file.name, trace: parseTrace(await file.text()) });
    } catch (err) {
      setState({ kind: "error", name: file.name, message: (err as Error).message });
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) void load(file);
  };
  const picker = (
    <label className="ctl ctl--primary">
      {state.kind === "loaded" ? "Open another trace" : "Open trace file"}
      <input
        type="file"
        accept="application/json,.json"
        className="visually-hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void load(file);
          e.target.value = "";
        }}
      />
    </label>
  );

  return (
    <div className="flex h-dvh flex-col bg-ground" onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      <AppNav current="/viewer" />
      {state.kind === "loaded" ? (
        <main className="min-h-0 flex-1">
          <RTCInspector trace={state.trace} title={state.name} actions={picker} syncHash />
        </main>
      ) : (
        <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-16">
          <h1 className="text-xl font-medium text-fg">Open a recorded trace</h1>
          <p className="text-fg-2">
            Traces come from <span className="measured text-fg">inspector.downloadTrace()</span> in your app, or the Export trace button in any inspector. They stay in
            this tab; nothing is uploaded.
          </p>
          <div
            className={`flex flex-col items-start gap-3 rounded-panel border border-dashed p-6 ${dragging ? "border-person bg-person-soft" : "border-line-2 bg-panel"}`}
          >
            <p className="text-sm text-dim">Drop a .json trace here, or</p>
            {picker}
          </div>
          {state.kind === "loading" && <p className="text-sm text-dim" role="status">Reading {state.name}…</p>}
          {state.kind === "error" && (
            <div className="rounded-panel border border-danger bg-danger-soft p-4 text-sm" role="alert">
              <p className="font-medium text-danger">Could not open {state.name}</p>
              <p className="mt-1 text-fg-2">{state.message}</p>
              <p className="mt-1 text-dim">Check that it is an RTC Inspector trace (format "rtc-inspector-trace").</p>
            </div>
          )}
        </main>
      )}
    </div>
  );
}
