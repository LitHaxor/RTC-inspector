/**
 * Background worker: toolbar badge (connections on the page) and opening the
 * inspector in a tab or a window, reusing one that is already open.
 */

import { BRIDGE_KEY, type PeerCounts } from "./bridge";
import { tabAppearance, type RuntimeMessage } from "./messages";

const opened = new Map<string, number>(); // `${mode}:${tabId}` -> inspector tab id

export async function openInspectorFor(tab: chrome.tabs.Tab, mode: "tab" | "window" = "tab"): Promise<number | undefined> {
  if (tab.id === undefined) return undefined;
  const key = `${mode}:${tab.id}`;
  const existing = opened.get(key);
  if (existing !== undefined) {
    try {
      const t = await chrome.tabs.get(existing);
      await chrome.tabs.update(existing, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
      return existing;
    } catch {
      opened.delete(key); // it was closed
    }
  }
  const url = chrome.runtime.getURL(`inspector.html?tabId=${tab.id}`);
  let id: number | undefined;
  if (mode === "window") {
    const win = await chrome.windows.create({ url, type: "popup", width: 1280, height: 820, focused: true });
    id = win.tabs?.[0]?.id;
  } else {
    id = (await chrome.tabs.create({ url, index: tab.index + 1, windowId: tab.windowId, openerTabId: tab.id })).id;
  }
  if (id !== undefined) opened.set(key, id);
  return id;
}

/** Last appearance applied per tab (read by the end-to-end test). */
const tabState = new Map<number, boolean>();

async function applyTab(tabId: number, counts: PeerCounts): Promise<void> {
  const look = tabAppearance(counts);
  tabState.set(tabId, look.active);
  try {
    await Promise.all([
      chrome.action.setIcon({ tabId, path: look.icon }),
      chrome.action.setBadgeText({ tabId, text: look.badge }),
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#2b7de9" }),
      chrome.action.setBadgeTextColor({ tabId, color: "#ffffff" }),
      chrome.action.setTitle({ tabId, title: look.title }),
    ]);
  } catch {
    // the tab went away
  }
}

/** When each tab last reported its count; a newer report beats an older refresh. */
const reportedAt = new Map<number, number>();

// Ask the page directly: covers navigations (including to chrome:// pages, where
// no script runs and the icon must go back to gray), tab switches and single-page apps.
async function refreshTab(tabId: number): Promise<void> {
  const started = performance.now();
  let counts: PeerCounts = { open: 0, total: 0 };
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      // Runs in the page, so it cannot use imports: BRIDGE_KEY is passed in.
      func: (key: string) => {
        const bridge = (window as unknown as Record<string, { counts?: () => PeerCounts } | undefined>)[key];
        return bridge?.counts ? bridge.counts() : null;
      },
      args: [BRIDGE_KEY],
    });
    const r = result?.result as Partial<PeerCounts> | null | undefined;
    if (r && typeof r.open === "number" && typeof r.total === "number") counts = { open: r.open, total: r.total };
  } catch {
    // not scriptable (chrome://, Web Store) or gone: gray
  }
  if ((reportedAt.get(tabId) ?? -1) > started) return; // the page reported something newer meanwhile
  await applyTab(tabId, counts);
}

/**
 * After install or update, Chrome does not add content scripts to tabs that are
 * already open, and the previous version's scripts are cut off. Add them now so
 * those tabs work without a reload (connections created from now on are recorded).
 */
async function attachToOpenTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", files: ["inject.global.js"] });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["relay.global.js"] });
      } catch {
        // tab not scriptable
      }
      await refreshTab(tab.id);
    }),
  );
}

chrome.runtime.onInstalled.addListener(() => void attachToOpenTabs());
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading") reportedAt.delete(tabId);
  if (change.status === "loading" || change.status === "complete") void refreshTab(tabId);
});
chrome.tabs.onActivated.addListener(({ tabId }) => void refreshTab(tabId));
chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
  reportedAt.delete(tabId);
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender) => {
  if (message.type === "rtc-inspector:peers" && sender.tab?.id !== undefined) {
    reportedAt.set(sender.tab.id, performance.now());
    void applyTab(sender.tab.id, { open: message.open, total: message.total });
  }
  if (message.type === "rtc-inspector:open") {
    void chrome.tabs.get(message.tabId).then((tab) => openInspectorFor(tab, message.mode));
  }
});

// Exposed for the end-to-end test, which cannot click the toolbar or read the icon.
Object.assign(globalThis, { openInspectorFor, tabState, attachToOpenTabs });
