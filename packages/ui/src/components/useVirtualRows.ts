"use client";

import { useLayoutEffect, useRef, useState, type UIEvent } from "react";

export const ROW_H = 30;

/**
 * Windowed rendering for long fixed-height lists. Follows new rows while the
 * user is parked at the bottom of a live list.
 */
export function useVirtualRows(count: number, live: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [size, setSize] = useState({ width: 0, height: 600 });
  const atBottom = useRef(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Follow new events while the user is parked at the bottom.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && live && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [count, live]);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_H * 2;
    setScrollTop(el.scrollTop);
  };
  const overscan = 12;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - overscan);
  const end = Math.min(count, Math.ceil((scrollTop + size.height) / ROW_H) + overscan);
  return { ref, start, end, width: size.width, onScroll, scrollTop, viewport: size.height };
}
