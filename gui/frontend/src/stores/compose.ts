/**
 * New-thread drafts, one per project and one per workspace (keyed by draftKey in
 * lib/compose.ts: the repo id, or "ws:<workspace id>"), so switching the selection away
 * and back keeps what was typed and attached. Kept in memory only (not persisted): the
 * files behind the attachments do not survive a reload anyway. Also caches each repo's
 * base refs (RepoService.ListRefs) for the base-ref picker.
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
import {
  checkAttachments,
  createdSessionId,
  DEFAULT_PERMISSION,
  draftKey,
  draftMembers,
  isWorkspaceKey,
  threadArgs,
  threadPlace,
  type ComposePermission,
  type ComposeTarget,
  type ThreadPlace,
  type WorktreeChoice,
} from "@/lib/compose";
import { projectPrompt, removeReferences } from "@/lib/prompt";
import { invokeConfirmed, refreshCommands } from "./commands";
import { getUiContext } from "./context";
import { useReposStore } from "./repos";
import { SESSION_COMMANDS } from "./sessionActions";
import { useUiStore, type Selection } from "./ui";
import { useWorkspacesStore } from "./workspaces";

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
  /** null: the primary repo's default base ref (ListRefs.default_ref). */
  base: string | null;
  /** Project drafts: other projects the thread also works in (a new workspace on send). */
  alsoIn: readonly string[];
  /** Repo id of the member the thread runs in; null: the project, or the workspace's first member. */
  primary: string | null;
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
  /** The draft (draftKey) the attachment belongs to. */
  draftKey: string;
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
  alsoIn: [],
  primary: null,
  phase: "idle",
  error: null,
  notice: null,
};

/** A workspace draft starts in the workspace's own worktrees. */
export const emptyWorkspaceDraft: Draft = { ...emptyDraft, worktree: { kind: "members" } };

function blankDraft(key: string): Draft {
  return isWorkspaceKey(key) ? emptyWorkspaceDraft : emptyDraft;
}

export const useComposeStore = create<ComposeState>()(() => ({ drafts: {}, refs: {}, preview: null }));

export function getDraft(key: string): Draft {
  return useComposeStore.getState().drafts[key] ?? blankDraft(key);
}

/** One field of a draft (narrow selector). */
export function useDraft<K extends keyof Draft>(key: string, field: K): Draft[K] {
  return useComposeStore((s) => (s.drafts[key] ?? blankDraft(key))[field]);
}

export function updateDraft(key: string, patch: Partial<Draft>): void {
  useComposeStore.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...(s.drafts[key] ?? blankDraft(key)), ...patch } } }));
}

/** Runs the thread in another member. The base picker lists that repo's refs, so its choice resets. */
export function setPrimary(key: string, repoId: string): void {
  const d = getDraft(key);
  if (d.primary === repoId) return;
  updateDraft(key, { primary: repoId, base: null, error: null });
}

/** Adds a project the thread also works in ("Also in"). */
export function addAlsoIn(key: string, repoId: string): void {
  const d = getDraft(key);
  if (d.alsoIn.includes(repoId)) return;
  updateDraft(key, { alsoIn: [...d.alsoIn, repoId], error: null });
}

/** Drops an "Also in" project; if the thread was to run there, it runs in the project again. */
export function removeAlsoIn(key: string, repoId: string): void {
  const d = getDraft(key);
  if (!d.alsoIn.includes(repoId)) return;
  updateDraft(key, {
    alsoIn: d.alsoIn.filter((id) => id !== repoId),
    ...(d.primary === repoId ? { primary: null, base: null } : {}),
    error: null,
  });
}

export function isDraftEmpty(d: Pick<Draft, "text" | "attachments">): boolean {
  return d.text.trim() === "" && d.attachments.length === 0;
}

let nextAttachmentId = 1;

/**
 * Adds pasted, dropped or picked files; rejects other types, oversized files and more
 * than 10. Returns the ones added (the editor puts chips for them into the text).
 */
export function addAttachments(key: string, files: readonly File[]): DraftAttachment[] {
  if (files.length === 0) return [];
  const d = getDraft(key);
  const { accepted, rejected } = checkAttachments(files, d.attachments.length, { types: ATTACHMENT_MIME_TYPES, maxBytes: ATTACHMENT_MAX_BYTES });
  const added = accepted.map<DraftAttachment>((file) => ({ id: `a${String(nextAttachmentId++)}`, file, url: URL.createObjectURL(file), stagedPath: null }));
  updateDraft(key, { attachments: [...d.attachments, ...added], notice: rejected.length > 0 ? rejected.join(" · ") : null });
  return added;
}

/** Removes an attachment and every chip that refers to it. */
export function removeAttachment(key: string, id: string): void {
  const d = getDraft(key);
  const gone = d.attachments.find((a) => a.id === id);
  if (!gone) return;
  URL.revokeObjectURL(gone.url);
  updateDraft(key, { attachments: d.attachments.filter((a) => a !== gone), text: removeReferences(d.text, id), notice: null });
}

/** Opens the preview of a draft's attachment; does nothing when the attachment is gone. */
export function openPreview(key: string, id: string, returnFocus: HTMLElement | null): boolean {
  if (!getDraft(key).attachments.some((a) => a.id === id)) return false;
  useComposeStore.setState({ preview: { draftKey: key, id, returnFocus, open: true } });
  return true;
}

export function closePreview(): void {
  useComposeStore.setState((s) => (s.preview?.open ? { preview: { ...s.preview, open: false } } : s));
}

export function clearDraft(key: string): void {
  const d = useComposeStore.getState().drafts[key];
  if (!d) return;
  for (const a of d.attachments) URL.revokeObjectURL(a.url);
  useComposeStore.setState((s) => {
    const { [key]: _gone, ...drafts } = s.drafts;
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

/**
 * Shows the composer for a workspace and focuses it. The selection carries the first
 * member's repo for the command context (session.new's availability); the draft names
 * the member the thread runs in.
 */
export function composeInWorkspace(workspaceId: string): void {
  const first = useWorkspacesStore.getState().byId[workspaceId]?.members[0]?.repoId ?? "";
  const ui = useUiStore.getState();
  ui.select({ kind: "compose", repoId: first, workspaceId });
  ui.focusComposer();
}

/** The composer target a compose selection shows. */
export function composeTarget(sel: Extract<Selection, { kind: "compose" }>): ComposeTarget {
  return sel.workspaceId ? { kind: "workspace", workspaceId: sel.workspaceId } : { kind: "project", repoId: sel.repoId };
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

/** Where a draft's thread would start now (null: its workspace is gone). */
export function draftPlace(target: ComposeTarget, d: Draft): ThreadPlace | null {
  const repos = useReposStore.getState().byId;
  const workspace = target.kind === "workspace" ? useWorkspacesStore.getState().byId[target.workspaceId] : undefined;
  const isRepo = (id: string) => id in repos;
  const { primary } = draftMembers({ target, alsoIn: d.alsoIn, primary: d.primary }, workspace, isRepo);
  return threadPlace(
    { target, worktree: d.worktree, base: d.base, alsoIn: d.alsoIn, primary: d.primary },
    {
      workspace,
      isRepo,
      hasWorktree: (repoId, path) => repos[repoId]?.worktrees.some((w) => w.path === path) ?? false,
      defaultRef: useComposeStore.getState().refs[primary]?.defaultRef ?? "",
    },
  );
}

/**
 * Sends a draft: stages its images one by one, then invokes session.new. On success the
 * draft is cleared and the new thread selected (the daemon's FocusSession intent usually
 * got there first). On failure the draft stays, with the error.
 */
export async function sendDraft(target: ComposeTarget, defaults: { model: string; effort: string }): Promise<boolean> {
  const key = draftKey(target);
  const d = getDraft(key);
  if (d.phase !== "idle" || isDraftEmpty(d)) return false;
  const pending = d.attachments.filter((a) => a.stagedPath === null);
  updateDraft(key, { phase: pending.length > 0 ? "attaching" : "starting", error: null, notice: null });
  try {
    for (const a of pending) {
      const path = await stageAttachment(a.file);
      const cur = getDraft(key);
      updateDraft(key, { attachments: cur.attachments.map((x) => (x.id === a.id ? { ...x, stagedPath: path } : x)) });
    }
    updateDraft(key, { phase: "starting" });
    const cur = getDraft(key);
    const place = draftPlace(target, cur);
    if (!place) throw new Error("This workspace no longer exists.");
    const staged = new Map(cur.attachments.map((a) => [a.id, a]));
    const text = projectPrompt(cur.text, (id) => {
      const a = staged.get(id);
      return a?.stagedPath ? { name: a.file.name, ref: a.stagedPath } : undefined;
    });
    const args = threadArgs(
      place,
      { text, model: cur.model ?? defaults.model, effort: cur.effort ?? defaults.effort, permission: cur.permission },
      cur.attachments.flatMap((a) => (a.stagedPath ? [a.stagedPath] : [])),
    );
    const sel: Selection = target.kind === "project" ? { kind: "compose", repoId: target.repoId } : { kind: "compose", repoId: place.repoId, workspaceId: target.workspaceId };
    const res = await invokeConfirmed(SESSION_COMMANDS.create, args, getUiContext(sel));
    if (!res) {
      updateDraft(key, { phase: "idle" });
      return false;
    }
    clearDraft(key);
    const id = createdSessionId(res.resultJson);
    const ui = useUiStore.getState();
    // Replace the composer with the new thread unless the user has moved on.
    if (id && ui.selection.kind === "compose" && draftKey(composeTarget(ui.selection)) === key) ui.select({ kind: "session", id }, { focusTerminal: true });
    return true;
  } catch (err) {
    updateDraft(key, { phase: "idle", error: errorMessage(err) });
    return false;
  } finally {
    void refreshCommands();
  }
}
