import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Toaster, toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { card } from "@/test/cardFakes";
import { invocationsOf, resetDaemon } from "@/test/daemonFakes";
import { HOME, pullRequest, texts } from "@/test/projectsWorld";
import { activePanelTab, bucket, mcpServer, resetCard, seedChild, seedNoGit, seedServers, seedSingle, seedWs9, setLog, TREE, updateThread } from "@/test/threadInfoWorld";
import { layoutSettled, resetFakeLayout, threadSeed } from "@/test/fakeLayout";
import { tooltipText } from "@/test/tooltip";
import type { DashboardView } from "@/api/gh";
import type { McpServerView } from "@/api/mcp";
import { useActionDialogStore } from "@/stores/actionDialog";
import { DASHBOARD_KEY, dashboardResource } from "@/stores/gh";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { ThreadInfoContent } from "./ThreadInfoCard";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/worktreeDetail", async (orig) => ({ ...(await orig<typeof import("@/api/worktreeDetail")>()), ...(await import("@/test/daemonFakes")).detailFakes }));
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), ...(await import("@/test/cardFakes")).cardGhFakes }));
vi.mock("@/api/actions", async (orig) => ({ ...(await orig<typeof import("@/api/actions")>()), ...(await import("@/test/cardFakes")).cardActionFakes }));
vi.mock("@/api/gitops", async (orig) => ({ ...(await orig<typeof import("@/api/gitops")>()), ...(await import("@/test/cardFakes")).cardGitopsFakes }));
vi.mock("@/api/placement", async (orig) => ({ ...(await orig<typeof import("@/api/placement")>()), ...(await import("@/test/cardFakes")).cardPlacementFakes }));
vi.mock("@/lib/clipboard", () => ({ copyText: () => Promise.resolve() }));
vi.mock("@/api/layout", async (orig) => (await import("@/test/fakeLayout")).fakeLayoutApi(await orig()));

/**
 * The thread info card's groups (docs/notes/thread-info-card.md) over the mock's
 * thread-info scenarios (src/test/threadInfoWorld.ts). What only a browser shows (the card
 * stepping aside at 1280px, menus under their rows, hover colours, the wheel) stays in
 * e2e/thread-info.spec.ts.
 */

const SLUG = "alexwaumann/code-foundry";
const linkTo = (number: number) => ({ slug: SLUG, number, url: `https://github.com/${SLUG}/pull/${String(number)}`, linkedAt: 0 });

/** The project's worktree at `path` gone, as an archive's cleanup leaves it. */
function removeWorktree(projectId: string, path: string): void {
  act(() => {
    useProjectsStore.setState((s) => {
      const p = s.byId[projectId];
      return p ? { byId: { ...s.byId, [projectId]: { ...p, worktrees: p.worktrees.filter((w) => w.path !== path) } } } : s;
    });
  });
}

const byTest = (root: ParentNode, id: string, attrs = ""): HTMLElement | null => root.querySelector<HTMLElement>(`[data-testid="${id}"]${attrs}`);
const cardEl = () => screen.getByTestId("thread-info-card");
const lineageRow = (id: string) => byTest(cardEl(), "ti-lineage-row", `[data-id="${id}"]`);
const oneLine = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
/** An element's children's texts as a reader sees them (flex gaps between them), one space apart. */
const parts = (el: Element | null | undefined) =>
  [...(el?.children ?? [])]
    .map((c) => oneLine(c))
    .filter(Boolean)
    .join(" ");

/** The Tip on a row that takes no focus, opened the way a pointer does (after the provider's 500 ms). */
async function hoverTip(el: HTMLElement): Promise<string | null> {
  fireEvent.pointerMove(el, { pointerType: "mouse" });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 550));
  });
  return screen.queryByRole("tooltip")?.textContent ?? null;
}

/** Opens a Radix menu trigger the way jsdom lets it (a primary pointer down). */
function openMenu(trigger: HTMLElement): void {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

/** Picks a menu item; Radix runs it once the menu has let go (onCloseAutoFocus), so a tick after. */
async function pick(item: HTMLElement): Promise<void> {
  fireEvent.click(item);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function renderCard(id: string) {
  // The card's thread in the window, its tab focused: what the card opens goes beside it.
  await resetFakeLayout(threadSeed(id));
  const r = render(
    <>
      <ThreadInfoContent threadId={id} />
      <Toaster />
    </>,
  );
  await act(async () => {
    await new Promise((res) => setTimeout(res, 0));
  });
  return r;
}

/** Once the tabs a click opened are in the layout. */
async function settle(): Promise<void> {
  await act(async () => {
    await layoutSettled();
  });
}

beforeEach(() => {
  resetDaemon();
  resetCard();
});

afterEach(() => {
  toast.dismiss();
  cleanup();
});

describe("ThreadInfoCard: one project", () => {
  it("the place group: the project, Fresh copy, a menu with Add project only, Open in Finder, the last run action", async () => {
    const id = seedSingle();
    await renderCard(id);
    const c = cardEl();
    expect(byTest(c, "ti-workspace")).toBeNull();
    expect(screen.getByTestId("ti-project").textContent).toContain("code-foundry");
    expect(screen.getByTestId("ti-project-meta").textContent).toBe("Fresh copy");
    openMenu(screen.getByTestId("ti-project"));
    const menu = await screen.findByTestId("ti-project-menu");
    expect(within(menu).getByTestId("ti-add-project")).toBeTruthy();
    expect(within(menu).queryByTestId("ti-runin-item")).toBeNull();
    expect(within(menu).queryByTestId("ti-save-workspace")).toBeNull();
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("ti-project-menu")).toBeNull();
    });
    expect(screen.getByTestId("ti-open-in").textContent).toMatch(/Open in Finder/);
    await waitFor(() => {
      expect(screen.getByTestId("ti-action").textContent).toContain("Dev");
    });
    expect(byTest(c, "ti-action-project")).toBeNull();
  });

  it("the git group: the branch 3 ahead, #78 then merged #63 unnamed, the changes; a click copies the branch and opens the tabs", async () => {
    const id = seedSingle();
    await renderCard(id);
    const c = cardEl();
    expect(screen.getByTestId("ti-branch").dataset.branch).toBe("cf/sidebar-tree");
    expect(screen.getByTestId("ti-branch-ahead").textContent).toBe("3");
    await waitFor(() => {
      expect(screen.getAllByTestId("ti-pr")).toHaveLength(2);
    });
    const prs = screen.getAllByTestId("ti-pr");
    expect(prs[0]?.dataset.number).toBe("78");
    expect(parts(within(prs[0] as HTMLElement).getByTestId("ti-pr-line"))).toBe("#78 review requested");
    expect(prs[1]?.dataset.state).toBe("merged");
    expect(byTest(c, "ti-pr-project")).toBeNull();
    await waitFor(() => {
      expect(screen.queryByTestId("ti-changes-meta")?.textContent).toBe("+42−9· 4 files");
    });

    // Changes opens the cwd's Changes tab, its own title; a pull request its PR tab.
    fireEvent.click(screen.getByTestId("ti-changes"));
    await settle();
    expect(activePanelTab()).toMatchObject({ kind: "diff", params: { project: "repo-cf", worktree: TREE, own: "1" } });
    fireEvent.click(prs[0] as HTMLElement);
    await settle();
    expect(activePanelTab()).toMatchObject({ kind: "pullrequest", params: { slug: "alexwaumann/code-foundry", number: "78" } });

    // The branch row copies the branch.
    fireEvent.click(screen.getByTestId("ti-branch"));
    expect(await screen.findByText("Branch copied")).toBeTruthy();
  });

  it("shells, lineage and MCP: one shell folded; live children with stop squares, the finished one under Previous agents", async () => {
    const id = seedSingle();
    await renderCard(id);
    const c = cardEl();
    // The thread's own background shell, folded.
    expect(screen.getByTestId("ti-shells").textContent).toContain("1 shell");
    expect(byTest(c, "ti-shell")).toBeNull();
    fireEvent.click(screen.getByTestId("ti-shells"));
    expect(screen.getAllByTestId("ti-shell")).toHaveLength(1);

    // Lineage: the running subagent and the child threads that work or wait, then the finished ones.
    expect(screen.getByTestId("ti-lineage-label").textContent).toBe("Lineage · 3 running");
    expect(lineageRow("s-ti-k1")?.dataset.state).toBe("working");
    expect(lineageRow("s-ti-k2")?.dataset.state).toBe("attention");
    expect(lineageRow("s-ti-k3")).toBeNull();
    expect(lineageRow("ag-explore")?.dataset.kind).toBe("agent");
    // Subagent runs have no stop square; a live child's interrupts it, without opening it.
    expect(screen.getAllByTestId("ti-lineage-stop").map((b) => b.dataset.id)).toEqual(["s-ti-k1", "s-ti-k2"]);
    const stop = (k: string) => byTest(c, "ti-lineage-stop", `[data-id="${k}"]`) as HTMLElement;
    fireEvent.click(stop("s-ti-k1"));
    // Enter on the square is the square's (a button's Enter is its click); the row does not see it.
    fireEvent.keyDown(stop("s-ti-k2"), { key: "Enter" });
    fireEvent.click(stop("s-ti-k2"));
    await waitFor(() => {
      expect(invocationsOf("thread.interrupt").map((i) => i.args.id)).toEqual(["s-ti-k1", "s-ti-k2"]);
    });
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id });
    fireEvent.click(screen.getByTestId("ti-previous"));
    expect(lineageRow("s-ti-k3")?.dataset.state).toBe("done");
    // A child's row opens the child.
    fireEvent.click(lineageRow("s-ti-k1") as HTMLElement);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-ti-k1" });

    expect(oneLine(screen.getByTestId("ti-mcp").querySelector(":scope > span:nth-of-type(2)"))).toBe("2 servers connected");
  });

  it("Compact: under Context past the threshold with Claude at its prompt; a double click compacts once; gone while it compacts and after", async () => {
    const id = seedSingle();
    const idle = { state: "connected", status: "idle", statusReason: "at prompt" } as const;
    updateThread(id, { ...idle, contextTokens: 400_000 });
    await renderCard(id);
    expect(screen.queryByTestId("ti-compact")).toBeNull();

    updateThread(id, { contextTokens: 412_000 });
    const row = screen.getByTestId("ti-compact");
    expect(row.textContent).toBe("Compact412K of context");
    expect([...screen.getByTestId("ti-context-group").children].map((r) => r.getAttribute("data-testid"))).toEqual(["ti-context", "ti-compact", "ti-usage"]);

    fireEvent.click(row, { detail: 1 });
    fireEvent.click(row, { detail: 2 });
    await waitFor(() => {
      expect(invocationsOf("thread.compact").map((i) => i.args)).toEqual([{ id }]);
    });

    updateThread(id, { status: "busy", statusReason: "compacting" });
    expect(screen.queryByTestId("ti-compact")).toBeNull();
    updateThread(id, { ...idle, contextTokens: 34_000 });
    expect(screen.queryByTestId("ti-compact")).toBeNull();
  });

  it("context and usage: the warm cache, the window's tokens, the cost by model, the fold's kinds, total, savings and requests", async () => {
    const id = seedSingle();
    await renderCard(id);
    expect(screen.getByTestId("ti-context-label").textContent).toBe("Context cached for 41m");
    expect(screen.getByTestId("ti-context-cache").textContent).toBe("cached for 41m");
    expect(screen.getByTestId("ti-context-bar")).toBeTruthy();
    expect(screen.getByTestId("ti-context-meta").textContent).toBe("221K of 1M");
    expect(await hoverTip(screen.getByTestId("ti-context"))).toBe("22% of context window used" + "Cache expires in 41 min" + "$2.21 to re-read it after that");

    // Usage: the row's value is the total cost in cents; the hover card splits it by model, one line each.
    const usage = screen.getByTestId("ti-usage");
    expect(usage.querySelector(":scope > span")?.textContent).toBe("Usage");
    expect(screen.getByTestId("ti-usage-meta").textContent).toBe("$320.00");
    expect(tooltipText(usage)).toBe("By model" + "Opus 5.5$224.0070.0%" + "Fable 5.1$96.0030.0%");
    expect(screen.getByRole("tooltip").textContent).not.toMatch(/saved/i);
    fireEvent.keyDown(document, { key: "Escape" });

    // The fold: the token kinds, their total (the row's cost), what cache reads saved, the requests.
    expect(screen.queryByTestId("ti-usage-detail")).toBeNull();
    fireEvent.click(usage);
    expect(usage.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("ti-usage-chevron").hasAttribute("data-open")).toBe(true);
    expect(texts(document, "ti-usage-kind")).toEqual(["Input12.9K$0.07", "Output980K$24.50", "Cache read349M$174.50", "Cache write12.2M$120.93"]);
    expect([...screen.getByTestId("ti-usage-total").querySelectorAll("span")].map((s) => s.textContent)).toEqual(["Total", "362M", "$320.00"]);
    const saved = screen.getByTestId("ti-usage-saved");
    expect(saved.textContent).toBe("Saved by cache reads$1,134.00");
    expect([...saved.querySelectorAll("span")].at(-1)?.className).toContain("text-cf-success-text");
    expect(screen.getByTestId("ti-usage-detail").textContent).toMatch(/Requests412$/);
  });

  it("the action menu: an item and a gear per action, Add action last; a gear opens that action's editor and runs nothing, the text runs it", async () => {
    const id = seedSingle();
    await renderCard(id);
    await waitFor(() => {
      expect(screen.getByTestId("ti-action").textContent).toContain("Dev");
    });
    openMenu(screen.getByTestId("ti-action-more"));
    const menu = await screen.findByTestId("ti-action-menu");
    const items = within(menu).getAllByTestId("ti-action-item");
    expect(items.map((i) => i.textContent)).toEqual(["Dev", "Test", "Check", "Build", "Lint", "Format"]);
    expect(within(menu).getAllByTestId("ti-action-gear")).toHaveLength(6);
    expect(within(within(menu).getByTestId("ti-add-action")).queryByTestId("ti-action-gear")).toBeNull();
    const gear = (name: string) => within(items.find((i) => i.textContent === name) as HTMLElement).getByTestId("ti-action-gear");
    expect(gear("Test").getAttribute("aria-label")).toBe("Edit action");

    await pick(gear("Test"));
    await waitFor(() => {
      expect(useActionDialogStore.getState().editor).toEqual({ mode: "edit", actionId: "a-cf-test", projectId: "repo-cf", from: "thread" });
    });
    expect(screen.queryByTestId("ti-action-menu")).toBeNull();
    expect(invocationsOf("action.run")).toEqual([]);

    openMenu(screen.getByTestId("ti-action-more"));
    const again = await screen.findByTestId("ti-action-menu");
    await pick(within(again).getAllByTestId("ti-action-item")[2] as HTMLElement);
    await waitFor(() => {
      expect(invocationsOf("action.run").map((i) => [i.args.action, i.context.activeThreadId])).toEqual([["a-cf-check", id]]);
    });
    expect(screen.queryByTestId("ti-action-menu")).toBeNull();
  });
});

describe("ThreadInfoCard: other scenarios", () => {
  it("nine projects in a workspace: Run in menu, the action of another project, other projects' pull requests, Changes fold, Fix sends once", async () => {
    const id = seedWs9();
    await renderCard(id);
    expect(screen.getByTestId("ti-workspace").textContent).toContain("platform");
    expect(screen.getByTestId("ti-workspace-meta").textContent).toBe("9 projects");
    expect(screen.getByTestId("ti-project").textContent).toContain("api");
    expect(screen.getByTestId("ti-project-chevron").hasAttribute("data-open")).toBe(false);

    openMenu(screen.getByTestId("ti-project"));
    const menu = await screen.findByTestId("ti-project-menu");
    expect(screen.getByTestId("ti-project-chevron").hasAttribute("data-open")).toBe(true);
    expect(within(menu).getByTestId("ti-add-project").hasAttribute("data-disabled")).toBe(false);
    // A named workspace: nothing to save.
    expect(within(menu).queryByTestId("ti-save-workspace")).toBeNull();
    const runIn = within(menu).getAllByTestId("ti-runin-item");
    expect(runIn).toHaveLength(9);
    expect(runIn.filter((i) => i.hasAttribute("data-current")).map((i) => i.dataset.project)).toEqual(["repo-api"]);
    const item = (p: string) => runIn.find((i) => i.dataset.project === p);
    expect(item("repo-auth-lib")?.textContent).toBe("auth-lib @ cf/auth-tokens-2");
    expect(item("repo-web")?.textContent).toBe("web");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("ti-project-menu")).toBeNull();
    });

    // The action last run in this thread was web's: named with its project, run for the thread, no toast.
    await waitFor(() => {
      expect(screen.getByTestId("ti-action").textContent).toContain("Typecheck");
    });
    expect(screen.getByTestId("ti-action-project").textContent).toBe("web");
    fireEvent.click(screen.getByTestId("ti-action"));
    await waitFor(() => {
      expect(invocationsOf("action.run").map((i) => [i.args.action, i.context.activeThreadId])).toEqual([["a-web-tc", id]]);
    });
    expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(0);

    // Pull requests over four projects: the cwd's first and unnamed, the others with their project; a stacked one names its base.
    await waitFor(() => {
      expect(screen.getAllByTestId("ti-pr")).toHaveLength(7);
    });
    const pr = (n: number) => byTest(cardEl(), "ti-pr", `[data-number="${String(n)}"]`) as HTMLElement;
    expect(screen.getAllByTestId("ti-pr")[0]?.dataset.number).toBe("412");
    expect(within(pr(412)).queryByTestId("ti-pr-project")).toBeNull();
    expect(oneLine(within(pr(58)).getByTestId("ti-pr-stacked"))).toBe("#57");
    expect(within(pr(58)).getByTestId("ti-pr-project").textContent).toBe("auth-lib");
    expect(pr(19).dataset.state).toBe("draft");

    await waitFor(() => {
      expect(oneLine(screen.queryByTestId("ti-changes-meta"))).toMatch(/· 4 projects$/);
    });
    fireEvent.click(screen.getByTestId("ti-changes"));
    expect(screen.getAllByTestId("ti-changes-project")).toHaveLength(4);
    // A project's row opens that checkout's Changes tab, named for the project.
    fireEvent.click(byTest(cardEl(), "ti-changes-project", '[data-project="repo-web"]') as HTMLElement);
    await settle();
    expect(activePanelTab()).toMatchObject({ kind: "diff", params: { project: "repo-web" } });
    expect(activePanelTab()?.title).toContain("web");

    // Diverged: Fix sends the thread its prompt; a double click sends once.
    expect(screen.getByTestId("ti-git").dataset.kind).toBe("diverged");
    const fix = screen.getByTestId("ti-git-fix");
    fireEvent.click(fix, { detail: 1 });
    fireEvent.click(fix, { detail: 2 });
    await waitFor(() => {
      expect(invocationsOf("thread.send").map((i) => [i.args.id, i.args.text])).toEqual([[id, expect.stringContaining("diverged from its upstream (3 ahead, 1 behind)")]]);
    });
  });

  it("a working thread: Push waits for the model, with the reason on hover", async () => {
    const id = seedSingle();
    updateThread(id, { status: "busy", statusReason: "working: Fix the stale PR badge" });
    await renderCard(id);
    const push = screen.getByTestId("ti-git");
    expect(push.dataset.kind).toBe("push");
    expect(push.hasAttribute("data-disabled")).toBe(true);
    expect(await hoverTip(push)).toBe("A model is still working on this branch.");
    fireEvent.click(push);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(invocationsOf("git.push")).toEqual([]);
  });

  it("a child thread: its parent row leads the lineage and goes to the parent", async () => {
    const id = seedChild();
    await renderCard(id);
    const parent = screen.getByTestId("ti-parent");
    expect(parent.textContent).toContain("Fix the stale PR badge");
    expect(parent.dataset.id).toBe("s-ti-1");
    expect(oneLine(screen.getByTestId("ti-parent-meta"))).toBe("Done");
    // It leads the group: right under the label.
    expect(screen.getByTestId("ti-lineage-label").nextElementSibling).toBe(parent);
    fireEvent.click(parent);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-ti-1" });
  });

  describe("pull requests without a checkout", () => {
    /** s-ti-1 as an archive leaves it: stopped, its worktree cleaned up, its links kept. */
    function seedArchivedCleaned(): string {
      const id = seedSingle();
      updateThread(id, { state: "disconnected", archivedAtMs: Date.now() });
      removeWorktree("repo-cf", TREE);
      return id;
    }

    it("an archived thread whose worktree was cleaned up: the pull requests, and no row that needs the checkout", async () => {
      await renderCard(seedArchivedCleaned());
      await waitFor(() => {
        expect(screen.getAllByTestId("ti-pr").map((r) => r.dataset.number)).toEqual(["78", "63"]);
      });
      expect(screen.queryByTestId("ti-branch")).toBeNull();
      expect(screen.queryByTestId("ti-git")).toBeNull();
      expect(screen.queryByTestId("ti-changes")).toBeNull();
    });

    it("a folder without git keeps a child's pull request", async () => {
      const id = seedNoGit();
      updateThread(id, { linkedPullRequests: [linkTo(78)] });
      card.prDetails.set(`${SLUG}#78`, pullRequest({ repoSlug: SLUG, number: 78, title: "Include the head SHA" }));
      await renderCard(id);
      await waitFor(() => {
        expect(screen.getByTestId("ti-pr-title").textContent).toBe("Include the head SHA");
      });
      expect(screen.queryByTestId("ti-branch")).toBeNull();
    });

    it("a thread with no project keeps a child's pull request, named by its repository", async () => {
      const id = seedNoGit();
      updateThread(id, { projectId: "", projectIds: [], worktreePath: HOME, linkedPullRequests: [linkTo(78)] });
      card.prDetails.set(`${SLUG}#78`, pullRequest({ repoSlug: SLUG, number: 78, title: "Include the head SHA" }));
      await renderCard(id);
      await waitFor(() => {
        expect(screen.getByTestId("ti-pr-project").textContent).toBe(SLUG);
      });
      expect(screen.queryByTestId("ti-branch")).toBeNull();
    });

    it("only closed pull requests: no group, so no empty divider", async () => {
      const id = seedArchivedCleaned();
      card.prDetails.set(`${SLUG}#78`, pullRequest({ repoSlug: SLUG, number: 78, state: "closed" }));
      card.prDetails.set(`${SLUG}#63`, pullRequest({ repoSlug: SLUG, number: 63, state: "closed" }));
      await renderCard(id);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(screen.queryByTestId("ti-git-group")).toBeNull();
    });

    it("a detail that cannot be read: the row comes from the dashboard, as the sidebar's does", async () => {
      const id = seedArchivedCleaned();
      card.prDetails.delete(`${SLUG}#78`);
      dashboardResource.set(DASHBOARD_KEY, {
        data: { authored: [pullRequest({ repoSlug: SLUG, number: 78, title: "From the dashboard" })], reviewRequested: [], reviewed: [], recentlyMerged: [] } as unknown as DashboardView,
      });
      await renderCard(id);
      await waitFor(() => {
        expect(screen.getAllByTestId("ti-pr").map((r) => r.dataset.number)).toEqual(["78", "63"]);
      });
      expect(screen.getAllByTestId("ti-pr-title")[0]?.textContent).toBe("From the dashboard");
    });
  });

  it("a folder without git: no git group", async () => {
    const id = seedNoGit();
    await renderCard(id);
    expect(screen.getByTestId("ti-project").textContent).toContain("writing");
    expect(screen.getByTestId("ti-project-meta").textContent).toBe("Project folder");
    expect(screen.queryByTestId("ti-git-group")).toBeNull();
    expect(screen.getByTestId("ti-context")).toBeTruthy();
  });

  it("servers: a listening shell is a row that opens its port; its stop square stops the shell once", async () => {
    const id = seedServers();
    await renderCard(id);
    const servers = () => screen.queryAllByTestId("ti-server");
    expect(servers()).toHaveLength(2);
    const [web, docs] = servers() as [HTMLElement, HTMLElement];
    expect(web.dataset.port).toBe("5173");
    expect(web.textContent).toContain("localhost:5173");
    expect(parts(within(web).getByTestId("ti-server-line"))).toMatch(/^pnpm --dir web dev · 1m 1\ds$/);
    // Several ports: the first on the row, the rest in the hover card.
    expect(within(web).getByTestId("ti-server-meta").textContent).toBe("+1");
    expect(tooltipText(web)).toContain("localhost:5173localhost:24678");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(within(docs).getByTestId("ti-server-line").textContent).toContain("python3 -m http.server");
    expect(within(docs).queryByTestId("ti-server-meta")).toBeNull();
    // The shells that listen on nothing stay folded below.
    expect(screen.getByTestId("ti-shells").textContent).toContain("2 more shells");

    // A click opens the port in the browser.
    fireEvent.click(docs);
    const opened = () => invocationsOf("view.open.url").map((i) => i.args.url);
    await waitFor(() => {
      expect(opened()).toEqual(["http://localhost:9399"]);
    });

    // The stop square stops the shell without opening the port; a double click stops once.
    const stops = () => invocationsOf("thread.shell.stop").map((i) => `${i.args.id ?? ""} ${i.args.task ?? ""}`);
    const stop = (task: string) => byTest(cardEl(), "ti-server-stop", `[data-task="${task}"]`) as HTMLElement;
    fireEvent.click(stop("bd9r3t6w1"));
    fireEvent.click(stop("bd9r3t6w1"));
    await waitFor(() => {
      expect(stops()).toEqual([`${id} bd9r3t6w1`]);
    });
    // The shell leaves the thread (the daemon's update): its row goes.
    const left = (task: string) => {
      updateThread(id, { backgroundShells: (useThreadsStore.getState().byId[id]?.backgroundShells ?? []).filter((s) => s.taskId !== task) });
    };
    left("bd9r3t6w1");
    expect(servers()).toHaveLength(1);
    fireEvent.keyDown(stop("bk4v8n2p7"), { key: "Enter" });
    fireEvent.click(stop("bk4v8n2p7"));
    await waitFor(() => {
      expect(stops()).toEqual([`${id} bd9r3t6w1`, `${id} bk4v8n2p7`]);
    });
    left("bk4v8n2p7");
    expect(servers()).toHaveLength(0);
    expect(screen.getByTestId("ti-shells").textContent).toContain("2 shells");
    expect(opened()).toEqual(["http://localhost:9399"]);
  });

  it("an expired cache: the context row and its hover card say nothing of it", async () => {
    const id = seedSingle();
    await renderCard(id);
    expect(screen.getByTestId("ti-context-cache").textContent).toBe("cached for 41m");
    updateThread(id, { cacheExpiresAtMs: Date.now() - 100_000 });
    expect(screen.queryByTestId("ti-context-cache")).toBeNull();
    expect(screen.getByTestId("ti-context-label").textContent).toBe("Context");
    expect(screen.getByTestId("ti-context-meta").textContent).toBe("221K of 1M");
    expect(await hoverTip(screen.getByTestId("ti-context"))).toBe("22% of context window used");
  });

  it("a thread under a cent: the row reads <$0.01, the kinds show no cost, nothing saved", async () => {
    const id = seedSingle();
    updateThread(id, {
      usage: [bucket("claude-haiku-5-5", { requests: 2, input: 900, output: 350, cacheRead: 4000, cacheWrite5m: 1200, inputCostUsd: 0.0009, outputCostUsd: 0.00175, cacheReadCostUsd: 0.0004, cacheWrite5mCostUsd: 0.0015, costUsd: 0.00455, cacheSavingsUsd: 0.0036 })],
    });
    await renderCard(id);
    expect(screen.getByTestId("ti-usage-meta").textContent).toBe("<$0.01");
    expect(tooltipText(screen.getByTestId("ti-usage"))).toBe("By model" + "Haiku 5.5<$0.01100.0%");
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByTestId("ti-usage"));
    expect(texts(document, "ti-usage-kind")).toEqual(["Input900", "Output350", "Cache read4K", "Cache write1.2K"]);
    expect(screen.getByTestId("ti-usage-total").textContent).toBe("Total6.5K<$0.01");
    expect(screen.queryByTestId("ti-usage-saved")).toBeNull();
    expect(screen.getByTestId("ti-usage-detail").textContent).toMatch(/Requests2$/);
  });

  it("the MCP row: connected count on the left, attention counts in the value column; the whole row opens the menu, Open MCP panel first", async () => {
    const id = seedSingle();
    const servers = (playwright: McpServerView["status"]) => [mcpServer("github", "connected"), mcpServer("context7", "connected"), mcpServer("linear", "needs-auth"), mcpServer("playwright", playwright), mcpServer("sentry", "disabled"), mcpServer("figma", "pending")];
    setLog(id, { mcp: servers("failed") });
    await renderCard(id);
    const mcp = screen.getByTestId("ti-mcp");
    const text = () => mcp.querySelector(":scope > span:nth-of-type(2)");
    expect(oneLine(text())).toBe("2 connected");
    expect(text()?.querySelector("span")?.className).toContain("text-cf-text-muted");
    expect(parts(screen.getByTestId("ti-mcp-meta"))).toBe("1 needs login 1 failed");
    expect(screen.getByTestId("ti-mcp-needs-login").className).toContain("text-cf-warning-text");
    expect(screen.getByTestId("ti-mcp-failed").className).toContain("text-cf-error-text");
    // The row is the trigger.
    expect(mcp.getAttribute("aria-haspopup")).toBe("menu");

    // A press on the value opens the menu, not the tab.
    openMenu(screen.getByTestId("ti-mcp-needs-login"));
    const menu = await screen.findByTestId("ti-mcp-menu");
    expect(screen.getByTestId("ti-mcp-chevron").hasAttribute("data-open")).toBe(true);
    expect(activePanelTab()).toBeNull();
    // Open MCP panel, Refresh, then Reconnect for the failed server only (a login cannot be done headlessly).
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Open MCP panel", "Refresh", "Reconnect playwright"]);
    await pick(within(menu).getByTestId("ti-mcp-reconnect"));
    expect(screen.queryByTestId("ti-mcp-menu")).toBeNull();
    await waitFor(() => {
      expect(invocationsOf("thread.mcp-reconnect").map((i) => i.args)).toEqual([{ id, server: "playwright" }]);
    });
    // The daemon's next check: playwright connected.
    setLog(id, { mcp: servers("connected") });
    expect(parts(screen.getByTestId("ti-mcp-meta"))).toBe("1 needs login");
    expect(screen.queryByTestId("ti-mcp-failed")).toBeNull();
    expect(oneLine(text())).toBe("3 connected");

    // The text and the chevron open the menu too; Enter and ArrowDown from the focused row as well.
    for (const target of [text() as HTMLElement, screen.getByTestId("ti-mcp-chevron")]) {
      openMenu(target);
      const m = await screen.findByTestId("ti-mcp-menu");
      fireEvent.keyDown(m, { key: "Escape" });
      await waitFor(() => {
        expect(screen.queryByTestId("ti-mcp-menu")).toBeNull();
      });
    }
    for (const key of ["Enter", "ArrowDown"]) {
      fireEvent.keyDown(mcp, { key });
      const m = await screen.findByTestId("ti-mcp-menu");
      fireEvent.keyDown(m, { key: "Escape" });
      await waitFor(() => {
        expect(screen.queryByTestId("ti-mcp-menu")).toBeNull();
      });
    }
    expect(activePanelTab()).toBeNull();

    // Open MCP panel opens the MCP tab.
    openMenu(mcp);
    await pick(within(await screen.findByTestId("ti-mcp-menu")).getByTestId("ti-mcp-open-panel"));
    await settle();
    expect(activePanelTab()?.kind).toBe("mcp");
    expect(screen.queryByTestId("ti-mcp-menu")).toBeNull();
  });
});
