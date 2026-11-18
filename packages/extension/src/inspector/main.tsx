import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { chromeTabDirectory, scriptingReader } from "../readers";
import { InspectorApp, Unsupported } from "../panel/App";
import "../panel/fonts.css";
import "../panel/panel.css";

const tabId = Number(new URLSearchParams(location.search).get("tabId"));
const reader = Number.isInteger(tabId) && tabId > 0 ? scriptingReader(tabId) : undefined;
const directory = chromeTabDirectory();
const setTitle = (host: string) => {
  document.title = `RTC Inspector: ${host}`;
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {reader ? (
      <InspectorApp reader={reader} tabs={directory ? { directory, tabId } : undefined} onTitle={setTitle} />
    ) : (
      <Unsupported>
        <p>Open a page that uses WebRTC and click the RTC Inspector icon in the toolbar.</p>
      </Unsupported>
    )}
  </StrictMode>,
);
