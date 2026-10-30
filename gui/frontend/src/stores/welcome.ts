/**
 * The first-run welcome on the home composer (docs/notes/welcome-composer.md). With zero
 * projects (the projects store loaded and empty) the No project composer says "Welcome to
 * Code Foundry" and its prompt is prefilled, never sent, with the tutorial prompt naming
 * the page the daemon places at every start (HealthService.Version's welcome_page,
 * docs/notes/welcome-page.md). The prefill happens once per window and only into an empty
 * draft, so a draft the user typed is never replaced and one they cleared stays clear.
 * When the first project arrives, a prefilled prompt the user left untouched is cleared
 * (they did not write it); an edited one stays.
 */
import { create } from "zustand";
import { welcomePage } from "@/api/health";
import { draftKey } from "@/lib/compose";
import { getDraft, isDraftEmpty, updateDraft } from "./compose";
import { useProjectsStore } from "./projects";

/**
 * The tutorial prompt for the placed page at `page`. The wording is measured: without
 * "and walk me through it" the thread shows an inline card instead (welcome-page.md).
 */
export function welcomePrompt(page: string): string {
  return `I just installed Code Foundry and have no projects yet. This is the welcome tutorial: open the page ${page} in the side panel and walk me through it.`;
}

/** The home composer's draft (No project). */
export const HOME_DRAFT = draftKey({ kind: "home" });

interface WelcomeState {
  /** The placed page's absolute path; "" until read. */
  page: string;
  /** The prefill was decided in this window (made, or skipped for a draft already typed). */
  decided: boolean;
}

export const useWelcomeStore = create<WelcomeState>()(() => ({ page: "", decided: false }));

/** True while the window greets a first run: the projects are loaded and there are none. */
export function isWelcome(s: { loaded: boolean; order: readonly string[] }): boolean {
  return s.loaded && s.order.length === 0;
}

/** Whether the home composer shows the welcome (narrow: one boolean). */
export function useWelcome(): boolean {
  return useProjectsStore(isWelcome);
}

let loading: Promise<void> | null = null;

/** Reads the welcome page's path once (again after a failed read). */
export function loadWelcomePage(): Promise<void> {
  if (useWelcomeStore.getState().page) return Promise.resolve();
  loading ??= welcomePage()
    .then(
      (page) => {
        useWelcomeStore.setState({ page });
      },
      () => {
        // No prefill until a later read succeeds: the heading alone still greets.
      },
    )
    .finally(() => {
      loading = null;
    });
  return loading;
}

/**
 * Prefills the home draft with the tutorial prompt: once per window, while the welcome
 * shows and the page is known, and only into an empty draft.
 */
export function prefillWelcome(): void {
  const { page, decided } = useWelcomeStore.getState();
  if (!page || decided || !isWelcome(useProjectsStore.getState())) return;
  useWelcomeStore.setState({ decided: true });
  if (isDraftEmpty(getDraft(HOME_DRAFT))) updateDraft(HOME_DRAFT, { text: welcomePrompt(page) });
}

/**
 * Clears a prefilled prompt the user left untouched when the first project arrives (in
 * this window or elsewhere: the Add project dialog moves the window off the composer
 * first). Returns the unsubscribe.
 */
export function startWelcomeSync(): () => void {
  return useProjectsStore.subscribe((s, prev) => {
    if (!isWelcome(prev) || !s.loaded || s.order.length === 0) return;
    const { page, decided } = useWelcomeStore.getState();
    if (decided && page && getDraft(HOME_DRAFT).text === welcomePrompt(page)) updateDraft(HOME_DRAFT, { text: "" });
  });
}
