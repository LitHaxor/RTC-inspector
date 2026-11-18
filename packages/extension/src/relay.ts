/**
 * Isolated-world content script: forwards the page script's connection count
 * to the background worker, which shows it on the toolbar badge.
 */

import { isPagePeersMessage, type RuntimeMessage } from "./messages";

window.addEventListener("message", (event) => {
  if (event.source !== window || !isPagePeersMessage(event.data)) return;
  const message: RuntimeMessage = { type: "rtc-inspector:peers", open: event.data.open, total: event.data.total };
  chrome.runtime.sendMessage(message).catch(() => {
    // the extension was reloaded; nothing to update
  });
});
