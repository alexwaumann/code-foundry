/**
 * Renders the side panel the way the app shows a pull request in it, for component tests of
 * the Pull request surface (src/components/pr): the Pull Requests page selected, the real
 * SidePanel (its tab strip and the surface), the confirm dialog and a sonner Toaster. Pair with
 * src/test/prWorld.ts (the mock's pull requests) and src/test/daemonFakes.ts (the commands),
 * mocked in the test file. Imports stores: load it after the vi.mock calls (await import).
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { ConfirmDialog } from "@/components/confirm/ConfirmDialog";
import { SidePanel } from "@/components/panel/SidePanel";
import { Toaster } from "@/components/ui/sonner";
import { useCommandsStore } from "@/stores/commands";
import { useConfirmStore } from "@/stores/confirm";
import { dashboardResource, pullRequestDetailResource, viewerResource } from "@/stores/gh";
import { usePanelStore } from "@/stores/panel";
import { openPullRequestInPanel, reviewerCandidatesResource, usePrPanelStore } from "@/stores/prPanel";
import { usePrThreadsStore } from "@/stores/prThreads";
import { useReviewerRecentsStore } from "@/stores/reviewerRecents";
import { useUiStore, type Selection } from "@/stores/ui";
import { useViewsStore } from "@/stores/views";
import { PR_COMMANDS, SLUG } from "./prWorld";

export const PR_PAGE: Selection = { kind: "view", name: "pullrequests" };

/** Forgets every pull request read, panel, busy flag and recent reviewer; selects the Pull Requests page. */
export function resetPrStores(selection: Selection = PR_PAGE): void {
  if (typeof Element.prototype.scrollIntoView !== "function") Element.prototype.scrollIntoView = () => undefined;
  if (typeof Element.prototype.scrollTo !== "function") Element.prototype.scrollTo = () => undefined;
  pullRequestDetailResource.store.setState({ entries: {} });
  reviewerCandidatesResource.store.setState({ entries: {} });
  dashboardResource.store.setState({ entries: {} });
  viewerResource.store.setState({ entries: {} });
  usePrPanelStore.setState({ byTab: {}, refreshing: {}, requesting: {}, confirmed: {}, merging: {}, reviewing: {} });
  usePrThreadsStore.setState({ starting: {} });
  useReviewerRecentsStore.setState({ bySlug: {} });
  usePanelStore.setState({ byKey: {} });
  useConfirmStore.setState({ pending: null });
  useCommandsStore.setState({ commands: PR_COMMANDS });
  useViewsStore.setState({ settingsOpen: false, usageOpen: false });
  useUiStore.setState({ selection, windowWidth: 1400, sidebarVisible: true, sidebarWidth: 260 });
}

/** The side panel, the confirm dialog and a Toaster. */
export function renderPrPanel() {
  return render(
    <>
      <SidePanel />
      <ConfirmDialog />
      <Toaster theme="dark" />
    </>,
  );
}

/** Lets reads land and a picked menu item run. */
export async function settle(times = 2): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** Opens a pull request in the current selection's panel (a row's click) and lets its detail load. */
export async function openPr(number: number, slug = SLUG): Promise<void> {
  act(() => {
    openPullRequestInPanel({ slug, number });
  });
  await settle();
}

/** The panel's tab titles. */
export function prTabs(): string[] {
  const strip = screen.queryByTestId("panel-tabs");
  return strip ? within(strip).queryAllByRole("tab").map((t) => t.textContent.trim()) : [];
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
