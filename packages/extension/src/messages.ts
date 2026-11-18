/** Messages between the page, the relay content script, the popup and the background worker. */

import type { PeerCounts } from "./bridge";

export const PAGE_SOURCE = "rtc-inspector";

/** Posted by the page script with window.postMessage. */
export interface PagePeersMessage extends PeerCounts {
  source: typeof PAGE_SOURCE;
}

export type RuntimeMessage =
  | ({ type: "rtc-inspector:peers" } & PeerCounts)
  | { type: "rtc-inspector:open"; tabId: number; mode: "tab" | "window" };

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

export function isPagePeersMessage(data: unknown): data is PagePeersMessage {
  const d = data as Partial<PagePeersMessage> | null;
  return !!d && d.source === PAGE_SOURCE && isCount(d.open) && isCount(d.total) && d.open <= d.total;
}

export function badgeText(count: number): string {
  if (count <= 0) return "";
  return count > 99 ? "99+" : String(count);
}

const iconSet = (state: "active" | "inactive") => ({
  16: `icons/${state}-16.png`,
  32: `icons/${state}-32.png`,
  48: `icons/${state}-48.png`,
  128: `icons/${state}-128.png`,
});

export interface TabAppearance {
  active: boolean;
  icon: Record<number, string>;
  badge: string;
  title: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Blue icon when the page used WebRTC, gray otherwise.
 * The badge counts connections that are still open; closed ones stay in the recording.
 */
export function tabAppearance({ open, total }: PeerCounts): TabAppearance {
  const active = total > 0;
  let title = "RTC Inspector: no WebRTC on this page";
  if (open > 0) title = `RTC Inspector: ${plural(open, "open connection")} on this page`;
  if (open > 0 && total > open) title += `, ${total - open} closed`;
  if (active && open === 0) title = `RTC Inspector: ${plural(total, "connection")} recorded, all closed`;
  return { active, icon: iconSet(active ? "active" : "inactive"), badge: badgeText(open), title };
}
