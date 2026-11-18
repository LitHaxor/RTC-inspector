# @rtc-inspector/sdk

Drop-in WebRTC instrumentation for your own app. It observes `RTCPeerConnection`s and `RTCDataChannel`s without changing how they behave, records every step as a structured event, and lets you view the result live, log it, or export it as a trace.

The [RTC Inspector Chrome extension](../../README.md) uses this SDK under the hood. Use the SDK directly when you want the inspector inside your app, in tests, or in a browser without the extension.

`@rtc-inspector/sdk` and `@rtc-inspector/core` have no React dependency. The visual inspector lives in `@rtc-inspector/ui`.

## Zero-config: patch the constructor

Import before your app creates any connection:

```ts
import "@rtc-inspector/sdk/auto"; // window.__RTC_INSPECTOR__ observes every new RTCPeerConnection
```

or, with options:

```ts
import { installGlobalInspector } from "@rtc-inspector/sdk";

const inspector = installGlobalInspector({
  statsIntervalMs: 1000,
  patch: { name: (i) => `pc-${i}` },
});
```

`patchGlobal()` replaces `RTCPeerConnection` with a subclass, so `instanceof` keeps working, and returns a function that restores the original.

## Explicit

```ts
import { createInspector } from "@rtc-inspector/sdk";

const inspector = createInspector();
const handle = inspector.observe(pc, { peerId: "caller", label: "Caller", group: "alice" });
// later
handle.dispose(); // restores every wrapped method
```

## Viewing

```tsx
import { RTCInspector } from "@rtc-inspector/ui";
import "@rtc-inspector/ui/styles.css";

<RTCInspector session={inspector} />;      // live
<RTCInspector trace={parseTrace(json)} />; // recorded
```

Without React: `inspector.logToConsole()` prints each event in plain language, and `inspector.downloadTrace()` saves a trace file to open in the viewer.

## Signaling annotations (optional)

WebRTC does not define signaling, so the SDK cannot see when your app sends an offer. Report it and the timeline draws an arrow from sender to receiver:

```ts
inspector.signaling(peerId, { direction: "sent", kind: "offer", messageId: msg.id, remote: "bob" });
// on the receiving side
inspector.signaling(peerId, { direction: "received", kind: "offer", messageId: msg.id, remote: "alice" });
```

Without annotations, flows are still inferred when both peers are in the same session: an SDP's `o=` line identifies it on both ends, candidates match by foundation, port and priority, and DataChannel messages match by channel and sequence.

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `redact` | `true` | Shorten IP addresses and remove `a=ice-pwd` at capture time. |
| `payload` | `"preview"` | `"none"` records DataChannel message sizes but no content. |
| `previewLength` | `200` | Characters kept per message preview. |
| `captureMessages` | `true` | `false` stops recording DataChannel messages entirely. |
| `statsIntervalMs` | `1000` | How often `getStats()` is sampled per connection. `0` turns sampling off. |
| `maxEvents` | `20000` | Ring buffer size; the oldest 10% is dropped when it fills. |

## Interception rules

- Methods are wrapped on the instance, never the prototype.
- Return values, resolutions and rejections are passed through unchanged.
- The legacy callback signatures are supported.
- `on*` handlers set by the app keep working.
- An exception inside the inspector never reaches the app.

The full event schema is in [packages/core/src/types.ts](../core/src/types.ts).

## Known limitations

- Declaration files use extensionless imports, which suits bundlers; Node's `node16` resolution would need `.js` extensions.
