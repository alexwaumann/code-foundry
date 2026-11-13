import { describe, expect, it } from "vitest";
import { MockLayout, panes, seqIds, type State } from "./layout";
import { layoutCommands } from "./layoutVerbs";

function world(seed = "grid") {
  const layout = new MockLayout({ publish: () => undefined, ids: seqIds() });
  layout.seed(seed);
  const cmds = layoutCommands({ layout, hasThread: (id) => /^s-\d$/.test(id) });
  const run = async (name: string, args: Record<string, string> = {}) => {
    const c = cmds.find((x) => x.cmd.name === name);
    if (!c) throw new Error(`no ${name}`);
    const out = await c.run(undefined, args);
    return JSON.parse(out.resultJson) as { rev: number; changed: boolean; tab?: string; pane?: string };
  };
  const st = (): State => layout.state();
  const focus = () => st().spaces[0]?.focus;
  const pane = (id: string) => panes(st().spaces[0]?.root).find((p) => p.id === id);
  return { layout, run, st, focus, pane };
}

describe("the mock's layout verbs", () => {
  it("answer Go's LayoutResult: the rev, whether it changed, and the op's result", async () => {
    const w = world();
    const r = await w.run("thread.open", { id: "s-5", focus: "true" });
    expect(r.changed).toBe(true);
    expect(r.rev).toBe(w.layout.rev);
    expect(w.pane(r.pane ?? "")?.active).toBe(r.tab);
    // Open already: nothing changes.
    const again = await w.run("thread.open", { id: "s-5", focus: "true" });
    expect(again).toMatchObject({ changed: false, tab: r.tab });
  });

  it("open a dropped thread at its place in one command, as Go's thread.open does", async () => {
    const w = world();
    const before = w.layout.rev;
    const strip = await w.run("thread.open", { id: "s-5", focus: "true", pane: "p-1", index: "0" });
    expect(w.pane("p-1")?.tabs?.[0]?.id).toBe(strip.tab);
    const edge = await w.run("thread.open", { id: "s-6", focus: "true", split: "p-2", edge: "bottom" });
    expect(edge.pane).not.toBe("p-2");
    expect(w.pane(edge.pane ?? "")?.tabs?.map((t) => t.id)).toEqual([edge.tab]);
    const outer = await w.run("thread.open", { id: "s-7", focus: "true", outer: "left" });
    const root = w.st().spaces[0]?.root;
    expect(root?.kids?.[0]?.tabs?.map((t) => t.id)).toEqual([outer.tab]);
    expect(w.layout.rev).toBe(before + 3);
    await expect(w.run("thread.open", { id: "s-8", split: "p-1" })).rejects.toThrow(/--split needs --edge/);
  });

  it("open an archived thread in the current space", async () => {
    const layout = new MockLayout({ publish: () => undefined, ids: seqIds() });
    layout.seed("grid");
    const cmds = layoutCommands({ layout, hasThread: () => true, isArchived: (id) => id === "s-9" });
    const run = (name: string, args: Record<string, string>) => cmds.find((x) => x.cmd.name === name)?.run(undefined, args);
    await run("space.new", { name: "Two" });
    const two = layout.state().current_space;
    expect(two).not.toBe(layout.state().default_space);
    await run("thread.open", { id: "s-9", focus: "true" });
    expect(layout.state().current_space).toBe(two);
    expect(layout.state().threads?.["s-9"]?.space).toBe(two);
  });

  it("default to the stored focus, as the user's call does", async () => {
    const w = world();
    expect(w.focus()).toBe("p-1");
    await w.run("tab.next");
    expect(w.pane("p-1")?.active).toBe("t-s3");
    await w.run("tab.previous");
    expect(w.pane("p-1")?.active).toBe("t-s1");
    // A thread's tab closes the thread, and its linked diff with it.
    await w.run("tab.close");
    expect(w.pane("p-1")?.tabs?.map((t) => t.id)).toEqual(["t-s3"]);
    expect(w.pane("p-2")?.tabs?.map((t) => t.id)).toEqual(["t-diff-s-3"]);
  });

  it("find a neighbour on the plain frame, or take the one the window resolved", async () => {
    const w = world();
    await w.run("pane.focus.right");
    expect(w.focus()).toBe("p-2");
    await w.run("pane.focus.down");
    expect(w.focus()).toBe("p-4");
    await w.run("pane.focus.left", { to: "p-1" });
    expect(w.focus()).toBe("p-1");
    const none = await w.run("pane.focus.left");
    expect(none.changed).toBe(false);
  });

  it("resize, split, swap and close panes", async () => {
    const w = world();
    await w.run("pane.resize", { split: "s-1", sizes: "0.7,0.3" });
    const root = w.st().spaces[0]?.root;
    expect(root?.sizes).toEqual([0.7, 0.3]);
    const split = await w.run("pane.split", { edge: "right" });
    expect(w.pane(split.pane ?? "")?.tabs?.map((t) => t.id)).toEqual(["t-s1"]);
    await w.run("pane.close", { pane: "p-4" });
    expect(w.pane("p-4")).toBeUndefined();
  });

  it("move a whole pane beside another, into another's strip, and onto the outer edge", async () => {
    const w = world();
    const moved = w.pane("p-4")?.tabs?.map((t) => t.id) ?? [];
    await w.run("pane.move", { pane: "p-4", beside: "p-1", edge: "left" });
    expect(panes(w.st().spaces[0]?.root).map((p) => p.id)[0]).toBe("p-4");
    const into = await w.run("pane.move", { pane: "p-4", into: "p-1", index: "0" });
    expect(into.pane).toBe("p-1");
    expect(w.pane("p-4")).toBeUndefined();
    expect(w.pane("p-1")?.tabs?.slice(0, moved.length).map((t) => t.id)).toEqual(moved);
    await w.run("pane.move", { pane: "p-2", outer: "bottom" });
    const root = w.st().spaces[0]?.root;
    expect(root).toMatchObject({ t: "split", dir: "col" });
    expect(root?.kids?.at(-1)?.id).toBe("p-2");
    await expect(w.run("pane.move", { pane: "p-2" })).rejects.toThrow(/give one of/);
    await expect(w.run("pane.move", { pane: "p-2", beside: "p-1" })).rejects.toThrow(/needs --edge/);
  });

  it("put a pane on the outer edge at its kind's size in the reported area, and split a pane in half", async () => {
    // p-2's active tab is a diff (0.45, at least 480px): with no area reported, 0.45.
    const w = world();
    await w.run("pane.move", { pane: "p-2", outer: "bottom" });
    expect(w.st().spaces[0]?.root?.sizes?.at(-1)).toBeCloseTo(0.45, 9);
    // In a 1600x1000 area, 0.45 of 1000 less a gutter is 445: raised to 480, as the rest keeps 508.
    const v = world();
    v.layout.setViewport("c-1", 1600, 1000);
    await v.run("pane.move", { pane: "p-2", outer: "bottom" });
    expect(v.st().spaces[0]?.root?.sizes?.at(-1)).toBeCloseTo(480 / 988, 9);
    // The area is the op's, not recorded as sent.
    expect(v.layout.applied.at(-1)?.op).not.toHaveProperty("w");
    // Beside a pane: half of it, whatever the kind and the area.
    await v.run("tab.move", { tab: "t-diff-s-3", split: "p-1", edge: "right" });
    const row = v.st().spaces[0]?.root?.kids?.[0];
    expect(row?.sizes?.slice(0, 2).map((x) => x / (row.sizes?.[0] ?? 1))).toEqual([1, 1]);
  });

  it("New thread opens the space's composer for what was picked", async () => {
    const w = world("empty");
    const r = await w.run("composer.new", { project: "repo-cf", focus: "true" });
    expect(w.pane(r.pane ?? "")?.tabs?.[0]).toMatchObject({ kind: "compose", params: { project: "repo-cf" } });
  });

  it("refuse what is not there", async () => {
    const w = world();
    await expect(w.run("thread.open", { id: "nope" })).rejects.toThrow(/not found/);
    await expect(w.run("pane.close", { pane: "p-zz" })).rejects.toThrow(/no pane/);
    await expect(w.run("pane.resize", { split: "s-1", sizes: "a,b" })).rejects.toThrow(/comma-separated/);
  });
});
