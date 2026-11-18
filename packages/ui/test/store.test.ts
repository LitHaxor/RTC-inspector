import { afterEach, describe, expect, it, vi } from "vitest";
import { InspectorSession, type RTCTraceEvent } from "@rtc-inspector/core";
import { appendInOrder, createInspectorStore, defaultFocus, staticSource } from "../src/store";

const ev = (i: number, peerId = "p"): RTCTraceEvent =>
  ({ id: `e${i}`, seq: i, timestamp: 1000 + i, peerId, type: "annotation", category: "annotation", details: { label: `n${i}` } }) as RTCTraceEvent;

afterEach(() => vi.useRealTimers());

describe("time travel", () => {
  const make = () => createInspectorStore(staticSource([ev(1), ev(2, "q"), ev(3), ev(4)])).store;

  it("jumps to an event and returns to live at the last one", () => {
    const store = make();
    store.getState().setTravel("e2");
    expect(store.getState().travelEventId).toBe("e2");
    store.getState().setTravel("e4");
    expect(store.getState().travelEventId).toBeUndefined();
    store.getState().setTravel(undefined);
    expect(store.getState().travelEventId).toBeUndefined();
  });

  it("steps from the cursor, selects the event, clamps at both ends", () => {
    const store = make();
    store.getState().stepTravel(-1);
    expect(store.getState()).toMatchObject({ travelEventId: "e3", selectedEventId: "e3", focusPeerId: "p" });
    store.getState().stepTravel(-1);
    expect(store.getState()).toMatchObject({ travelEventId: "e2", focusPeerId: "q" });
    store.getState().stepTravel(-10);
    expect(store.getState().travelEventId).toBe("e1");
    store.getState().stepTravel(10);
    expect(store.getState().travelEventId).toBeUndefined();
    expect(store.getState().selectedEventId).toBe("e4");
  });

  it("steps from the selected event when live, and clear resets travel", () => {
    const store = make();
    store.getState().selectEvent("e2");
    store.getState().stepTravel(-1);
    expect(store.getState().travelEventId).toBe("e1");
    store.getState().clear();
    expect(store.getState()).toMatchObject({ travelEventId: undefined, events: [] });
    store.getState().stepTravel(1); // no events: no-op
    expect(store.getState().travelEventId).toBeUndefined();
  });

  it("keeps recording live events while traveling", () => {
    vi.useFakeTimers();
    const session = new InspectorSession({ statsIntervalMs: 0 });
    session.annotate("p", "a");
    session.annotate("p", "b");
    const { store, dispose } = createInspectorStore(session, { flushMs: 10 });
    store.getState().setTravel(store.getState().events[0]!.id);
    session.annotate("p", "c");
    vi.advanceTimersByTime(20);
    expect(store.getState().events).toHaveLength(3);
    expect(store.getState().travelEventId).toBe(store.getState().events[0]!.id);
    store.getState().setEventView("state");
    expect(store.getState().eventView).toBe("state");
    dispose();
  });
});

describe("default focus", () => {
  it("follows the first open connection, else the newest", () => {
    // Stop, then Start again: the new connections, not the first closed one.
    expect(defaultFocus([{ id: 1, closedAt: 5 }, { id: 2, closedAt: 5 }, { id: 3 }, { id: 4 }])?.id).toBe(3);
    expect(defaultFocus([{ id: 1, closedAt: 5 }, { id: 2, closedAt: 6 }])?.id).toBe(2);
    expect(defaultFocus([])).toBeUndefined();
  });

  it("prefers the endpoint the inspector was opened from", () => {
    const peers = [
      { id: 1, group: "Tab 1" },
      { id: 2, group: "Tab 2", closedAt: 3 },
      { id: 3, group: "Tab 2" },
    ];
    expect(defaultFocus(peers, "Tab 2")?.id).toBe(3);
    expect(defaultFocus(peers, "Tab 9")?.id).toBe(1);
  });
});

describe("appendInOrder", () => {
  it("appends in order and slots late events from another page into place", () => {
    const at = (seq: number, timestamp: number) => ({ ...ev(seq), timestamp });
    const list = [at(1, 10), at(2, 20)];
    expect(appendInOrder(list, [at(3, 30)]).map((e) => e.timestamp)).toEqual([10, 20, 30]);
    expect(appendInOrder(list, [at(9, 25), at(1, 15)]).map((e) => e.timestamp)).toEqual([10, 15, 20, 25]);
    expect(appendInOrder([], [at(1, 5)])).toHaveLength(1);
  });

  it("keeps a live store in time order when a batch arrives late", () => {
    vi.useFakeTimers();
    let listener: (e: RTCTraceEvent) => void = () => {};
    const { store } = createInspectorStore({ getSnapshot: () => ({ events: [], stats: [] }), subscribe: (l) => ((listener = l), () => {}) });
    listener({ ...ev(1), timestamp: 30 });
    vi.advanceTimersByTime(200);
    listener({ ...ev(2), timestamp: 20 });
    vi.advanceTimersByTime(200);
    expect(store.getState().events.map((e) => e.timestamp)).toEqual([20, 30]);
  });
});
