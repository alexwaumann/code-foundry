import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), ...(await import("@/test/daemonFakes")).ghFakes }));
vi.mock("@/api/worktreeDetail", async (orig) => ({ ...(await orig<typeof import("@/api/worktreeDetail")>()), ...(await import("@/test/daemonFakes")).detailFakes }));
vi.mock("@/api/layout", async (orig) => (await import("@/test/fakeLayout")).fakeLayoutApi(await orig()));
vi.mock("@/api/gitops", async (orig) => ({ ...(await orig<typeof import("@/api/gitops")>()), ...(await import("@/test/cardFakes")).cardGitopsFakes }));
// The table's own width (jsdom lays nothing out): what a test sets.
const tableWidth = vi.hoisted(() => ({ px: 1100 }));
vi.mock("@/lib/useWidth", () => ({ useWidth: () => [{ current: null }, tableWidth.px] }));

const { ProjectsPage } = await import("./ProjectsPage");
const { OPEN_IN_ITEM, OPEN_IN_MORE } = await import("./OpenInMenuItem");
const { card } = await import("@/test/cardFakes");
const { lastInvocation, resetDaemon } = await import("@/test/daemonFakes");
const { addThreads, addWorkspace, addWorktrees, CF, FEAT, FIX, HOME, menuEntries, resetPanels, seedWorld, status, thread, updateProject, worktree } = await import("@/test/projectsWorld");
const { projectPage, useUiStore } = await import("@/stores/ui");
const { editorAppsResource } = await import("@/stores/threadInfo");
const { hoverTooltipText } = await import("@/test/tooltip");

/**
 * A project page's Checkouts table (docs/notes/project-page-2-checkouts.md): its columns at a
 * width, the Branch cell's signals, and the row's right-click menu's parts (Open thread, the
 * split Open in Finder, its app submenu). The item list per condition is menus.test.ts
 * (checkoutMenu); Run action and its editor are components/actions/CheckoutActions.test.tsx.
 * e2e/projects.spec.ts keeps the split item's hover blocks (pseudo-elements) and the real width.
 */

const row = (path: string) => document.querySelector<HTMLElement>(`[data-nav-key="pw:repo-cf::${path}"]`) as HTMLElement;
const cells = (path: string) => document.querySelector<HTMLElement>(`[data-testid="project-worktree"][data-path="${path}"]`) as HTMLElement;
const LOGIN = `${HOME}/.code-foundry/worktrees/code-foundry/feat-login`;

async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function renderPage() {
  act(() => {
    useUiStore.getState().select(projectPage("repo-cf"));
  });
  return render(<ProjectsPage />);
}

function openMenu(path: string): HTMLElement {
  fireEvent.contextMenu(row(path));
  return screen.getByTestId("checkout-menu");
}

/** A submenu's trigger, focused, then ArrowRight (Radix's keyboard path into it). */
function openSub(trigger: HTMLElement, menuTestId: string): HTMLElement {
  act(() => {
    trigger.focus();
  });
  fireEvent.keyDown(trigger, { key: "ArrowRight" });
  return screen.getByTestId(menuTestId);
}

beforeEach(async () => {
  resetDaemon();
  seedWorld();
  await resetPanels();
  tableWidth.px = 1100;
  card.editors = [{ name: "VS Code", bundleId: "com.microsoft.VSCode", path: "/Applications/Visual Studio Code.app" }];
  editorAppsResource.store.setState({ entries: {} });
});
afterEach(() => {
  cleanup();
});

describe("the columns", () => {
  it.each<[number, string]>([
    [1100, "Branch,Threads,Changes,Sync,Pull request"],
    [860, "Branch,Threads,Changes,Pull request"],
    [700, "Branch,Changes,Pull request"],
    [520, "Branch,Pull request"],
  ])("at %d px: %s, header and cells alike", async (px, want) => {
    tableWidth.px = px;
    renderPage();
    await settle();
    expect(screen.getByTestId("checkouts-table").dataset.columns).toBe(want);
    expect(screen.getByTestId("checkouts-head").textContent).toBe(want.replaceAll(",", ""));
    const has = (id: string) => within(cells(FIX)).queryByTestId(id) !== null;
    expect([has("worktree-threads"), has("worktree-changes-cell"), has("worktree-sync")]).toEqual([want.includes("Threads"), want.includes("Changes"), want.includes("Sync")]);
  });
});

describe("a row", () => {
  it("has no click but tints on hover; its branch has no tooltip (the text is on screen)", async () => {
    renderPage();
    await settle();
    expect(row(FIX).className).toContain("hover:bg-cf-control-hover/50");
    fireEvent.click(row(FIX));
    expect(row(FIX).getAttribute("aria-selected")).toBe("false");
    expect(within(cells(FIX)).getByTestId("worktree-branch").hasAttribute("data-tip")).toBe(false);
  });

  it.each<[string, Partial<{ upstream: string; ahead: number; behind: number }>, string, string, string | null]>([
    ["up to date: green with a check", { upstream: "origin/fix", ahead: 0, behind: 0 }, "up to date", "text-cf-success-text", "lucide-check"],
    ["to push: blue with an up arrow", { upstream: "origin/fix", ahead: 2, behind: 0 }, "2 to push", "text-cf-info-text", "lucide-arrow-up"],
    ["behind: amber with a down arrow", { upstream: "origin/fix", ahead: 0, behind: 1 }, "1 behind", "text-cf-warning-text", "lucide-arrow-down"],
    ["both: amber diverged with a split, both counts in sight", { upstream: "origin/fix", ahead: 2, behind: 1 }, "diverged ↑2 ↓1", "text-cf-warning-text", "lucide-split"],
    ["no upstream: muted, no icon", { upstream: "", ahead: 0, behind: 0 }, "not pushed", "text-cf-text-muted", null],
  ])("Sync, %s; no tooltip (nothing is hidden)", (_name, st, text, tone, icon) => {
    updateProject("repo-cf", (p) => ({ ...p, worktrees: p.worktrees.map((w) => (w.path === FIX ? { ...w, status: status({ ...w.status, ...st }) } : w)) }));
    renderPage();
    const cell = within(cells(FIX)).getByTestId("worktree-sync");
    expect(cell.textContent).toBe(text);
    expect(cell.className).toContain(tone);
    expect(cell.hasAttribute("data-tip")).toBe(false);
    expect(cell.querySelector("svg")?.getAttribute("class")?.split(" ").find((c) => c.startsWith("lucide-") && c !== "lucide-icon") ?? null).toBe(icon);
  });

  it("the main checkout's FolderRoot and a workspace checkout's Layers, nothing on the others", async () => {
    const ws = addWorkspace("login-and-billing", ["repo-cf", "repo-gp"]);
    addWorktrees("repo-cf", worktree("repo-cf", LOGIN, "feat/login"));
    addThreads(thread("s-ws", { worktreePath: LOGIN, name: "Login flow", workspaceId: ws.id, projectIds: ["repo-cf", "repo-gp"] }));
    renderPage();
    await settle();
    const main = within(cells(CF)).getByTestId("worktree-main-signal");
    expect(main.getAttribute("class")).toContain("size-3.5");
    expect(await hoverTooltipText(main)).toBe("Main checkout · the project folder, ~/src/code-foundry");
    fireEvent.pointerLeave(main);
    const sig = within(cells(LOGIN)).getByTestId("worktree-workspace-signal");
    expect(sig.getAttribute("aria-label")).toBe("Workspace login-and-billing");
    cleanup();
    renderPage();
    await settle();
    const wsCard = await hoverTooltipText(within(cells(LOGIN)).getByTestId("worktree-workspace-signal"));
    expect(wsCard).toBe("login-and-billingWorkspace · code-foundry, ghostty-playground1 thread · Login flow");
    for (const p of [FEAT, FIX]) {
      expect(within(cells(p)).queryByTestId("worktree-main-signal")).toBeNull();
      expect(within(cells(p)).queryByTestId("worktree-workspace-signal")).toBeNull();
    }
  });
});

describe("the right-click menu's parts", () => {
  it("Open thread lists the checkout's open threads with their state; a pick selects one", async () => {
    renderPage();
    await settle();
    const menu = openMenu(FEAT);
    const sub = openSub(within(menu).getByTestId("checkout-menu-threads"), "checkout-menu-threads-menu");
    expect(within(sub).getAllByTestId("checkout-menu-thread").map((e) => `${e.querySelector(".truncate")?.textContent ?? ""} ${within(e).getByTestId("checkout-menu-thread-state").textContent}`)).toEqual(["Investigate flaky e2e idle", "Write thread docs working"]);
    fireEvent.click(within(sub).getAllByTestId("checkout-menu-thread")[1] as HTMLElement);
    await settle();
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-5" });
  });

  it("the split Open in Finder: a click on it reveals the checkout and closes the menu", async () => {
    renderPage();
    await settle();
    const menu = openMenu(FIX);
    const split = within(menu).getByTestId("checkout-menu-open-in");
    expect(split.textContent).toBe("Open in Finder");
    fireEvent.click(split);
    await settle();
    expect(screen.queryByTestId("checkout-menu")).toBeNull();
    expect(lastInvocation("worktree.reveal")?.args).toEqual({ worktree: FIX });
    expect(lastInvocation("worktree.reveal")?.context).toMatchObject({ activeProjectId: "repo-cf", activeWorktreePath: FIX });
  });

  it("Enter on it reveals too; ArrowRight opens the apps: Finder, the editors, then Terminal", async () => {
    renderPage();
    await settle();
    let split = within(openMenu(FIX)).getByTestId("checkout-menu-open-in");
    act(() => {
      split.focus();
    });
    fireEvent.keyDown(split, { key: "Enter" });
    await settle();
    expect(screen.queryByTestId("checkout-menu")).toBeNull();
    expect(lastInvocation("worktree.reveal")?.args).toEqual({ worktree: FIX });

    split = within(openMenu(FIX)).getByTestId("checkout-menu-open-in");
    const apps = openSub(split, "checkout-menu-open-in-menu");
    expect(menuEntries(apps, true)).toEqual(["Finder", "VS Code", "—", "Terminal"]);
    fireEvent.click(within(apps).getByTestId("open-in-editor"));
    await settle();
    expect(screen.queryByTestId("checkout-menu")).toBeNull();
    expect(lastInvocation("worktree.open.editor")?.args).toEqual({ worktree: FIX, app: "com.microsoft.VSCode" });

    split = within(openMenu(FIX)).getByTestId("checkout-menu-open-in");
    fireEvent.click(within(openSub(split, "checkout-menu-open-in-menu")).getByTestId("open-in-terminal"));
    await settle();
    expect(lastInvocation("terminal.new")?.context).toMatchObject({ activeProjectId: "repo-cf", activeWorktreePath: FIX });
  });

  it("a click on its › block opens the apps instead of revealing", async () => {
    renderPage();
    await settle();
    const split = within(openMenu(FIX)).getByTestId("checkout-menu-open-in");
    fireEvent.click(within(split).getByTestId("checkout-menu-open-in-more"));
    expect(screen.getByTestId("checkout-menu-open-in-menu")).toBeTruthy();
    expect(lastInvocation("worktree.reveal")).toBeUndefined();
  });

  it("hovers as two blocks: the item's before: and the › block's after:, 2px apart, no tint of its own", () => {
    for (const c of ["isolate", "focus:bg-transparent", "data-[state=open]:bg-transparent", "before:right-8.5", "before:left-0", "before:-z-1", "before:rounded-l-md", "data-highlighted:before:bg-cf-control-hover", "data-[state=open]:before:bg-cf-control-hover/50", "has-[[data-open-in-more]:hover]:before:bg-cf-control-hover/50"]) {
      expect(OPEN_IN_ITEM.split(" ")).toContain(c);
    }
    for (const c of ["after:w-8", "after:right-0", "after:inset-y-0", "after:-z-1", "after:rounded-r-md", "group-data-highlighted/split:after:bg-cf-control-hover/50", "hover:after:bg-cf-control-hover", "group-data-[state=open]/split:after:bg-cf-control-hover"]) {
      expect(OPEN_IN_MORE.split(" ")).toContain(c);
    }
  });
});
