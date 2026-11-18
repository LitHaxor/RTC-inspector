/**
 * Two ways to read a page's recording:
 *  - from the DevTools panel, via chrome.devtools.inspectedWindow.eval
 *  - from a normal extension tab, via chrome.scripting.executeScript (MAIN world)
 */

import { BRIDGE_KEY, CLEAR_EXPRESSION, readExpression, type Bridge, type BridgeRead } from "./bridge";
import type { TabDirectory } from "./panel/tabs";

export interface PageReader {
  read(after: number, limit: number): Promise<BridgeRead | null>;
  clear(): Promise<void>;
}

export type Evaluate = (expression: string) => Promise<unknown>;

export function evalReader(evaluate: Evaluate): PageReader {
  return {
    read: async (after, limit) => (await evaluate(readExpression(after, limit))) as BridgeRead | null,
    clear: async () => {
      await evaluate(CLEAR_EXPRESSION);
    },
  };
}

export const devtoolsEvaluate: Evaluate = (expression) =>
  new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(expression, (result, exception) => {
      if (exception && (exception.isError || exception.isException)) reject(new Error(exception.value ?? exception.description ?? "eval failed"));
      else resolve(result);
    });
  });

type Scripting = Pick<typeof chrome.scripting, "executeScript">;

// Runs inside the inspected page; must be self-contained (it is serialised).
function readInPage(key: string, after: number, limit: number): BridgeRead | null {
  const bridge = (window as unknown as Record<string, Bridge | undefined>)[key];
  return bridge && bridge.version === 1 ? bridge.read(after, limit) : null;
}

function clearInPage(key: string): void {
  (window as unknown as Record<string, Bridge | undefined>)[key]?.clear();
}

export function scriptingReader(tabId: number, scripting: Scripting = chrome.scripting): PageReader {
  return {
    async read(after, limit) {
      const [result] = await scripting.executeScript({ target: { tabId }, world: "MAIN", func: readInPage, args: [BRIDGE_KEY, after, limit] });
      return (result?.result as BridgeRead | null | undefined) ?? null;
    },
    async clear() {
      await scripting.executeScript({ target: { tabId }, world: "MAIN", func: clearInPage, args: [BRIDGE_KEY] });
    },
  };
}

type Tabs = Pick<typeof chrome.tabs, "query">;

/**
 * The tabs of one site, for the merged view. Undefined where the tabs and
 * scripting APIs are not available (a DevTools panel in some Chrome versions).
 */
export function chromeTabDirectory(tabs: Tabs | undefined = globalThis.chrome?.tabs, scripting: Scripting | undefined = globalThis.chrome?.scripting): TabDirectory | undefined {
  if (typeof tabs?.query !== "function" || typeof scripting?.executeScript !== "function") return undefined;
  return {
    // Match patterns and ports do not mix well, so compare origins here.
    async list(origin) {
      const found = await tabs.query({ url: ["http://*/*", "https://*/*"] });
      return found.flatMap((t) => (t.id !== undefined && t.url && originOf(t.url) === origin ? [t.id] : []));
    },
    reader: (tabId) => scriptingReader(tabId, scripting),
  };
}

export function originOf(url: string): string | undefined {
  try {
    const { origin } = new URL(url);
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}
