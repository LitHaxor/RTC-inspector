# Chrome Web Store listing

Everything the [Developer Dashboard](https://chrome.google.com/webstore/devconsole) asks for, ready to paste. Upload `release/rtc-inspector-<version>.zip` (built by `pnpm package:extension`), then fill each tab as below.

## Package

| | |
| --- | --- |
| File | `packages/extension/release/rtc-inspector-0.1.0.zip` |
| Version | `0.1.0` (from `public/manifest.json`; must match `package.json`) |
| Visibility | Public |
| Regions | All regions |
| Price | Free |

## Store listing tab

**Name** (from the manifest)

```
RTC Inspector
```

**Summary** (from the manifest, 124 of 132 characters)

```
See what any page's WebRTC connections are doing: signaling, ICE, data channels and stats. Everything stays in your browser.
```

**Category:** Developer Tools
**Language:** English

**Description** (plain text; the store does not render Markdown)

```text
RTC Inspector shows what every WebRTC connection on a page is doing, and explains in plain language why one failed. No code changes, no setup: open a page that uses WebRTC and click the icon.

The toolbar icon turns blue on pages that use WebRTC and its badge counts the connections that are open. Click it to inspect the tab in a popup, open a full-size inspector window, or use the RTC Inspector panel in DevTools.

WHAT YOU GET

• Sequence timeline: every offer, answer, ICE candidate and DataChannel message drawn between the peers that sent and received it.
• Both ends of a call: when each participant is a tab of the same site, the recordings are merged and paired, so you see the call from both sides.
• Diagnosis: rules spot the common failures (candidates never forwarded, answer lost in signaling, no TURN server, channel created after negotiation, send() before open, packet loss, high round-trip time) and say what to check.
• Action log with diffs: every WebRTC event in order, what it changed in the connection's state, and what it means.
• Time travel: scrub through the recording and every view shows the connection as it was at that moment.
• Signaling: SDP structure by media section, raw text and a diff between descriptions.
• ICE: local and remote candidates, candidate pairs and the selected path.
• Data channels: each channel's settings and state, and a log of messages with size and timing.
• Live stats: round-trip time, bitrates, packet loss and DTLS state, charted once per second.
• Export: save a trace file to share with a teammate or attach to a bug report.

PRIVATE BY DESIGN

RTC Inspector collects nothing and sends nothing. The recording stays in the page's memory and is gone when the page reloads or closes. IP addresses are shortened and ICE passwords removed at capture time. The extension's fonts and code are all packaged with it; it makes no network requests.

GOOD TO KNOW

• Works on http and https pages in Chrome 111 or later.
• Only the top frame of a page is recorded.
• Chrome blocks every extension on chrome:// pages, the New Tab Page and the Chrome Web Store.
• Tabs that were open before installation are attached automatically; connections they create from then on are recorded. Reload a page to capture a call from its first offer.

Try it on the WebRTC samples: https://webrtc.github.io/samples/src/content/datachannel/basic/ (click Start).
```

### Graphic assets

Regenerate them with `node packages/extension/scripts/store-assets.ts` after a build.

| Slot | File | Size |
| --- | --- | --- |
| Store icon | `store/icon-128.png` | 128 × 128 (96 px artwork, 16 px padding) |
| Screenshot 1 | `store/screenshots/1-timeline.png` | 1280 × 800 |
| Screenshot 2 | `store/screenshots/2-overview.png` | 1280 × 800 |
| Screenshot 3 | `store/screenshots/3-events.png` | 1280 × 800 |
| Screenshot 4 | `store/screenshots/4-stats.png` | 1280 × 800 |
| Screenshot 5 | `store/screenshots/5-diagnosis.png` | 1280 × 800 |
| Small promo tile | `store/promo/small-440x280.png` | 440 × 280 |
| Marquee promo tile | `store/promo/marquee-1400x560.png` | 1400 × 560 |

Screenshots and tiles are 24-bit PNGs without an alpha channel, as the store requires.

**Official URL / homepage:** https://github.com/LitHaxor/RTC-inspector
**Support URL:** https://github.com/LitHaxor/RTC-inspector/issues

## Privacy practices tab

**Single purpose**

```
RTC Inspector is a developer tool that records the WebRTC activity (peer connections, data channels, signaling, ICE and connection statistics) of the page in the current tab and displays it, so developers can see what their connections are doing and why they fail.
```

**Permission justifications**

`scripting`

```
Used to run a read-only function in the tab the user is inspecting, which returns that tab's WebRTC recording to the extension's inspector page, and to attach the recorder to tabs that were already open when the extension was installed or updated.
```

Host permissions (`http://*/*`, `https://*/*`) and content scripts

```
WebRTC connections can only be observed from inside the page that creates them, and a page can create one at any moment on any site the developer is working on (localhost, staging, production). The content script must run at document_start, before the page's own code, so it observes every connection from the first one. Host access is also needed to read the recording when the user opens the inspector and to update the toolbar badge. Nothing is read from pages that do not use WebRTC, and nothing leaves the browser.
```

**Remote code:** No, I am not using remote code.

```
All JavaScript, styles and fonts are included in the package. The extension loads no external scripts, uses no eval(), and makes no network requests.
```

**Data usage**

The extension processes page content (WebRTC activity) locally and never transmits it. Declaring that conservatively avoids a mismatch with what reviewers observe:

- Tick **Website content** only. Leave every other category unticked.
- Tick all three certifications:
  - I do not sell or transfer user data to third parties, outside of the approved use cases.
  - I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
  - I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://github.com/LitHaxor/RTC-inspector/blob/main/PRIVACY.md

## Notes for the reviewer

```
To see the extension work: open https://webrtc.github.io/samples/src/content/datachannel/basic/ and click Start. The toolbar icon turns blue with a badge of 2. Click the icon to open the inspector for that tab; the Timeline, Events and Data channels tabs show the two connections and the messages sent between them. The extension makes no network requests; all data stays in the tab.
```
