/**
 * Model test for the Watch side of docs/notes/thread-render-stall.md: a daemon thread log
 * (the Go threadLog's rules: one seq per event, deltas only for known items, an append of
 * a known id is an update) emits events; they reach the store in random batches, with
 * resync snapshots (the Watch handler's answer to dropped events) and reconnects mixed
 * in. Whatever the batching, the store must end equal to the daemon's snapshot.
 */
import { describe, expect, it } from "vitest";
import type { ThreadEventView, ThreadItemView } from "@/api/thread";
import { applyThreadEvents, type ThreadLog } from "./thread";

/** A tiny deterministic PRNG (mulberry32) so a failing seed can be replayed. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The daemon's threadLog, reduced to what the Watch carries. */
class DaemonLog {
  seq = 0;
  items: ThreadItemView[] = [];
  private nextOrd = 1;

  snapshot(): ThreadEventView {
    return { kind: "snapshot", sessionId: "s", seq: this.seq, items: this.items.map((it) => ({ ...it })), pending: [], mcp: null, commands: [] };
  }

  append(id: string, streaming: boolean): ThreadEventView {
    const i = this.items.findIndex((it) => it.id === id);
    this.seq++;
    if (i >= 0) {
      const it = { ...(this.items[i] as ThreadItemView), streaming };
      this.items[i] = it;
      return { kind: "updated", sessionId: "s", seq: this.seq, item: { ...it } };
    }
    const it: ThreadItemView = { id, kind: "text", text: "", ordinal: this.nextOrd++, parentToolUseId: "", createdAtMs: null, updatedAtMs: null, streaming };
    this.items.push(it);
    return { kind: "appended", sessionId: "s", seq: this.seq, item: { ...it } };
  }

  delta(id: string, text: string): ThreadEventView | null {
    const i = this.items.findIndex((it) => it.id === id);
    if (i < 0) return null; // the Go delta() publishes nothing for an unknown item
    const it = this.items[i] as Extract<ThreadItemView, { kind: "text" }>;
    this.items[i] = { ...it, text: it.text + text };
    this.seq++;
    return { kind: "delta", sessionId: "s", seq: this.seq, itemId: id, ordinal: it.ordinal, field: "text", text };
  }

  finish(id: string): ThreadEventView | null {
    const i = this.items.findIndex((it) => it.id === id);
    if (i < 0) return null;
    this.items[i] = { ...(this.items[i] as ThreadItemView), streaming: false };
    this.seq++;
    return { kind: "updated", sessionId: "s", seq: this.seq, item: { ...(this.items[i]) } };
  }
}

function view(log: ThreadLog | undefined): { seq: number; items: ThreadItemView[] } {
  return { seq: log?.seq ?? -1, items: log ? log.order.map((id) => log.byId[id] as ThreadItemView) : [] };
}

describe("Watch events applied in any batching converge on the daemon's log", () => {
  it.each(Array.from({ length: 200 }, (_, i) => i + 1))("seed %i", (seed) => {
    const r = rng(seed);
    const d = new DaemonLog();
    // The Watch: a snapshot, then events; the store receives them in batches.
    let wire: ThreadEventView[] = [d.snapshot()];
    let store: ThreadLog | undefined;
    let n = 0;
    for (let step = 0; step < 400; step++) {
      const x = r();
      const id = `m${String(Math.floor(r() * (n + 1)))}`;
      let ev: ThreadEventView | null = null;
      if (x < 0.15) ev = d.append(`m${String(n++)}`, true);
      else if (x < 0.7) ev = d.delta(id, String.fromCharCode(97 + Math.floor(r() * 26)));
      else if (x < 0.8) ev = d.finish(id);
      else if (x < 0.83) ev = d.append(id, false);
      else if (x < 0.86) {
        // Dropped events: the handler resends the snapshot (later events follow it).
        wire.push(d.snapshot());
      } else if (x < 0.88) {
        // A reconnect: queued events of the old stream may still be flushed, then the new
        // stream's snapshot.
        wire.push(d.snapshot());
      }
      if (ev) wire.push(ev);
      if (r() < 0.3) {
        const cut = Math.floor(r() * (wire.length + 1));
        store = applyThreadEvents(store, wire.slice(0, cut));
        wire = wire.slice(cut);
      }
    }
    store = applyThreadEvents(store, wire);
    const want = d.snapshot();
    expect(view(store)).toEqual({ seq: d.seq, items: want.kind === "snapshot" ? want.items : [] });
  });
});
