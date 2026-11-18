import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ExternalLink, PanelTop } from "lucide-react";
import { chromeTabDirectory, scriptingReader, type PageReader } from "../readers";
import { InspectorApp, Unsupported } from "../panel/App";
import type { RuntimeMessage } from "../messages";
import "../panel/fonts.css";
import "../panel/panel.css";

/** The tab to inspect: ?tabId= when given (tests), otherwise the active tab. */
async function targetTab(): Promise<number | undefined> {
  const fromQuery = Number(new URLSearchParams(location.search).get("tabId"));
  if (Number.isInteger(fromQuery) && fromQuery > 0) return fromQuery;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function open(tabId: number, mode: "tab" | "window") {
  const message: RuntimeMessage = { type: "rtc-inspector:open", tabId, mode };
  void chrome.runtime.sendMessage(message).then(() => window.close());
}

const directory = chromeTabDirectory();
const siteTabs = (tabId: number) => (directory ? { directory, tabId } : undefined);

function Popup() {
  const [target, setTarget] = useState<{ tabId: number; reader: PageReader } | null | undefined>();
  useEffect(() => {
    void targetTab().then((tabId) => setTarget(tabId ? { tabId, reader: scriptingReader(tabId) } : null));
  }, []);
  if (target === undefined) return null;
  if (target === null) return <Unsupported>No tab to inspect.</Unsupported>;
  const actions = (
    <>
      <button type="button" className="ctl" onClick={() => open(target.tabId, "window")} aria-label="Open in window" title="Open in window">
        <PanelTop size={14} aria-hidden="true" />
        Window
      </button>
      <button type="button" className="ctl" onClick={() => open(target.tabId, "tab")} aria-label="Open in tab" title="Open in tab">
        <ExternalLink size={14} aria-hidden="true" />
        Tab
      </button>
    </>
  );
  return <InspectorApp reader={target.reader} tabs={siteTabs(target.tabId)} actions={actions} initialTab="events" compact />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
