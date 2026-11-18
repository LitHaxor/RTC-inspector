import Link from "next/link";

const LINKS = [
  { href: "/", label: "Playground" },
  { href: "/embedded", label: "Embedded mode" },
  { href: "/viewer", label: "Trace viewer" },
];

export function AppNav({ current }: { current: string }) {
  return (
    <nav className="flex min-h-11 shrink-0 items-center gap-1 border-b border-line bg-well px-4" aria-label="RTC Inspector">
      <span className="mr-4 text-sm font-medium text-fg">RTC Inspector</span>
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} className="tab" aria-current={l.href === current ? "page" : undefined} aria-selected={l.href === current}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
