import { describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import { applyThreadListEvent, attentionIds, emptyThreads, isOwned, replaceThreads, runningCount } from "./threads";

function thread(id: string, over: Partial<ThreadView> = {}): ThreadView {
  return { id, createdAtMs: 10, status: "idle", state: "connected", archivedAtMs: null, snoozedUntilMs: null, flags: [], usage: [], ...over } as ThreadView;
}

// docs/notes/plugins-6-thread-terminal.md: a plugin's own threads stay in byId (its thread
// node shows them) but out of `order`, which every list of the user's threads reads.
describe("owned threads", () => {
  const mine = thread("s-mine", { createdAtMs: 1 });
  const plugin = thread("s-plugin", { createdAtMs: 2, owner: "plugin:hello", status: "attention", flags: [{ plugin: "hello", pluginName: "Hello", level: "error", reason: "x", setAtMs: 1, untilSeen: false }] });
  const busy = thread("s-busy", { createdAtMs: 3, owner: "plugin:hello", status: "busy" });

  it("keeps them out of order, in owned, and out of the attention and running counts", () => {
    const d = replaceThreads(emptyThreads, [plugin, mine, busy]);
    expect(Object.keys(d.byId).sort()).toEqual(["s-busy", "s-mine", "s-plugin"]);
    expect(d.order).toEqual(["s-mine"]);
    expect(d.owned).toEqual(["s-plugin", "s-busy"]);
    expect(attentionIds(d)).toEqual([]);
    expect(runningCount(d)).toBe(0);
    expect(isOwned(plugin)).toBe(true);
    expect(isOwned(mine)).toBe(false);
  });

  // docs/notes/ember-1-primitives.md: a resident thread is kept out of every user list too.
  it("keeps a resident thread out of order, attention and running counts", () => {
    const ember = thread("s-ember", { createdAtMs: 4, resident: "ember", epoch: 2, status: "attention" });
    const working = thread("s-ember-busy", { createdAtMs: 5, resident: "scout", status: "busy" });
    const d = replaceThreads(emptyThreads, [mine, ember, working]);
    expect(d.order).toEqual(["s-mine"]);
    expect(d.owned).toEqual(["s-ember", "s-ember-busy"]);
    expect(attentionIds(d)).toEqual([]);
    expect(runningCount(d)).toBe(0);
    expect(isOwned(ember)).toBe(true);
  });

  it("follows updates and removals; the owned list is always set (the store merges results)", () => {
    let d = replaceThreads(emptyThreads, [mine]);
    expect(d.owned).toEqual([]);
    d = applyThreadListEvent(d, { kind: "updated", thread: plugin });
    expect(d.order).toEqual(["s-mine"]);
    expect(d.owned).toEqual(["s-plugin"]);
    const same = applyThreadListEvent(d, { kind: "updated", thread: { ...mine, name: "renamed" } });
    expect(same.owned).toBe(d.owned);
    d = applyThreadListEvent(d, { kind: "removed", id: "s-plugin" });
    expect(d.owned).toEqual([]);
    expect(d.order).toEqual(["s-mine"]);
  });
});
