import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectView } from "@/api/project";
import { COMMITTED_HEAD, DEFAULT_BASE, DEFAULT_HEAD, type DiffTarget } from "@/surfaces/diffTarget";
import { lastTabOf, openCheckoutDiff, openDiffInPanel, openFileInPanel, openLooseFile } from "./filePanel";
import { usePanelStore } from "./panel";
import { useProjectsStore } from "./projects";
import { HOME, useUiStore } from "./ui";

/** Diff tabs, one per checkout (docs/notes/diff-viewer-2.md), and File tabs beside them. */

const W = "/Users/dev/src/code-foundry";
const KEY = "thread:s-1";

beforeEach(() => {
  useUiStore.setState({ selection: { kind: "thread", id: "s-1" } });
  usePanelStore.setState({ byKey: {} });
});

const target = (o: Partial<DiffTarget> = {}): DiffTarget => ({ project: "repo-cf", worktree: W, base: DEFAULT_BASE, head: DEFAULT_HEAD, file: "", oldPath: "", own: true, ...o });

describe("openDiffInPanel", () => {
  it("one tab per checkout: another file or other sources are the same tab", () => {
    openDiffInPanel("current", target({ file: "README.md" }));
    openDiffInPanel("current", target({ file: "notes/plan.md", head: COMMITTED_HEAD }));
    openDiffInPanel("current", target({ worktree: "/other" }));
    const tabs = usePanelStore.getState().byKey[KEY]?.groups[0]?.tabs ?? [];
    expect(tabs.map((t) => [t.params.worktree, t.params.path ?? "", t.params.head ?? ""])).toEqual([
      [W, "notes/plan.md", "ref:HEAD"],
      ["/other", "", ""],
    ]);
    expect(usePanelStore.getState().byKey[KEY]?.open).toBe(true);
  });
});

describe("openCheckoutDiff", () => {
  it("opens the checkout's tab and shows the panel without taking focus", () => {
    const seq = useUiStore.getState().panelFocusSeq;
    expect(openCheckoutDiff("current", "repo-cf", W, true)).toBe(true);
    const e = usePanelStore.getState().byKey[KEY];
    expect(e?.open).toBe(true);
    expect(e?.groups[0]?.tabs.map((t) => t.params)).toEqual([{ project: "repo-cf", worktree: W, own: "1" }]);
    expect(useUiStore.getState().panelFocusSeq).toBe(seq);
  });

  it("an open tab keeps what it compares and shows: coming back is not a reset", () => {
    openDiffInPanel("current", target({ file: "a.ts", base: { kind: "ref", ref: "v1" } }), "feat vs v1");
    openFileInPanel("current", { project: "repo-cf", base: W, path: "README.md" });
    openCheckoutDiff("current", "repo-cf", W, true);
    const e = usePanelStore.getState().byKey[KEY];
    const tab = e?.groups[0]?.tabs.find((t) => t.kind === "diff");
    expect(tab?.params).toMatchObject({ path: "a.ts", base: "ref:v1" });
    expect(tab?.title).toBe("feat vs v1");
    expect(e?.groups[0]?.activeTabId).toBe(tab?.id);
  });
});

describe("lastTabOf", () => {
  it("the letters bring back a panel's last tab of a kind", () => {
    expect(lastTabOf("diff", KEY)).toBeNull();
    openDiffInPanel("current", target({ file: "README.md" }));
    openFileInPanel("current", { project: "repo-cf", base: W, path: "README.md" });
    expect(lastTabOf("diff", KEY)?.params.path).toBe("README.md");
    expect(lastTabOf("files", KEY)?.params.path).toBe(`${W}/README.md`);
  });
});

describe("openLooseFile", () => {
  const DIR = "/Users/dev/.claude/skills/pr-review";
  const shown = (key: string) => {
    const e = usePanelStore.getState().byKey[key];
    const g = e?.groups[0];
    return { open: e?.open, expanded: e?.expanded, tab: g?.tabs.find((t) => t.id === g.activeTabId)?.params };
  };

  it.each([
    ["a thread", { kind: "thread", id: "s-1" }, "thread:s-1"],
    ["the home composer", HOME, "compose:home:"],
    ["a project's composer", { kind: "compose", projectId: "p-1" }, "compose:p-1"],
    ["the Pull Requests page", { kind: "view", name: "pullrequests" }, "view:pullrequests"],
    ["a project's page", { kind: "view", name: "projects", projectId: "p-1" }, "view:projects:project:p-1"],
  ] as const)("opens in %s's panel, as nobody's file", (_name, selection, key) => {
    useUiStore.setState({ selection, windowWidth: 1600 });
    expect(openLooseFile(DIR, "SKILL.md")).toBe(true);
    expect(shown(key)).toMatchObject({ open: true, tab: { project: "", base: DIR, path: `${DIR}/SKILL.md` } });
    expect(shown(key).expanded).toBeUndefined();
  });

  it("with nothing that has a panel selected, the home composer takes it", () => {
    useUiStore.setState({ selection: { kind: "none" }, windowWidth: 1600 });
    expect(openLooseFile(DIR, "SKILL.md")).toBe(true);
    expect(useUiStore.getState().selection).toEqual(HOME);
    expect(shown("compose:home:")).toMatchObject({ open: true, tab: { path: `${DIR}/SKILL.md` } });
  });

  it("a window too narrow for a panel beside the content gets it expanded, so it shows", () => {
    useUiStore.setState({ selection: { kind: "thread", id: "s-1" }, windowWidth: 700 });
    expect(openLooseFile(DIR, "SKILL.md")).toBe(true);
    expect(shown(KEY)).toMatchObject({ open: true, expanded: true });
  });
});

describe("openCheckoutDiff's title", () => {
  it("another project's checkout is named at once; the thread's own needs no name", () => {
    useProjectsStore.setState({ byId: { web: { id: "web", name: "web-app" } as ProjectView }, order: ["web"] });
    openCheckoutDiff("current", "web", "/w/web");
    openCheckoutDiff("current", "repo-cf", W, true);
    expect(usePanelStore.getState().byKey[KEY]?.groups[0]?.tabs.map((t) => t.title)).toEqual(["Diff · web-app", "Diff"]);
  });
});
