import { useEffect, useState, type ReactNode } from "react";
import { RTCInspector, Segmented, type TabKey } from "@rtc-inspector/ui";
import { PagePoller, type PollStatus } from "./poller";
import { MultiTabSource, type TabDirectory, type TabInfo } from "./tabs";
import { originOf, type PageReader } from "../readers";

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function Message({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-3 px-6 py-12 text-sm">
      <h1 className="text-base font-medium text-fg">{title}</h1>
      <div className="flex flex-col gap-2 text-fg-2">{children}</div>
    </main>
  );
}

/** Explain a failure to read the page in words a person can act on. */
function explainError(message: string): { title: string; hint: string } {
  if (/No tab with id/i.test(message)) return { title: "The inspected tab was closed", hint: "Click the RTC Inspector icon on another tab to inspect it." };
  if (/chrome:\/\/|chrome-extension|webstore|Cannot access/i.test(message)) {
    return { title: "Chrome does not allow inspecting this page", hint: "chrome:// pages, the New Tab Page and the Chrome Web Store are off limits to every extension. Open an http(s) page." };
  }
  return { title: "Could not read the page", hint: "Reload the page to try again." };
}

type Scope = "tab" | "all";
const SCOPE_KEY = "rtc-inspector:scope";

function savedScope(): Scope {
  try {
    return localStorage.getItem(SCOPE_KEY) === "tab" ? "tab" : "all";
  } catch {
    return "all";
  }
}

function saveScope(scope: Scope) {
  try {
    localStorage.setItem(SCOPE_KEY, scope);
  } catch {
    // storage unavailable: the choice lasts until the window closes
  }
}

interface SiteTabs {
  source: MultiTabSource;
  tabs: TabInfo[];
  generation: number;
}

/** Every tab of the inspected page's site, merged; undefined until the first round is in. */
function useSiteTabs(directory: TabDirectory | undefined, origin: string | undefined): SiteTabs | undefined {
  const [state, setState] = useState<SiteTabs | undefined>();
  useEffect(() => {
    setState(undefined);
    if (!directory || !origin) return;
    const source = new MultiTabSource(directory, origin, () => setState({ source, tabs: source.tabs(), generation: source.generation }));
    source.start();
    return () => source.stop();
  }, [directory, origin]);
  return state;
}

export function InspectorApp({
  reader,
  tabs,
  onTitle,
  actions,
  initialTab = "events",
  compact = false,
}: {
  reader: PageReader;
  /** Lets the inspector also show the other tabs of the same site (the other ends of a call). */
  tabs?: { directory: TabDirectory; tabId: number };
  onTitle?: (host: string) => void;
  actions?: ReactNode;
  initialTab?: TabKey;
  compact?: boolean;
}) {
  const [status, setStatus] = useState<PollStatus | undefined>();
  const [scope, setScope] = useState<Scope>(savedScope);
  // Switching scope or reloading the page remounts the inspector: reopen on the same section.
  const [section, setSection] = useState<TabKey>(initialTab);
  const [waited, setWaited] = useState(false);

  useEffect(() => {
    const poller = new PagePoller(reader, setStatus);
    poller.start();
    return () => poller.stop();
  }, [reader]);

  const source = status?.kind === "attached" ? status.source : undefined;
  useEffect(() => {
    if (source) onTitle?.(hostOf(source.url));
  }, [source, onTitle]);

  const site = useSiteTabs(tabs?.directory, source ? originOf(source.url) : undefined);
  // Do not show one tab and then jump to all of them: wait briefly for the first round.
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), 1500);
    return () => clearTimeout(timer);
  }, []);

  if (!status || (tabs && source && !site && !waited)) return <Message title="Connecting to the page…" />;
  if (status.kind === "error") {
    const { title, hint } = explainError(status.message);
    return (
      <Message title={title}>
        <p>{hint}</p>
        <p className="measured text-xs text-dim">{status.message}</p>
      </Message>
    );
  }
  if (status.kind === "waiting") {
    return (
      <Message title="No recording on this page yet">
        <p>The extension starts recording when a page loads. Reload the page you want to inspect.</p>
        <p className="text-dim">Pages opened before the extension was installed or updated need one reload.</p>
      </Message>
    );
  }

  const recording = site?.tabs.filter((t) => t.recording) ?? [];
  const self = site?.tabs.find((t) => t.tabId === tabs?.tabId);
  const canMerge = !!site && !!self && recording.length > 1;
  const merged = canMerge && scope === "all";
  const choose = (next: Scope) => {
    setScope(next);
    saveScope(next);
  };
  const toolbar = (
    <>
      {canMerge && (
        <Segmented
          label="Show recordings from"
          value={merged ? "all" : "tab"}
          onChange={choose}
          options={[
            { value: "tab", label: `Tab ${self.n}` },
            { value: "all", label: `All ${recording.length} tabs` },
          ]}
        />
      )}
      {actions}
    </>
  );
  const title = hostOf(status.source.url);
  if (merged) {
    return (
      <RTCInspector
        key={`all:${site.generation}`}
        source={site.source}
        title={title}
        initialTab={section}
        onTabChange={setSection}
        actions={toolbar}
        compact={compact}
        focusGroup={`Tab ${self.n}`}
      />
    );
  }
  return (
    <RTCInspector key={status.source.sessionId} source={status.source} title={title} initialTab={section} onTabChange={setSection} actions={toolbar} compact={compact} />
  );
}

export function Unsupported({ children }: { children: ReactNode }) {
  return <Message title="Nothing to inspect here">{children}</Message>;
}
