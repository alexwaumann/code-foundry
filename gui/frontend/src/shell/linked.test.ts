import { describe, expect, it } from "vitest";
import type { LayoutState, PaneEntry, TabEntry } from "@/stores/layout";
import type { TerminalView } from "@/api/terminal";
import { closeThreadAction, diffKey, linkedRowOf, moveToSpaceAction, newTerminalAction, plusAction, prKey, rowAction, showTerminalAction, spaceChoices, spaceTabs, surfaceAction, tabbedTerminalIds, threadSurfaces, untabbedTerminals } from "./linked";

const t = (id: string, kind: string, thread: string, key: string, paneId: string): TabEntry => ({ id, kind, thread, key, params: {}, title: "", name: "", paneId });

const one = [{ projectId: "pj-a", path: "/w/a", name: "api" }];
const two = [...one, { projectId: "pj-b", path: "/w/b", name: "web" }];

describe("threadSurfaces", () => {
  it("lists one Diff for one checkout, the pull requests in the order given, and the thread's terminal tabs", () => {
    const tabs = [t("t-x", "terminal", "s-1", "term:x", "p-1"), t("t-y", "terminal", "s-2", "term:y", "p-1")];
    const s = threadSurfaces("s-1", one, [{ slug: "Org/Repo", number: 7 }, { slug: "org/repo", number: 3 }], tabs);
    expect(s.diffs.map((d) => [d.label, d.key, d.openTab])).toEqual([["Diff", diffKey("s-1", "pj-a", "/w/a"), ""]]);
    expect(s.prs.map((p) => [p.label, p.key])).toEqual([
      ["PR #7", "pr:org/repo#7"],
      ["PR #3", "pr:org/repo#3"],
    ]);
    expect(s.terminals.map((x) => x.openTab)).toEqual(["t-x"]);
  });

  it("names a diff per checkout by its project when there are several, skipping one with no path, and drops a repeated pull request", () => {
    const s = threadSurfaces("s-1", [...two, { projectId: "pj-c", path: "", name: "docs" }], [{ slug: "o/r", number: 2 }, { slug: "O/R", number: 2 }], []);
    expect(s.diffs.map((d) => d.label)).toEqual(["Diff · api", "Diff · web"]);
    expect(s.prs).toHaveLength(1);
    expect(s.terminals).toEqual([]);
  });

  it("marks an item open with the tab that has its identity in the space", () => {
    const tabs = [t("t-d", "diff", "s-1", diffKey("s-1", "pj-b", "/w/b"), "p-2"), t("t-pr", "pullrequest", "s-1", prKey("o/r", 4), "p-2")];
    const s = threadSurfaces("s-1", two, [{ slug: "o/r", number: 4 }, { slug: "o/r", number: 5 }], tabs);
    expect(s.diffs.map((d) => d.openTab)).toEqual(["", "t-d"]);
    expect(s.prs.map((p) => p.openTab)).toEqual(["t-pr", ""]);
  });
});

describe("the actions", () => {
  const [diffA, diffB] = threadSurfaces("s-1", two, [], []).diffs;
  const [pr] = threadSurfaces("s-1", one, [{ slug: "o/r", number: 9 }], []).prs;
  const [diffOne] = threadSurfaces("s-1", one, [], []).diffs;

  it("open a closed surface with its view.open verb, in the pane when the + menu asks, else by the rules", () => {
    if (!diffA || !diffB || !pr || !diffOne) throw new Error("fixtures");
    expect(surfaceAction("s-1", diffOne)).toEqual({ run: "view.open.diff", args: { thread: "s-1" } });
    expect(surfaceAction("s-1", diffB, "p-3")).toEqual({ run: "view.open.diff", args: { thread: "s-1", path: "/w/b", pane: "p-3" } });
    expect(surfaceAction("s-1", diffA)).toEqual({ run: "view.open.diff", args: { thread: "s-1", path: "/w/a" } });
    expect(surfaceAction("s-1", pr, "p-3")).toEqual({ run: "view.open.pr", args: { number: "9", thread: "s-1", pane: "p-3" } });
  });

  it("focus an open surface where it is, even from the + menu", () => {
    const [open] = threadSurfaces("s-1", one, [], [t("t-d", "diff", "s-1", diffKey("s-1", "pj-a", "/w/a"), "p-2")]).diffs;
    if (!open) throw new Error("fixture");
    expect(surfaceAction("s-1", open, "p-1")).toEqual({ focus: "t-d" });
    const [term] = threadSurfaces("s-1", [], [], [t("t-x", "terminal", "s-1", "term:x", "p-1")]).terminals;
    if (!term) throw new Error("fixture");
    expect(surfaceAction("s-1", term, "p-2")).toEqual({ focus: "t-x" });
  });

  it("start a thread's terminal (cmd+t's) or a free one (cmd+shift+t's); the + menu's general items open in its pane", () => {
    expect(newTerminalAction("s-1")).toEqual({ terminal: "new", thread: "s-1", pane: "" });
    expect(newTerminalAction("s-1", "p-2")).toEqual({ terminal: "new", thread: "s-1", pane: "p-2" });
    expect(plusAction("new-thread", "p-2")).toEqual({ run: "composer.new", args: { pane: "p-2" } });
    expect(plusAction("terminal", "p-2")).toEqual({ terminal: "new", thread: "", pane: "p-2" });
    expect(showTerminalAction("t-9", "p-2")).toEqual({ terminal: "show", id: "t-9", pane: "p-2" });
    expect(plusAction("prs", "p-2")).toEqual({ run: "view.pullrequests", args: { pane: "p-2" } });
    expect(plusAction("projects", "p-2")).toEqual({ run: "view.projects", args: { pane: "p-2" } });
    expect(moveToSpaceAction("s-1", "sp-b")).toEqual({ run: "thread.space.move", args: { id: "s-1", space: "sp-b" } });
    expect(closeThreadAction("s-1")).toEqual({ run: "thread.close", args: { id: "s-1" } });
  });
});

type Slice = Pick<LayoutState, "panes" | "tabs" | "threads" | "defaultSpaceId" | "spaceOrder" | "spaces">;

function slice(tabs: TabEntry[], threads: Slice["threads"] = {}): Slice {
  const panes: Record<string, PaneEntry> = {};
  for (const tb of tabs) {
    const p = panes[tb.paneId] ?? { id: tb.paneId, spaceId: tb.paneId.startsWith("q") ? "sp-b" : "sp-a", tabIds: [], active: tb.id };
    panes[tb.paneId] = { ...p, tabIds: [...p.tabIds, tb.id] };
  }
  return {
    panes,
    tabs: Object.fromEntries(tabs.map((x) => [x.id, x])),
    threads,
    defaultSpaceId: "sp-a",
    spaceOrder: ["sp-a", "sp-b"],
    spaces: { "sp-a": { id: "sp-a", name: "Main", focus: "", mru: [], drafts: [] }, "sp-b": { id: "sp-b", name: "Review", focus: "", mru: [], drafts: [] } },
  };
}

describe("the row under a linked tab", () => {
  const diff = t("t-d", "diff", "s-1", "k", "p-2");

  it("is live while the thread's tab is open in the tab's space, and links to it", () => {
    const s = slice([t("t-th", "thread", "s-1", "thread:s-1", "p-1"), diff]);
    const row = linkedRowOf(s, diff);
    expect(row).toEqual({ thread: "s-1", threadTab: "t-th", live: true, elsewhere: "" });
    if (!row) throw new Error("row");
    expect(rowAction(row, "p-2")).toEqual({ focus: "t-th" });
  });

  it("is dormant when the thread is not open here; its link opens the thread in this pane", () => {
    const s = slice([t("t-th", "thread", "s-1", "thread:s-1", "q-1"), diff]);
    const row = linkedRowOf(s, diff);
    expect(row).toEqual({ thread: "s-1", threadTab: "", live: false, elsewhere: "" });
    if (!row) throw new Error("row");
    expect(rowAction(row, "p-2")).toEqual({ run: "thread.open", args: { id: "s-1", pane: "p-2", focus: "true" } });
  });

  it("names the space of a thread that lives in another, and takes the window there", () => {
    const s = slice([diff], { "s-1": { threadId: "s-1", spaceId: "sp-b", quick: null, remembered: [], rememberedPaneId: "", info: null } });
    const row = linkedRowOf(s, diff);
    expect(row).toMatchObject({ live: false, elsewhere: "sp-b" });
    if (!row) throw new Error("row");
    // The window switches to the thread's space, where its tab opens or is focused.
    expect(rowAction(row, "p-2")).toEqual({ run: "thread.open", args: { id: "s-1", focus: "true" } });
  });

  it("is not drawn for a thread's own tab or an unlinked one", () => {
    const s = slice([t("t-th", "thread", "s-1", "thread:s-1", "p-1"), t("t-prs", "prs", "", "prs", "p-1")]);
    expect(linkedRowOf(s, t("t-th", "thread", "s-1", "", "p-1"))).toBeNull();
    expect(linkedRowOf(s, t("t-prs", "prs", "", "", "p-1"))).toBeNull();
  });
});

describe("spaceTabs and spaceChoices", () => {
  it("list a space's tabs, and the spaces with the thread's own marked here", () => {
    const s = slice([t("t-1", "thread", "s-1", "", "p-1"), t("t-2", "prs", "", "", "q-1")]);
    expect(spaceTabs(s, "sp-a").map((x) => x.id)).toEqual(["t-1"]);
    expect(spaceChoices(s, "s-1")).toEqual([
      { id: "sp-a", name: "Main", here: true },
      { id: "sp-b", name: "Review", here: false },
    ]);
  });
});

describe("untabbedTerminals", () => {
  const term = (id: string, labels: Record<string, string>, state: TerminalView["state"] = "running"): TerminalView => ({
    id,
    argv: ["/bin/zsh"],
    cwd: "/w",
    cols: 80,
    rows: 24,
    title: "",
    state,
    exitCode: 0,
    startedAtMs: null,
    exitedAtMs: null,
    altScreen: false,
    labels,
    liveCwd: "",
    foreground: "",
    lastCommand: "",
  });
  const all = [
    term("t-proj", { kind: "shell", project: "pj", worktree: "/w" }),
    term("t-free", { kind: "shell" }),
    term("t-act", { kind: "action", project: "pj", worktree: "/w", action: "dev" }),
    term("t-tabbed", { kind: "shell" }),
    term("t-thread", { kind: "shell", thread: "s-1" }),
    term("t-quick", { kind: "shell", thread: "s-1", slot: "quick" }),
    term("t-gone", { kind: "shell" }, "exited"),
    term("t-plugin", { kind: "plugin", plugin: "p" }),
  ];
  const byId = Object.fromEntries(all.map((x) => [x.id, x]));

  it("lists running terminals of no thread that no tab shows, in order; never a thread's, an exited one or a plugin's", () => {
    const tabs = { "t-x": t("t-x", "terminal", "", "term:t-tabbed", "p-1") };
    tabs["t-x"].params = { terminal: "t-tabbed" };
    expect(tabbedTerminalIds(tabs)).toEqual(["t-tabbed"]);
    expect(untabbedTerminals(byId, all.map((x) => x.id), tabbedTerminalIds(tabs)).map((x) => x.id)).toEqual(["t-proj", "t-free", "t-act"]);
  });
});
