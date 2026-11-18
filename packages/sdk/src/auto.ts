/**
 * Zero-config embedded mode. Import this before your app creates any
 * RTCPeerConnection:
 *
 *   import "@rtc-inspector/sdk/auto";
 *
 * Every connection is then observed by `window.__RTC_INSPECTOR__`.
 */
import { installGlobalInspector } from "./global";

export const inspector = installGlobalInspector();
