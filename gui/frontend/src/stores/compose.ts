/**
 * New-thread drafts, one per repo, so switching the selection away and back keeps what
 * was typed and attached. Kept in memory only (not persisted): the files behind the
 * attachments do not survive a reload anyway. Also caches each repo's base refs
 * (RepoService.ListRefs) for the base-ref picker.
 *
 * The draft's text is the prompt with inline image chips as tokens (lib/prompt.ts); the
 * attachments are the images themselves (the thumbnails). A chip refers to an attachment
 * by id; removing a chip from the text keeps the attachment.
 *
 * Sending stages the attachments (SessionService.StageAttachment) and invokes the
 * session.new registry command, like every other user action.
 */
import { create } from "zustand";
import { listRefs } from "@/api/repo";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MIME_TYPES, stageAttachment } from "@/api/session";
import { isOutdatedDaemon } from "@/api/errors";
import { errorMessage } from "@/api/stream";
import { checkAttachments, createdSessionId, DEFAULT_PERMISSION, sessionNewArgs, type ComposePermission, type WorktreeChoice } from "@/lib/compose";
import { projectPrompt, removeReferences } from "@/lib/prompt";
import { invokeConfirmed, refreshCommands } from "./commands";
import { getUiContext } from "./context";
import { useReposStore } from "./repos";
import { SESSION_COMMANDS } from "./sessionActions";
import { useUiStore } from "./ui";

export interface DraftAttachment {
  id: string;
  file: File;
  /** Object URL for the thumbnail; revoked when the attachment goes away. */
  url: string;
  /** Daemon path once staged; a retry after a failed send reuses it. */
  stagedPath: string | null;
}

/** idle: editable. attaching: staging images. starting: session.new in flight. */
export type DraftPhase = "idle" | "attaching" | "starting";

export interface Draft {
  /** The prompt, chips as `![name](cf-attachment://<id>)` tokens. */
  text: string;
  attachments: readonly DraftAttachment[];
  /** null: the settings default (sessions.default_model / default_effort). */
  model: string | null;
  effort: string | null;
  permission: ComposePermission;
  worktree: WorktreeChoice;
  /** null: the repo's default base ref (ListRefs.default_ref). */
  base: string | null;
  phase: DraftPhase;
  /** Why the last send failed. */
  error: string | null;
  /** Attachments that were rejected (type, size, count). */
  notice: string | null;
}

export interface RefsState {
  status: "loading" | "ready" | "error";
  refs: readonly string[];
  defaultRef: string;
  error: string | null;
  /** The daemon predates ListRefs (error is the restart hint). */
  outdated: boolean;
}

/** The attachment shown in the preview lightbox. */
export interface AttachmentPreview {
  repoId: string;
  id: string;
  /** Focused again when the preview closes (the thumbnail, or the prompt for a chip). */
  returnFocus: HTMLElement | null;
  /** False while closing: the last preview stays for the exit animation and focus return. */
  open: boolean;
}

interface ComposeState {
  drafts: Readonly<Record<string, Draft>>;
  refs: Readonly<Record<string, RefsState>>;
  preview: AttachmentPreview | null;
}

export const emptyDraft: Draft = {
  text: "",
  attachments: [],
  model: null,
  effort: null,
  permission: DEFAULT_PERMISSION,
  worktree: { kind: "new" },
  base: null,
  phase: "idle",
  error: null,
  notice: null,
};

export const useComposeStore = create<ComposeState>()(() => ({ drafts: {}, refs: {}, preview: null }));

export function getDraft(repoId: string): Draft {
  return useComposeStore.getState().drafts[repoId] ?? emptyDraft;
}

/** One field of a repo's draft (narrow selector). */
export function useDraft<K extends keyof Draft>(repoId: string, key: K): Draft[K] {
  return useComposeStore((s) => (s.drafts[repoId] ?? emptyDraft)[key]);
}

export function updateDraft(repoId: string, patch: Partial<Draft>): void {
  useComposeStore.setState((s) => ({ drafts: { ...s.drafts, [repoId]: { ...(s.drafts[repoId] ?? emptyDraft), ...patch } } }));
}

export function isDraftEmpty(d: Pick<Draft, "text" | "attachments">): boolean {
  return d.text.trim() === "" && d.attachments.length === 0;
}

let nextAttachmentId = 1;

/**
 * Adds pasted, dropped or picked files; rejects other types, oversized files and more
 * than 10. Returns the ones added (the editor puts chips for them into the text).
 */
export function addAttachments(repoId: string, files: readonly File[]): DraftAttachment[] {
  if (files.length === 0) return [];
  const d = getDraft(repoId);
  const { accepted, rejected } = checkAttachments(files, d.attachments.length, { types: ATTACHMENT_MIME_TYPES, maxBytes: ATTACHMENT_MAX_BYTES });
  const added = accepted.map<DraftAttachment>((file) => ({ id: `a${String(nextAttachmentId++)}`, file, url: URL.createObjectURL(file), stagedPath: null }));
  updateDraft(repoId, { attachments: [...d.attachments, ...added], notice: rejected.length > 0 ? rejected.join(" · ") : null });
  return added;
}

/** Removes an attachment and every chip that refers to it. */
export function removeAttachment(repoId: string, id: string): void {
  const d = getDraft(repoId);
  const gone = d.attachments.find((a) => a.id === id);
  if (!gone) return;
  URL.revokeObjectURL(gone.url);
  updateDraft(repoId, { attachments: d.attachments.filter((a) => a !== gone), text: removeReferences(d.text, id), notice: null });
}

/** Opens the preview of a draft's attachment; does nothing when the attachment is gone. */
export function openPreview(repoId: string, id: string, returnFocus: HTMLElement | null): boolean {
  if (!getDraft(repoId).attachments.some((a) => a.id === id)) return false;
  useComposeStore.setState({ preview: { repoId, id, returnFocus, open: true } });
  return true;
}

export function closePreview(): void {
  useComposeStore.setState((s) => (s.preview?.open ? { preview: { ...s.preview, open: false } } : s));
}

export function clearDraft(repoId: string): void {
  const d = useComposeStore.getState().drafts[repoId];
  if (!d) return;
  for (const a of d.attachments) URL.revokeObjectURL(a.url);
  useComposeStore.setState((s) => {
    const { [repoId]: _gone, ...drafts } = s.drafts;
    return { drafts };
  });
}

/** Opens the project picker (session.new's GUI presentation; see keys/bindings.ts). */
export function openNewThreadPicker(): void {
  const ui = useUiStore.getState();
  const returnTo = ui.palette.open ? ui.palette.returnTo : ui.focus;
  // Deferred: picked inside the palette, the palette closes after the presenter runs.
  queueMicrotask(() => {
    useUiStore.getState().openProjectPicker(returnTo);
  });
}

/** Shows the composer for a repo and focuses it. */
export function composeIn(repoId: string, worktreePath?: string): void {
  if (worktreePath) updateDraft(repoId, { worktree: { kind: "existing", path: worktreePath } });
  const ui = useUiStore.getState();
  ui.select({ kind: "compose", repoId });
  ui.focusComposer();
}

/** Loads the repo's base refs (once per composer mount; the previous list shows meanwhile). */
export async function loadRefs(repoId: string): Promise<void> {
  const prev = useComposeStore.getState().refs[repoId];
  const set = (r: RefsState) => {
    useComposeStore.setState((s) => ({ refs: { ...s.refs, [repoId]: r } }));
  };
  if (!prev) set({ status: "loading", refs: [], defaultRef: "", error: null, outdated: false });
  try {
    const res = await listRefs(repoId);
    set({ status: "ready", refs: res.refs, defaultRef: res.defaultRef, error: null, outdated: false });
  } catch (err) {
    if (prev?.status === "ready") return;
    set({ status: "error", refs: [], defaultRef: "", error: errorMessage(err), outdated: isOutdatedDaemon(err) });
  }
}

/** The worktree choice, falling back to a new worktree when the chosen one is gone. */
export function effectiveWorktree(repoId: string, choice: WorktreeChoice): WorktreeChoice {
  if (choice.kind === "new") return choice;
  const exists = useReposStore.getState().byId[repoId]?.worktrees.some((w) => w.path === choice.path) ?? false;
  return exists ? choice : { kind: "new" };
}

/**
 * Sends a repo's draft: stages its images one by one, then invokes session.new. On
 * success the draft is cleared and the new thread selected (the daemon's FocusSession
 * intent usually got there first). On failure the draft stays, with the error.
 */
export async function sendDraft(repoId: string, defaults: { model: string; effort: string }): Promise<boolean> {
  const d = getDraft(repoId);
  if (d.phase !== "idle" || isDraftEmpty(d)) return false;
  const pending = d.attachments.filter((a) => a.stagedPath === null);
  updateDraft(repoId, { phase: pending.length > 0 ? "attaching" : "starting", error: null, notice: null });
  try {
    for (const a of pending) {
      const path = await stageAttachment(a.file);
      const cur = getDraft(repoId);
      updateDraft(repoId, { attachments: cur.attachments.map((x) => (x.id === a.id ? { ...x, stagedPath: path } : x)) });
    }
    updateDraft(repoId, { phase: "starting" });
    const cur = getDraft(repoId);
    const refs = useComposeStore.getState().refs[repoId];
    const staged = new Map(cur.attachments.map((a) => [a.id, a]));
    const text = projectPrompt(cur.text, (id) => {
      const a = staged.get(id);
      return a?.stagedPath ? { name: a.file.name, ref: a.stagedPath } : undefined;
    });
    const args = sessionNewArgs(
      repoId,
      {
        text,
        model: cur.model ?? defaults.model,
        effort: cur.effort ?? defaults.effort,
        permission: cur.permission,
        worktree: effectiveWorktree(repoId, cur.worktree),
        base: cur.base ?? refs?.defaultRef ?? "",
      },
      cur.attachments.flatMap((a) => (a.stagedPath ? [a.stagedPath] : [])),
    );
    const res = await invokeConfirmed(SESSION_COMMANDS.create, args, getUiContext({ kind: "compose", repoId }));
    if (!res) {
      updateDraft(repoId, { phase: "idle" });
      return false;
    }
    clearDraft(repoId);
    const id = createdSessionId(res.resultJson);
    const ui = useUiStore.getState();
    // Replace the composer with the new thread unless the user has moved on.
    if (id && ui.selection.kind === "compose" && ui.selection.repoId === repoId) ui.select({ kind: "session", id }, { focusTerminal: true });
    return true;
  } catch (err) {
    updateDraft(repoId, { phase: "idle", error: errorMessage(err) });
    return false;
  } finally {
    void refreshCommands();
  }
}
