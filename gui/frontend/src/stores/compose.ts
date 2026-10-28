/**
 * New-thread drafts, one per project, one per workspace and one without a project (keyed
 * by draftKey in lib/compose.ts: the project id, "ws:<workspace id>", or "home:"), so switching the selection away
 * and back keeps what was typed and attached. Kept in memory only (not persisted): the
 * files behind the attachments do not survive a reload anyway. Also caches each project's
 * branches (ProjectService.ListRefs) for the Work in and Branch from pickers.
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
import { ATTACHMENT_MIME_TYPES, attachmentMaxBytes, MAX_INLINE_PDF_PAGES, MESSAGE_INLINE_MAX_BYTES, PDF_MIME_TYPE, stageAttachment, stageAttachmentPath } from "@/api/threads";
import { isOutdatedDaemon } from "@/api/errors";
import { errorMessage, sendErrorMessage } from "@/api/stream";
import {
  checkAttachments,
  createdThreadId,
  inlineBytes,
  inlineCapNotice,
  longPdfNotice,
  MAX_ATTACHMENTS,
  sentInline,
  DEFAULT_PERMISSION,
  defaultWorktree,
  draftKey,
  movedDraft,
  setWorkIn,
  threadArgs,
  threadPlace,
  WORK_IN_SETTING_KEY,
  type AttachmentLimits,
  type ComposePermission,
  type ComposeTarget,
  type ProjectWorktree,
  type ThreadPlace,
  type WorktreeChoice,
} from "@/lib/compose";
import { unshownHints } from "@/lib/collisionHints";
import { pdfSummary } from "@/lib/pdf";
import { resolveSet, toggled, WORKSPACE_PRIMARY, type ResolvedSet, type SetDefaults } from "@/lib/projectSet";
import { NO_PROJECT } from "@/lib/threadRow";
import { sentComposerText } from "@/lib/userMessage";
import { projectPrompt, removeReferences, removeProjectTags, projectTagCount, stagedPdfPages, tagsByProject } from "@/lib/prompt";
import type { Citation } from "@/lib/citation";
import { toast } from "sonner";
import { readAttachmentFile } from "./attachments";
import { invokeConfirmed, refreshCommands } from "./commands";
import { requestConfirm, type ConfirmRequest } from "./confirm";
import { getUiContext } from "./context";
import { useProjectsStore } from "./projects";
import { THREAD_COMMANDS } from "./threadActions";
import { useSettingsStore } from "./settings";
import { useThreadsStore } from "./threads";
import { useUiStore, type Selection } from "./ui";
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
   * null: the default, resolved live from threads.default_worktree (projectWorktree for
   * a single project, lib/compose setWorkIn for a set).
   */
  worktree: WorktreeChoice | null;
  /**
   * The branch new worktrees branch from (Branch from): a name every git project of the
   * set has; null: each project's default branch (no base sent: the daemon's rule).
   */
  base: string | null;
  /**
   * The projects the thread works in, in the order they were picked (lib/projectSet);
   * null: the target's (its project, or its workspace's members).
   */
  projects: readonly string[] | null;
  /** The workspace the thread references; "" none; null: the target's (a workspace target's own). */
  workspace: string | null;
  /**
   * Where the thread runs: a project of the set, or "workspace" (the workspace's folder);
   * null: the default (the workspace's default primary, else the first picked project).
   * For a like draft: the primary the user picked over the thread's own.
   */
  primary: string | null;
  phase: DraftPhase;
  /** Why the last send failed. */
  error: string | null;
  /** Attachments that were rejected (type, size, count, inline cap), and PDFs Claude reads page by page; " · " between. */
  notice: string | null;
  /** Citation bodies by id (the text's `cf-cite://<id>` tokens name them). */
  citations: Readonly<Record<string, Citation>>;
}

/** A project's branches (ListRefs.branches, newest commit first) and default branch. */
export interface RefsState {
  status: "loading" | "ready" | "error";
  branches: readonly string[];
  defaultBranch: string;
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
  projects: null,
  workspace: null,
  primary: null,
  phase: "idle",
  error: null,
  notice: null,
  citations: {},
};


export const useComposeStore = create<ComposeState>()(() => ({ drafts: {}, refs: {}, preview: null }));

export function getDraft(key: string): Draft {
  return useComposeStore.getState().drafts[key] ?? emptyDraft;
}

/** One field of a draft (narrow selector). */
export function useDraft<K extends keyof Draft>(key: string, field: K): Draft[K] {
  return useComposeStore((s) => (s.drafts[key] ?? emptyDraft)[field]);
}

export function updateDraft(key: string, patch: Partial<Draft>): void {
  useComposeStore.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...(s.drafts[key] ?? emptyDraft), ...patch } } }));
}

/**
 * Runs the thread in another project of its set (or "workspace", the workspace's folder).
 * The base stays: it is a branch every git project of the set has, whichever runs it.
 */
export function setPrimary(key: string, primary: string): void {
  const d = getDraft(key);
  if (d.primary === primary) return;
  updateDraft(key, { primary, error: null });
}

/** The set a target starts with: its project, or its workspace's members and the workspace. */
export function targetDefaults(t: ComposeTarget): SetDefaults {
  switch (t.kind) {
    case "project":
      return { projects: [t.projectId], workspace: "" };
    case "workspace":
      return { projects: useWorkspacesStore.getState().byId[t.workspaceId]?.members.map((m) => m.projectId) ?? [], workspace: t.workspaceId };
    default:
      return { projects: [], workspace: "" };
  }
}

/** A draft's set now (lib/projectSet resolveSet over the projects and workspaces stores). */
export function draftSet(target: ComposeTarget, d: Pick<Draft, "projects" | "workspace" | "primary">): ResolvedSet {
  const projects = useProjectsStore.getState().byId;
  const workspaces = useWorkspacesStore.getState().byId;
  return resolveSet(d, targetDefaults(target), {
    known: (id) => id in projects,
    workspace: (id) => {
      const w = workspaces[id];
      return w ? { members: w.members.map((m) => m.projectId), defaultPrimary: w.defaultPrimary } : undefined;
    },
  });
}

/** The question before a change that removes tags of `gone` projects from the text, or null when it removes none. */
function goneTagsConfirm(text: string, gone: readonly string[], title: string, confirmLabel: string): ConfirmRequest | null {
  const n = gone.reduce((sum, id) => sum + projectTagCount(text, id), 0);
  if (n === 0) return null;
  const projects = useProjectsStore.getState().byId;
  const names = gone.filter((id) => projectTagCount(text, id) > 0).map((id) => projects[id]?.name ?? id);
  return { title, message: `${String(n)} ${n === 1 ? "reference" : "references"} to ${listNames(names)} in your text will be removed.`, confirmLabel, centered: true };
}

/**
 * Writes a new set into the draft: the picked projects (and the workspace, when given),
 * with the tags of the projects that leave removed from the text (after a confirm when
 * there are any). The base resets when the projects change. Resolves false when the user
 * cancelled or the draft is busy.
 */
async function writeSet(target: ComposeTarget, picked: readonly string[], workspace: string | undefined, title: string): Promise<boolean> {
  const key = draftKey(target);
  const before = getDraft(key);
  if (before.phase !== "idle") return false;
  const was = draftSet(target, before);
  const gone = was.picked.filter((id) => !picked.includes(id));
  const ask = goneTagsConfirm(before.text, gone, title, "Remove");
  if (ask && !(await requestConfirm(ask))) return false;
  const d = getDraft(key);
  let text = d.text;
  for (const id of gone) text = removeProjectTags(text, id);
  const patch: Partial<Draft> = { projects: picked, text, error: null, ...(workspace === undefined ? {} : { workspace }) };
  const next = draftSet(target, { ...d, ...patch });
  // The base is a branch the old set's git projects have in common: another set starts from the defaults.
  if (next.projectIds.length !== was.projectIds.length || next.projectIds.some((id) => !was.projectIds.includes(id))) patch.base = null;
  // A pick that left the set (or a workspace folder without its workspace) goes back to the default.
  if (d.primary !== null && d.primary !== next.primary) patch.primary = null;
  updateDraft(key, patch);
  return true;
}

/**
 * Adds a project to the draft's set, or removes it (its skill and file tags go too, after
 * a confirm when the text has any). The last project of a workspace's set takes the
 * workspace reference with it, and the last project of a plain set leaves it empty: the
 * draft has no set then (the composer's empty state, nothing to send) until a project or
 * a workspace is picked, so an empty project list is never sent with a workspace (the
 * daemon would read it as all its members). Picked on the no-project composer, it moves
 * the draft to that project's composer instead.
 */
export async function toggleDraftProject(target: ComposeTarget, projectId: string): Promise<boolean> {
  if (target.kind === "home") return switchDraftTarget(target, { kind: "project", projectId });
  if (target.kind === "like") return false;
  const set = draftSet(target, getDraft(draftKey(target)));
  const last = set.picked.includes(projectId) && set.picked.length === 1;
  const name = useProjectsStore.getState().byId[projectId]?.name ?? projectId;
  return writeSet(target, toggled(set.picked, projectId), last ? "" : undefined, `Remove ${name} from the thread?`);
}

/**
 * Makes one project the draft's whole set (the heading picker's project row): no
 * workspace reference, nothing else. On the no-project composer it moves the draft to
 * that project's composer.
 */
export async function setDraftProject(target: ComposeTarget, projectId: string): Promise<boolean> {
  if (target.kind === "home") return switchDraftTarget(target, { kind: "project", projectId });
  if (target.kind === "like") return false;
  if (!(projectId in useProjectsStore.getState().byId)) return false;
  const name = useProjectsStore.getState().byId[projectId]?.name ?? projectId;
  return writeSet(target, [projectId], "", `Switch to ${name}?`);
}

/** Empties the draft's set (the chip row's Clear): the composer's empty state until a project or a workspace is picked. */
export async function clearDraftSet(target: ComposeTarget): Promise<boolean> {
  if (target.kind === "home" || target.kind === "like") return false;
  return writeSet(target, [], "", "Clear the projects?");
}

/** A draft whose set was emptied (every project of its workspace taken out): nothing to send until a project is picked. */
export function isSetEmpty(set: Pick<ResolvedSet, "projectIds" | "workspaceId">): boolean {
  return set.projectIds.length === 0 && set.workspaceId === "";
}

/**
 * Picks a workspace for the draft (the heading picker's workspace row): its members become
 * the set and it is the thread's reference (its instructions and skills). On the
 * no-project composer it moves the draft to the workspace's composer.
 */
export async function pickDraftWorkspace(target: ComposeTarget, workspaceId: string): Promise<boolean> {
  if (target.kind === "home") return switchDraftTarget(target, { kind: "workspace", workspaceId });
  if (target.kind === "like") return false;
  const ws = useWorkspacesStore.getState().byId[workspaceId];
  if (!ws) return false;
  const known = useProjectsStore.getState().byId;
  const members = ws.members.map((m) => m.projectId).filter((id) => id in known);
  return writeSet(target, members, workspaceId, `Switch to ${ws.name}?`);
}

/**
 * Takes the referenced workspace out of the draft (the workspace chip's ×) with the
 * members it brought; projects added on top of it stay. With none, the composer's empty
 * state.
 */
export async function removeDraftWorkspace(target: ComposeTarget): Promise<boolean> {
  if (target.kind === "home" || target.kind === "like") return false;
  const set = draftSet(target, getDraft(draftKey(target)));
  if (!set.workspaceId) return false;
  const ws = useWorkspacesStore.getState().byId[set.workspaceId];
  const members = new Set(ws?.members.map((m) => m.projectId) ?? []);
  const name = ws?.name ?? set.workspaceId;
  return writeSet(
    target,
    set.picked.filter((id) => !members.has(id)),
    "",
    `Remove ${name} from the thread?`,
  );
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

/** The last segment of a path. */
function baseName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

interface StagedPath {
  name: string;
  type: string;
  size: number;
  /** A PDF's count from the staged name (null: an estimate, or an image). */
  pages: number | null;
  file: File;
  stagedPath: string;
}

/** Stages one dropped or picked path and reads it back as a File named like the original. */
async function stagePath(path: string): Promise<StagedPath> {
  const stagedPath = await stageAttachmentPath(path);
  // Read straight from the daemon: the draft keeps its own File, so the thread's shared
  // cache (stores/attachments) need not hold a second copy.
  const blob = await readAttachmentFile(stagedPath);
  if (!blob) throw new Error("staged, but the daemon did not serve it back");
  const name = baseName(path);
  const file = new File([blob], name, { type: blob.type });
  return { name, type: file.type, size: file.size, pages: file.type === PDF_MIME_TYPE ? stagedPdfPages(stagedPath) : null, file, stagedPath };
}

/**
 * Adds image and PDF paths dropped on the composer or picked in the native open panel
 * (lib/droppedPaths splitDroppedPaths' attach list; the Wails host hands over paths, never
 * File objects). Each is staged by path at once (ThreadService.StageAttachment) and read
 * back (ReadAttachment, the thread's loader) as the attachment's file, so its tile, chip
 * and preview are a pasted file's and the send reuses the staged path. The count cap
 * applies before staging; the daemon refuses unsupported content, files over the size
 * cap and vanished paths ("<name>: <its message>" in the notice); the inline cap applies
 * once the size, and a PDF's page count from the staged name, are known. Resolves to the
 * ones added (the editor puts chips for them into the text).
 */
export async function addAttachmentPaths(key: string, paths: readonly string[]): Promise<DraftAttachment[]> {
  if (paths.length === 0) return [];
  const room = Math.max(0, MAX_ATTACHMENTS - getDraft(key).attachments.length);
  const take = paths.slice(0, room);
  const notices: string[] = [];
  if (paths.length > take.length) notices.push(`At most ${String(MAX_ATTACHMENTS)} attachments per message; ${String(paths.length - take.length)} not attached`);
  const results = await Promise.allSettled(take.map(stagePath));
  const staged: StagedPath[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") staged.push(r.value);
    else notices.push(`${baseName(take[i] ?? "")}: ${errorMessage(r.reason)}`);
  });
  const d = getDraft(key);
  const { accepted, rejected } = checkAttachments(staged, { count: d.attachments.length, inlineBytes: draftInlineBytes(d.attachments) }, ATTACHMENT_LIMITS);
  notices.push(...rejected);
  const added = accepted.map<DraftAttachment>((a) => ({
    id: `a${String(nextAttachmentId++)}`,
    file: a.file,
    kind: a.type === PDF_MIME_TYPE ? "pdf" : "image",
    url: URL.createObjectURL(a.file),
    stagedPath: a.stagedPath,
    pages: a.pages,
    thumb: null,
  }));
  for (const a of added) if (a.pages !== null && a.pages > MAX_INLINE_PDF_PAGES) notices.push(longPdfNotice(a.file.name, a.pages));
  updateDraft(key, { attachments: [...d.attachments, ...added], notice: notices.length > 0 ? notices.join(" · ") : null });
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
    // A PDF staged by path had its count, and this notice, from the staged name already.
    notice: a.pages === null && info.pages > MAX_INLINE_PDF_PAGES ? withNotice(d.notice, longPdfNotice(a.file.name, info.pages)) : d.notice,
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

/** Why a draft whose set was emptied (isSetEmpty) does not send. */
export const NO_SET = "Pick a project or a workspace for the thread first.";

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

/**
 * Shows the composer for a project and focuses it. Its draft keeps what was typed and the
 * set the user made of it; an empty draft (no text, no attachments) starts again from
 * that project alone (the set, the workspace reference, the primary and the base reset),
 * so a project picked from cmd+N, the Projects page or a row is always in the set its
 * composer shows.
 */
export function composeIn(projectId: string, worktreePath?: string): void {
  const d = useComposeStore.getState().drafts[projectId];
  if (d && isDraftEmpty(d) && d.phase === "idle" && (d.projects !== null || d.workspace !== null)) {
    updateDraft(projectId, { projects: null, workspace: null, primary: null, base: null, error: null });
  }
  if (worktreePath) updateDraft(projectId, { worktree: { kind: "existing", path: worktreePath } });
  const ui = useUiStore.getState();
  ui.select({ kind: "compose", projectId });
  ui.focusComposer();
}

/**
 * Shows the composer for a workspace and focuses it: its members are the set and it is
 * the thread's reference. The selection carries the first member's project for the
 * command context (thread.new's availability).
 */
export function composeInWorkspace(workspaceId: string): void {
  const first = useWorkspacesStore.getState().byId[workspaceId]?.members[0]?.projectId ?? "";
  const ui = useUiStore.getState();
  ui.select({ kind: "compose", projectId: first, workspaceId });
  ui.focusComposer();
}

/**
 * "New thread on this branch" (thread.new-like's presenter): the composer prefilled with
 * the thread's set, branch, primary, workspace and mode, so only the prompt is typed; the
 * daemon copies all of it from the thread. False when the thread is not known (the
 * command then runs as usual).
 */
export function composeLike(threadId: string): boolean {
  const t = useThreadsStore.getState().byId[threadId];
  if (!t) return false;
  noteLikeSource(threadId);
  // Picked in the palette: the composer takes focus when it closes, not what had it before.
  if (useUiStore.getState().palette.open) useUiStore.setState((s) => ({ palette: { ...s.palette, returnTo: "content" } }));
  // Deferred: picked inside the palette or a menu, that closes after the presenter runs.
  queueMicrotask(() => {
    const ui = useUiStore.getState();
    ui.select({ kind: "compose", projectId: t.projectId, likeThreadId: threadId });
    ui.focusComposer();
  });
  return true;
}

/** What a like draft's thread was: what its draft becomes when the thread is removed (convertGoneLikeDraft). */
interface LikeSource {
  name: string;
  projectIds: readonly string[];
  workspaceId: string;
  /** A project id, WORKSPACE_PRIMARY, or "" (no project). */
  primary: string;
  worktreeMode: boolean;
}

/** By thread id; in memory, as the drafts are. */
const likeSources = new Map<string, LikeSource>();

/** Remembers a like draft's thread as it is now (composeLike, and the like composer while it shows the thread). */
export function noteLikeSource(threadId: string): void {
  const t = useThreadsStore.getState().byId[threadId];
  if (!t) return;
  likeSources.set(threadId, {
    name: t.name,
    projectIds: t.projectIds,
    workspaceId: t.workspaceId,
    primary: t.projectId || (t.workspaceId ? WORKSPACE_PRIMARY : ""),
    worktreeMode: t.createdWorktree,
  });
}

/**
 * The like draft of a thread that was removed becomes a plain draft with the thread's set,
 * workspace and primary (the one the draft picked, else the thread's) and its mode as
 * Work in, keeping the text, attachments and options; it moves to the workspace's
 * composer (the primary project's without a workspace, No project without either) and
 * that composer shows, with a toast. A draft already waiting there keeps its text first,
 * the moved text after it. False when the thread still exists or was never seen.
 */
export function convertGoneLikeDraft(threadId: string): boolean {
  const src = likeSources.get(threadId);
  if (!src || threadId in useThreadsStore.getState().byId) return false;
  likeSources.delete(threadId);
  const fromKey = draftKey({ kind: "like", threadId });
  const d = getDraft(fromKey);
  if (d.phase !== "idle") return false;
  const known = useProjectsStore.getState().byId;
  const ids = src.projectIds.filter((id) => id in known);
  const ws = src.workspaceId && src.workspaceId in useWorkspacesStore.getState().byId ? src.workspaceId : "";
  const want = d.primary ?? src.primary;
  const primary = (want === WORKSPACE_PRIMARY && ws) || ids.includes(want) ? want : (ids[0] ?? (ws ? WORKSPACE_PRIMARY : ""));
  const to: ComposeTarget = ws
    ? { kind: "workspace", workspaceId: ws }
    : primary && primary !== WORKSPACE_PRIMARY
      ? { kind: "project", projectId: primary }
      : { kind: "home" };
  const toKey = draftKey(to);
  const waiting = useComposeStore.getState().drafts[toKey];
  const keep = waiting && !isDraftEmpty(waiting) ? waiting : undefined;
  const moved: Draft = {
    ...d,
    text: keep ? `${keep.text}\n\n${d.text}` : d.text,
    attachments: keep ? [...keep.attachments, ...d.attachments] : d.attachments,
    citations: keep ? { ...keep.citations, ...d.citations } : d.citations,
    projects: to.kind === "home" ? null : [...(primary && primary !== WORKSPACE_PRIMARY ? [primary] : []), ...ids.filter((id) => id !== primary)],
    workspace: to.kind === "home" ? null : ws,
    primary: to.kind === "home" ? null : primary || null,
    worktree: to.kind === "home" ? null : { kind: src.worktreeMode ? "new" : "current" },
    base: null,
    error: null,
  };
  useComposeStore.setState((s) => {
    if (!keep) for (const a of s.drafts[toKey]?.attachments ?? []) URL.revokeObjectURL(a.url);
    const { [fromKey]: _gone, ...drafts } = s.drafts;
    return { drafts: { ...drafts, [toKey]: moved }, preview: null };
  });
  const ui = useUiStore.getState();
  // Not composeIn: it would reset an empty draft's set to the project alone.
  if (to.kind === "workspace") composeInWorkspace(to.workspaceId);
  else if (to.kind === "project") ui.select({ kind: "compose", projectId: to.projectId });
  else ui.select({ kind: "compose", projectId: "", noProject: true });
  useUiStore.getState().focusComposer();
  toast.info(`Thread ${src.name || threadId} was removed; starting fresh`);
  return true;
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

/** A target's display name (the project's or the workspace's, else its id; "No project"; a like draft's thread). */
function targetName(t: ComposeTarget): string {
  switch (t.kind) {
    case "project":
      return useProjectsStore.getState().byId[t.projectId]?.name ?? t.projectId;
    case "workspace":
      return useWorkspacesStore.getState().byId[t.workspaceId]?.name ?? t.workspaceId;
    case "like":
      return useThreadsStore.getState().byId[t.threadId]?.name || t.threadId;
    case "home":
      return NO_PROJECT;
  }
}

/**
 * Moves the draft to another target (the composer heading's switch to or from No
 * project) and shows that composer, prompt focused. The draft keeps its text, images and
 * options; where it runs resets to the new target's (lib/compose movedDraft). The old key
 * is deleted without revoking the attachments' object URLs: they moved with it.
 *
 * Tags of projects the new target does not have leave the text; when there are any, a
 * confirm comes first ("Switch to <name>?"). A non-empty draft already at the new target
 * is replaced only after a confirm. On either cancel nothing changes. An empty draft moves
 * nothing: the new target's own draft is shown as it is. Resolves false when nothing
 * happened (same target, busy, cancelled).
 */
export async function switchDraftTarget(from: ComposeTarget, to: ComposeTarget): Promise<boolean> {
  const fromKey = draftKey(from);
  const toKey = draftKey(to);
  if (fromKey === toKey || getDraft(fromKey).phase !== "idle") return false;
  const waiting = useComposeStore.getState().drafts[toKey];
  const members = targetDefaults(to).projects;
  if (isDraftEmpty(getDraft(fromKey))) {
    if (waiting && !isDraftEmpty(waiting)) {
      selectTarget(to);
      return true;
    }
  } else {
    const drop = droppedTagsConfirm(getDraft(fromKey).text, movedDraft(getDraft(fromKey), members).text, to);
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
  const moved = movedDraft(cur, members);
  useComposeStore.setState((s) => {
    // The replaced draft's attachments go away with it.
    for (const a of s.drafts[toKey]?.attachments ?? []) URL.revokeObjectURL(a.url);
    const { [fromKey]: _moved, ...drafts } = s.drafts;
    return { drafts: { ...drafts, [toKey]: moved }, preview: null };
  });
  selectTarget(to);
  return true;
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
  else if (to.kind === "like") composeLike(to.threadId);
  else composeNoProject();
}

/** The composer target a compose selection shows. */
export function composeTarget(sel: Extract<Selection, { kind: "compose" }>): ComposeTarget {
  if (sel.likeThreadId) return { kind: "like", threadId: sel.likeThreadId };
  if (sel.workspaceId) return { kind: "workspace", workspaceId: sel.workspaceId };
  return sel.noProject ? { kind: "home" } : { kind: "project", projectId: sel.projectId };
}

/**
 * The compose selection that shows a target (sendDraft's command context): a set's with
 * its primary project (none for the workspace's folder), a like draft's with its thread's.
 */
export function composeSelection(target: ComposeTarget, place: ThreadPlace): Selection {
  switch (target.kind) {
    case "project":
      return { kind: "compose", projectId: target.projectId };
    case "workspace":
      return { kind: "compose", projectId: place.kind === "set" && place.primary !== WORKSPACE_PRIMARY ? place.primary : "", workspaceId: target.workspaceId };
    case "like":
      return { kind: "compose", projectId: useThreadsStore.getState().byId[target.threadId]?.projectId ?? "", likeThreadId: target.threadId };
    case "home":
      return { kind: "compose", projectId: "", noProject: true };
  }
}

/** The ListRefs calls in flight, by project: a picker opened twice in a row asks once. */
const refsInFlight = new Map<string, Promise<void>>();

/**
 * Loads a project's branches (ListRefs; on each opening of a picker that lists them, the
 * previous list showing meanwhile).
 */
export function loadRefs(projectId: string): Promise<void> {
  const running = refsInFlight.get(projectId);
  if (running) return running;
  const prev = useComposeStore.getState().refs[projectId];
  const set = (r: RefsState) => {
    useComposeStore.setState((s) => ({ refs: { ...s.refs, [projectId]: r } }));
  };
  if (!prev || prev.status === "error") set({ status: "loading", branches: [], defaultBranch: "", error: null, outdated: false });
  const p = (async () => {
    try {
      const res = await listRefs(projectId);
      set({ status: "ready", branches: res.branches, defaultBranch: res.defaultBranch, error: null, outdated: false });
    } catch (err) {
      if (prev?.status === "ready") return;
      set({ status: "error", branches: [], defaultBranch: "", error: errorMessage(err), outdated: isOutdatedDaemon(err) });
    } finally {
      refsInFlight.delete(projectId);
    }
  })();
  refsInFlight.set(projectId, p);
  return p;
}

/** Loads the branches of every project of `projectIds` in parallel (loadRefs). */
export async function loadBranches(projectIds: readonly string[]): Promise<void> {
  await Promise.all(projectIds.map((id) => loadRefs(id)));
}

/**
 * The worktree choice a draft's set starts in: its pick, else the setting (projectWorktree
 * for one project); in place for a set without a git project (lib/compose setWorkIn). An
 * existing branch picked for a set with a git project stays that branch.
 */
export function draftWorktree(set: Pick<ResolvedSet, "isSet" | "projectIds">, d: Pick<Draft, "worktree">): WorktreeChoice {
  if (set.isSet) {
    const projects = useProjectsStore.getState().byId;
    const hasGit = set.projectIds.some((id) => projects[id]?.git === true);
    if (hasGit && d.worktree?.kind === "branch") return d.worktree;
    return { kind: setWorkIn(d.worktree, useSettingsStore.getState().snapshot?.values[WORK_IN_SETTING_KEY], hasGit) === "new" ? "new" : "current" };
  }
  return d.worktree ?? projectWorktree(set.projectIds[0] ?? "");
}

/** Where a draft's thread would start now (null: nothing left to start it in, its projects or workspace gone). */
export function draftPlace(target: ComposeTarget, d: Draft): ThreadPlace | null {
  const projects = useProjectsStore.getState().byId;
  const set = draftSet(target, d);
  return threadPlace(
    { target, worktree: draftWorktree(set, d), base: d.base, set, likePrimary: d.primary ?? "" },
    {
      isGitProject: (id) => projects[id]?.git === true,
      hasWorktree: (projectId, path) => projects[projectId]?.worktrees.some((w) => w.path === path) ?? false,
      mainPath: mainCheckout,
      noGitCheckout: (projectId) => noGitCheckout(projects[projectId]),
    },
  );
}

function mainCheckout(projectId: string): string | undefined {
  return useProjectsStore.getState().byId[projectId]?.worktrees.find((w) => w.isMain)?.path;
}

/**
 * Where a project's new thread works until the user picks: threads.default_worktree
 * (lib/compose defaultWorktree). The composer resolves the same inputs with hooks; a pick
 * in the Work in picker is the draft's own (Draft.worktree) and changes no default.
 */
export function projectWorktree(projectId: string): ProjectWorktree {
  return defaultWorktree({
    setting: useSettingsStore.getState().snapshot?.values[WORK_IN_SETTING_KEY],
    mainPath: mainCheckout(projectId),
  });
}

/** The one checkout of a project without git (its main worktree, else its path); undefined for git or unknown. */
export function noGitCheckout(r: Pick<ProjectView, "git" | "path" | "worktrees"> | undefined): string | undefined {
  if (!r || r.git) return undefined;
  return r.worktrees.find((w) => w.isMain)?.path ?? r.path;
}

/**
 * Sends a draft: stages its attachments one by one, then invokes thread.new. On success the
 * draft is cleared and the new thread selected (the daemon's FocusThread intent usually
 * got there first). On failure the draft stays, with the error. `shownHints` are the
 * collision hints the composer showed under its chips; the daemon's after-create hints
 * that repeat one of them are not toasted again (lib/collisionHints unshownHints).
 */
export async function sendDraft(target: ComposeTarget, defaults: { model: string; effort: string }, shownHints: readonly string[] = []): Promise<boolean> {
  const key = draftKey(target);
  const d = getDraft(key);
  if (d.phase !== "idle" || isDraftEmpty(d)) return false;
  if (target.kind !== "home" && target.kind !== "like" && isSetEmpty(draftSet(target, d))) {
    updateDraft(key, { error: NO_SET });
    return false;
  }
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
    if (!place) throw new Error(target.kind === "workspace" ? "This workspace no longer exists." : "None of these projects is registered any more.");
    // An empty project list with a workspace is the workspace's members to the daemon:
    // only a workspace that has none may go without projects.
    if (place.kind === "set" && place.projectIds.length === 0 && (useWorkspacesStore.getState().byId[place.workspaceId]?.members.length ?? 0) > 0) throw new Error(NO_SET);
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
    // "New thread on this branch" is its own command (the daemon copies the thread's set, branch, workspace and mode).
    const command = place.kind === "like" ? THREAD_COMMANDS.newLike : THREAD_COMMANDS.create;
    const res = await invokeConfirmed(command, args, getUiContext(composeSelection(target, place)));
    if (!res) {
      updateDraft(key, { phase: "idle" });
      return false;
    }
    clearDraft(key);
    // The daemon's collision hints (CreateThreadResponse.hints): never a refusal, said once
    // the thread exists; not again when the composer already showed the line.
    for (const w of unshownHints(res.warnings ?? [], shownHints)) toast.warning(w);
    const id = createdThreadId(res.resultJson);
    const ui = useUiStore.getState();
    // Replace the composer with the new thread unless the user has moved on.
    if (id && ui.selection.kind === "compose" && draftKey(composeTarget(ui.selection)) === key) ui.select({ kind: "thread", id }, { focusPrompt: true });
    return true;
  } catch (err) {
    updateDraft(key, { phase: "idle", error: sendErrorMessage(err) });
    return false;
  } finally {
    void refreshCommands();
  }
}
