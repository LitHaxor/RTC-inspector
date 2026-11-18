"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, Pause, Play } from "lucide-react";
import { useDerived, useInspector } from "../context";
import { relTime } from "../format";
import { Button, cx } from "../components/primitives";

/**
 * The time-travel slider: scrub through the recording and every tab shows
 * the session as it was right after that event.
 */
export function TimeTravelBar({ compact = false }: { compact?: boolean }) {
  const events = useInspector((s) => s.events);
  const setTravel = useInspector((s) => s.setTravel);
  const stepTravel = useInspector((s) => s.stepTravel);
  const selectEvent = useInspector((s) => s.selectEvent);
  const { travelIndex, origin } = useDerived();
  const [playing, setPlaying] = useState(false);
  const last = events.length - 1;
  const index = travelIndex ?? last;
  const current = events[index];

  useEffect(() => {
    if (!playing) return;
    if (travelIndex === undefined) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => stepTravel(1), 250);
    return () => clearTimeout(timer);
  }, [playing, travelIndex, stepTravel]);

  if (!events.length) return null;

  const goTo = (i: number) => {
    const e = events[i];
    if (!e) return;
    setTravel(e.id);
    selectEvent(e.id);
  };

  return (
    <div className="flex shrink-0 items-center gap-1 border-t border-line bg-panel px-3 py-1.5" role="group" aria-label="Time travel">
      <Button variant="quiet" aria-label="First event" onClick={() => goTo(0)} disabled={index === 0}>
        <ChevronsLeft size={16} aria-hidden="true" />
      </Button>
      <Button variant="quiet" aria-label="Previous event" onClick={() => stepTravel(-1)} disabled={index === 0}>
        <ChevronLeft size={16} aria-hidden="true" />
      </Button>
      <Button
        variant="quiet"
        aria-label={playing ? "Pause replay" : "Replay from here"}
        onClick={() => {
          if (!playing && travelIndex === undefined) goTo(0);
          setPlaying(!playing);
        }}
      >
        {playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
      </Button>
      <Button variant="quiet" aria-label="Next event" onClick={() => stepTravel(1)} disabled={travelIndex === undefined}>
        <ChevronRight size={16} aria-hidden="true" />
      </Button>
      <input
        type="range"
        className="time-slider min-w-40 flex-1"
        min={0}
        max={Math.max(0, last)}
        value={index}
        onChange={(e) => goTo(Number(e.target.value))}
        aria-label="Event position"
        aria-valuetext={current ? `${index + 1} of ${events.length}, ${current.type}` : undefined}
      />
      <span className="measured shrink-0 text-xs text-dim">
        {index + 1} / {events.length}
      </span>
      <span className={cx("measured w-56 truncate text-xs text-fg-2", compact ? "hidden" : "hidden md:inline")} title={current?.type}>
        {current ? `${relTime(current.timestamp, origin)} ${current.type}` : ""}
      </span>
      <Button className="shrink-0" variant={travelIndex === undefined ? "default" : "primary"} onClick={() => setTravel(undefined)} disabled={travelIndex === undefined}>
        {travelIndex === undefined ? "Live" : "Back to live"}
      </Button>
    </div>
  );
}
