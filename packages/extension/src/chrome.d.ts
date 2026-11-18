// The few chrome.* APIs this extension uses (avoids a @types/chrome dependency).
declare namespace chrome.devtools {
  namespace panels {
    function create(title: string, iconPath: string, pagePath: string, callback?: (panel: unknown) => void): void;
  }
  namespace inspectedWindow {
    const tabId: number;
    function eval(
      expression: string,
      callback: (result: unknown, exceptionInfo?: { isError?: boolean; isException?: boolean; value?: string; description?: string }) => void,
    ): void;
  }
}

declare namespace chrome.scripting {
  function executeScript<Args extends unknown[], Result>(injection: {
    target: { tabId: number };
    world?: "MAIN" | "ISOLATED";
    func: (...args: Args) => Result;
    args?: Args;
  }): Promise<{ result?: Result }[]>;
  function executeScript(injection: { target: { tabId: number }; world?: "MAIN" | "ISOLATED"; files: string[] }): Promise<{ result?: unknown }[]>;
}

declare namespace chrome.tabs {
  interface Tab {
    id?: number;
    url?: string;
    index: number;
    windowId: number;
  }
  function create(props: { url: string; index?: number; windowId?: number; openerTabId?: number; active?: boolean }): Promise<Tab>;
  function get(tabId: number): Promise<Tab>;
  function query(query: { url?: string | string[]; active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
  const onActivated: { addListener(callback: (info: { tabId: number; windowId: number }) => void): void };
  const onUpdated: { addListener(callback: (tabId: number, change: { status?: "loading" | "complete" }) => void): void };
  const onRemoved: { addListener(callback: (tabId: number) => void): void };
  function update(tabId: number, props: { active?: boolean }): Promise<Tab>;
}

declare namespace chrome.windows {
  function update(windowId: number, props: { focused?: boolean }): Promise<unknown>;
  function create(props: { url: string; type?: "normal" | "popup"; width?: number; height?: number; focused?: boolean }): Promise<{ id?: number; tabs?: chrome.tabs.Tab[] }>;
}

declare namespace chrome.action {
  function setBadgeText(details: { tabId?: number; text: string }): Promise<void>;
  function getBadgeText(details: { tabId?: number }): Promise<string>;
  function setBadgeBackgroundColor(details: { tabId?: number; color: string }): Promise<void>;
  function setBadgeTextColor(details: { tabId?: number; color: string }): Promise<void>;
  function setIcon(details: { tabId?: number; path: Record<number, string> }): Promise<void>;
  function setTitle(details: { tabId?: number; title: string }): Promise<void>;
}

declare namespace chrome.runtime {
  function getURL(path: string): string;
  function reload(): void;
  const onInstalled: { addListener(callback: (details: { reason: string }) => void): void };
  function sendMessage(message: unknown): Promise<unknown>;
  const onMessage: {
    addListener(callback: (message: never, sender: { tab?: chrome.tabs.Tab }, sendResponse: (response?: unknown) => void) => void): void;
  };
}
