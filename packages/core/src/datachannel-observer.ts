import { safely, toErrorInfo, wrapMethod } from "./instrument-utils";
import type { DataChannelInfo, EventDetailsMap, RTCEventType } from "./types";

export type PayloadCapture = "none" | "preview";

export interface DataChannelObserverContext {
  emit: <T extends RTCEventType>(type: T, details: EventDetailsMap[T], correlationId?: string) => void;
  channelKey: () => string;
  /** Whether to keep a short preview of message contents. */
  payload: PayloadCapture;
  previewLength: number;
  captureMessages: boolean;
}

const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : undefined;

export function payloadSize(data: unknown): number {
  if (typeof data === "string") return encoder ? encoder.encode(data).length : data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return 0;
}

export function payloadType(data: unknown): "string" | "binary" | "unknown" {
  if (typeof data === "string") return "string";
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return "binary";
  if (typeof Blob !== "undefined" && data instanceof Blob) return "binary";
  return "unknown";
}

export function payloadPreview(data: unknown, max: number): string | undefined {
  if (typeof data === "string") return data.length > max ? `${data.slice(0, max)}…` : data;
  let bytes: Uint8Array | undefined;
  if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (bytes) {
    const shown = Array.from(bytes.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join(" ");
    return bytes.byteLength > 16 ? `${shown} …` : shown;
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) return `[Blob ${data.size} bytes]`;
  return undefined;
}

export function channelInfo(channel: RTCDataChannel, channelKey: string): DataChannelInfo {
  return {
    channelKey,
    label: channel.label,
    id: channel.id ?? null,
    protocol: channel.protocol,
    ordered: channel.ordered,
    maxRetransmits: channel.maxRetransmits ?? null,
    maxPacketLifeTime: channel.maxPacketLifeTime ?? null,
    negotiated: channel.negotiated,
    readyState: channel.readyState,
    binaryType: channel.binaryType,
  };
}

/**
 * Observe one RTCDataChannel: lifecycle events, incoming messages and (by
 * wrapping the instance's `send`) outgoing messages.
 */
export function observeDataChannel(
  channel: RTCDataChannel,
  origin: "local" | "remote",
  ctx: DataChannelObserverContext,
): () => void {
  const key = ctx.channelKey();
  const info = () => channelInfo(channel, key);
  let sentSeq = 0;
  let receivedSeq = 0;
  const disposers: (() => void)[] = [];
  const listen = (type: string, handler: (event: Event) => void) => {
    const wrapped = (event: Event) => safely(() => handler(event));
    channel.addEventListener(type, wrapped);
    disposers.push(() => channel.removeEventListener(type, wrapped));
  };

  ctx.emit(origin === "local" ? "datachannel.created" : "datachannel.received", info());

  listen("open", () => ctx.emit("datachannel.open", info()));
  listen("closing", () => ctx.emit("datachannel.closing", info()));
  listen("close", () => ctx.emit("datachannel.close", info()));
  listen("error", (event) => {
    const error = (event as Event & { error?: unknown }).error;
    ctx.emit("datachannel.error", {
      ...info(),
      error: error ? toErrorInfo(error) : { name: "Error", message: "DataChannel error event" },
    });
  });

  if (ctx.captureMessages) {
    listen("message", (event) => {
      const data = (event as MessageEvent).data;
      receivedSeq += 1;
      const preview = ctx.payload === "preview" ? payloadPreview(data, ctx.previewLength) : undefined;
      ctx.emit("datachannel.message", {
        channelKey: key,
        label: channel.label,
        channelId: channel.id ?? null,
        direction: "incoming",
        dataType: payloadType(data),
        size: payloadSize(data),
        seq: receivedSeq,
        ...(preview !== undefined && { preview }),
      });
    });
  }

  disposers.push(
    wrapMethod(channel, "send", (original) =>
      function (this: RTCDataChannel, ...args: unknown[]) {
        const data = args[0];
        try {
          const result = original.apply(this, args);
          if (ctx.captureMessages) {
            safely(() => {
              sentSeq += 1;
              const preview = ctx.payload === "preview" ? payloadPreview(data, ctx.previewLength) : undefined;
              ctx.emit("datachannel.message", {
                channelKey: key,
                label: channel.label,
                channelId: channel.id ?? null,
                direction: "outgoing",
                dataType: payloadType(data),
                size: payloadSize(data),
                seq: sentSeq,
                bufferedAmount: channel.bufferedAmount,
                ...(preview !== undefined && { preview }),
              });
            });
          }
          return result;
        } catch (error) {
          safely(() => ctx.emit("datachannel.error", { ...info(), operation: "send", error: toErrorInfo(error) }));
          throw error;
        }
      },
    ),
  );

  return () => disposers.forEach((d) => d());
}
