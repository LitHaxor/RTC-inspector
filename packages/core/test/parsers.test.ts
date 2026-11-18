import { describe, expect, it } from "vitest";
import {
  cachedParseSdp,
  candidateCorrelationKey,
  classifyAddress,
  describeCandidate,
  diffSdp,
  parseCandidate,
  parseSdp,
  primaryCodecs,
  redactAddress,
  redactCandidate,
  redactSdp,
  redactText,
  sdpOrigin,
  sectionTitle,
} from "../src";
import {
  HOST_CANDIDATE,
  IPV6_CANDIDATE,
  MDNS_CANDIDATE,
  RELAY_CANDIDATE,
  SRFLX_CANDIDATE,
  TCP_CANDIDATE,
  makeSdp,
} from "./fakes";

describe("parseCandidate", () => {
  it("parses a host candidate and decomposes its priority", () => {
    const c = parseCandidate(HOST_CANDIDATE)!;
    expect(c).toMatchObject({
      foundation: "842163049",
      component: 1,
      componentName: "rtp",
      protocol: "udp",
      address: "192.168.1.20",
      addressKind: "private",
      port: 54321,
      type: "host",
      generation: 0,
      ufrag: "Ab12",
      networkId: 1,
    });
    // 2122260223 = 126·2^24 + 32542·2^8 + (256 - 1)
    expect(c.typePreference).toBe(126);
    expect(c.localPreference).toBe(32542);
  });

  it("parses related address for srflx and relay candidates", () => {
    expect(parseCandidate(SRFLX_CANDIDATE)).toMatchObject({ type: "srflx", addressKind: "public", relatedAddress: "192.168.1.20", relatedPort: 54321 });
    expect(parseCandidate(RELAY_CANDIDATE)).toMatchObject({ type: "relay", typePreference: 2 });
  });

  it("handles tcp, mDNS, IPv6 and the a= prefix", () => {
    expect(parseCandidate(TCP_CANDIDATE)).toMatchObject({ protocol: "tcp", tcpType: "active" });
    expect(parseCandidate(MDNS_CANDIDATE)).toMatchObject({ addressKind: "mdns" });
    expect(parseCandidate(IPV6_CANDIDATE)).toMatchObject({ address: "2001:db8::1234", addressKind: "public" });
    expect(parseCandidate(`a=${HOST_CANDIDATE}`)?.port).toBe(54321);
    expect(parseCandidate("candidate:1 2 UDP 1 10.0.0.1 1 typ host")?.componentName).toBe("rtcp");
  });

  it("returns null for garbage", () => {
    expect(parseCandidate("")).toBeNull();
    expect(parseCandidate("candidate:1 1 udp 1 1.2.3.4 5 nottyp host")).toBeNull();
  });

  it("builds a correlation key without the IP address", () => {
    const key = candidateCorrelationKey(parseCandidate(SRFLX_CANDIDATE)!);
    expect(key).not.toContain("203.0.113.7");
    expect(key).toBe(candidateCorrelationKey(redactCandidate(parseCandidate(SRFLX_CANDIDATE)!)));
  });

  it("redacts addresses in a parsed candidate and describes it", () => {
    const c = redactCandidate(parseCandidate(SRFLX_CANDIDATE)!);
    expect(c.address).toBe("203.x.x.x");
    expect(c.relatedAddress).toBe("192.168.x.x");
    expect(describeCandidate(c)).toBe("srflx udp 203.x.x.x:61000");
    expect(describeCandidate(parseCandidate(TCP_CANDIDATE)!)).toContain("tcp (active)");
  });
});

describe("address redaction", () => {
  it.each([
    ["10.1.2.3", "private", "10.1.x.x"],
    ["172.20.1.1", "private", "172.20.x.x"],
    ["172.32.1.1", "public", "172.x.x.x"],
    ["192.168.0.5", "private", "192.168.x.x"],
    ["8.8.8.8", "public", "8.x.x.x"],
    ["127.0.0.1", "loopback", "127.0.0.1"],
    ["169.254.3.4", "link-local", "169.254.x.x"],
    ["100.64.1.1", "cgnat", "100.64.x.x"],
    ["0.0.0.0", "unspecified", "0.0.0.0"],
    ["abc.local", "mdns", "abc.local"],
    ["::1", "loopback", "::1"],
    ["fe80::1", "link-local", "fe80::x"],
    ["fd00::1", "private", "fd00::x"],
    ["2001:db8::1", "public", "2001::x"],
    ["turn.example.com", "hostname", "turn.example.com"],
  ])("%s is %s → %s", (address, kind, redacted) => {
    expect(classifyAddress(address)).toBe(kind);
    expect(redactAddress(address)).toBe(redacted);
  });

  it("handles empty input", () => {
    expect(classifyAddress(undefined)).toBe("unknown");
    expect(redactAddress(null)).toBeNull();
    expect(classifyAddress("999.1.1.1")).toBe("hostname");
  });

  it("redacts addresses in free text but not fingerprints", () => {
    expect(redactText("from 203.0.113.7 and 2001:db8:0:0:0:0:0:1 ok")).toBe("from 203.x.x.x and 2001::x ok");
    const fp = "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";
    expect(redactText(fp)).toBe(fp);
  });

  it("redacts SDP connection lines, candidates and ICE passwords", () => {
    const sdp = makeSdp({ candidates: [SRFLX_CANDIDATE] }).replace("c=IN IP4 0.0.0.0", "c=IN IP4 203.0.113.7");
    const red = redactSdp(sdp);
    expect(red).not.toContain("203.0.113.7");
    expect(red).not.toContain("192.168.1.20");
    expect(red).not.toContain("supersecretpassword");
    expect(red).toContain("a=ice-pwd:[redacted]");
    expect(red).toContain("a=fingerprint:sha-256 AB:CD:EF");
    expect(red).toContain("127.0.0.1"); // loopback in o= is not sensitive
  });
});

describe("parseSdp", () => {
  const sdp = makeSdp({ sessionId: "4611731400430051336", version: 2, application: true, candidates: [HOST_CANDIDATE], video: "recvonly" });
  const parsed = parseSdp(sdp);

  it("parses the session level", () => {
    expect(parsed.version).toBe(0);
    expect(parsed.origin).toMatchObject({ sessionId: "4611731400430051336", sessionVersion: "2", address: "127.0.0.1" });
    expect(parsed.sessionName).toBe("-");
    expect(parsed.groups).toEqual([{ semantics: "BUNDLE", mids: ["0", "1", "2"] }]);
    expect(parsed.extmapAllowMixed).toBe(true);
    expect(parsed.msidSemantic).toBe("WMS");
    expect(parsed.warnings).toEqual([]);
  });

  it("parses audio with codecs in preference order", () => {
    const audio = parsed.media[0]!;
    expect(sectionTitle(audio)).toBe("Audio");
    expect(audio).toMatchObject({ kind: "audio", mid: "0", direction: "sendrecv", rtcpMux: true, setup: "actpass", iceUfrag: expect.any(String) });
    expect(audio.codecs.map((c) => c.name)).toEqual(["opus", "red", "G722", "PCMU", "PCMA", "CN", "telephone-event", "telephone-event"]);
    expect(audio.codecs[0]).toMatchObject({ clockRate: 48000, channels: 2, fmtp: { minptime: "10", useinbandfec: "1" }, rtcpFeedback: ["transport-cc"] });
    expect(primaryCodecs(audio).map((c) => c.name)).toEqual(["opus", "G722", "PCMU", "PCMA"]);
    expect(audio.extmaps[0]).toEqual({ id: 1, uri: "urn:ietf:params:rtp-hdrext:ssrc-audio-level" });
    expect(audio.fingerprint?.algorithm).toBe("sha-256");
    expect(audio.candidates).toHaveLength(1);
    expect(audio.ssrcs).toEqual([1111]);
  });

  it("parses video details", () => {
    const video = parsed.media[1]!;
    expect(video.direction).toBe("recvonly");
    expect(video.rtcpRsize).toBe(true);
    expect(video.codecs.find((c) => c.name === "VP8")?.rtcpFeedback).toEqual(["nack", "nack pli"]);
    expect(video.codecs.find((c) => c.name === "rtx")?.fmtp).toEqual({ apt: "96" });
    expect(video.extmaps[1]).toEqual({ id: 3, uri: "urn:3gpp:video-orientation", direction: "sendonly" });
    expect(video.ssrcGroups).toEqual([{ semantics: "FID", ssrcs: [2222, 3333] }]);
  });

  it("parses the data channel section", () => {
    const app = parsed.media[2]!;
    expect(sectionTitle(app)).toBe("Data channels");
    expect(app).toMatchObject({ kind: "application", protocol: "UDP/DTLS/SCTP", sctpPort: 5000, maxMessageSize: 262144, codecs: [] });
  });

  it("keeps raw lines with their section", () => {
    expect(parsed.lines[0]).toMatchObject({ lineNumber: 1, section: -1, key: "v", value: "0" });
    expect(parsed.lines.find((l) => l.text.startsWith("m=video"))?.section).toBe(1);
  });

  it("marks rejected sections, bundle-only, rid/simulcast and end-of-candidates", () => {
    const p = parseSdp(
      makeSdp({ rejectVideo: true }) +
        "m=video 0 UDP/TLS/RTP/SAVPF 96\r\na=bundle-only\r\na=rid:h send\r\na=simulcast:send h\r\na=end-of-candidates\r\na=ice-lite\r\n",
    );
    expect(p.media[1]!.rejected).toBe(true);
    expect(p.media[2]).toMatchObject({ rejected: false, bundleOnly: true, rids: [{ id: "h", direction: "send" }], simulcast: "send h", endOfCandidates: true });
  });

  it("reports malformed lines and missing headers", () => {
    const p = parseSdp("garbage\r\nm=audio 9 RTP/AVP 0\r\na=candidate:nonsense");
    expect(p.warnings.join("\n")).toMatch(/not a valid/);
    expect(p.warnings.join("\n")).toMatch(/Unparseable candidate/);
    expect(p.warnings.join("\n")).toMatch(/Missing v=/);
  });

  it("extracts the origin cheaply and caches parses", () => {
    expect(sdpOrigin(sdp)).toEqual({ sessionId: "4611731400430051336", sessionVersion: "2" });
    expect(sdpOrigin("v=0")).toBeUndefined();
    expect(cachedParseSdp(sdp)).toBe(cachedParseSdp(sdp));
  });
});

describe("diffSdp", () => {
  it("explains direction, codec and DTLS role differences between offer and answer", () => {
    const offer = makeSdp({ type: "offer", application: true });
    const answer = makeSdp({ type: "answer", application: true, video: "recvonly" }).replace(
      "m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    );
    const { rows } = diffSdp(offer, answer);
    const row = (section: string, field: string) => rows.find((r) => r.section.startsWith(section) && r.field === field)!;

    expect(row("Video", "Direction")).toMatchObject({ left: "sendrecv", right: "recvonly", status: "different" });
    expect(row("Video", "Direction").note).toMatch(/only receive/);
    expect(row("Audio", "Codecs")).toMatchObject({ right: "opus", status: "different", note: "Negotiated: opus is preferred." });
    expect(row("Audio", "DTLS role (setup)").note).toMatch(/DTLS client/);
    expect(row("Data channels", "Max message size").status).toBe("same");
    expect(row("Session", "BUNDLE").status).toBe("same");
  });

  it("flags rejected and missing sections and dropped BUNDLE", () => {
    const offer = makeSdp({ type: "offer", application: true });
    const answer = makeSdp({ type: "answer", rejectVideo: true }).replace(/a=group:BUNDLE.*\r\n/, "");
    const diff = diffSdp(offer, answer);
    expect(diff.rows.find((r) => r.section.startsWith("Video") && r.field === "Status")).toMatchObject({ status: "warning", right: "rejected" });
    expect(diff.rows.find((r) => r.section.startsWith("Data") && r.field === "Present")?.status).toBe("warning");
    expect(diff.rows.find((r) => r.field === "BUNDLE")?.note).toMatch(/did not accept BUNDLE/);
    expect(diff.warnings).toBeGreaterThanOrEqual(2);
  });

  it("warns when no codec is in common and when both sides only send", () => {
    const offer = makeSdp({ video: false, audio: "sendonly" });
    const answer = makeSdp({ video: false, audio: "sendonly" }).replace(/opus/g, "foo").replace(/G722|PCMU|PCMA/g, "bar");
    const rows = diffSdp(offer, answer).rows;
    expect(rows.find((r) => r.field === "Codecs")).toMatchObject({ status: "warning", note: "No codec in common. Media cannot flow." });
    expect(rows.find((r) => r.field === "Direction")).toMatchObject({ status: "warning", note: expect.stringMatching(/nobody receives/) });
    const same = diffSdp(makeSdp({ video: false }), makeSdp({ video: false })).rows;
    expect(same.find((r) => r.field === "Direction")?.status).toBe("same");
    const recv = diffSdp(makeSdp({ video: false, audio: "recvonly" }), makeSdp({ video: false, audio: "inactive" })).rows;
    expect(recv.find((r) => r.field === "Direction")).toMatchObject({ status: "warning" });
  });
});
