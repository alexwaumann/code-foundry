/**
 * The new-thread composer over the mock's world (src/test/projectsWorld.ts): the settings
 * the mock starts with (Sonnet 5 at medium, its model registry), the composer the
 * selection shows (App.tsx's Content, keyed the same way), and helpers for its pickers.
 * Pair with src/test/daemonFakes.ts (thread.new and the other commands) and
 * src/test/composerFakes.ts (ListRefs, ListSkills, StageAttachment).
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import { vi } from "vitest";
import { Composer } from "@/components/compose/Composer";
import { useComposeStore } from "@/stores/compose";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { resetComposerDaemon } from "./composerFakes";
import { resetDaemon } from "./daemonFakes";
import { seedWorld } from "./projectsWorld";

/** internal/model's registry as the mock's settings schema lists it. */
export const MODEL_CHOICES = [
  { value: "claude-opus-5-5[1m]", label: "Opus 5.5" },
  { value: "claude-opus-4-8[1m]", label: "Opus 4.8" },
  { value: "claude-opus-4-7[1m]", label: "Opus 4.7" },
  { value: "claude-sonnet-5-5[1m]", label: "Sonnet 5.5" },
  { value: "claude-sonnet-5[1m]", label: "Sonnet 5" },
  { value: "claude-sonnet-4-6[1m]", label: "Sonnet 4.6" },
  { value: "claude-haiku-5-5[1m]", label: "Haiku 5.5" },
  { value: "claude-4.5-haiku[1m]", label: "Haiku 4.5" },
];

/** jsdom lays nothing out: ProseMirror, cmdk and Radix ask for rects, scrolling and observers. */
export function stubLayout(): void {
  const noRects = () => [] as unknown as DOMRectList;
  Range.prototype.getClientRects = noRects;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Element.prototype.getClientRects = noRects;
  Element.prototype.scrollIntoView = () => undefined;
  if (typeof Element.prototype.scrollTo !== "function") Element.prototype.scrollTo = () => undefined;
  if (typeof Element.prototype.hasPointerCapture !== "function") Element.prototype.hasPointerCapture = () => false;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = () => undefined;
      unobserve = () => undefined;
      disconnect = () => undefined;
    },
  );
  URL.createObjectURL = vi.fn(() => "blob:draft");
  URL.revokeObjectURL = vi.fn();
}

/**
 * The mock's world with its settings (`settings` over them: "threads.default_worktree":
 * "new" is e2e's freshCopyByDefault), no drafts, and the fakes reset.
 */
export function seedComposer(settings: Record<string, string> = {}): void {
  stubLayout();
  resetDaemon();
  resetComposerDaemon();
  seedWorld();
  useComposeStore.setState({ drafts: {}, refs: {}, preview: null });
  useSettingsStore.setState({
    modelChoices: MODEL_CHOICES,
    snapshot: { values: { "threads.default_model": "claude-sonnet-5[1m]", "threads.default_effort": "medium", ...settings }, path: "", revision: 1, loadError: "", issues: [], restartPending: [] },
  });
}

/** Selects a project's new-thread composer (cmd+N, then its row). */
export function composeIn(projectId: string): void {
  act(() => {
    useUiStore.getState().select({ kind: "compose", projectId });
  });
}

/** What App.tsx's Content shows for the selection: the composer it keys, else the thread's id. */
export function SelectedComposer() {
  const sel = useUiStore((s) => s.selection);
  if (sel.kind === "thread") return <div data-testid="selected-thread">{sel.id}</div>;
  if (sel.kind !== "compose") return <div data-testid="selected-view">{sel.kind === "view" ? sel.name : sel.kind}</div>;
  return (
    <Composer
      key={sel.likeThreadId ? `like:${sel.likeThreadId}` : sel.workspaceId ? `ws:${sel.workspaceId}` : sel.noProject ? "home:" : sel.projectId}
      projectId={sel.projectId}
      workspaceId={sel.workspaceId}
      noProject={sel.noProject}
      likeThreadId={sel.likeThreadId}
    />
  );
}

/** Lets promises and effects settle (refs and skills arriving, a send's await chain). */
export async function settle(n = 5): Promise<void> {
  await act(async () => {
    for (let i = 0; i < n; i++) await Promise.resolve();
  });
}

/** Opens a composer picker by its trigger's test id ("composer-worktree") and returns its list. */
export async function openPicker(testId: string): Promise<HTMLElement> {
  act(() => {
    fireEvent.click(screen.getByTestId(testId));
  });
  return await screen.findByTestId(`${testId}-list`);
}

/** A picker list's option texts (Radix and cmdk render them as role option). */
export function optionTexts(list: HTMLElement): string[] {
  return within(list)
    .queryAllByRole("option")
    .map((o) => o.textContent);
}

/** Picks the option whose text contains `text` in an open picker list. */
export async function pickOption(list: HTMLElement, text: string): Promise<void> {
  const option = within(list)
    .getAllByRole("option")
    .find((o) => o.textContent.includes(text));
  if (!option) throw new Error(`no option "${text}" in ${optionTexts(list).join(" | ")}`);
  act(() => {
    fireEvent.click(option);
  });
  await settle();
}

/** The prompt as the draft stores it (composer-prompt's data-value). */
export function promptValue(): string {
  return screen.getByTestId("composer-prompt").getAttribute("data-value") ?? "";
}

/** Clicks the send button and lets the send's chain run. */
export async function send(): Promise<void> {
  act(() => {
    fireEvent.click(screen.getByTestId("composer-send"));
  });
  await settle(20);
}
