import { describe, expect, it } from "vitest";
import { MockLayout, panes, seqIds, type ThreadsOpenAs } from "./layout";
import { layoutCommands } from "./layoutVerbs";

/**
 * The mock's layout under the setting layout.threads_open_as (internal/layout modes.go, tested
 * in Go; docs/notes/threads-open-as-1-rules.md): thread.open replaces under panes and single,
 * opens beside on --beside and from a lead, single refuses --beside, and a conform converts.
 */
function world(mode: ThreadsOpenAs) {
  const setting = { mode };
  const layout = new MockLayout({ publish: () => undefined, ids: seqIds(), threadsOpenAs: () => setting.mode });
  layout.seed("grid");
  layout.setViewport("", 2400, 1600);
  const cmds = layoutCommands({ layout, hasThread: (id) => /^s-\d$/.test(id), createdUnder: (id, from) => id === "s-7" && from === "s-1" });
  const run = async (name: string, args: Record<string, string> = {}) => {
    const c = cmds.find((x) => x.cmd.name === name);
    if (!c) throw new Error(`no ${name}`);
    const out = await c.run(undefined, args);
    return { ...(JSON.parse(out.resultJson) as Record<string, unknown>), message: out.message };
  };
  /** Each pane holding a thread: its thread tabs' threads. */
  const threadPanes = () =>
    panes(layout.state().spaces[0]?.root)
      .map((p) => ({ id: p.id, tabs: p.tabs ?? [] }))
      .filter((p) => p.tabs.some((t) => t.kind === "thread"))
      .map((p) => ({ id: p.id, threads: p.tabs.map((t) => (t.kind === "thread" ? t.thread : t.kind)) }));
  return { layout, run, threadPanes, setting };
}

describe("threads open as", () => {
  it("tabs: a thread opens as a tab beside the others", async () => {
    const w = world("tabs");
    await w.run("thread.open", { id: "s-5", focus: "true" });
    expect(w.threadPanes()).toEqual([{ id: "p-1", threads: ["s-1", "s-5", "s-3"] }]);
  });

  it("panes: three sidebar opens leave one thread pane, showing the last", async () => {
    const w = world("tabs");
    w.setting.mode = "panes";
    w.layout.apply({ op: "conform" });
    for (const id of ["s-5", "s-6", "s-7"]) await w.run("thread.open", { id, focus: "true" });
    expect(w.threadPanes()).toEqual([{ id: "p-1", threads: ["s-7"] }]);
  });

  it("panes: --beside and --from a lead open a second thread pane; a thread that did not create it replaces", async () => {
    const w = world("panes");
    w.layout.apply({ op: "conform" });
    await w.run("thread.open", { id: "s-5", beside: "s-1", focus: "true" });
    expect(w.threadPanes().map((p) => p.threads)).toEqual([["s-1"], ["s-5"]]);
    await w.run("thread.open", { id: "s-7", from: "s-1", focus: "true" });
    expect(w.threadPanes().map((p) => p.threads)).toEqual([["s-1"], ["s-7"], ["s-5"]]);
    await w.run("thread.open", { id: "s-8", from: "s-5", focus: "true" });
    expect(w.threadPanes()).toHaveLength(3);
  });

  it("single: --beside is refused with the rule; every other open replaces", async () => {
    const w = world("single");
    w.layout.apply({ op: "conform" });
    await expect(w.run("thread.open", { id: "s-5", beside: "s-1" })).rejects.toThrow(/threads open as single/);
    await w.run("thread.open", { id: "s-7", from: "s-1", focus: "true" });
    await w.run("thread.open", { id: "s-8", split: "p-3", edge: "bottom", focus: "true" });
    expect(w.threadPanes()).toEqual([{ id: "p-1", threads: ["s-8"] }]);
  });

  it("panes: composer.new --beside opens a composer in a new pane on the thread pane's right, which keeps its thread; single refuses it", async () => {
    const w = world("panes");
    w.layout.apply({ op: "conform" });
    const r = await w.run("composer.new", { beside: "p-1", focus: "true" });
    const kinds = panes(w.layout.state().spaces[0]?.root).map((p) => (p.tabs ?? []).map((t) => (t.kind === "thread" ? t.thread : t.kind)));
    expect(kinds.slice(0, 2)).toEqual([["s-1"], ["compose"]]);
    expect(w.layout.state().spaces[0]?.focus).toBe((r as { pane?: string }).pane);
    await expect(w.run("composer.new", { beside: "p-1", pane: "p-1" })).rejects.toThrow(/place of its own/);
    w.setting.mode = "single";
    w.layout.apply({ op: "conform" });
    await expect(w.run("composer.new", { beside: "p-1" })).rejects.toThrow(/threads open as single/);
  });

  it("the preview verb counts what a switch would close, and changes nothing; the conform does it", async () => {
    const w = world("tabs");
    const rev = w.layout.rev;
    const preview = await w.run("layout.threads-open-as.preview", { to: "panes" });
    expect(preview).toMatchObject({ to: "panes", thread_tabs: 1, moved: 0, spaces: 1 });
    expect(await w.run("layout.threads-open-as.preview", { to: "tabs" })).toMatchObject({ thread_tabs: 0, message: expect.stringMatching(/changes nothing/) as unknown });
    expect(w.layout.rev).toBe(rev);
    w.setting.mode = "panes";
    const { result } = w.layout.apply({ op: "conform" });
    expect(result.conformed).toMatchObject({ thread_tabs: 1, spaces: 1 });
    expect(w.threadPanes()).toEqual([{ id: "p-1", threads: ["s-1"] }]);
  });
});
