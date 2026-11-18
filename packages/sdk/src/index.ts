export { Inspector, createInspector, type PatchGlobalOptions, type ConsoleLoggerOptions } from "./inspector";
export { getGlobalInspector, installGlobalInspector, GLOBAL_KEY } from "./global";
export type {
  InspectorOptions,
  ObserveOptions,
  PeerHandle,
  RTCTraceEvent,
  RTCEventType,
  EventDetailsMap,
  SignalingMessageDetails,
  TraceFile,
} from "@rtc-inspector/core";
