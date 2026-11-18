/**
 * Playground scenarios. Each one is a real WebRTC connection between peers in
 * this page, with optional faults injected into the simulated signaling or the
 * application logic, reproducing bugs people actually ship.
 */

export interface Faults {
  /** Never deliver ICE candidates through signaling. */
  dropCandidates?: boolean;
  /** Never deliver the answer. */
  dropAnswer?: boolean;
  /** Deliver candidates this fast, overtaking slower SDP messages; the app does not queue them. */
  candidateLatencyMs?: number;
  /** Create the data channel after createOffer() and ignore negotiationneeded. */
  channelAfterOffer?: boolean;
  /** Call send() right after createDataChannel(), before the channel is open. */
  sendBeforeOpen?: boolean;
}

export interface Scenario {
  id: string;
  title: string;
  /** What happens, in one sentence. */
  summary: string;
  /** Where to look in the inspector. */
  lookFor: string;
  agents: string[];
  topology: "pair" | "mesh";
  signalingLatencyMs: number;
  config?: RTCConfiguration;
  faults?: Faults;
  greet?: boolean;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "happy-path",
    title: "Two peers, one data channel",
    summary: "Alice offers, Bob answers, candidates trickle across, the channel opens and both say hello.",
    lookFor: "Timeline: follow the offer, answer and candidates across the two lifelines.",
    agents: ["alice", "bob"],
    topology: "pair",
    signalingLatencyMs: 60,
    greet: true,
  },
  {
    id: "mesh",
    title: "Mesh of four",
    summary: "Four peers each connect to every other peer: six connection pairs, twelve RTCPeerConnections.",
    lookFor: "Overview: the topology; Timeline: switch lanes to one per endpoint.",
    agents: ["alice", "bob", "carol", "dave"],
    topology: "mesh",
    signalingLatencyMs: 40,
    greet: true,
  },
  {
    id: "candidates-dropped",
    title: "Candidates never forwarded",
    summary: "The app sends the offer and answer but forgets to forward 'icecandidate' events.",
    lookFor: "Overview: the diagnosis; ICE: no remote candidates on either side.",
    agents: ["alice", "bob"],
    topology: "pair",
    signalingLatencyMs: 60,
    faults: { dropCandidates: true },
  },
  {
    id: "answer-lost",
    title: "Answer lost in signaling",
    summary: "Bob answers, but the answer never reaches Alice. Alice waits in have-local-offer.",
    lookFor: "Signaling: Alice's state path stops at have-local-offer.",
    agents: ["alice", "bob"],
    topology: "pair",
    signalingLatencyMs: 60,
    faults: { dropAnswer: true },
  },
  {
    id: "early-candidates",
    title: "Candidates overtake the offer",
    summary: "Candidates travel faster than the SDP and the app adds them before setRemoteDescription().",
    lookFor: "Timeline: addIceCandidate() failures; Overview: the fix (queue candidates).",
    agents: ["alice", "bob"],
    topology: "pair",
    signalingLatencyMs: 700,
    faults: { candidateLatencyMs: 15 },
  },
  {
    id: "channel-after-offer",
    title: "Channel created after the offer",
    summary: "The offer only has audio; the data channel is created afterwards and negotiationneeded is ignored.",
    lookFor: "Data channels: stuck in connecting; Signaling: compare offer and answer.",
    agents: ["alice", "bob"],
    topology: "pair",
    signalingLatencyMs: 60,
    faults: { channelAfterOffer: true },
  },
  {
    id: "send-before-open",
    title: "send() before the channel opens",
    summary: "The app sends a message immediately after createDataChannel(). It throws and is lost.",
    lookFor: "Overview: the send() failure and its fix.",
    agents: ["alice", "bob"],
    topology: "pair",
    signalingLatencyMs: 60,
    faults: { sendBeforeOpen: true },
    greet: true,
  },
  {
    id: "bad-ice-servers",
    title: "Unreachable STUN and TURN",
    summary: "The ICE servers point at an unroutable address. Gathering waits for timeouts; host candidates still connect.",
    lookFor: "ICE: server errors (701) and slow gathering. Errors can take 10 to 40 s to appear.",
    agents: ["alice", "bob"],
    topology: "pair",
    signalingLatencyMs: 60,
    config: {
      iceServers: [
        { urls: "stun:192.0.2.1:3478" },
        { urls: "turn:192.0.2.1:3478?transport=udp", username: "demo", credential: "wrong-password" },
      ],
    },
    greet: true,
  },
  {
    id: "relay-only",
    title: "Relay only, no TURN server",
    summary: "iceTransportPolicy is 'relay' but no TURN server is configured, so no candidates exist at all.",
    lookFor: "Overview: no local candidates; ICE: gathering completes empty.",
    agents: ["alice", "bob"],
    topology: "pair",
    signalingLatencyMs: 60,
    config: { iceServers: [], iceTransportPolicy: "relay" },
  },
];
