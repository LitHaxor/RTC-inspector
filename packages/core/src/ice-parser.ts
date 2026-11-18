/**
 * ICE candidate parsing (RFC 8445 / RFC 8839 `candidate` attribute).
 *
 *   candidate:842163049 1 udp 1677729535 203.0.113.7 54321 typ srflx
 *     raddr 192.168.1.20 rport 54321 generation 0 ufrag Abcd network-cost 999
 */

import { classifyAddress, redactAddress, type AddressKind } from "./redact";

export type CandidateType = "host" | "srflx" | "prflx" | "relay" | (string & {});

export interface ParsedCandidate {
  foundation: string;
  component: number;
  componentName: "rtp" | "rtcp" | (string & {});
  protocol: string;
  priority: number;
  /** Decomposed priority: (2^24 * type pref) + (2^8 * local pref) + (256 - component). */
  typePreference: number;
  localPreference: number;
  address: string;
  addressKind: AddressKind;
  port: number;
  type: CandidateType;
  relatedAddress?: string;
  relatedPort?: number;
  tcpType?: string;
  generation?: number;
  ufrag?: string;
  networkId?: number;
  networkCost?: number;
}

export const CANDIDATE_TYPE_INFO: Record<string, { name: string; meaning: string }> = {
  host: {
    name: "Host",
    meaning: "An address on a local network interface (LAN IP, VPN, or an mDNS .local name that hides it).",
  },
  srflx: {
    name: "Server reflexive",
    meaning: "The public address a STUN server saw this peer coming from, i.e. the NAT's external mapping.",
  },
  prflx: {
    name: "Peer reflexive",
    meaning: "An address learned during connectivity checks, when the remote peer saw traffic from an address it was not told about.",
  },
  relay: {
    name: "Relay",
    meaning: "An address allocated on a TURN server. Traffic is relayed through it; works through almost any NAT/firewall.",
  },
};

export function parseCandidate(input: string): ParsedCandidate | null {
  const line = input.trim().replace(/^a=/, "").replace(/^candidate:/, "");
  const parts = line.split(/\s+/);
  if (parts.length < 8 || parts[6] !== "typ") return null;
  const [foundation, componentStr, protocol, priorityStr, address, portStr, , type] = parts as [
    string, string, string, string, string, string, string, string,
  ];
  const component = Number(componentStr);
  const priority = Number(priorityStr);
  const parsed: ParsedCandidate = {
    foundation,
    component,
    componentName: component === 1 ? "rtp" : component === 2 ? "rtcp" : String(component),
    protocol: protocol.toLowerCase(),
    priority,
    typePreference: Math.floor(priority / 2 ** 24),
    localPreference: Math.floor(priority / 2 ** 8) & 0xffff,
    address,
    addressKind: classifyAddress(address),
    port: Number(portStr),
    type,
  };
  for (let i = 8; i + 1 < parts.length; i += 2) {
    const key = parts[i]!;
    const value = parts[i + 1]!;
    switch (key) {
      case "raddr":
        parsed.relatedAddress = value;
        break;
      case "rport":
        parsed.relatedPort = Number(value);
        break;
      case "tcptype":
        parsed.tcpType = value;
        break;
      case "generation":
        parsed.generation = Number(value);
        break;
      case "ufrag":
        parsed.ufrag = value;
        break;
      case "network-id":
        parsed.networkId = Number(value);
        break;
      case "network-cost":
        parsed.networkCost = Number(value);
        break;
      default:
        break;
    }
  }
  return parsed;
}

export function redactCandidate(parsed: ParsedCandidate): ParsedCandidate {
  return {
    ...parsed,
    address: redactAddress(parsed.address) ?? parsed.address,
    ...(parsed.relatedAddress !== undefined && {
      relatedAddress: redactAddress(parsed.relatedAddress) ?? parsed.relatedAddress,
    }),
  };
}

/**
 * A correlation key that identifies a candidate on both ends of a connection
 * without including the IP address (so it is safe to export). The ufrag is
 * deliberately excluded: Firefox omits it from candidate strings, and the
 * receiving side often doesn't pass `usernameFragment` to addIceCandidate.
 */
export function candidateCorrelationKey(parsed: ParsedCandidate): string {
  return [
    "cand",
    parsed.foundation,
    parsed.component,
    parsed.protocol,
    parsed.priority,
    parsed.port,
    parsed.type,
  ].join(":");
}

export function describeCandidate(c: Pick<ParsedCandidate, "type" | "protocol" | "address" | "port" | "tcpType">): string {
  const tcp = c.tcpType ? ` (${c.tcpType})` : "";
  return `${c.type} ${c.protocol}${tcp} ${c.address}:${c.port}`;
}
