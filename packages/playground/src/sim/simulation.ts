/**
 * The playground simulation: real RTCPeerConnections in one page, connected
 * through an in-memory signaling channel with latency and injectable faults.
 *
 * The app code here is deliberately ordinary WebRTC code. The inspector only
 * observes it (session.observe) and receives signaling annotations, exactly
 * as an embedding application would provide them.
 */

import type { InspectorSession } from "@rtc-inspector/core";
import type { Scenario } from "./scenarios";

type Kind = "offer" | "answer" | "candidate";

export interface SimChannel {
  peerId: string;
  label: string;
  channel: RTCDataChannel;
}

export interface SimConnection {
  peerId: string;
  label: string;
  agent: string;
  remote: string;
  initiator: boolean;
  pc: RTCPeerConnection;
  channels: Map<string, RTCDataChannel>;
  /** Candidates that arrived before the remote description (well-behaved apps queue them). */
  pendingCandidates: RTCIceCandidateInit[];
}

let messageCounter = 0;

export class Simulation {
  readonly connections = new Map<string, SimConnection>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<() => void>();
  /** Per-direction delivery clock: signaling is ordered, like a WebSocket. */
  private readonly lastDelivery = new Map<string, number>();
  private stopped = false;

  constructor(
    private readonly session: InspectorSession,
    readonly scenario: Scenario,
  ) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Open channels, for the message composer. */
  openChannels(): SimChannel[] {
    const out: SimChannel[] = [];
    for (const c of this.connections.values()) {
      for (const [label, channel] of c.channels) if (channel.readyState === "open") out.push({ peerId: c.peerId, label, channel });
    }
    return out;
  }

  async start(): Promise<void> {
    const { agents, topology } = this.scenario;
    const pairs: [string, string][] = [];
    if (topology === "pair") pairs.push([agents[0]!, agents[1]!]);
    else for (let i = 0; i < agents.length; i++) for (let j = i + 1; j < agents.length; j++) pairs.push([agents[i]!, agents[j]!]);
    await Promise.all(pairs.map(([a, b]) => this.connectPair(a, b)));
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const c of this.connections.values()) {
      for (const channel of c.channels.values()) channel.close();
      if (c.pc.signalingState !== "closed") c.pc.close();
    }
    this.emit();
  }

  send(peerId: string, label: string, text: string): boolean {
    const channel = this.connections.get(peerId)?.channels.get(label);
    if (!channel || channel.readyState !== "open") return false;
    channel.send(text);
    return true;
  }

  close(peerId: string): void {
    this.connections.get(peerId)?.pc.close();
    this.emit();
  }

  /** ICE restart: new credentials, renegotiated by the initiating side. */
  async restartIce(peerId: string): Promise<void> {
    const c = this.connections.get(peerId);
    if (!c || !c.initiator || c.pc.signalingState === "closed") return;
    c.pc.restartIce();
    await this.sendOffer(c);
  }

  // --- internals --------------------------------------------------------------

  private emit() {
    for (const l of this.listeners) l();
  }

  private idFor(agent: string, remote: string) {
    return `${agent}→${remote}`;
  }

  private labelFor(agent: string, remote: string) {
    return this.scenario.topology === "pair" ? agent : `${agent} → ${remote}`;
  }

  private createConnection(agent: string, remote: string, initiator: boolean): SimConnection {
    const pc = new RTCPeerConnection(this.scenario.config);
    const peerId = this.idFor(agent, remote);
    this.session.observe(pc, { peerId, label: this.labelFor(agent, remote), group: agent });
    const conn: SimConnection = { peerId, label: this.labelFor(agent, remote), agent, remote, initiator, pc, channels: new Map(), pendingCandidates: [] };
    this.connections.set(peerId, conn);

    pc.onicecandidate = (e) => {
      if (e.candidate) this.signal(conn, "candidate", e.candidate.toJSON());
    };
    pc.ondatachannel = (e) => this.registerChannel(conn, e.channel);
    pc.onconnectionstatechange = () => this.emit();
    return conn;
  }

  private registerChannel(conn: SimConnection, channel: RTCDataChannel) {
    conn.channels.set(channel.label, channel);
    channel.onopen = () => {
      if (this.scenario.greet) channel.send(`hi ${conn.remote}, this is ${conn.agent}`);
      this.emit();
    };
    channel.onclose = () => this.emit();
  }

  private async connectPair(a: string, b: string) {
    const offerer = this.createConnection(a, b, true);
    this.createConnection(b, a, false);
    const faults = this.scenario.faults ?? {};

    if (faults.channelAfterOffer) {
      // A media section so ICE/DTLS still connect; no data channel yet.
      offerer.pc.addTransceiver("audio", { direction: "recvonly" });
    } else {
      const channel = offerer.pc.createDataChannel("chat");
      this.registerChannel(offerer, channel);
      if (faults.sendBeforeOpen) {
        try {
          channel.send(`hello ${b}?`);
        } catch {
          // A real app would usually not even notice this.
        }
      }
    }
    await this.sendOffer(offerer);
  }

  private async sendOffer(conn: SimConnection) {
    const faults = this.scenario.faults ?? {};
    const offer = await conn.pc.createOffer();
    if (faults.channelAfterOffer && !conn.channels.size) {
      this.registerChannel(conn, conn.pc.createDataChannel("chat"));
    }
    await conn.pc.setLocalDescription(offer);
    this.signal(conn, "offer", { type: conn.pc.localDescription!.type, sdp: conn.pc.localDescription!.sdp });
  }

  /** The "early candidates" scenario models an app that neither orders nor queues. */
  private get naive(): boolean {
    return this.scenario.faults?.candidateLatencyMs !== undefined;
  }

  private async receive(conn: SimConnection, kind: Kind, payload: unknown) {
    if (this.stopped || conn.pc.signalingState === "closed") return;
    const pc = conn.pc;
    try {
      if (kind === "offer") {
        await pc.setRemoteDescription(payload as RTCSessionDescriptionInit);
        await this.flushCandidates(conn);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.signal(conn, "answer", { type: pc.localDescription!.type, sdp: pc.localDescription!.sdp });
      } else if (kind === "answer") {
        await pc.setRemoteDescription(payload as RTCSessionDescriptionInit);
        await this.flushCandidates(conn);
      } else if (!pc.remoteDescription && !this.naive) {
        conn.pendingCandidates.push(payload as RTCIceCandidateInit);
      } else {
        await pc.addIceCandidate(payload as RTCIceCandidateInit);
      }
    } catch {
      // Errors are recorded by the inspector; the app carries on like many real apps do.
    }
  }

  private async flushCandidates(conn: SimConnection) {
    for (const candidate of conn.pendingCandidates.splice(0)) await conn.pc.addIceCandidate(candidate);
  }

  private signal(from: SimConnection, kind: Kind, payload: unknown) {
    if (this.stopped) return;
    const to = this.connections.get(this.idFor(from.remote, from.agent));
    if (!to) return;
    const faults = this.scenario.faults ?? {};
    const messageId = `m${++messageCounter}`;
    const wire = JSON.stringify(payload);
    this.session.signaling(from.peerId, { direction: "sent", kind, remote: from.remote, messageId, size: wire.length });

    const dropped = (kind === "candidate" && faults.dropCandidates) || (kind === "answer" && faults.dropAnswer);
    if (dropped) {
      this.session.annotate(from.peerId, `Simulated fault: ${kind} dropped by signaling`);
      return;
    }
    const fast = kind === "candidate" && faults.candidateLatencyMs !== undefined;
    const base = fast ? faults.candidateLatencyMs! : this.scenario.signalingLatencyMs;
    let deliverAt = Date.now() + base + Math.random() * base * 0.2;
    if (!fast) {
      // Ordered channel: never overtake an earlier message in the same direction.
      const lane = `${from.peerId}>${to.peerId}`;
      deliverAt = Math.max(deliverAt, (this.lastDelivery.get(lane) ?? 0) + 1);
      this.lastDelivery.set(lane, deliverAt);
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.stopped) return;
      this.session.signaling(to.peerId, { direction: "received", kind, remote: from.agent, messageId, size: wire.length });
      void this.receive(to, kind, JSON.parse(wire));
    }, deliverAt - Date.now());
    this.timers.add(timer);
  }
}
