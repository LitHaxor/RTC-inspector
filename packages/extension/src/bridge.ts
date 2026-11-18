/**
 * The page-side read API the DevTools panel polls through
 * chrome.devtools.inspectedWindow.eval(). It only reads from the page's
 * InspectorSession; nothing leaves the browser.
 */

import type { InspectorSession, RTCTraceEvent } from "@rtc-inspector/core";

export const BRIDGE_KEY = "__RTC_INSPECTOR_BRIDGE__";

export interface BridgeRead {
  sessionId: string;
  url: string;
  events: RTCTraceEvent[];
  /** More events are waiting beyond `limit`; read again with the last seq. */
  more: boolean;
  dropped: number;
}

export interface PeerCounts {
  /** Connections not closed yet. */
  open: number;
  /** Every connection observed on this page, closed ones included. */
  total: number;
}

export interface Bridge {
  version: 1;
  read(after?: number, limit?: number): BridgeRead;
  clear(): void;
  counts(): PeerCounts;
}

/** First index whose seq is greater than `after` (events are ordered by seq). */
function firstAfter(events: RTCTraceEvent[], after: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid]!.seq <= after) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function createBridge(inspector: InspectorSession, location: { href: string } = { href: "" }): Bridge {
  return {
    version: 1,
    read(after = 0, limit = 2000) {
      const all = inspector.getAllEvents();
      const start = firstAfter(all, after);
      const events = all.slice(start, start + limit);
      return {
        sessionId: inspector.sessionId,
        url: location.href,
        events,
        more: start + limit < all.length,
        dropped: inspector.droppedEvents,
      };
    },
    clear() {
      inspector.clear();
    },
    counts() {
      const peers = inspector.getPeers();
      return { open: peers.filter((p) => p.pc.signalingState !== "closed").length, total: peers.length };
    },
  };
}

export function exposeBridge(inspector: InspectorSession, target: object = globalThis): Bridge {
  const bridge = createBridge(inspector, (target as { location?: { href: string } }).location ?? { href: "" });
  Object.defineProperty(target, BRIDGE_KEY, { value: bridge, configurable: true, enumerable: false });
  return bridge;
}

/** The expression the panel evaluates in the inspected page. */
export function readExpression(after: number, limit = 2000): string {
  return `(function(){var b=window.${BRIDGE_KEY};return b&&b.version===1?b.read(${Math.floor(after)},${Math.floor(limit)}):null})()`;
}

export const CLEAR_EXPRESSION = `(function(){var b=window.${BRIDGE_KEY};if(b)b.clear();return true})()`;
