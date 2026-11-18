/**
 * A small, dependency-free SDP parser aimed at *explaining* a session
 * description rather than round-tripping it. It understands the attributes
 * browsers actually emit for WebRTC (JSEP) and keeps every raw line so the UI
 * can annotate the original text.
 */

import { parseCandidate, type ParsedCandidate } from "./ice-parser";

export interface SdpOrigin {
  username: string;
  sessionId: string;
  sessionVersion: string;
  netType: string;
  addrType: string;
  address: string;
}

export interface SdpCodec {
  payloadType: number;
  name: string;
  clockRate?: number;
  channels?: number;
  fmtp: Record<string, string>;
  rtcpFeedback: string[];
}

export interface SdpExtmap {
  id: number;
  uri: string;
  direction?: string;
}

export interface SdpFingerprint {
  algorithm: string;
  value: string;
}

export interface SdpLine {
  /** 1-based line number in the original SDP. */
  lineNumber: number;
  /** -1 for session level, otherwise the media section index. */
  section: number;
  text: string;
  key: string;
  value: string;
}

export interface SdpMediaSection {
  index: number;
  kind: string;
  port: number;
  protocol: string;
  formats: string[];
  rejected: boolean;
  mid?: string;
  direction?: "sendrecv" | "sendonly" | "recvonly" | "inactive";
  connection?: { netType: string; addrType: string; address: string };
  iceUfrag?: string;
  icePwd?: string;
  iceOptions?: string[];
  fingerprint?: SdpFingerprint;
  setup?: string;
  rtcpMux: boolean;
  rtcpRsize: boolean;
  bundleOnly: boolean;
  codecs: SdpCodec[];
  extmaps: SdpExtmap[];
  msid?: string;
  ssrcs: number[];
  ssrcGroups: { semantics: string; ssrcs: number[] }[];
  rids: { id: string; direction: string }[];
  simulcast?: string;
  sctpPort?: number;
  maxMessageSize?: number;
  candidates: ParsedCandidate[];
  endOfCandidates: boolean;
  attributes: { key: string; value: string }[];
}

export interface ParsedSdp {
  version?: number;
  origin?: SdpOrigin;
  sessionName?: string;
  timing?: string;
  groups: { semantics: string; mids: string[] }[];
  iceOptions?: string[];
  iceLite: boolean;
  fingerprint?: SdpFingerprint;
  setup?: string;
  msidSemantic?: string;
  extmapAllowMixed: boolean;
  media: SdpMediaSection[];
  attributes: { key: string; value: string }[];
  lines: SdpLine[];
  warnings: string[];
}

const DIRECTIONS = new Set(["sendrecv", "sendonly", "recvonly", "inactive"]);

function splitAttribute(value: string): [string, string] {
  const i = value.indexOf(":");
  return i === -1 ? [value, ""] : [value.slice(0, i), value.slice(i + 1)];
}

function parseFingerprint(value: string): SdpFingerprint {
  const [algorithm = "", fp = ""] = value.split(" ");
  return { algorithm, value: fp };
}

export function parseSdp(sdp: string): ParsedSdp {
  const result: ParsedSdp = {
    groups: [],
    iceLite: false,
    extmapAllowMixed: false,
    media: [],
    attributes: [],
    lines: [],
    warnings: [],
  };
  let media: SdpMediaSection | undefined;
  const codecFor = (m: SdpMediaSection, pt: number): SdpCodec => {
    let codec = m.codecs.find((c) => c.payloadType === pt);
    if (!codec) {
      codec = { payloadType: pt, name: "unknown", fmtp: {}, rtcpFeedback: [] };
      m.codecs.push(codec);
    }
    return codec;
  };

  const rawLines = sdp.split(/\r?\n/);
  rawLines.forEach((text, i) => {
    if (!text.trim()) return;
    const eq = text.indexOf("=");
    if (eq !== 1) {
      result.warnings.push(`Line ${i + 1} is not a valid "x=value" line: ${text}`);
      return;
    }
    const key = text[0]!;
    const value = text.slice(2);

    if (key === "m") {
      const [kind = "", port = "0", protocol = "", ...formats] = value.split(" ");
      media = {
        index: result.media.length,
        kind,
        port: Number(port),
        protocol,
        formats,
        rejected: Number(port) === 0,
        rtcpMux: false,
        rtcpRsize: false,
        bundleOnly: false,
        codecs: [],
        extmaps: [],
        ssrcs: [],
        ssrcGroups: [],
        rids: [],
        candidates: [],
        endOfCandidates: false,
        attributes: [],
      };
      if (protocol.includes("RTP")) {
        for (const f of formats) codecFor(media, Number(f));
      }
      result.media.push(media);
    }
    result.lines.push({ lineNumber: i + 1, section: media ? media.index : -1, text, key, value });

    if (!media) {
      switch (key) {
        case "v":
          result.version = Number(value);
          return;
        case "o": {
          const [username = "", sessionId = "", sessionVersion = "", netType = "", addrType = "", address = ""] =
            value.split(" ");
          result.origin = { username, sessionId, sessionVersion, netType, addrType, address };
          return;
        }
        case "s":
          result.sessionName = value;
          return;
        case "t":
          result.timing = value;
          return;
        case "a": {
          const [attr, attrValue] = splitAttribute(value);
          result.attributes.push({ key: attr, value: attrValue });
          switch (attr) {
            case "group": {
              const [semantics = "", ...mids] = attrValue.split(" ");
              result.groups.push({ semantics, mids });
              break;
            }
            case "ice-options":
              result.iceOptions = attrValue.split(" ");
              break;
            case "ice-lite":
              result.iceLite = true;
              break;
            case "fingerprint":
              result.fingerprint = parseFingerprint(attrValue);
              break;
            case "setup":
              result.setup = attrValue;
              break;
            case "msid-semantic":
              result.msidSemantic = attrValue.trim();
              break;
            case "extmap-allow-mixed":
              result.extmapAllowMixed = true;
              break;
            default:
              break;
          }
          return;
        }
        default:
          return;
      }
    }

    if (key === "c") {
      const [netType = "", addrType = "", address = ""] = value.split(" ");
      media.connection = { netType, addrType, address };
      return;
    }
    if (key !== "a") return;

    const [attr, attrValue] = splitAttribute(value);
    media.attributes.push({ key: attr, value: attrValue });
    if (DIRECTIONS.has(attr)) {
      media.direction = attr as SdpMediaSection["direction"];
      return;
    }
    switch (attr) {
      case "mid":
        media.mid = attrValue;
        break;
      case "ice-ufrag":
        media.iceUfrag = attrValue;
        break;
      case "ice-pwd":
        media.icePwd = attrValue;
        break;
      case "ice-options":
        media.iceOptions = attrValue.split(" ");
        break;
      case "fingerprint":
        media.fingerprint = parseFingerprint(attrValue);
        break;
      case "setup":
        media.setup = attrValue;
        break;
      case "rtcp-mux":
        media.rtcpMux = true;
        break;
      case "rtcp-rsize":
        media.rtcpRsize = true;
        break;
      case "bundle-only":
        media.bundleOnly = true;
        media.rejected = false;
        break;
      case "rtpmap": {
        const [pt = "", desc = ""] = attrValue.split(" ");
        const [name = "", clock, channels] = desc.split("/");
        const codec = codecFor(media, Number(pt));
        codec.name = name;
        if (clock) codec.clockRate = Number(clock);
        if (channels) codec.channels = Number(channels);
        break;
      }
      case "fmtp": {
        const sp = attrValue.indexOf(" ");
        const pt = Number(attrValue.slice(0, sp));
        const params = attrValue.slice(sp + 1);
        const codec = codecFor(media, pt);
        for (const kv of params.split(";")) {
          const [k, v = ""] = kv.split("=");
          if (k) codec.fmtp[k.trim()] = v.trim();
        }
        break;
      }
      case "rtcp-fb": {
        const sp = attrValue.indexOf(" ");
        const pt = attrValue.slice(0, sp);
        const fb = attrValue.slice(sp + 1);
        if (pt === "*") media.codecs.forEach((c) => c.rtcpFeedback.push(fb));
        else codecFor(media, Number(pt)).rtcpFeedback.push(fb);
        break;
      }
      case "extmap": {
        const [idDir = "", uri = ""] = attrValue.split(" ");
        const [id = "", direction] = idDir.split("/");
        media.extmaps.push({ id: Number(id), uri, ...(direction && { direction }) });
        break;
      }
      case "msid":
        media.msid = attrValue;
        break;
      case "ssrc": {
        const ssrc = Number(attrValue.split(" ")[0]);
        if (!media.ssrcs.includes(ssrc)) media.ssrcs.push(ssrc);
        break;
      }
      case "ssrc-group": {
        const [semantics = "", ...ssrcs] = attrValue.split(" ");
        media.ssrcGroups.push({ semantics, ssrcs: ssrcs.map(Number) });
        break;
      }
      case "rid": {
        const [id = "", direction = ""] = attrValue.split(" ");
        media.rids.push({ id, direction });
        break;
      }
      case "simulcast":
        media.simulcast = attrValue;
        break;
      case "sctp-port":
        media.sctpPort = Number(attrValue);
        break;
      case "max-message-size":
        media.maxMessageSize = Number(attrValue);
        break;
      case "candidate": {
        const c = parseCandidate(attrValue);
        if (c) media.candidates.push(c);
        else result.warnings.push(`Unparseable candidate in section ${media.index}: ${attrValue}`);
        break;
      }
      case "end-of-candidates":
        media.endOfCandidates = true;
        break;
      default:
        break;
    }
  });

  // Drop codecs that only appeared through fmtp/rtcp-fb but are not in the m= line.
  for (const m of result.media) {
    if (m.protocol.includes("RTP")) {
      const listed = new Set(m.formats.map(Number));
      m.codecs = m.codecs.filter((c) => listed.has(c.payloadType));
      m.codecs.sort((a, b) => m.formats.indexOf(String(a.payloadType)) - m.formats.indexOf(String(b.payloadType)));
    }
  }

  if (result.version === undefined) result.warnings.push("Missing v= line");
  if (!result.origin) result.warnings.push("Missing o= line");
  return result;
}

/** Extract only the `o=` session id / version, cheaply. */
export function sdpOrigin(sdp: string): { sessionId: string; sessionVersion: string } | undefined {
  const m = /^o=\S+ (\S+) (\S+)/m.exec(sdp);
  return m ? { sessionId: m[1]!, sessionVersion: m[2]! } : undefined;
}

export function sectionTitle(m: SdpMediaSection): string {
  if (m.kind === "application") return "Data channels";
  return m.kind.charAt(0).toUpperCase() + m.kind.slice(1);
}

/** Codecs that are infrastructure rather than "the" codec (retransmission, FEC...). */
export const AUXILIARY_CODECS = new Set(["rtx", "red", "ulpfec", "flexfec-03", "CN", "telephone-event"]);

export function primaryCodecs(m: SdpMediaSection): SdpCodec[] {
  return m.codecs.filter((c) => !AUXILIARY_CODECS.has(c.name));
}

/** Plain-language explanation of common SDP attributes, used by the raw view. */
export const SDP_LINE_HELP: Record<string, string> = {
  v: "Protocol version. Always 0.",
  o: "Origin: username, session id, session version (bumped on every renegotiation), and address.",
  s: "Session name. Browsers send '-'.",
  t: "Timing. '0 0' means the session is permanent.",
  m: "Media section: kind, port, transport protocol and payload formats. Port 0 means rejected.",
  c: "Connection address for this section (the default candidate; 0.0.0.0 until candidates exist).",
  group: "Bundles media sections so they share one transport (one ICE + DTLS connection).",
  "msid-semantic": "Declares how media stream ids are associated with tracks.",
  "extmap-allow-mixed": "Both one- and two-byte RTP header extensions may be used.",
  "ice-ufrag": "ICE username fragment. Identifies this ICE session; changes on ICE restart.",
  "ice-pwd": "ICE password used to authenticate connectivity checks.",
  "ice-options": "ICE capabilities; 'trickle' means candidates are sent incrementally.",
  "ice-lite": "The endpoint implements ICE-lite (typically a server) and will not initiate checks.",
  fingerprint: "Hash of the DTLS certificate. The remote peer verifies the handshake against it.",
  setup: "DTLS role. actpass = either, active = DTLS client, passive = DTLS server.",
  mid: "Media id, used to match this section to transceivers and BUNDLE groups.",
  sendrecv: "Direction: this side wants to send and receive.",
  sendonly: "Direction: this side only sends.",
  recvonly: "Direction: this side only receives.",
  inactive: "Direction: no media flows in either direction.",
  "rtcp-mux": "RTP and RTCP share one port.",
  "rtcp-rsize": "Reduced-size RTCP is supported.",
  rtpmap: "Maps a payload type number to a codec name / clock rate / channels.",
  fmtp: "Codec-specific format parameters.",
  "rtcp-fb": "RTCP feedback mechanisms supported for a codec (NACK, PLI, transport-cc...).",
  extmap: "RTP header extension mapping.",
  msid: "Associates this section with a MediaStream id and track id.",
  ssrc: "Synchronisation source identifier for an RTP stream.",
  "ssrc-group": "Groups SSRCs, e.g. FID (a stream + its retransmission stream).",
  "sctp-port": "SCTP port used by data channels inside the DTLS connection.",
  "max-message-size": "Largest data channel message the endpoint can receive, in bytes.",
  candidate: "An ICE candidate: a transport address this peer can be reached at.",
  "end-of-candidates": "No more candidates will be sent for this section.",
  "bundle-only": "This section is only usable inside a BUNDLE group.",
  rid: "Restriction identifier, used for simulcast layers.",
  simulcast: "Declares simulcast layers being sent or received.",
};

const parseCache = new Map<string, ParsedSdp>();
/** parseSdp with a small LRU cache: the UI and diagnostics re-parse the same blobs often. */
export function cachedParseSdp(sdp: string): ParsedSdp {
  const hit = parseCache.get(sdp);
  if (hit) {
    parseCache.delete(sdp);
    parseCache.set(sdp, hit);
    return hit;
  }
  const parsed = parseSdp(sdp);
  parseCache.set(sdp, parsed);
  if (parseCache.size > 200) parseCache.delete(parseCache.keys().next().value!);
  return parsed;
}
