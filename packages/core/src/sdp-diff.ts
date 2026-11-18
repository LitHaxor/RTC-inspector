/**
 * Semantic SDP comparison. Rather than a textual diff, compare what each side
 * *means*: directions, codecs, DTLS roles, data channel transport... and
 * explain the consequence of each difference.
 */

import { parseSdp, primaryCodecs, sectionTitle, type ParsedSdp, type SdpMediaSection } from "./sdp-parser";

export type DiffStatus = "same" | "different" | "only-left" | "only-right" | "warning";

export interface SdpDiffRow {
  section: string;
  field: string;
  left?: string;
  right?: string;
  status: DiffStatus;
  note?: string;
}

export interface SdpDiff {
  rows: SdpDiffRow[];
  warnings: number;
}

const codecLabel = (m: SdpMediaSection) =>
  primaryCodecs(m)
    .map((c) => c.name)
    .filter((n, i, all) => all.indexOf(n) === i)
    .join(", ") || "none";

/** What the remote side's direction implies for an offer/answer pair. */
const DIRECTION_PAIRS: Record<string, { note: string; bad: boolean }> = {
  "sendrecv>recvonly": { note: "Right side will only receive. Media flows one way: left → right.", bad: false },
  "sendrecv>sendonly": { note: "Right side will only send. Media flows one way: right → left.", bad: false },
  "sendrecv>inactive": { note: "Right side declined to send or receive. No media will flow on this section.", bad: true },
  "sendonly>recvonly": { note: "Compatible: left sends, right receives.", bad: false },
  "recvonly>sendonly": { note: "Compatible: right sends, left receives.", bad: false },
  "sendonly>sendonly": { note: "Both sides only send: nobody receives. Probably a bug.", bad: true },
  "recvonly>recvonly": { note: "Both sides only receive: no media will flow.", bad: true },
  "sendonly>inactive": { note: "Right side declined the media left wants to send.", bad: true },
  "recvonly>inactive": { note: "Right side has nothing to send, so no media will flow.", bad: true },
};

/** What the remote side's direction implies for an offer/answer pair. */
function directionNote(left?: string, right?: string): { status: DiffStatus; note?: string } {
  const known = left && right ? DIRECTION_PAIRS[`${left}>${right}`] : undefined;
  if (known) return { status: known.bad ? "warning" : "different", note: known.note };
  return { status: left === right ? "same" : "different" };
}

function setupNote(left?: string, right?: string): string | undefined {
  if (!left || !right) return undefined;
  if (right === "active") return "Right side is the DTLS client (initiates the handshake).";
  if (right === "passive") return "Right side is the DTLS server; left side initiates the handshake.";
  if (left === "actpass" && right === "actpass") return "Answer must not be actpass. This is invalid.";
  return undefined;
}

function matchSections(left: ParsedSdp, right: ParsedSdp): [SdpMediaSection | undefined, SdpMediaSection | undefined][] {
  const pairs: [SdpMediaSection | undefined, SdpMediaSection | undefined][] = [];
  const usedRight = new Set<number>();
  for (const l of left.media) {
    const r =
      (l.mid !== undefined ? right.media.find((m) => m.mid === l.mid) : undefined) ??
      right.media.find((m) => m.index === l.index && m.kind === l.kind);
    if (r) usedRight.add(r.index);
    pairs.push([l, r]);
  }
  for (const r of right.media) if (!usedRight.has(r.index)) pairs.push([undefined, r]);
  return pairs;
}

function compare(rows: SdpDiffRow[], section: string, field: string, left?: string, right?: string, note?: string) {
  const status: DiffStatus =
    left === right ? "same" : left === undefined ? "only-right" : right === undefined ? "only-left" : "different";
  rows.push({ section, field, ...(left !== undefined && { left }), ...(right !== undefined && { right }), status, ...(note && { note }) });
}

export function diffSdp(leftInput: string | ParsedSdp, rightInput: string | ParsedSdp): SdpDiff {
  const left = typeof leftInput === "string" ? parseSdp(leftInput) : leftInput;
  const right = typeof rightInput === "string" ? parseSdp(rightInput) : rightInput;
  const rows: SdpDiffRow[] = [];
  const session = "Session";

  const bundle = (s: ParsedSdp) => s.groups.find((g) => g.semantics === "BUNDLE")?.mids.join(" ");
  const lb = bundle(left);
  const rb = bundle(right);
  compare(
    rows,
    session,
    "BUNDLE",
    lb ?? "none",
    rb ?? "none",
    lb && !rb ? "Right side did not accept BUNDLE: each section needs its own transport." : undefined,
  );
  compare(rows, session, "ICE lite", String(left.iceLite), String(right.iceLite));
  compare(rows, session, "Media sections", String(left.media.length), String(right.media.length));

  for (const [l, r] of matchSections(left, right)) {
    const ref = (l ?? r)!;
    const name = `${sectionTitle(ref)}${ref.mid !== undefined ? ` (mid ${ref.mid})` : ""}`;
    if (!l || !r) {
      rows.push({
        section: name,
        field: "Present",
        ...(l && { left: "yes" }),
        ...(r && { right: "yes" }),
        status: "warning",
        note: l
          ? "Section missing on the right. An answer must contain every offered section."
          : "Section only exists on the right.",
      });
      continue;
    }
    const lState = l.rejected ? "rejected" : "accepted";
    const rState = r.rejected ? "rejected" : "accepted";
    rows.push({
      section: name,
      field: "Status",
      left: lState,
      right: rState,
      status: lState === rState ? "same" : "warning",
      ...(r.rejected && !l.rejected && { note: "Right side rejected this section (port 0). It will carry nothing." }),
    });

    if (ref.kind !== "application") {
      const d = directionNote(l.direction, r.direction);
      rows.push({
        section: name,
        field: "Direction",
        ...(l.direction && { left: l.direction }),
        ...(r.direction && { right: r.direction }),
        status: d.status,
        ...(d.note && { note: d.note }),
      });
      const lc = codecLabel(l);
      const rc = codecLabel(r);
      const lNames = new Set(primaryCodecs(l).map((c) => c.name.toLowerCase()));
      const common = primaryCodecs(r).filter((c) => lNames.has(c.name.toLowerCase()));
      rows.push({
        section: name,
        field: "Codecs",
        left: lc,
        right: rc,
        status: lc === rc ? "same" : common.length === 0 && !r.rejected ? "warning" : "different",
        ...(common.length > 0 && lc !== rc && { note: `Negotiated: ${common[0]!.name} is preferred.` }),
        ...(common.length === 0 && !r.rejected && { note: "No codec in common. Media cannot flow." }),
      });
      compare(rows, name, "Header extensions", String(l.extmaps.length), String(r.extmaps.length));
      compare(rows, name, "RTCP mux", String(l.rtcpMux), String(r.rtcpMux));
    } else {
      compare(rows, name, "SCTP port", l.sctpPort?.toString(), r.sctpPort?.toString());
      compare(
        rows,
        name,
        "Max message size",
        l.maxMessageSize?.toString(),
        r.maxMessageSize?.toString(),
        "Each side may only send messages up to the *other* side's max-message-size.",
      );
    }

    const lSetup = l.setup ?? left.setup;
    const rSetup = r.setup ?? right.setup;
    compare(rows, name, "DTLS role (setup)", lSetup, rSetup, setupNote(lSetup, rSetup));
    const ufragNote =
      l.iceUfrag !== r.iceUfrag
        ? "Different ICE credentials. Expected between two peers; within one peer it means an ICE restart."
        : undefined;
    compare(rows, name, "ICE ufrag", l.iceUfrag, r.iceUfrag, ufragNote);
    compare(rows, name, "Candidates in SDP", String(l.candidates.length), String(r.candidates.length));
  }
  return { rows, warnings: rows.filter((r) => r.status === "warning").length };
}
