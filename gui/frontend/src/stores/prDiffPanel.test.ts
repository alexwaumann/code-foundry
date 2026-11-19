import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab as FakeTab } from "../../mock/layout";
import type { FakeLayoutState } from "@/test/fakeLayout";

vi.mock("@/api/layout", async (orig) => (await import("@/test/fakeLayout")).fakeLayoutApi(await orig()));

const { applyLayoutOp } = await import("@/api/layout");
const { layoutSettled, resetFakeLayout, threadSeed } = await import("@/test/fakeLayout");
const { useUiStore } = await import("./ui");
const { setTabParams, tabPlace } = await import("@/shell/host");
const { useLayoutStore } = await import("./layout");
const { openPullRequestInPanel } = await import("./prPanel");
const { openPullRequestDiff } = await import("./prDiffPanel");

const TARGET = "thread:a";
const place = () => tabPlace(TARGET);
const diffTabs = () => place().tabs.filter((t) => t.kind === "prdiff");
const groupOf = (id: string) => place().groups.findIndex((g) => g.tabs.some((t) => t.id === id));
const prTab = (n: number) => place().tabs.find((t) => t.kind === "pullrequest" && t.params.number === String(n));

async function run(f: () => void): Promise<void> {
  f();
  await layoutSettled();
}

beforeEach(async () => {
  useUiStore.setState({ selection: { kind: "thread", id: "a" } });
  await resetFakeLayout(threadSeed("a"));
});

describe("openPullRequestDiff", () => {
  it("opens the diff right after the pull request's tab, in its pane, titled Diff #N, wherever the focus is", async () => {
    await run(() => openPullRequestInPanel({ slug: "acme/repo", number: 5 }, TARGET));
    const pr = prTab(5);
    expect(pr).toBeDefined();
    // The thread's pane has the focus: the diff still goes where its pull request is.
    const s = useLayoutStore.getState();
    const thread = Object.values(s.tabs).find((t) => t.kind === "thread");
    await applyLayoutOp({ op: "focus_tab", tab: thread?.id ?? "" });
    await layoutSettled();
    const now = useLayoutStore.getState();
    expect(now.spaces[now.currentSpaceId]?.focus).toBe(thread?.paneId);
    expect(thread?.paneId).not.toBe(now.tabs[pr?.id ?? ""]?.paneId);
    await run(() => openPullRequestDiff({ slug: "acme/repo", number: 5 }, TARGET));
    const [diff] = diffTabs();
    expect(diff?.title).toBe("Diff #5");
    expect(diff?.params).toEqual({ slug: "acme/repo", number: "5" });
    const g = groupOf(pr?.id ?? "");
    expect(groupOf(diff?.id ?? "")).toBe(g);
    const strip = place().groups[g]?.tabs.map((t) => t.id) ?? [];
    expect(strip.indexOf(diff?.id ?? "")).toBe(strip.indexOf(pr?.id ?? "") + 1);
    expect(place().groups[g]?.active?.id).toBe(diff?.id);
  });

  it("opened again, however the slug is spelled, selects the one tab, keeping the file it shows", async () => {
    await run(() => openPullRequestInPanel({ slug: "Acme/Repo", number: 5 }, TARGET));
    await run(() => openPullRequestDiff({ slug: "Acme/Repo", number: 5 }, TARGET));
    const id = diffTabs()[0]?.id ?? "";
    await run(() => {
      setTabParams(TARGET, id, (p) => ({ ...p, path: "src/b.ts" }));
    });
    // The user goes back to the pull request's tab, then asks for its diff again.
    const pr = prTab(5)?.id ?? "";
    await applyLayoutOp({ op: "focus_tab", tab: pr });
    await layoutSettled();
    expect(place().groups[groupOf(pr)]?.active?.id).toBe(pr);
    await run(() => openPullRequestDiff({ slug: "acme/repo", number: 5 }, TARGET));
    expect(diffTabs()).toHaveLength(1);
    expect(diffTabs()[0]?.params).toEqual({ slug: "Acme/Repo", number: "5", path: "src/b.ts" });
    expect(place().groups[groupOf(id)]?.active?.id).toBe(id);
  });

  it("finds its tab in another pane and selects it there, opening none", async () => {
    await run(() => openPullRequestInPanel({ slug: "acme/repo", number: 5 }, TARGET));
    await run(() => openPullRequestDiff({ slug: "acme/repo", number: 5 }, TARGET));
    const id = diffTabs()[0]?.id ?? "";
    const pane = useLayoutStore.getState().tabs[id]?.paneId ?? "";
    await applyLayoutOp({ op: "move_tab", tab: id, pane, edge: "bottom" });
    await layoutSettled();
    const moved = groupOf(id);
    expect(moved).not.toBe(groupOf(prTab(5)?.id ?? ""));
    await applyLayoutOp({ op: "focus_tab", tab: prTab(5)?.id ?? "" });
    await layoutSettled();
    await run(() => openPullRequestDiff({ slug: "acme/repo", number: 5 }, TARGET));
    expect(diffTabs()).toHaveLength(1);
    expect(groupOf(id)).toBe(moved);
    expect(place().focused).toBe(moved);
  });

  it("from the Pull Requests page, goes to the pull request's pane, not the focused page's", async () => {
    useUiStore.setState({ selection: { kind: "view", name: "pullrequests" } });
    const pane = (id: string, tabs: FakeTab[]) => ({ t: "pane" as const, id, tabs, active: tabs[0]?.id ?? "" });
    await resetFakeLayout({
      v: 1,
      spaces: [
        {
          id: "sp-main",
          name: "Main",
          root: { t: "split" as const, id: "s-r", dir: "row" as const, kids: [pane("p-1", [{ id: "t-prs", kind: "prs", title: "Pull Requests" }]), pane("p-pr", [{ id: "t-pr", kind: "pullrequest", title: "#5", params: { slug: "acme/repo", number: "5" } }])], sizes: [0.55, 0.45] },
          focus: "p-1",
          mru: ["t-prs", "t-pr"],
        },
      ],
      current_space: "sp-main",
      default_space: "sp-main",
    } satisfies FakeLayoutState);
    await run(() => openPullRequestDiff({ slug: "acme/repo", number: 5 }));
    const s = useLayoutStore.getState();
    const diff = Object.values(s.tabs).find((t) => t.kind === "prdiff");
    expect(diff?.paneId).toBe("p-pr");
    expect(s.panes["p-pr"]?.tabIds).toEqual(["t-pr", diff?.id]);
  });

  it("each pull request has its own diff tab", async () => {
    await run(() => openPullRequestInPanel({ slug: "acme/repo", number: 5 }, TARGET));
    await run(() => openPullRequestDiff({ slug: "acme/repo", number: 5 }, TARGET));
    await run(() => openPullRequestDiff({ slug: "acme/repo", number: 6 }, TARGET));
    expect(diffTabs().map((t) => t.title).sort()).toEqual(["Diff #5", "Diff #6"]);
  });
});
