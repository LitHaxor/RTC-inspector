import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { chromeTabDirectory, devtoolsEvaluate, evalReader } from "../readers";
import { InspectorApp, Unsupported } from "./App";
import "./fonts.css";
import "./panel.css";

const supported = typeof chrome !== "undefined" && !!chrome.devtools?.inspectedWindow;
const reader = supported ? evalReader(devtoolsEvaluate) : undefined;
// The merged view needs chrome.tabs and chrome.scripting; DevTools panels get them in recent Chrome only.
const directory = supported ? chromeTabDirectory() : undefined;
const tabs = directory ? { directory, tabId: chrome.devtools.inspectedWindow.tabId } : undefined;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {reader ? (
      <InspectorApp reader={reader} tabs={tabs} />
    ) : (
      <Unsupported>
        <p>This is the DevTools panel. Click the RTC Inspector icon in the toolbar instead, or open DevTools on a page and pick the RTC Inspector tab.</p>
      </Unsupported>
    )}
  </StrictMode>,
);
