"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { STATE_HELP, stateTone, type Tone } from "@rtc-inspector/core";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function Button({
  variant = "default",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "quiet" }) {
  return (
    <button
      type="button"
      {...props}
      className={cx("ctl", variant === "primary" && "ctl--primary", variant === "quiet" && "ctl--quiet", className)}
    />
  );
}

export function Chip({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={cx("chip", tone !== "neutral" && `chip--${tone}`)} title={title}>
      {children}
    </span>
  );
}

const STATE_KIND_LABEL: Record<string, string> = {
  signaling: "Signaling",
  gathering: "ICE gathering",
  ice: "ICE connection",
  connection: "Connection",
};

/** A state value with its plain-language meaning as a tooltip. */
export function StateChip({ kind, state }: { kind: keyof typeof STATE_HELP; state: string }) {
  const help = STATE_HELP[kind]?.[state];
  return (
    <Chip tone={stateTone(state)} title={help ? `${STATE_KIND_LABEL[kind]}: ${help}` : undefined}>
      {state}
    </Chip>
  );
}

export function Panel({
  title,
  aside,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cx("min-w-0 rounded-panel border border-line bg-panel", className)}>
      {(title || aside) && (
        <header className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
          {title && <h2 className="text-sm font-medium text-fg">{title}</h2>}
          {aside && <div className="flex flex-wrap items-center gap-2 text-xs text-dim">{aside}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 px-4 py-8">
      <p className="text-sm font-medium text-fg">{title}</p>
      {children && <div className="max-w-prose text-sm text-dim">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Label over a value; the value is set in the measured face when it was measured. */
export function Reading({ label, value, measured = true, hint }: { label: string; value: ReactNode; measured?: boolean; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 px-4 py-3" title={hint}>
      <span className="text-xs text-dim">{label}</span>
      <span className={cx("truncate text-sm", measured ? "measured text-fg" : "text-fg")}>{value}</span>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex gap-1">
      {options.map((o) => (
        <button key={o.value} type="button" className="ctl" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function PeerSelect({
  peers,
  value,
  onChange,
  label = "Connection",
}: {
  peers: { peerId: string; label: string }[];
  value: string | undefined;
  onChange: (peerId: string) => void;
  label?: string;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-xs text-dim">
      {label}
      <select className="field" value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
        {peers.map((p) => (
          <option key={p.peerId} value={p.peerId}>
            {p.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Collapsible JSON tree, read-only. Long strings are shortened with a way to expand them. */
export function JsonView({ value, depth = 0, openDepth = 1 }: { value: unknown; depth?: number; openDepth?: number }) {
  if (value === null || typeof value !== "object") {
    const tone =
      typeof value === "string" ? "text-good" : typeof value === "number" ? "text-reading" : typeof value === "boolean" ? "text-person" : "text-dim";
    const text = typeof value === "string" ? JSON.stringify(value) : String(value);
    if (text.length > 240) {
      return (
        <details className="inline">
          <summary className={cx("measured cursor-pointer", tone)}>{text.slice(0, 120)}… ({text.length} characters)</summary>
          <span className={cx("measured whitespace-pre-wrap break-all", tone)}>{text}</span>
        </details>
      );
    }
    return <span className={cx("measured", tone)}>{text}</span>;
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  if (!entries.length) return <span className="measured text-dim">{Array.isArray(value) ? "[]" : "{}"}</span>;
  return (
    <ul className={cx("measured text-xs", depth > 0 && "border-l border-line pl-3")}>
      {entries.map(([k, v]) => {
        const nested = v !== null && typeof v === "object";
        return (
          <li key={k} className="py-0.5">
            {nested ? (
              <details open={depth < openDepth}>
                <summary className="cursor-pointer text-fg-2">
                  {k}
                  <span className="text-dim">{Array.isArray(v) ? ` [${(v as unknown[]).length}]` : ""}</span>
                </summary>
                <JsonView value={v} depth={depth + 1} openDepth={openDepth} />
              </details>
            ) : (
              <span className="break-all">
                <span className="text-fg-2">{k}: </span>
                <JsonView value={v} depth={depth + 1} openDepth={openDepth} />
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
