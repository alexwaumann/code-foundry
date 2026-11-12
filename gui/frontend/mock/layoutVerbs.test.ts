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
