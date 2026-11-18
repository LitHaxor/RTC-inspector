import {
  InspectorSession,
  describeEvent,
  type InspectorOptions,
  type ObserveOptions,
  type RTCTraceEvent,
  type Tone,
} from "@rtc-inspector/core";

const PATCHED = Symbol.for("rtc-inspector.patched");

type PeerConnectionCtor = typeof RTCPeerConnection & { [PATCHED]?: true };
type GlobalWithRTC = { RTCPeerConnection?: PeerConnectionCtor; webkitRTCPeerConnection?: PeerConnectionCtor };

export interface PatchGlobalOptions {
  /** Name each new connection. Return a peer id string or full observe options. */
  name?: (index: number, configuration?: RTCConfiguration) => string | ObserveOptions | undefined;
  /** Object that owns RTCPeerConnection. Defaults to globalThis. */
  target?: object;
}

export interface ConsoleLoggerOptions {
  /** Only log events for which this returns true. Stats samples are skipped by default. */
  filter?: (event: RTCTraceEvent) => boolean;
  logger?: Pick<Console, "log">;
}

const TONE_COLOR: Record<Tone, string> = {
  neutral: "color:inherit",
  info: "color:#2563eb",
  success: "color:#16a34a",
  warning: "color:#d97706",
  error: "color:#dc2626;font-weight:bold",
};

/**
 * The SDK entry point. An InspectorSession (event collector) plus browser
 * conveniences: global patching, console logging, trace download.
 */
export class Inspector extends InspectorSession {
  /**
   * Replace the global RTCPeerConnection with a subclass that observes every
   * instance it creates. `instanceof RTCPeerConnection` keeps working.
   * Returns a function that restores the original constructor.
   */
  patchGlobal(options: PatchGlobalOptions = {}): () => void {
    const target = (options.target ?? globalThis) as GlobalWithRTC;
    const Original = target.RTCPeerConnection;
    if (!Original) {
      console.warn("[rtc-inspector] RTCPeerConnection is not available in this environment");
      return () => {};
    }
    if (Original[PATCHED]) {
      console.warn("[rtc-inspector] RTCPeerConnection is already patched");
      return () => {};
    }
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const session = this;
    let index = 0;
    class InstrumentedRTCPeerConnection extends Original {
      constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
        super(...args);
        index += 1;
        let meta: ObserveOptions = {};
        try {
          const named = options.name?.(index, args[0]);
          meta = typeof named === "string" ? { peerId: named } : named ?? {};
        } catch {
          // a naming callback must never break connection creation
        }
        session.observe(this, meta);
      }
    }
    Object.defineProperty(InstrumentedRTCPeerConnection, "name", { value: "RTCPeerConnection" });
    Object.defineProperty(InstrumentedRTCPeerConnection, PATCHED, { value: true });
    const Patched = InstrumentedRTCPeerConnection as unknown as PeerConnectionCtor;
    target.RTCPeerConnection = Patched;
    const patchedWebkit = target.webkitRTCPeerConnection === Original;
    if (patchedWebkit) target.webkitRTCPeerConnection = Patched;
    return () => {
      if (target.RTCPeerConnection === Patched) target.RTCPeerConnection = Original;
      if (patchedWebkit && target.webkitRTCPeerConnection === Patched) target.webkitRTCPeerConnection = Original;
    };
  }

  /** Pretty-print events to the console as they happen. Returns an unsubscribe function. */
  logToConsole(options: ConsoleLoggerOptions = {}): () => void {
    const logger = options.logger ?? console;
    const filter = options.filter ?? ((e: RTCTraceEvent) => e.type !== "stats.sample");
    return this.subscribe((event) => {
      if (!filter(event)) return;
      const d = describeEvent(event);
      const t = ((event.timestamp - this.startedAt) / 1000).toFixed(3).padStart(8);
      logger.log(`%c[rtc] +${t}s %c${event.peerId}%c ${d.title}%c ${d.summary}`, "color:gray", "font-weight:bold", TONE_COLOR[d.tone], "color:gray");
    });
  }

  /** Serialise the session and trigger a browser download. */
  downloadTrace(filename = `rtc-trace-${new Date().toISOString().replace(/[:.]/g, "-")}.json`): void {
    const trace = this.exportTrace(typeof navigator !== "undefined" ? { userAgent: navigator.userAgent } : {});
    const blob = new Blob([JSON.stringify(trace, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function createInspector(options?: InspectorOptions): Inspector {
  return new Inspector(options);
}
