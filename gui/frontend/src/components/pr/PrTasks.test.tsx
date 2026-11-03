import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), ...(await import("@/test/prWorld")).prGhFakes }));

const { invocationsOf, resetDaemon } = await import("@/test/daemonFakes");
const { seedPrWorld, SLUG } = await import("@/test/prWorld");
const { openPr, pick, press, renderPrPanel, resetPrStores, settle, toastTexts } = await import("@/test/prPanelHarness");
const { seedWorld } = await import("@/test/projectsWorld");
const { useProjectsStore } = await import("@/stores/projects");
const { usePrTasksStore } = await import("@/stores/prTasks");
const { useThreadsStore } = await import("@/stores/threads");
const { useUiStore } = await import("@/stores/ui");

/**
 * The readiness rows' thread tasks (TaskButton, stores/prTasks.ts) in the real side panel
 * against src/test/prWorld.ts: which rows get which button, where it routes, the pr.task
 * args each target sends, the busy state and the toasts. The routing rules themselves are
 * table-tested in taskRouting.test.ts.
 */

let world: ReturnType<typeof seedPrWorld>;

beforeEach(() => {
  resetDaemon();
  world = seedPrWorld();
  usePrTasksStore.setState({ running: {} });
});

afterEach(() => {
  act(() => {
    toast.dismiss();
  });
  cleanup();
  vi.clearAllMocks();
});

const byTestId = (id: string) => screen.getByTestId(id);
const tasks = () => invocationsOf("pr.task").map((i) => i.args);
/** Every task button's label, by kind, in row order. */
const buttons = () => Object.fromEntries(screen.queryAllByTestId("pr-ready-row").flatMap((r) => (r.dataset.task ? [[r.dataset.task, within(r).queryByTestId(`pr-task-${r.dataset.task}`)?.textContent ?? null]] : [])));

/** Sets a thread's linked pull requests (what the daemon publishes). */
function link(id: string, numbers: number[], slug = SLUG): void {
  act(() => {
    useThreadsStore.setState((s) => {
      const t = s.byId[id];
      if (!t) throw new Error(`no ${id}`);
      return { byId: { ...s.byId, [id]: { ...t, linkedPullRequests: numbers.map((number) => ({ slug, number, url: `https://github.com/${slug}/pull/${String(number)}`, linkedAt: null })) } } };
    });
  });
}

/** The seeded projects and threads, with `selected` selected. */
function fromThread(selected: string): void {
  seedWorld();
  resetPrStores({ kind: "thread", id: selected });
}

function openTargets(kind: string): HTMLElement {
  press(byTestId(`pr-task-${kind}-menu-button`));
  return byTestId(`pr-task-${kind}-menu`);
}

const targets = (menu: HTMLElement) => within(menu).getAllByTestId("pr-task-target").map((i) => ({ text: i.textContent, default: i.dataset.default === "true" }));

function toastOpen(text: string): HTMLElement | null {
  const t = [...document.querySelectorAll<HTMLElement>("[data-sonner-toast]")].find((el) => el.textContent.includes(text));
  if (!t) throw new Error(`no toast "${text}": ${toastTexts().join(" | ")}`);
  return within(t).queryByRole("button", { name: "Open" });
}

async function expectToast(text: string): Promise<void> {
  await vi.waitFor(() => {
    expect(toastTexts().some((t) => t.includes(text))).toBe(true);
  });
}

describe("which rows get which button", () => {
  it("#145 from a thread that links it: Fix / Address / Address in this thread; no icon", async () => {
    fromThread("s-1");
    link("s-1", [145]);
    renderPrPanel();
    await openPr(145);
    expect(buttons()).toEqual({ checks: "Fix in this thread", review: "Address in this thread", conversations: "Address in this thread" });
    expect(byTestId("pr-task-checks").querySelector("svg")).toBeNull();
  });

  it.each([
    [161, { conflicts: "Resolve in new thread" }],
    [162, { behind: "Update in new thread" }],
    [139, { "review-request": "Review in new thread" }],
  ])("#%i from the Pull Requests page: %o", async (n, want) => {
    resetPrStores();
    renderPrPanel();
    await openPr(n);
    expect(buttons()).toEqual(want);
  });

  it("none on merged or closed pull requests", async () => {
    resetPrStores();
    renderPrPanel();
    for (const n of [138, 131]) {
      await openPr(n);
      expect(screen.queryAllByTestId(/^pr-task-/)).toEqual([]);
    }
  });

  it("a viewer who cannot push gets no push task, but still Review when asked", async () => {
    world.update(145, (d) => ({ ...d, viewerCanUpdate: false, viewerPermission: "read", pullRequest: { ...d.pullRequest, author: "teammate-kim" } }));
    world.update(139, (d) => ({ ...d, viewerCanUpdate: false, viewerPermission: "read" }));
    resetPrStores();
    renderPrPanel();
    await openPr(145);
    expect(screen.queryAllByTestId(/^pr-task-/)).toEqual([]);
    await openPr(139);
    expect(buttons()).toEqual({ "review-request": "Review in new thread" });
  });
});

describe("running pr.task", () => {
  it("into this thread: --thread with the selection; the daemon's message, no Open", async () => {
    fromThread("s-1");
    link("s-1", [145]);
    renderPrPanel();
    await openPr(145);
    fireEvent.click(byTestId("pr-task-checks"));
    await settle();
    expect(tasks()).toEqual([{ "repo-slug": SLUG, number: "145", kind: "checks", thread: "s-1" }]);
    await expectToast("Sent to s-1 (#7)");
    // The CLI's wait hint is for agents, not the window.
    expect(toastTexts().join(" ")).not.toContain("thread wait");
    expect(toastOpen("Sent to s-1")).toBeNull();
  });

  it("an unrelated pull request: new thread by default; the menu lists this thread and a thread that links it; picking that one sends there, Open selects it", async () => {
    fromThread("s-1");
    link("s-1", [145]);
    link("s-3", [161]);
    link("s-7", [161]); // archived: not offered
    renderPrPanel();
    await openPr(161);
    expect(buttons()).toEqual({ conflicts: "Resolve in new thread" });
    const menu = openTargets("conflicts");
    expect(within(menu).getByText("Resolve the conflicts")).toBeTruthy();
    expect(targets(menu)).toEqual([
      { text: "In a new thread", default: true },
      { text: "In this thread", default: false },
      { text: "In Fix resize race", default: false },
    ]);
    await pick(within(menu).getAllByTestId("pr-task-target")[2] as HTMLElement);
    expect(tasks()).toEqual([{ "repo-slug": SLUG, number: "161", kind: "conflicts", thread: "s-3" }]);
    await expectToast("Sent to s-3");
    fireEvent.click(toastOpen("Sent to s-3") as HTMLElement);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-3" });
  });

  it("this thread from the menu when it does not link the pull request", async () => {
    fromThread("s-1");
    renderPrPanel();
    await openPr(162);
    await pick(within(openTargets("behind")).getByText("In this thread"));
    expect(tasks()).toEqual([{ "repo-slug": SLUG, number: "162", kind: "behind", thread: "s-1" }]);
  });

  it("a new thread: no --thread; Started thread … with Open", async () => {
    resetPrStores();
    renderPrPanel();
    await openPr(139);
    fireEvent.click(byTestId("pr-task-review-request"));
    await settle();
    expect(tasks()).toEqual([{ "repo-slug": SLUG, number: "139", kind: "review-request" }]);
    await expectToast("Started thread s-new-");
    const id = /Started thread (s-new-\d+)/.exec(toastTexts().join(" "))?.[1];
    fireEvent.click(toastOpen("Started thread") as HTMLElement);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id });
  });

  it("a repository that is no project: the new thread's item says it clones first", async () => {
    fromThread("s-1");
    act(() => {
      useProjectsStore.setState((s) => ({ order: s.order.filter((id) => s.byId[id]?.githubSlug !== SLUG) }));
    });
    renderPrPanel();
    await openPr(161);
    const items = within(openTargets("conflicts")).getAllByTestId("pr-task-target");
    expect(items[0]?.textContent).toBe(`In a new threadClones ${SLUG} first`);
    expect(items[1]?.textContent).toBe("In this thread");
  });

  it("busy: spinner, aria-disabled; a second press sends nothing; the other rows stay free", async () => {
    fromThread("s-1");
    link("s-1", [145]);
    const release = world.hold("pr.task");
    renderPrPanel();
    await openPr(145);
    fireEvent.click(byTestId("pr-task-checks"));
    await settle();
    expect(byTestId("pr-task-checks").getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByTestId("pr-task-checks-busy")).not.toBeNull();
    fireEvent.click(byTestId("pr-task-checks"));
    await settle();
    expect(byTestId("pr-task-review").getAttribute("aria-disabled")).toBeNull();
    release();
    await settle();
    expect(tasks()).toHaveLength(1);
    expect(byTestId("pr-task-checks").getAttribute("aria-disabled")).toBeNull();
  });

  it("a refusal toasts the daemon's error", async () => {
    world.failNext.add("pr.task");
    resetPrStores();
    renderPrPanel();
    await openPr(161);
    fireEvent.click(byTestId("pr-task-conflicts"));
    await expectToast("comes from a fork");
    expect(toastTexts().join(" ")).toContain("Hand Pull Request Task to Thread failed");
    expect(byTestId("pr-task-conflicts").getAttribute("aria-disabled")).toBeNull();
  });
});
