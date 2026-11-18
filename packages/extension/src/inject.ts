/**
 * Runs in the page's own JavaScript world at document_start, before any page
 * script, so every RTCPeerConnection the page creates is observed.
 * The page's code is not modified; RTCPeerConnection is subclassed in place.
 */

import { installGlobalInspector } from "@rtc-inspector/sdk";
import { exposeBridge } from "./bridge";
import { PAGE_SOURCE, type PagePeersMessage } from "./messages";

// May run twice in one page (content script, then re-attached after an extension
// update); installGlobalInspector() returns the existing inspector the second time.
if (typeof RTCPeerConnection !== "undefined") {
  const inspector = installGlobalInspector({ statsIntervalMs: 1000 });
  const bridge = exposeBridge(inspector, window);

  // Tell the extension how many connections this page has (for the toolbar badge).
  const report = () => window.postMessage({ source: PAGE_SOURCE, ...bridge.counts() } satisfies PagePeersMessage, location.origin === "null" ? "*" : location.origin);
  inspector.subscribe((e) => {
    if (e.type === "peer.created" || e.type === "peer.closed") report();
  });
  setTimeout(report, 0); // the relay script may start after us
}
