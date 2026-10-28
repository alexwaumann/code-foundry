/**
 * The "Previous prompts" picker's window side (docs/notes/prompt-history-2-picker.md):
 * the composers that can open it (a registry, like stores/cite.ts's targets), putting a
 * picked prompt in a draft, showing a prompt in its thread, copying it, and the
 * composer.history command's presentation (the focused composer's picker, else the
 * palette's prompts page).
 */
import { toast } from "sonner";
import type { PromptScopeView, SentPromptView } from "@/api/thread";
import { newCitationId } from "@/lib/citation";
import { copyText } from "@/lib/clipboard";
import { draftKey as composeDraftKey, type ComposeTarget } from "@/lib/compose";
import { draftOfSent } from "@/lib/failedPrompt";
import { getTimeline } from "./cite";
import { putCitation, updateDraft } from "./compose";
import { getUiContext } from "./context";
import { threadDraftKey } from "./threadActions";
import { useThreadsStore } from "./threads";
import { useUiStore, type Selection } from "./ui";

/** Where a composer's Project scope reads: its thread, or its project set (none: the threads without a project). */
export interface PromptSource {
  threadId?: string;
  projectIds?: readonly string[];
}

/** A mounted composer the picker can open in. */
export interface HistoryComposer {
  /** The composer's draft. */
  draftKey: string;
  /** Its root element: the command opens the picker in the composer that has the keyboard. */
  root: () => HTMLElement | null;
  /** Opens its picker. */
  open: () => void;
  /** Its Project scope's source (the palette lists the same). */
  source: () => PromptSource;
  /** Focuses its prompt, caret at the end. */
  focus: () => void;
}

const composers = new Set<HistoryComposer>();

/** A composer registers while mounted. Returns the unregister. */
export function registerHistoryComposer(c: HistoryComposer): () => void {
  composers.add(c);
  return () => {
    composers.delete(c);
  };
}

function composerOf(draftKey: string): HistoryComposer | undefined {
  for (const c of composers) if (c.draftKey === draftKey) return c;
  return undefined;
}

/**
 * Puts a prompt in a draft, replacing its text (the picker's filter): the composer text
 * when the prompt had tags, so they come back as chips, else the text. Citations get new
 * draft ids (lib/failedPrompt draftOfSent, as the failed-prompt notice's Edit does).
 */
export function insertPrompt(draftKey: string, p: SentPromptView): void {
  const d = draftOfSent({ text: p.text, composerText: p.composerText, attachments: [] }, () => undefined, newCitationId);
  for (const c of d.citations) putCitation(draftKey, c);
  updateDraft(draftKey, { text: d.text, error: null });
}

/** Copies a prompt's text. */
export async function copyPrompt(p: SentPromptView): Promise<void> {
  try {
    await copyText(p.text);
    toast.success("Prompt copied");
  } catch {
    toast.error("Copy failed");
  }
}

/** How long a prompt shown in another thread waits for that thread's timeline and row. */
const REVEAL_FRAMES = 180;

/**
 * Shows a prompt in its thread: selects the thread when it is not the one on screen, then
 * scrolls its user row to the top of the timeline (the prompt rail's jump) once the
 * timeline has it. A row that never shows (a prompt the timeline does not have) leaves the
 * thread selected.
 */
export function revealPrompt(p: SentPromptView): void {
  const ui = useUiStore.getState();
  const sel = ui.selection;
  if (sel.kind !== "thread" || sel.id !== p.threadId) ui.select({ kind: "thread", id: p.threadId });
  let tries = 0;
  const step = () => {
    if (getTimeline(p.threadId)?.showRow(p.itemId, "start")) return;
    if (++tries < REVEAL_FRAMES) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** The new-thread composer's target for a compose selection (components/compose/Composer.tsx). */
function composeTarget(sel: Extract<Selection, { kind: "compose" }>): ComposeTarget {
  if (sel.likeThreadId) return { kind: "like", threadId: sel.likeThreadId };
  if (sel.workspaceId) return { kind: "workspace", workspaceId: sel.workspaceId };
  if (sel.noProject) return { kind: "home" };
  return { kind: "project", projectId: sel.projectId };
}

/** The draft the window's composer edits: the selected thread's, the new-thread composer's, or none. */
export function activeDraftKey(sel: Selection = useUiStore.getState().selection): string | null {
  if (sel.kind === "thread") return threadDraftKey(sel.id);
  if (sel.kind === "compose") return composeDraftKey(composeTarget(sel));
  return null;
}

/**
 * What the palette's prompts page lists: the window's thread (This thread, and Project
 * around it), else the new-thread composer's set, else the active project. `scope` is
 * where it starts: This thread with a thread, Project with a composer or a project, else All.
 */
export function paletteSource(): { threadId: string; source: PromptSource; scope: PromptScopeView } {
  const sel = useUiStore.getState().selection;
  if (sel.kind === "thread") return { threadId: sel.id, source: { threadId: sel.id }, scope: "thread" };
  const key = activeDraftKey(sel);
  const c = key ? composerOf(key) : undefined;
  if (c) return { threadId: "", source: c.source(), scope: "project" };
  const project = getUiContext().activeProjectId;
  return project ? { threadId: "", source: { projectIds: [project] }, scope: "project" } : { threadId: "", source: {}, scope: "all" };
}

/**
 * The palette's Enter: the prompt goes into the window's composer (the thread's, else the
 * new-thread composer's). With neither on screen, the new-thread composer opens where the
 * prompt's thread worked (its workspace, else its project, else no project) with the
 * prompt as its draft.
 */
export function insertFromPalette(p: SentPromptView): void {
  const ui = useUiStore.getState();
  let key = activeDraftKey();
  if (key === null) {
    const t = useThreadsStore.getState().byId[p.threadId];
    const sel: Selection = t?.workspaceId
      ? { kind: "compose", projectId: t.projectId, workspaceId: t.workspaceId }
      : t?.projectId
        ? { kind: "compose", projectId: t.projectId }
        : { kind: "compose", projectId: "", noProject: true };
    key = activeDraftKey(sel);
    ui.select(sel);
  }
  if (key === null) return;
  insertPrompt(key, p);
  const target = key;
  // After the palette has closed and handed the keyboard back.
  requestAnimationFrame(() => {
    composerOf(target)?.focus();
  });
}

/**
 * composer.history in this window: the picker of the composer that has the keyboard, else
 * the palette's prompts page (deferred: picked in the palette, the palette closes after
 * the presenter runs).
 */
export function presentPromptHistory(): boolean {
  const active = document.activeElement;
  if (!useUiStore.getState().palette.open && active) {
    for (const c of composers) {
      if (c.root()?.contains(active)) {
        c.open();
        return true;
      }
    }
  }
  queueMicrotask(() => {
    useUiStore.getState().openPromptsPalette();
  });
  return true;
}
