# RTC Inspector privacy policy

_Effective 18 November 2026. Applies to the RTC Inspector Chrome extension._

RTC Inspector is a developer tool that shows what the WebRTC connections on a web page are doing. It works entirely inside your browser. **It does not collect, transmit, sell or share any data.** There is no account, no analytics, no telemetry and no server operated by the extension.

## What the extension reads

On `http` and `https` pages, the extension observes the page's use of the WebRTC API (`RTCPeerConnection` and `RTCDataChannel`) and records:

- the page's address, to label the recording;
- connection settings and state changes (signaling, ICE, DTLS, connection state);
- session descriptions (SDP) and ICE candidates;
- DataChannel lifecycle and messages: direction, size, sequence number and, by default, a preview of the first 200 characters;
- connection statistics from `getStats()`, once per second while a connection is open;
- errors raised by WebRTC calls.

It does not read page text, form fields, cookies, browsing history, or audio and video content.

### Redaction at capture time

Before anything is recorded:

- IP addresses in candidates, SDP and statistics are shortened: private addresses keep their prefix (`192.168.x.x`), public addresses keep only their first octet (`203.x.x.x`);
- the `a=ice-pwd` value in SDP is replaced with `[redacted]`;
- TURN passwords are never recorded; only whether one is set. Server URLs and usernames are kept, because they are needed to diagnose server errors.

## Where the data is kept

- **In the page's own memory.** The recording lives inside the tab, up to 20,000 events, oldest dropped first. It is discarded when the page reloads, navigates away or closes.
- **In the inspector while it is open.** The popup, inspector window and DevTools panel read the recording from the tab and display it. Closing them discards their copy.
- **One display preference.** Whether the inspector shows one tab or all tabs of a site is stored in the extension's local storage on your computer.
- **Files you export.** The **Export trace** button saves a JSON file to your computer through Chrome's normal download flow. Nothing is exported unless you click it.

The extension's pages, scripts and fonts are all packaged with the extension; it makes no network requests of its own.

## Permissions

| Permission | Why it is needed |
| --- | --- |
| Content scripts on `http://*/*` and `https://*/*` (run at `document_start`) | To start observing before the page's own code creates a connection. A page's WebRTC can only be recorded from inside that page. |
| Host access to `http://*/*` and `https://*/*` | To read the recording from a tab when you open the inspector, to update the toolbar badge, and to attach to tabs that were already open when the extension was installed or updated. |
| `scripting` | To run the read-only function that fetches the recording from the tab you are inspecting. |

Chrome does not let any extension run on `chrome://` pages, the New Tab Page or the Chrome Web Store, so nothing is recorded there.

## Children

The extension is a developer tool and is not directed at children. It collects no personal information from anyone.

## Changes

If this policy changes, the new version will be published at the same address with a new effective date.

## Contact

Questions about this policy: open an issue at https://github.com/LitHaxor/RTC-inspector/issues, or use the publisher contact email shown on the extension's Chrome Web Store listing.
