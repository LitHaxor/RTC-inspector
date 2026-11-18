/**
 * IP address classification and redaction.
 *
 * Redaction keeps enough information to debug (is it private? loopback? mDNS?
 * which private range?) without exposing a user's actual addresses in exported
 * traces or screenshots.
 */

export type AddressKind =
  | "private"
  | "public"
  | "loopback"
  | "link-local"
  | "cgnat"
  | "unspecified"
  | "mdns"
  | "hostname"
  | "unknown";

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isIPv4(value: string): boolean {
  const m = IPV4.exec(value);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

export function isIPv6(value: string): boolean {
  // Deliberately permissive: candidate/SDP addresses are already well formed.
  return value.includes(":") && /^[0-9a-fA-F:.]+(%\w+)?$/.test(value);
}

export function classifyAddress(address: string | null | undefined): AddressKind {
  if (!address) return "unknown";
  if (address.endsWith(".local")) return "mdns";
  if (isIPv4(address)) {
    const [a, b] = address.split(".").map(Number) as [number, number, number, number];
    if (address === "0.0.0.0") return "unspecified";
    if (a === 127) return "loopback";
    if (a === 10) return "private";
    if (a === 172 && b >= 16 && b <= 31) return "private";
    if (a === 192 && b === 168) return "private";
    if (a === 169 && b === 254) return "link-local";
    if (a === 100 && b >= 64 && b <= 127) return "cgnat";
    return "public";
  }
  if (isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower === "::") return "unspecified";
    if (lower === "::1") return "loopback";
    if (/^fe[89ab]/.test(lower)) return "link-local";
    if (/^f[cd]/.test(lower)) return "private";
    return "public";
  }
  if (/^[a-zA-Z0-9.-]+$/.test(address)) return "hostname";
  return "unknown";
}

/**
 * Redact a single address. Private/loopback ranges keep their identifying
 * prefix (useful for spotting "two peers on the same LAN"), public addresses
 * keep only the first octet. mDNS names are already anonymous and are kept.
 */
export function redactAddress(address: string | null | undefined): string | null | undefined {
  if (!address) return address;
  const kind = classifyAddress(address);
  switch (kind) {
    case "mdns":
    case "unspecified":
    case "hostname":
    case "unknown":
      return address;
    case "loopback":
      return address;
    default:
      break;
  }
  if (isIPv4(address)) {
    const octets = address.split(".");
    const keep = kind === "public" ? 1 : 2;
    return octets.map((o, i) => (i < keep ? o : "x")).join(".");
  }
  const first = address.split(":")[0] || "";
  return `${first}::x`;
}

/** Redact every IPv4 / IPv6 address that appears in free text. */
export function redactText(text: string): string {
  return text
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, (ip) => (isIPv4(ip) ? redactAddress(ip) ?? ip : ip))
    .replace(/(?<![\w:])(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{0,4}(?![\w:])/g, (ip) =>
      ip.length >= 6 && isIPv6(ip) ? redactAddress(ip) ?? ip : ip,
    );
}

/** Redact addresses and ICE passwords inside an SDP blob. */
export function redactSdp(sdp: string): string {
  return sdp
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith("a=ice-pwd:")) return "a=ice-pwd:[redacted]";
      if (line.startsWith("c=") || line.startsWith("o=") || line.startsWith("a=candidate:") || line.startsWith("a=rtcp:")) {
        return redactText(line);
      }
      return line;
    })
    .join("\r\n");
}
