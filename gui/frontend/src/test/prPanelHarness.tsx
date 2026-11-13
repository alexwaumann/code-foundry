/**
 * Renders the window's panes the way the app shows a pull request in a tab, for component tests
 * of the Pull request surface (src/components/pr): the Pull Requests page selected, the current
 * space's panes (src/test/shellPanes.tsx: each pane's tab strip and its active tab), the confirm
 * dialog and a sonner Toaster. Pair with src/test/prWorld.ts (the mock's pull requests),
 * src/test/daemonFakes.ts (the commands) and src/test/fakeLayout.ts (the layout daemon), mocked in
 * the test file:
 *
 *   vi.mock("@/api/layout", async (orig) => (await import("@/test/fakeLayout")).fakeLayoutApi(await orig()));
 *
 * Imports stores: load it after the vi.mock calls (await import).
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { applyLayoutOp } from "@/api/layout";
import { ConfirmDialog } from "@/components/confirm/ConfirmDialog";
import { Toaster } from "@/components/ui/sonner";
import { useCommandsStore } from "@/stores/commands";
import { useConfirmStore } from "@/stores/confirm";
import { focusTab } from "@/stores/layout";
import { dashboardResource, pullRequestDetailResource, viewerResource } from "@/stores/gh";
import { openPullRequestInPanel, reviewerCandidatesResource, usePrPanelStore } from "@/stores/prPanel";
import { usePrThreadsStore } from "@/stores/prThreads";
import { usePrTasksStore } from "@/stores/prTasks";
import { useReviewerRecentsStore } from "@/stores/reviewerRecents";
import { useUiStore, type Selection } from "@/stores/ui";
import { useViewsStore } from "@/stores/views";
import { layoutSettled, resetFakeLayout, threadSeed, type FakeLayoutState } from "./fakeLayout";
import { throwIfTimedOut } from "./isolate";
import { PR_COMMANDS, SLUG } from "./prWorld";
import { layoutTabs } from "./layoutTabs";
import { ShellPanes } from "./shellPanes";

export const PR_PAGE: Selection = { kind: "view", name: "pullrequests" };

/**
 * Forgets every pull request read, tab, busy flag and recent reviewer; selects the Pull Requests
 * page. The layout starts as `seed`; by default empty for a page, and with the thread's tab for a thread.
 */
export async function resetPrStores(selection: Selection = PR_PAGE, seed?: FakeLayoutState | string): Promise<void> {
  if (typeof Element.prototype.scrollIntoView !== "function") Element.prototype.scrollIntoView = () => undefined;
  if (typeof Element.prototype.scrollTo !== "function") Element.prototype.scrollTo = () => undefined;
  pullRequestDetailResource.store.setState({ entries: {} });
  reviewerCandidatesResource.store.setState({ entries: {} });
  dashboardResource.store.setState({ entries: {} });
  viewerResource.store.setState({ entries: {} });
  usePrPanelStore.setState({ byTab: {}, refreshing: {}, requesting: {}, confirmed: {}, merging: {}, reviewing: {}, changing: {}, reverting: {}, taskChecks: {}, mergeMethods: {} });
  usePrThreadsStore.setState({ starting: {} });
  usePrTasksStore.setState({ running: {} });
  useReviewerRecentsStore.setState({ bySlug: {} });
  await resetFakeLayout(seed ?? (selection.kind === "thread" ? threadSeed(selection.id) : "empty"));
  useConfirmStore.setState({ pending: null });
  useCommandsStore.setState({ commands: PR_COMMANDS });
  useViewsStore.setState({ settingsOpen: false, usageOpen: false });
  useUiStore.setState({ selection, sidebarVisible: true, sidebarWidth: 260 });
}

/** The current space's panes, the confirm dialog and a Toaster. */
export function renderPrPanel() {
  return render(
    <>
      <ShellPanes />
      <ConfirmDialog />
      <Toaster theme="dark" />
    </>,
  );
}

/** Lets reads land and a picked menu item run. A test that timed out stops here (src/test/isolate.ts). */
export async function settle(times = 2): Promise<void> {
  for (let i = 0; i < times; i++) {
    throwIfTimedOut();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  throwIfTimedOut();
}

/** The open pull request tab for this pull request in the current space, if any. */
function layoutPrTab(number: number, slug: string): string | undefined {
  return layoutTabs().find((t) => t.kind === "pullrequest" && t.params.number === String(number) && (t.params.slug ?? "").toLowerCase() === slug.toLowerCase())?.id;
}

/**
 * Opens a pull request in the current selection's tabs (a row's click) and shows it, once the
 * layout has it, and lets its detail load. A new tab opened into the focused pane stays behind its
 * active tab (the daemon's placement: an open does not take the focus), so the tab is then
 * clicked, as the user would.
 */
export async function openPr(number: number, slug = SLUG): Promise<void> {
  throwIfTimedOut();
  await act(async () => {
    openPullRequestInPanel({ slug, number });
    await layoutSettled();
  });
  const id = layoutPrTab(number, slug);
  if (id && !layoutTabs().find((t) => t.id === id)?.active) {
    await act(async () => {
      await focusTab(id);
      await layoutSettled();
    });
  }
  await settle();
}

/** The pull request tabs' titles in the panes' strips, pane by pane. */
export function prTabs(): string[] {
  return screen.queryAllByTestId("shell-tab").flatMap((t) => (t.dataset.kind === "pullrequest" ? [within(t).getByTestId("shell-tab-label").textContent.trim()] : []));
}

/** The layout id of the pull request tab with this title in the panes' strips. */
function prTabId(title: string): string {
  const tab = screen.queryAllByTestId("shell-tab").find((t) => t.dataset.kind === "pullrequest" && within(t).getByTestId("shell-tab-label").textContent.trim() === title);
  if (!tab?.dataset.tabId) throw new Error(`no pull request tab ${title}`);
  return tab.dataset.tabId;
}

/** Selects a pull request tab by its title, as a click on it does (tab.focus: focus_tab). */
export async function selectPrTab(title: string): Promise<void> {
  const id = prTabId(title);
  await act(async () => {
    await focusTab(id);
    await layoutSettled();
  });
}

/** Closes a pull request tab by its title, as its × does (tab.close: close_tab). */
export async function closePrTab(title: string): Promise<void> {
  const id = prTabId(title);
  await act(async () => {
    await applyLayoutOp({ op: "close_tab", tab: id }).catch(() => undefined);
    await layoutSettled();
  });
}

/** Radix opens a dropdown on pointerdown (left button, no ctrl). */
export function press(el: HTMLElement): void {
  fireEvent.pointerDown(el, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

/** Clicks a menu item (Radix runs onSelect on click) and lets what it starts run. */
export async function pick(el: HTMLElement): Promise<void> {
  fireEvent.click(el);
  await settle();
}

/** Every toast's title and description, in order. */
export function toastTexts(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-sonner-toast]")].map((t) => t.textContent.trim());
}

/** The texts of every element with a test id, in document order. */
export function texts(testId: string, root: ParentNode = document): string[] {
  return [...root.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)].map((e) => e.textContent.trim());
}
