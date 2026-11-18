import type { InspectorOptions } from "@rtc-inspector/core";
import { Inspector, type PatchGlobalOptions } from "./inspector";

export const GLOBAL_KEY = "__RTC_INSPECTOR__";

type Holder = { [GLOBAL_KEY]?: Inspector };

/** The page-wide inspector installed by `installGlobalInspector` / `@rtc-inspector/sdk/auto`. */
export function getGlobalInspector(): Inspector | undefined {
  return (globalThis as Holder)[GLOBAL_KEY];
}

/**
 * Create (once) a page-wide inspector, expose it on `window.__RTC_INSPECTOR__`
 * and patch RTCPeerConnection so every connection in the page is observed.
 */
export function installGlobalInspector(options: InspectorOptions & { patch?: PatchGlobalOptions } = {}): Inspector {
  const holder = globalThis as Holder;
  const existing = holder[GLOBAL_KEY];
  if (existing) return existing;
  const { patch, ...sessionOptions } = options;
  const inspector = new Inspector(sessionOptions);
  inspector.patchGlobal(patch);
  holder[GLOBAL_KEY] = inspector;
  return inspector;
}
