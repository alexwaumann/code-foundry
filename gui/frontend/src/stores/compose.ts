/**
 * New-thread drafts, one per project, one per workspace and one without a project (keyed
 * by draftKey in lib/compose.ts: the project id, "ws:<workspace id>", or "home:"), so switching the selection away
 * and back keeps what was typed and attached. Kept in memory only (not persisted): the
 * files behind the attachments do not survive a reload anyway. Also caches each project's
 * base refs (ProjectService.ListRefs) for the base-ref picker.
 *
 * The draft's text is the prompt with inline tags as tokens (lib/prompt.ts: attachment
 * chips, skills, files); the attachments are the images and PDFs themselves (the tiles).
 * A chip refers to an attachment by id; removing a chip from the text keeps the
 * attachment. Skill and file tags of a project go when the project leaves the draft.
 * A citation tag (text quoted from one of Claude's answers, docs/notes/citations.md)
 * refers to its body in `citations` by id, the way a chip refers to its attachment: kept
 * when the tag is deleted (undo brings it back), gone with the draft.
 *
 * A PDF's page count and first-page thumbnail come from pdf.js (lib/pdf.ts, loaded on
 * the first PDF) a moment after it is added; the inline cap and the "reads it page by
 * page" notice apply then (settlePdf).
 *
 * Sending stages the attachments (ThreadService.StageAttachment) and invokes the
 * thread.new registry command, like every other user action.
 */
import { create } from "zustand";
import { listRefs, type ProjectView } from "@/api/project";
import { ATTACHMENT_MIME_TYPES, attachmentMaxBytes, MAX_INLINE_PDF_PAGES, MESSAGE_INLINE_MAX_BYTES, PDF_MIME_TYPE, stageAttachment } from "@/api/threads";
import { isOutdatedDaemon } from "@/api/errors";
import { errorMessage } from "@/api/stream";
import {
  checkAttachments,
  createdThreadId,
  inlineBytes,
  inlineCapNotice,
  longPdfNotice,
  sentInline,
  DEFAULT_PERMISSION,
  defaultWorktree,
  draftKey,
  draftMembers,
  isWorkspaceKey,
  movedDraft,
  threadArgs,
  threadPlace,
  WORK_IN_SETTING_KEY,
  workInMemory,
  type AttachmentLimits,
  type ComposePermission,
  type ComposeTarget,
  type ProjectWorktree,
  type ThreadPlace,
  type WorktreeChoice,
} from "@/lib/compose";
import { pdfSummary } from "@/lib/pdf";
import { NO_PROJECT } from "@/lib/threadRow";
import { sentComposerText } from "@/lib/userMessage";
import { projectPrompt, removeReferences, removeProjectTags, projectTagCount, tagsByProject } from "@/lib/prompt";
import type { Citation } from "@/lib/citation";
import { invokeConfirmed, refreshCommands } from "./commands";
import { requestConfirm, type ConfirmRequest } from "./confirm";
import { getUiContext } from "./context";
import { useProjectsStore } from "./projects";
import { THREAD_COMMANDS } from "./threadActions";
import { useSettingsStore } from "./settings";
import { useUiStore, type Selection } from "./ui";
import { rememberedWorkIn, rememberWorkIn } from "./workIn";
import { useWorkspacesStore } from "./workspaces";

export interface DraftAttachment {
  id: string;
  file: File;
  kind: "image" | "pdf";
  /** Object URL of the file (an image's thumbnail, the preview); revoked when the attachment goes away. */
  url: string;
  /** Daemon path once staged; a retry after a failed send reuses it. */
  stagedPath: string | null;
  /** A PDF's page count: null while it is counted, or when pdf.js could not read it. Always null for an image. */
  pages: number | null;
  /** A PDF's first page as a data URL PDF_THUMB_WIDTH px wide; null until rendered (or when it did not render), and for an image. */
  thumb: string | null;
}

/** The width a PDF's first-page thumbnail is rendered at (the 64px tile at 2x). */
export const PDF_THUMB_WIDTH = 128;

/** What the composers accept (the daemon's limits, api/threads.ts). */
export const ATTACHMENT_LIMITS: AttachmentLimits = {
  types: ATTACHMENT_MIME_TYPES,
  pdfType: PDF_MIME_TYPE,
  maxBytes: attachmentMaxBytes,
  maxInlineBytes: MESSAGE_INLINE_MAX_BYTES,
  maxInlinePages: MAX_INLINE_PDF_PAGES,
};

/** idle: editable. attaching: staging attachments. starting: thread.new in flight. */
export type DraftPhase = "idle" | "attaching" | "starting";

export interface Draft {
  /** The prompt, tags as tokens (`![name](cf-attachment://<id>)`, `[/name](cf-skill://…)`, …). */
  text: string;
  attachments: readonly DraftAttachment[];
  /** null: the settings default (threads.default_model / default_effort). */
  model: string | null;
  effort: string | null;
  permission: ComposePermission;
  /**
   * null: the project's default, resolved live (projectWorktree: the choice remembered
   * for the project, else threads.default_worktree). Workspace drafts always have one.
   */
  worktree: WorktreeChoice | null;
  /** null: the primary project's default base ref (ListRefs.default_ref). */
  base: string | null;
  /** Project drafts: other projects the thread also works in (a new workspace on send). */
  alsoIn: readonly string[];
  /** Project id of the member the thread runs in; null: the project, or the workspace's first member. */
  primary: string | null;
  phase: DraftPhase;
  /** Why the last send failed. */
  error: string | null;
  /** Attachments that were rejected (type, size, count, inline cap), and PDFs Claude reads page by page; " · " between. */
  notice: string | null;
  /** Citation bodies by id (the text's `cf-cite://<id>` tokens name them). */
  citations: Readonly<Record<string, Citation>>;
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
  worktree: null,
  base: null,
  alsoIn: [],
  primary: null,
  phase: "idle",
  error: null,
  notice: null,
  citations: {},
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

/** Runs the thread in another member. The base picker lists that project's refs, so its choice resets. */
export function setPrimary(key: string, projectId: string): void {
  const d = getDraft(key);
  if (d.primary === projectId) return;
  updateDraft(key, { primary: projectId, base: null, error: null });
}

/** Adds a project the thread also works in ("Also in"). */
export function addAlsoIn(key: string, projectId: string): void {
  const d = getDraft(key);
  if (d.alsoIn.includes(projectId)) return;
  updateDraft(key, { alsoIn: [...d.alsoIn, projectId], error: null });
}

/**
 * Drops an "Also in" project and every tag in the text that refers to it (its skills and
 * files); if the thread was to run there, it runs in the project again.
 */
export function removeAlsoIn(key: string, projectId: string): void {
  const d = getDraft(key);
  if (!d.alsoIn.includes(projectId)) return;
  updateDraft(key, {
    alsoIn: d.alsoIn.filter((id) => id !== projectId),
    text: removeProjectTags(d.text, projectId),
    ...(d.primary === projectId ? { primary: null, base: null } : {}),
    error: null,
  });
}

export function isDraftEmpty(d: Pick<Draft, "text" | "attachments">): boolean {
  return d.text.trim() === "" && d.attachments.length === 0;
}

let nextAttachmentId = 1;

/** A file with no type but a .pdf name (some drags and pastes) typed as a PDF. */
function withPdfType(file: File): File {
  if (file.type !== "" || !/\.pdf$/i.test(file.name)) return file;
  return new File([file], file.name, { type: PDF_MIME_TYPE, lastModified: file.lastModified });
}

function inlineOf(a: DraftAttachment) {
  return { kind: a.kind, size: a.file.size, pages: a.pages };
}

/** The bytes a draft's attachments send inline so far (lib/compose sentInline). */
function draftInlineBytes(list: readonly DraftAttachment[]): number {
  return inlineBytes(list.map(inlineOf), MAX_INLINE_PDF_PAGES);
}

function withNotice(notice: string | null, add: string): string {
  return notice ? `${notice} · ${add}` : add;
}

/**
 * Adds pasted, dropped or picked files; rejects other types, oversized files, more than
 * 10, and images over the inline cap. Returns the ones added (the editor puts chips for
 * them into the text). Each PDF is then counted and its first page rendered (settlePdf).
 */
export function addAttachments(key: string, files: readonly File[]): DraftAttachment[] {
  if (files.length === 0) return [];
  const d = getDraft(key);
  const { accepted, rejected } = checkAttachments(files.map(withPdfType), { count: d.attachments.length, inlineBytes: draftInlineBytes(d.attachments) }, ATTACHMENT_LIMITS);
  const added = accepted.map<DraftAttachment>((file) => ({
    id: `a${String(nextAttachmentId++)}`,
    file,
    kind: file.type === PDF_MIME_TYPE ? "pdf" : "image",
    url: URL.createObjectURL(file),
    stagedPath: null,
    pages: null,
    thumb: null,
  }));
  updateDraft(key, { attachments: [...d.attachments, ...added], notice: rejected.length > 0 ? rejected.join(" · ") : null });
  for (const a of added) if (a.kind === "pdf") void summarizePdf(a);
  return added;
}

/** Counts a PDF's pages and renders its thumbnail (pdf.js, loaded on the first PDF: lib/pdf.ts). */
async function summarizePdf(a: DraftAttachment): Promise<void> {
  try {
    settlePdf(a.id, await pdfSummary(a.file, PDF_THUMB_WIDTH));
  } catch {
    // Not a PDF pdf.js reads: no count and no thumbnail. The daemon still takes it (it
    // counts with pdfinfo, else estimates) and checks the inline cap on send.
  }
}

/**
 * A PDF's page count and thumbnail arrived. They go to the draft that holds the PDF now
 * (a draft can have moved to another target meanwhile; one that is gone ignores them).
 * A PDF short enough to go inline that takes the message over the inline cap is removed
 * again, chips and all, with a notice (while the draft is idle and the PDF not staged yet;
 * a send under way, or a failed one the user may retry, leaves it to the daemon); a longer
 * one gets the "reads it page by page" notice.
 */
export function settlePdf(id: string, info: { pages: number; thumb: string | null }): void {
  const drafts = useComposeStore.getState().drafts;
  const key = Object.keys(drafts).find((k) => drafts[k]?.attachments.some((a) => a.id === id));
  const d = key === undefined ? undefined : drafts[key];
  const a = d?.attachments.find((x) => x.id === id);
  if (key === undefined || !d || !a) return;
  const settled: DraftAttachment = { ...a, pages: info.pages, thumb: info.thumb };
  const others = d.attachments.filter((x) => x.id !== id);
  if (d.phase === "idle" && a.stagedPath === null && sentInline(inlineOf(settled), MAX_INLINE_PDF_PAGES) && draftInlineBytes(others) + a.file.size > MESSAGE_INLINE_MAX_BYTES) {
    URL.revokeObjectURL(a.url);
    updateDraft(key, { attachments: others, text: removeReferences(d.text, id), notice: withNotice(d.notice, inlineCapNotice(a.file.name, MESSAGE_INLINE_MAX_BYTES)) });
    return;
  }
  updateDraft(key, {
    attachments: d.attachments.map((x) => (x.id === id ? settled : x)),
    notice: info.pages > MAX_INLINE_PDF_PAGES ? withNotice(d.notice, longPdfNotice(a.file.name, info.pages)) : d.notice,
  });
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

/** Keeps a citation's body in a draft (new, or an edited comment). */
export function putCitation(key: string, c: Citation): void {
  const d = getDraft(key);
  updateDraft(key, { citations: { ...d.citations, [c.id]: c } });
}

/** A citation's body: the draft's own, else any draft's (a token copied between composers). */
export function findCitation(key: string, id: string): Citation | undefined {
  const drafts = useComposeStore.getState().drafts;
  return drafts[key]?.citations[id] ?? Object.values(drafts).find((d) => id in d.citations)?.citations[id];
}

/**
 * The error for a draft that projects to nothing: its only content is a citation chip
 * whose body no draft has (pasted from a composer that has sent it), which the projection
 * leaves out. Sending it would be an empty message (or a thread with no prompt).
 */
export const NOTHING_TO_SEND = "Nothing to send: the quote is no longer in any draft.";

/** A citation of a draft (narrow selector; findCitation's fallback included). */
export function useCitation(key: string, id: string): Citation | undefined {
  return useComposeStore((s) => s.drafts[key]?.citations[id] ?? Object.values(s.drafts).find((d) => id in d.citations)?.citations[id]);
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

/** Opens the project picker (thread.new's GUI presentation; see keys/bindings.ts). */
export function openNewThreadPicker(): void {
  const ui = useUiStore.getState();
  const returnTo = ui.palette.open ? ui.palette.returnTo : ui.focus;
  // Deferred: picked inside the palette, the palette closes after the presenter runs.
  queueMicrotask(() => {
    useUiStore.getState().openProjectPicker(returnTo);
  });
}

/** Shows the composer for a project and focuses it. */
export function composeIn(projectId: string, worktreePath?: string): void {
  if (worktreePath) updateDraft(projectId, { worktree: { kind: "existing", path: worktreePath } });
  const ui = useUiStore.getState();
  ui.select({ kind: "compose", projectId });
  ui.focusComposer();
}

/**
 * Shows the composer for a workspace and focuses it. The selection carries the first
 * member's project for the command context (thread.new's availability); the draft names
 * the member the thread runs in.
 */
export function composeInWorkspace(workspaceId: string): void {
  const first = useWorkspacesStore.getState().byId[workspaceId]?.members[0]?.projectId ?? "";
  const ui = useUiStore.getState();
  ui.select({ kind: "compose", projectId: first, workspaceId });
  ui.focusComposer();
}

/**
 * Shows the composer for a thread without a project and focuses it. Its selection has
 * no project, so the command context is the compose view alone (thread.new --no-project).
 */
export function composeNoProject(): void {
  const ui = useUiStore.getState();
  ui.select({ kind: "compose", projectId: "", noProject: true });
  ui.focusComposer();
}

/** A target's display name (the project's or the workspace's, else its id; "No project"). */
function targetName(t: ComposeTarget): string {
  switch (t.kind) {
    case "project":
      return useProjectsStore.getState().byId[t.projectId]?.name ?? t.projectId;
    case "workspace":
      return useWorkspacesStore.getState().byId[t.workspaceId]?.name ?? t.workspaceId;
    case "home":
      return NO_PROJECT;
  }
}

/**
 * Moves the draft to another project or workspace (the composer heading's switch) and
 * shows that composer, prompt focused. The draft keeps its text, images and options;
 * where it runs resets (lib/compose movedDraft). The old key is deleted without
 * revoking the attachments' object URLs: they moved with it.
 *
 * Tags of projects the moved draft no longer has (the old project, Also in projects a
 * workspace or no-git target drops) leave the text; when there are any, a confirm comes
 * first ("Switch to <name>?"). A non-empty draft already at the new target is replaced
 * only after a confirm. On either cancel nothing changes. An empty draft moves nothing: the new target's own draft is
 * shown as it is. Resolves false when nothing happened (same target, busy, cancelled).
 */
export async function switchDraftTarget(from: ComposeTarget, to: ComposeTarget): Promise<boolean> {
  const fromKey = draftKey(from);
  const toKey = draftKey(to);
  if (fromKey === toKey || getDraft(fromKey).phase !== "idle") return false;
  const waiting = useComposeStore.getState().drafts[toKey];
  const isGit = (id: string) => useProjectsStore.getState().byId[id]?.git === true;
  if (isDraftEmpty(getDraft(fromKey))) {
    if (waiting && !isDraftEmpty(waiting)) {
      selectTarget(to);
      return true;
    }
  } else {
    const drop = droppedTagsConfirm(getDraft(fromKey).text, movedDraft(getDraft(fromKey), from, to, isGit, workspaceMemberIds(to)).text, to);
    if (drop && !(await requestConfirm(drop))) return false;
  }
  if (!isDraftEmpty(getDraft(fromKey)) && waiting && !isDraftEmpty(waiting)) {
    const yes = await requestConfirm({
      title: `Replace the draft in ${targetName(to)}?`,
      message: "It has unsent text or attachments.",
      confirmLabel: "Replace",
      centered: true,
    });
    if (!yes) return false;
  }
  const cur = getDraft(fromKey);
  if (cur.phase !== "idle") return false;
  const moved = movedDraft(cur, from, to, isGit, workspaceMemberIds(to));
  useComposeStore.setState((s) => {
    // The replaced draft's attachments go away with it.
    for (const a of s.drafts[toKey]?.attachments ?? []) URL.revokeObjectURL(a.url);
    const { [fromKey]: _moved, ...drafts } = s.drafts;
    return { drafts: { ...drafts, [toKey]: moved }, preview: null };
  });
  selectTarget(to);
  return true;
}

/** A workspace target's member project ids ([] for a project, or a workspace that is gone). */
function workspaceMemberIds(t: ComposeTarget): string[] {
  return t.kind === "workspace" ? (useWorkspacesStore.getState().byId[t.workspaceId]?.members.map((m) => m.projectId) ?? []) : [];
}

/** "a", "a and b", "a, b and c". */
function listNames(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

/**
 * The question to ask when moving the draft drops tags (skills, files of projects that
 * leave it), or null when it drops none.
 */
function droppedTagsConfirm(before: string, after: string, to: ComposeTarget): ConfirmRequest | null {
  const kept = tagsByProject(after);
  const gone = tagsByProject(before).filter((id) => !kept.includes(id));
  if (gone.length === 0) return null;
  const n = gone.reduce((sum, id) => sum + projectTagCount(before, id), 0);
  const projects = useProjectsStore.getState().byId;
  return {
    title: `Switch to ${targetName(to)}?`,
    message: `${String(n)} ${n === 1 ? "reference" : "references"} to ${listNames(gone.map((id) => projects[id]?.name ?? id))} in your text will be removed.`,
    confirmLabel: "Switch",
    centered: true,
  };
}

/** Shows a target's composer and focuses its prompt (no worktree side effect, unlike composeIn's path). */
function selectTarget(to: ComposeTarget): void {
  if (to.kind === "project") composeIn(to.projectId);
  else if (to.kind === "workspace") composeInWorkspace(to.workspaceId);
  else composeNoProject();
}

/** The composer target a compose selection shows. */
export function composeTarget(sel: Extract<Selection, { kind: "compose" }>): ComposeTarget {
  if (sel.workspaceId) return { kind: "workspace", workspaceId: sel.workspaceId };
  return sel.noProject ? { kind: "home" } : { kind: "project", projectId: sel.projectId };
}

/** The compose selection that shows a target (sendDraft's command context): a workspace's with the member the thread runs in. */
export function composeSelection(target: ComposeTarget, place: ThreadPlace): Selection {
  switch (target.kind) {
    case "project":
      return { kind: "compose", projectId: target.projectId };
    case "workspace":
      return { kind: "compose", projectId: place.kind === "home" ? "" : place.projectId, workspaceId: target.workspaceId };
    case "home":
      return { kind: "compose", projectId: "", noProject: true };
  }
}

/** Loads the project's base refs (once per composer mount; the previous list shows meanwhile). */
export async function loadRefs(projectId: string): Promise<void> {
  const prev = useComposeStore.getState().refs[projectId];
  const set = (r: RefsState) => {
    useComposeStore.setState((s) => ({ refs: { ...s.refs, [projectId]: r } }));
  };
  if (!prev) set({ status: "loading", refs: [], defaultRef: "", error: null, outdated: false });
  try {
    const res = await listRefs(projectId);
    set({ status: "ready", refs: res.refs, defaultRef: res.defaultRef, error: null, outdated: false });
  } catch (err) {
    if (prev?.status === "ready") return;
    set({ status: "error", refs: [], defaultRef: "", error: errorMessage(err), outdated: isOutdatedDaemon(err) });
  }
}

/** Where a draft's thread would start now (null: its workspace is gone). */
export function draftPlace(target: ComposeTarget, d: Draft): ThreadPlace | null {
  const projects = useProjectsStore.getState().byId;
  const workspace = target.kind === "workspace" ? useWorkspacesStore.getState().byId[target.workspaceId] : undefined;
  // A project without git is never an Also in project (a new workspace needs git).
  const isGitProject = (id: string) => projects[id]?.git === true;
  const { primary } = draftMembers({ target, alsoIn: d.alsoIn, primary: d.primary }, workspace, isGitProject);
  return threadPlace(
    {
      target,
      worktree: d.worktree ?? (target.kind === "project" ? projectWorktree(target.projectId) : { kind: "members" }),
      base: d.base,
      alsoIn: d.alsoIn,
      primary: d.primary,
    },
    {
      workspace,
      isGitProject,
      hasWorktree: (projectId, path) => projects[projectId]?.worktrees.some((w) => w.path === path) ?? false,
      defaultRef: useComposeStore.getState().refs[primary]?.defaultRef ?? "",
      noGitCheckout: (projectId) => noGitCheckout(projects[projectId]),
    },
  );
}

function mainCheckout(projectId: string): string | undefined {
  return useProjectsStore.getState().byId[projectId]?.worktrees.find((w) => w.isMain)?.path;
}

/**
 * Where a project's new thread works until the user picks: the choice remembered for the
 * project, else threads.default_worktree (lib/compose defaultWorktree). The composer
 * resolves the same inputs with hooks.
 */
export function projectWorktree(projectId: string): ProjectWorktree {
  return defaultWorktree({
    setting: useSettingsStore.getState().snapshot?.values[WORK_IN_SETTING_KEY],
    remembered: rememberedWorkIn(projectId),
    mainPath: mainCheckout(projectId),
  });
}

/**
 * The user picked where a project's thread works (the Work in picker): the draft takes
 * it, and a fresh copy or the main checkout becomes the project's default for new
 * threads (another existing worktree is a one-off).
 */
export function pickWorktree(projectId: string, choice: ProjectWorktree): void {
  updateDraft(projectId, { worktree: choice });
  const mode = workInMemory(choice, mainCheckout(projectId));
  if (mode) rememberWorkIn(projectId, mode);
}

/** The one checkout of a project without git (its main worktree, else its path); undefined for git or unknown. */
export function noGitCheckout(r: Pick<ProjectView, "git" | "path" | "worktrees"> | undefined): string | undefined {
  if (!r || r.git) return undefined;
  return r.worktrees.find((w) => w.isMain)?.path ?? r.path;
}

/**
 * Sends a draft: stages its attachments one by one, then invokes thread.new. On success the
 * draft is cleared and the new thread selected (the daemon's FocusThread intent usually
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
      const path = await stageAttachment(a.file, a.pages);
      const cur = getDraft(key);
      updateDraft(key, { attachments: cur.attachments.map((x) => (x.id === a.id ? { ...x, stagedPath: path } : x)) });
    }
    updateDraft(key, { phase: "starting" });
    const cur = getDraft(key);
    const place = draftPlace(target, cur);
    if (!place) throw new Error("This workspace no longer exists.");
    const staged = new Map(cur.attachments.map((a) => [a.id, a]));
    const cite = (id: string) => findCitation(key, id);
    const text = projectPrompt(
      cur.text,
      (id) => {
        const a = staged.get(id);
        return a?.stagedPath ? { name: a.file.name, ref: a.stagedPath, kind: a.kind } : undefined;
      },
      cite,
    );
    const sent = cur.attachments.filter((a) => a.stagedPath !== null);
    if (!text.trim() && sent.length === 0) throw new Error(NOTHING_TO_SEND);
    const args = threadArgs(
      place,
      {
        text,
        composerText: sentComposerText(cur.text, (id) => sent.findIndex((a) => a.id === id), cite),
        model: cur.model ?? defaults.model,
        effort: cur.effort ?? defaults.effort,
        permission: cur.permission,
      },
      sent.map((a) => a.stagedPath ?? ""),
    );
    const res = await invokeConfirmed(THREAD_COMMANDS.create, args, getUiContext(composeSelection(target, place)));
    if (!res) {
      updateDraft(key, { phase: "idle" });
      return false;
    }
    clearDraft(key);
    const id = createdThreadId(res.resultJson);
    const ui = useUiStore.getState();
    // Replace the composer with the new thread unless the user has moved on.
    if (id && ui.selection.kind === "compose" && draftKey(composeTarget(ui.selection)) === key) ui.select({ kind: "thread", id }, { focusPrompt: true });
    return true;
  } catch (err) {
    updateDraft(key, { phase: "idle", error: errorMessage(err) });
    return false;
  } finally {
    void refreshCommands();
  }
}
