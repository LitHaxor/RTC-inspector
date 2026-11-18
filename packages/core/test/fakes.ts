/**
 * Minimal spec-shaped fakes for RTCPeerConnection / RTCDataChannel, enough to
 * exercise the observer without a browser. Real-browser behaviour is covered
 * by the Playwright e2e suite in the playground.
 */

let sessionCounter = 1000;

export interface SdpOptions {
  sessionId?: string;
  version?: number;
  type?: "offer" | "answer";
  audio?: string | false;
  video?: string | false;
  application?: boolean;
  candidates?: string[];
  setup?: string;
  rejectVideo?: boolean;
}

export function makeSdp(o: SdpOptions = {}): string {
  const sessionId = o.sessionId ?? String(++sessionCounter);
  const setup = o.setup ?? (o.type === "answer" ? "active" : "actpass");
  const mids: string[] = [];
  const sections: string[] = [];
  const common = (mid: string, ufrag: string) => [
    "c=IN IP4 0.0.0.0",
    `a=ice-ufrag:${ufrag}`,
    "a=ice-pwd:supersecretpassword1234",
    "a=ice-options:trickle",
    "a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89",
    `a=setup:${setup}`,
    `a=mid:${mid}`,
    ...(o.candidates ?? []).map((c) => `a=${c}`),
  ];
  const ufrag = `u${sessionId.slice(-4)}`;
  if (o.audio !== false) {
    const mid = String(mids.length);
    mids.push(mid);
    sections.push(
      [
        "m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126",
        ...common(mid, ufrag),
        "a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level",
        `a=${o.audio ?? "sendrecv"}`,
        "a=rtcp-mux",
        "a=rtpmap:111 opus/48000/2",
        "a=rtcp-fb:111 transport-cc",
        "a=fmtp:111 minptime=10;useinbandfec=1",
        "a=rtpmap:63 red/48000/2",
        "a=fmtp:63 111/111",
        "a=rtpmap:9 G722/8000",
        "a=rtpmap:0 PCMU/8000",
        "a=rtpmap:8 PCMA/8000",
        "a=rtpmap:13 CN/8000",
        "a=rtpmap:110 telephone-event/48000",
        "a=rtpmap:126 telephone-event/8000",
        "a=ssrc:1111 cname:abc",
      ].join("\r\n"),
    );
  }
  if (o.video !== false) {
    const mid = String(mids.length);
    mids.push(mid);
    sections.push(
      [
        `m=video ${o.rejectVideo ? 0 : 9} UDP/TLS/RTP/SAVPF 96 97 98`,
        ...common(mid, ufrag),
        "a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
        "a=extmap:3/sendonly urn:3gpp:video-orientation",
        `a=${o.video ?? "sendrecv"}`,
        "a=rtcp-mux",
        "a=rtcp-rsize",
        "a=rtpmap:96 VP8/90000",
        "a=rtcp-fb:96 nack",
        "a=rtcp-fb:96 nack pli",
        "a=rtpmap:97 rtx/90000",
        "a=fmtp:97 apt=96",
        "a=rtpmap:98 H264/90000",
        "a=fmtp:98 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
        "a=ssrc-group:FID 2222 3333",
        "a=ssrc:2222 cname:abc",
        "a=ssrc:3333 cname:abc",
      ].join("\r\n"),
    );
  }
  if (o.application) {
    const mid = String(mids.length);
    mids.push(mid);
    sections.push(
      ["m=application 9 UDP/DTLS/SCTP webrtc-datachannel", ...common(mid, ufrag), "a=sctp-port:5000", "a=max-message-size:262144"].join(
        "\r\n",
      ),
    );
  }
  const header = [
    "v=0",
    `o=- ${sessionId} ${o.version ?? 2} IN IP4 127.0.0.1`,
    "s=-",
    "t=0 0",
    ...(mids.length ? [`a=group:BUNDLE ${mids.join(" ")}`] : []),
    "a=extmap-allow-mixed",
    "a=msid-semantic: WMS",
  ].join("\r\n");
  return [header, ...sections].join("\r\n") + "\r\n";
}

export const HOST_CANDIDATE = "candidate:842163049 1 udp 2122260223 192.168.1.20 54321 typ host generation 0 ufrag Ab12 network-id 1";
export const SRFLX_CANDIDATE =
  "candidate:1467250027 1 udp 1686052607 203.0.113.7 61000 typ srflx raddr 192.168.1.20 rport 54321 generation 0 ufrag Ab12 network-id 1";
export const RELAY_CANDIDATE =
  "candidate:3471623853 1 udp 41885439 198.51.100.4 49152 typ relay raddr 203.0.113.7 rport 61000 generation 0 ufrag Ab12";
export const MDNS_CANDIDATE = "candidate:1 1 udp 2113937151 7a2b6c1e-1234-4c3d-9e8f-0123456789ab.local 50000 typ host generation 0";
export const TCP_CANDIDATE = "candidate:3 1 tcp 1518280447 192.168.1.20 9 typ host tcptype active generation 0";
export const IPV6_CANDIDATE = "candidate:4 1 udp 2122197247 2001:db8::1234 50001 typ host generation 0";

function domError(name: string, message: string): Error {
  return new DOMException(message, name) as unknown as Error;
}

export class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";
  bufferedAmount = 0;
  binaryType: BinaryType = "arraybuffer";
  readonly ordered: boolean;
  readonly protocol: string;
  readonly negotiated: boolean;
  readonly maxRetransmits: number | null;
  readonly maxPacketLifeTime: number | null;
  sent: unknown[] = [];
  onopen: ((e: Event) => void) | null = null;
  peer?: FakeDataChannel;

  constructor(
    public readonly label: string,
    init: RTCDataChannelInit = {},
    public id: number | null = init.id ?? null,
  ) {
    super();
    this.ordered = init.ordered ?? true;
    this.protocol = init.protocol ?? "";
    this.negotiated = init.negotiated ?? false;
    this.maxRetransmits = init.maxRetransmits ?? null;
    this.maxPacketLifeTime = init.maxPacketLifeTime ?? null;
  }

  send(data: unknown): void {
    if (this.readyState !== "open") throw domError("InvalidStateError", "RTCDataChannel.readyState is not 'open'");
    this.sent.push(data);
    // Real channels deliver asynchronously.
    const peer = this.peer;
    if (peer) setTimeout(() => peer.receive(data), 1);
  }

  open(id = this.id ?? 1): void {
    this.id = id;
    this.readyState = "open";
    const e = new Event("open");
    this.onopen?.(e);
    this.dispatchEvent(e);
  }

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  close(): void {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

type Desc = { type: RTCSdpType; sdp: string };

export class FakePeerConnection extends EventTarget {
  signalingState: RTCSignalingState = "stable";
  iceGatheringState: RTCIceGatheringState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  connectionState: RTCPeerConnectionState = "new";
  localDescription: Desc | null = null;
  remoteDescription: Desc | null = null;
  onicecandidate: ((e: Event) => void) | null = null;
  readonly sessionId = String(++sessionCounter);
  private version = 1;
  channels: FakeDataChannel[] = [];
  statsReport: Map<string, Record<string, unknown>> = new Map();
  addedCandidates: unknown[] = [];

  constructor(private readonly config: RTCConfiguration = {}) {
    super();
  }

  getConfiguration(): RTCConfiguration {
    return this.config;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.version += 1;
    return { type: "offer", sdp: makeSdp({ sessionId: this.sessionId, version: this.version, type: "offer", application: this.channels.length > 0 }) };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    if (this.signalingState !== "have-remote-offer") throw domError("InvalidStateError", "createAnswer called in wrong state");
    this.version += 1;
    const app = /m=application/.test(this.remoteDescription?.sdp ?? "");
    return { type: "answer", sdp: makeSdp({ sessionId: this.sessionId, version: this.version, type: "answer", application: app }) };
  }

  async setLocalDescription(desc?: RTCSessionDescriptionInit): Promise<void> {
    const d = (desc ?? (await (this.signalingState === "have-remote-offer" ? this.createAnswer() : this.createOffer()))) as Desc;
    this.localDescription = d;
    this.setSignaling(d.type === "offer" ? "have-local-offer" : "stable");
    if (this.iceGatheringState === "new") this.setState("iceGatheringState", "gathering", "icegatheringstatechange");
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    if (desc.type === "answer" && this.signalingState !== "have-local-offer") {
      throw domError("InvalidStateError", `Failed to set remote answer sdp: Called in wrong state: ${this.signalingState}`);
    }
    this.remoteDescription = desc as Desc;
    this.setSignaling(desc.type === "offer" ? "have-remote-offer" : "stable");
  }

  async addIceCandidate(candidate?: RTCIceCandidateInit | null): Promise<void> {
    if (!this.remoteDescription) throw domError("InvalidStateError", "The remote description was null");
    this.addedCandidates.push(candidate);
  }

  createDataChannel(label: string, init?: RTCDataChannelInit): FakeDataChannel {
    const channel = new FakeDataChannel(label, init);
    this.channels.push(channel);
    return channel;
  }

  async getStats(): Promise<Map<string, Record<string, unknown>>> {
    return this.statsReport;
  }

  restartIce(): void {}

  close(): void {
    this.signalingState = "closed";
    this.connectionState = "closed";
    this.iceConnectionState = "closed";
  }

  // --- test helpers -----------------------------------------------------------
  gather(candidate: string, sdpMid = "0"): void {
    const c = { candidate, sdpMid, sdpMLineIndex: 0, usernameFragment: "Ab12" };
    const e = Object.assign(new Event("icecandidate"), { candidate: c });
    this.onicecandidate?.(e);
    this.dispatchEvent(e);
  }

  finishGathering(): void {
    this.dispatchEvent(Object.assign(new Event("icecandidate"), { candidate: null }));
    this.setState("iceGatheringState", "complete", "icegatheringstatechange");
  }

  setIce(state: RTCIceConnectionState): void {
    this.setState("iceConnectionState", state, "iceconnectionstatechange");
  }

  setConnection(state: RTCPeerConnectionState): void {
    this.setState("connectionState", state, "connectionstatechange");
  }

  announceChannel(label: string, id = 1): FakeDataChannel {
    const channel = new FakeDataChannel(label, {}, id);
    channel.readyState = "open";
    this.dispatchEvent(Object.assign(new Event("datachannel"), { channel }));
    return channel;
  }

  candidateError(errorCode: number, url: string, errorText = "STUN host lookup received error."): void {
    this.dispatchEvent(Object.assign(new Event("icecandidateerror"), { errorCode, errorText, url, address: "192.168.1.20", port: 50000 }));
  }

  private setSignaling(state: RTCSignalingState): void {
    this.setState("signalingState", state, "signalingstatechange");
  }

  private setState<K extends "signalingState" | "iceGatheringState" | "iceConnectionState" | "connectionState">(
    key: K,
    value: this[K],
    event: string,
  ): void {
    this[key] = value;
    this.dispatchEvent(new Event(event));
  }
}

export const asPc = (fake: FakePeerConnection) => fake as unknown as RTCPeerConnection;

/** Flush pending promise callbacks. */
export const tick = () => new Promise((r) => setTimeout(r, 0));
