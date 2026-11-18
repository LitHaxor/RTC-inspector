/**
 * Human-readable descriptions of events and states, written for people who
 * are new to WebRTC. Shared by the UI and the console logger.
 */

import { CANDIDATE_TYPE_INFO, describeCandidate } from "./ice-parser";
import { isRemoteCloseAbort, type AnyTraceEvent, type RTCTraceEvent } from "./types";

export type Tone = "neutral" | "info" | "success" | "warning" | "error";

export interface EventDescription {
  title: string;
  summary: string;
  tone: Tone;
  /** One or two sentences explaining what this event means. */
  explain: string;
}

const STATE_TONE: Record<string, Tone> = {
  connected: "success",
  completed: "success",
  complete: "success",
  open: "success",
  stable: "success",
  failed: "error",
  closed: "neutral",
  disconnected: "warning",
  checking: "info",
  connecting: "info",
  gathering: "info",
  new: "neutral",
};

export const STATE_HELP: Record<string, Record<string, string>> = {
  signaling: {
    stable: "No offer/answer exchange is in progress.",
    "have-local-offer": "We applied our own offer and are waiting for the remote answer.",
    "have-remote-offer": "We applied the remote offer and should now create and apply an answer.",
    "have-local-pranswer": "We sent a provisional answer; a final answer is still expected.",
    "have-remote-pranswer": "The remote sent a provisional answer; a final answer is still expected.",
    closed: "The connection was closed.",
  },
  gathering: {
    new: "Candidate gathering has not started (no local description yet).",
    gathering: "The browser is discovering local, STUN and TURN candidates.",
    complete: "All candidates have been gathered.",
  },
  ice: {
    new: "ICE is waiting for candidates.",
    checking: "Connectivity checks are running between candidate pairs.",
    connected: "A working candidate pair was found. Media/data can flow.",
    completed: "ICE finished checking and found a connection for every component.",
    disconnected: "Connectivity checks are failing on the selected pair. This may recover on its own.",
    failed: "All candidate pairs failed. No network path exists between the peers.",
    closed: "ICE agent shut down.",
  },
  connection: {
    new: "Nothing has started yet.",
    connecting: "ICE and/or DTLS are being established.",
    connected: "ICE is connected and the DTLS handshake completed. The connection is usable.",
    disconnected: "The transport lost connectivity. It may come back.",
    failed: "ICE or DTLS failed. The connection is unusable without an ICE restart.",
    closed: "The connection was closed.",
  },
};

export function stateTone(state: string | undefined): Tone {
  return (state && STATE_TONE[state]) || "neutral";
}

const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export function describeEvent(event: RTCTraceEvent): EventDescription {
  const e = event as AnyTraceEvent;
  switch (e.type) {
    case "peer.created":
      return {
        title: e.details.attachedLate ? "Inspector attached" : "PeerConnection created",
        summary: e.details.configuration
          ? `${e.details.configuration.iceServers.length} ICE server(s)${e.details.configuration.iceTransportPolicy === "relay" ? ", relay only" : ""}`
          : "",
        tone: "neutral",
        explain: e.details.attachedLate
          ? "The inspector started observing a connection that already existed. Earlier events were not captured."
          : "A new RTCPeerConnection was constructed. Its configuration decides which STUN/TURN servers are used.",
      };
    case "peer.closed":
      return { title: "PeerConnection closed", summary: "close() called", tone: "neutral", explain: "The application called close(). All transports and data channels are shut down." };
    case "negotiation.needed":
      return {
        title: "Negotiation needed",
        summary: "renegotiate to apply changes",
        tone: "info",
        explain: "Something changed (a track or data channel was added) that requires a new offer/answer exchange.",
      };
    case "offer.created":
      return {
        title: "Offer created",
        summary: `createOffer(), ${(e.details.durationMs ?? 0).toFixed(1)} ms`,
        tone: "info",
        explain: "This peer generated an SDP offer describing the media and data it wants to exchange. The app must deliver it to the other peer through its signaling channel.",
      };
    case "answer.created":
      return {
        title: "Answer created",
        summary: `createAnswer(), ${(e.details.durationMs ?? 0).toFixed(1)} ms`,
        tone: "info",
        explain: "This peer generated an SDP answer accepting (or rejecting) each section of the remote offer.",
      };
    case "sdp.local.set":
      return {
        title: `Local ${e.details.type || "description"} applied`,
        summary: "setLocalDescription()",
        tone: "info",
        explain: "The description is now in effect locally. For an offer or answer this also starts ICE candidate gathering.",
      };
    case "sdp.remote.set":
      return {
        title: `Remote ${e.details.type || "description"} applied`,
        summary: "setRemoteDescription()",
        tone: "info",
        explain: "The other peer's description was applied. Its ICE credentials and DTLS fingerprint are now known, and remote candidates can be added.",
      };
    case "signaling.state":
      return {
        title: "Signaling state",
        summary: `${e.details.previous ?? "?"} → ${e.details.state}`,
        tone: stateTone(e.details.state),
        explain: STATE_HELP.signaling![e.details.state] ?? "",
      };
    case "signaling.message":
      return {
        title: `${capitalize(e.details.kind)} ${e.details.direction === "sent" ? "sent" : "received"} via signaling`,
        summary: e.details.remote ? `${e.details.direction === "sent" ? "to" : "from"} ${e.details.remote}` : "",
        tone: "neutral",
        explain: "Reported by the application: a message crossed its own signaling channel (WebSocket, HTTP…). WebRTC itself does not define signaling.",
      };
    case "ice.candidate.discovered": {
      const p = e.details.parsed;
      return {
        title: "ICE candidate discovered",
        summary: p ? describeCandidate(p) : e.details.candidate,
        tone: "neutral",
        explain: `${p ? `${CANDIDATE_TYPE_INFO[p.type]?.name ?? p.type} candidate: ${CANDIDATE_TYPE_INFO[p.type]?.meaning ?? ""} ` : ""}It must be sent to the remote peer (trickle ICE).`,
      };
    }
    case "ice.candidate.added": {
      const p = e.details.parsed;
      return {
        title: e.details.endOfCandidates ? "End of remote candidates" : "Remote ICE candidate added",
        summary: p ? describeCandidate(p) : e.details.endOfCandidates ? "addIceCandidate(null)" : e.details.candidate,
        tone: "neutral",
        explain: "A candidate received from the other peer was given to the ICE agent. It will be paired with local candidates and checked.",
      };
    }
    case "ice.candidate.error":
      return {
        title: "ICE server error",
        summary: `${e.details.errorCode} ${e.details.errorText}${e.details.url ? `, ${e.details.url}` : ""}`,
        tone: "warning",
        explain: explainCandidateError(e.details.errorCode),
      };
    case "ice.gathering.state":
      return {
        title: "ICE gathering",
        summary: `${e.details.previous ?? "?"} → ${e.details.state}`,
        tone: stateTone(e.details.state),
        explain: STATE_HELP.gathering![e.details.state] ?? "",
      };
    case "ice.connection.state":
      return {
        title: "ICE connection",
        summary: `${e.details.previous ?? "?"} → ${e.details.state}`,
        tone: stateTone(e.details.state),
        explain: STATE_HELP.ice![e.details.state] ?? "",
      };
    case "ice.restart":
      return { title: "ICE restart requested", summary: "restartIce()", tone: "info", explain: "The next offer will carry new ICE credentials, forcing fresh candidate gathering and checks." };
    case "ice.pair.selected": {
      const pair = e.details.pair;
      return {
        title: e.details.previousPairId ? "Selected pair changed" : "Candidate pair selected",
        summary: `${pair.local?.candidateType ?? "?"} ↔ ${pair.remote?.candidateType ?? "?"}${pair.local?.protocol ? `, ${pair.local.protocol}` : ""}`,
        tone: "success",
        explain: "ICE nominated this local/remote candidate pair. All traffic now flows over it.",
      };
    }
    case "connection.state":
      return {
        title: "Connection",
        summary: `${e.details.previous ?? "?"} → ${e.details.state}`,
        tone: stateTone(e.details.state),
        explain: STATE_HELP.connection![e.details.state] ?? "",
      };
    case "datachannel.created":
      return {
        title: "DataChannel created",
        summary: `"${e.details.label}"${e.details.negotiated ? ", negotiated" : ""}${e.details.ordered === false ? ", unordered" : ""}`,
        tone: "info",
        explain: "createDataChannel() was called. The channel opens once the SCTP transport inside the DTLS connection is up.",
      };
    case "datachannel.received":
      return {
        title: "DataChannel received",
        summary: `"${e.details.label}" (remote)`,
        tone: "info",
        explain: "The remote peer created this channel; it was announced to us through the datachannel event.",
      };
    case "datachannel.open":
      return { title: "DataChannel open", summary: `"${e.details.label}", id ${e.details.id ?? "?"}`, tone: "success", explain: "The channel is ready. send() works from now on." };
    case "datachannel.closing":
      return { title: "DataChannel closing", summary: `"${e.details.label}"`, tone: "neutral", explain: "Closing has started; buffered data is still being flushed." };
    case "datachannel.close":
      return { title: "DataChannel closed", summary: `"${e.details.label}"`, tone: "neutral", explain: "The channel is closed. Either side called close() or the connection went away." };
    case "datachannel.error":
      if (isRemoteCloseAbort(e.details.error)) {
        return {
          title: "DataChannel closed by the other side",
          summary: `"${e.details.label}"`,
          tone: "neutral",
          explain: "The remote peer closed this channel or its connection. Chrome reports that as an 'error' event (SCTP User-Initiated Abort), but it is a normal close, not a failure.",
        };
      }
      return {
        title: e.details.operation === "send" ? "DataChannel send() failed" : "DataChannel error",
        summary: `"${e.details.label}", ${e.details.error.name}: ${e.details.error.message}`,
        tone: "error",
        explain:
          e.details.operation === "send"
            ? "send() threw. The most common cause is sending before the channel is open (readyState must be 'open')."
            : "The channel reported an error, typically an SCTP failure or a message larger than the remote max-message-size.",
      };
    case "datachannel.message":
      return {
        title: e.details.direction === "outgoing" ? "Message sent" : "Message received",
        summary: `"${e.details.label}", ${formatBytes(e.details.size)}${e.details.preview !== undefined ? `, ${truncate(e.details.preview, 48)}` : ""}`,
        tone: "neutral",
        explain:
          e.details.direction === "outgoing"
            ? "send() queued this message on the channel."
            : "A message arrived on the channel (message event).",
      };
    case "track.added":
      return { title: "Track added", summary: `${e.details.kind}, addTrack()`, tone: "info", explain: "A local media track was attached; negotiation is needed to send it." };
    case "track.received":
      return { title: "Remote track", summary: `${e.details.kind}${e.details.mid ? `, mid ${e.details.mid}` : ""}`, tone: "info", explain: "The remote description created a receiving track (track event)." };
    case "api.error":
      return {
        title: `${e.details.method}() failed`,
        summary: `${e.details.error.name}: ${e.details.error.message}`,
        tone: "error",
        explain: explainApiError(e.details.method, e.details.error.name, e.details.error.message),
      };
    case "stats.sample":
      return {
        title: "Stats sample",
        summary: e.details.roundTripTimeMs !== undefined ? `RTT ${e.details.roundTripTimeMs.toFixed(0)} ms` : "",
        tone: "neutral",
        explain: "A periodic getStats() snapshot.",
      };
    case "annotation":
      return { title: e.details.label, summary: "", tone: "neutral", explain: "A marker added by the application." };
    default:
      return { title: (event as RTCTraceEvent).type, summary: "", tone: "neutral", explain: "" };
  }
}

export function explainCandidateError(code: number): string {
  if (code === 701) return "The STUN/TURN server could not be reached (timeout / DNS / network). Check the URL, port and that UDP/TCP traffic to it is allowed.";
  if (code === 401) return "TURN authentication failed. The username/credential are wrong or expired.";
  if (code === 403) return "The TURN server refused the request (forbidden). The peer address may be blocked by the server's policy.";
  if (code === 437) return "TURN allocation mismatch: a stale allocation exists for this 5-tuple.";
  if (code === 486) return "The TURN server's allocation quota was reached for this user.";
  if (code === 508) return "The TURN server could not allocate a relay port (insufficient capacity).";
  if (code >= 300 && code < 700) return "The STUN/TURN server returned an error response.";
  return "The ICE agent reported an error contacting a STUN/TURN server.";
}

export function explainApiError(method: string, name: string, message: string): string {
  const m = message.toLowerCase();
  if (method === "addIceCandidate" && (m.includes("remote description") || name === "InvalidStateError")) {
    return "A remote candidate arrived before setRemoteDescription() completed. Queue candidates until the remote description is applied.";
  }
  if (method === "setRemoteDescription" && name === "InvalidStateError") {
    return "The remote description does not fit the current signaling state (e.g. an answer while 'stable'). Check offer/answer ordering and glare handling.";
  }
  if (method === "setLocalDescription" && name === "InvalidModificationError") {
    return "The SDP was modified between createOffer/createAnswer and setLocalDescription in a way the browser does not allow.";
  }
  if (name === "OperationError" && method.startsWith("set")) {
    return "The browser could not apply the description. The SDP is likely malformed or incompatible (codecs, fingerprint, BUNDLE).";
  }
  return `${method}() rejected. Check the arguments and the signaling state at the time of the call.`;
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
