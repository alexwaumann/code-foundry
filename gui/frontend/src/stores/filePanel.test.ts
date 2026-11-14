import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectView } from "@/api/project";
import { COMMITTED_HEAD, DEFAULT_BASE, DEFAULT_HEAD, type DiffTarget } from "@/surfaces/diffTarget";

vi.mock("@/api/layout", async (orig) => (await import("@/test/fakeLayout")).fakeLayoutApi(await orig()));

const { layoutSettled, resetFakeLayout, threadSeed } = await import("@/test/fakeLayout");
const { shownTab, tabPlace } = await import("@/shell/host");
const { useLayoutStore } = await import("./layout");
const { lastTabOf, openCheckoutDiff, openDiffInPanel, openFileInPanel, openLooseFile } = await import("./filePanel");
const { useProjectsStore } = await import("./projects");
const { HOME, useUiStore } = await import("./ui");

/** Diff tabs, one per checkout (docs/notes/diff-viewer-2.md), and File tabs beside them. */

const W = "/Users/dev/src/code-foundry";
const KEY = "thread:s-1";

beforeEach(async () => {
  await resetFakeLayout(threadSeed("s-1"));
  useUiStore.setState({ selection: { kind: "thread", id: "s-1" } });
});

const target = (o: Partial<DiffTarget> = {}): DiffTarget => ({ project: "repo-cf", worktree: W, base: DEFAULT_BASE, head: DEFAULT_HEAD, file: "", oldPath: "", own: true, ...o });

describe("openDiffInPanel", () => {
  it("one tab per checkout: another file or other sources are the same tab", async () => {
    openDiffInPanel("current", target({ file: "README.md" }));
    openDiffInPanel("current", target({ file: "notes/plan.md", head: COMMITTED_HEAD }));
    openDiffInPanel("current", target({ worktree: "/other" }));
    await layoutSettled();
    const p = tabPlace(KEY);
    expect(p.tabs.map((t) => [t.params.worktree, t.params.path ?? "", t.params.head ?? ""])).toEqual([
      [W, "notes/plan.md", "ref:HEAD"],
      ["/other", "", ""],
    ]);
    expect(p.shown).toBe(true);
  });
});

describe("openCheckoutDiff", () => {
  it("opens the checkout's tab and shows it with the focus: the user asked for it", async () => {
    expect(openCheckoutDiff("current", "repo-cf", W, true)).toBe(true);
    await layoutSettled();
    const p = tabPlace(KEY);
    expect(p.shown).toBe(true);
    expect(p.tabs.map((t) => t.params)).toEqual([{ project: "repo-cf", worktree: W, own: "1" }]);
    const s = useLayoutStore.getState();
    const shown = s.tabs[s.panes[s.spaces[s.currentSpaceId]?.focus ?? ""]?.active ?? ""];
    expect(shown?.kind).toBe("diff");
    expect(shown?.params).toEqual({ project: "repo-cf", worktree: W, own: "1" });
  });

  it("an open tab keeps what it compares and shows: coming back is not a reset", async () => {
    openDiffInPanel("current", target({ file: "a.ts", base: { kind: "ref", ref: "v1" } }), "feat vs v1");
    openFileInPanel("current", { project: "repo-cf", base: W, path: "README.md" });
    await layoutSettled();
    openCheckoutDiff("current", "repo-cf", W, true);
    await layoutSettled();
    const p = tabPlace(KEY);
    const tab = p.tabs.find((t) => t.kind === "diff");
    expect(tab?.params).toMatchObject({ path: "a.ts", base: "ref:v1" });
    expect(tab?.title).toBe("feat vs v1");
    expect(shownTab(p)?.id).toBe(tab?.id);
  });
});

describe("lastTabOf", () => {
  it("the letters bring back a panel's last tab of a kind", async () => {
    expect(lastTabOf("diff", KEY)).toBeNull();
    openDiffInPanel("current", target({ file: "README.md" }));
    openFileInPanel("current", { project: "repo-cf", base: W, path: "README.md" });
    await layoutSettled();
    expect(lastTabOf("diff", KEY)?.params.path).toBe("README.md");
    expect(lastTabOf("files", KEY)?.params.path).toBe(`${W}/README.md`);
  });
});

describe("openLooseFile", () => {
  const DIR = "/Users/dev/.claude/skills/pr-review";
  const shown = (key: string) => {
    const p = tabPlace(key);
    return { open: p.shown, tab: (shownTab(p) ?? p.tabs[p.tabs.length - 1])?.params };
  };

  it.each([
    ["a thread", { kind: "thread", id: "s-1" }, "thread:s-1"],
    ["the home composer", HOME, "compose:home:"],
    ["a project's composer", { kind: "compose", projectId: "p-1" }, "compose:p-1"],
    ["the Pull Requests page", { kind: "view", name: "pullrequests" }, "view:pullrequests"],
    ["a project's page", { kind: "view", name: "projects", projectId: "p-1" }, "view:projects:project:p-1"],
  ] as const)("opens in %s's tabs, as nobody's file", async (_name, selection, key) => {
    useUiStore.setState({ selection });
    expect(openLooseFile(DIR, "SKILL.md")).toBe(true);
    await layoutSettled();
    expect(shown(key)).toMatchObject({ open: true, tab: { project: "", base: DIR, path: `${DIR}/SKILL.md` } });
  });

  it("with nothing that has tabs selected, the home composer takes it", async () => {
    useUiStore.setState({ selection: { kind: "none" } });
    expect(openLooseFile(DIR, "SKILL.md")).toBe(true);
    await layoutSettled();
    expect(useUiStore.getState().selection).toEqual(HOME);
    expect(shown("compose:home:")).toMatchObject({ open: true, tab: { path: `${DIR}/SKILL.md` } });
  });
});

describe("openCheckoutDiff's title", () => {
  it("another project's checkout is named at once; the thread's own needs no name", async () => {
    useProjectsStore.setState({ byId: { web: { id: "web", name: "web-app" } as ProjectView }, order: ["web"] });
    openCheckoutDiff("current", "web", "/w/web");
    openCheckoutDiff("current", "repo-cf", W, true);
    await layoutSettled();
    expect(tabPlace(KEY).tabs.map((t) => t.title)).toEqual(["Diff · web-app", "Diff"]);
  });
});
