/**
 * The ways out of a thread's setup, as the composer offers them
 * (docs/notes/instant-threads-4-composer.md): Cancel while it runs, and after it failed or
 * was cancelled Try again and Edit. Each is a thread.setup.* registry command. Edit undoes
 * the send: the thread goes and the new-thread composer shows the draft it came from. The
 * rules of what comes back are here; the snapshot's format is lib/setupDraft.
 */
import { toast } from "sonner";
import { isFailedPrecondition } from "@/api/errors";
import type { ThreadView } from "@/api/threads";
import { newCitationId } from "@/lib/citation";
import { draftKey, type ComposeTarget } from "@/lib/compose";
import { appendToDraft, draftOfSent, sentAttachmentNames, type SentMessage } from "@/lib/failedPrompt";
import { WORKSPACE_PRIMARY } from "@/lib/projectSet";
import { tildify } from "@/lib/path";
import { parseDiscardedSetup, parseSetupDraft, remapAttachmentChips, SETUP_DRAFT_VERSION, encodeSetupDraft, type DiscardedSetup, type SetupDraft, type SetupDraftAttachment } from "@/lib/setupDraft";
import { readAttachmentFile } from "./attachments";
import { runCommandForResult } from "./commands";
import { addStagedAttachments, getDraft, isDraftEmpty, putCitation, showComposer, takeDraft, targetName, updateDraft, type Draft } from "./compose";
import { useProjectsStore } from "./projects";
import { threadContext, threadDraftKey } from "./threadActions";
import { hideThread, useThreadsStore } from "./threads";
import { useUiStore } from "./ui";
import { useWorkspacesStore } from "./workspaces";

export const SETUP_COMMANDS = { retry: "thread.setup.retry", cancel: "thread.setup.cancel", discard: "thread.setup.discard" } as const;

/** What a draft sends as draft_json: everything that puts it back, as lib/setupDraft says. */
export function setupDraftJson(target: ComposeTarget, d: Draft): string {
  const attachments = d.attachments.flatMap((a): SetupDraftAttachment[] => (a.stagedPath ? [{ id: a.id, path: a.stagedPath, name: a.file.name, kind: a.kind, pages: a.pages }] : []));
  return encodeSetupDraft({
    v: SETUP_DRAFT_VERSION,
    target,
    text: d.text,
    attachments,
    citations: d.citations,
    model: d.model,
    effort: d.effort,
    permission: d.permission,
    worktree: d.worktree,
    base: d.base,
    projects: d.projects,
    workspace: d.workspace,
    primary: d.primary,
  });
}

/**
 * The composer each thread was sent from in this window, by thread: Edit waits in the right
 * one before the daemon has given the snapshot back, so a set whose primary is not the
 * target, or a like draft, does not pass through another composer on the way. A thread's
 * entry goes when Edit takes it away or its setup is done (no Edit after that).
 */
const sentFrom = new Map<string, ComposeTarget>();

useThreadsStore.subscribe((s, prev) => {
  if (sentFrom.size === 0 || s.byId === prev.byId) return;
  for (const id of sentFrom.keys()) if (s.byId[id]?.setup?.phase === "done") sentFrom.delete(id);
});

/** sendDraft's note of where a thread came from. */
export function noteSentFrom(threadId: string, target: ComposeTarget): void {
  sentFrom.set(threadId, target);
}

/** thread.setup.retry (the note's Try again). The daemon's refusal is the composer's error line. */
export async function retrySetup(threadId: string): Promise<boolean> {
  const key = threadDraftKey(threadId);
  updateDraft(key, { error: null });
  const res = await runCommandForResult(SETUP_COMMANDS.retry, { id: threadId }, {
    ctx: threadContext(threadId),
    quiet: true,
    expected: () => true,
    onError: (error) => {
      updateDraft(key, { error });
    },
  });
  return res !== null;
}

/** Cancel lost the race with the setup's end: the composer shows what is true now. */
export const CANCEL_TOO_LATE = "Too late to cancel: this setup has just ended.";

/** Edit lost the race with a Try again, or the setup finished. */
export const EDIT_TOO_LATE = "This setup is running again, so there is no send to undo.";

/**
 * thread.setup.cancel (Interrupt's place while a setup runs). What it left for the work in
 * it goes on the notice line. Too late, because Claude is starting or the setup failed just
 * then, is no failure: the daemon's word on it, without alarm, and the composer shows what
 * is true now. The daemon's refusal names the thread by id, which is no use here.
 */
export async function cancelSetup(threadId: string): Promise<boolean> {
  const res = await runCommandForResult(SETUP_COMMANDS.cancel, { id: threadId }, {
    ctx: threadContext(threadId),
    quiet: true,
    expected: (err) => {
      if (!isFailedPrecondition(err)) return false;
      toast.info(CANCEL_TOO_LATE);
      return true;
    },
  });
  if (!res) return false;
  const kept = parseDiscardedSetup(res.resultJson).keptWorktrees;
  if (kept.length > 0) updateDraft(threadDraftKey(threadId), { notice: keptNotice(kept) });
  return true;
}

function keptNotice(paths: readonly string[]): string {
  return `${paths.map(tildify).join(", ")} stayed: ${paths.length > 1 ? "they have" : "it has"} work in ${paths.length > 1 ? "them" : "it"}`;
}

/** The target a thread came from, as far as its own fields tell. */
function targetOfThread(t: Pick<ThreadView, "workspaceId" | "projectId" | "projectIds">): ComposeTarget {
  if (t.workspaceId) return { kind: "workspace", workspaceId: t.workspaceId };
  const projectId = t.projectId || t.projectIds[0] || "";
  return projectId ? { kind: "project", projectId } : { kind: "home" };
}

/** Whether a target can still show a composer. */
function targetExists(t: ComposeTarget, leaving: string): boolean {
  switch (t.kind) {
    case "project":
      return t.projectId in useProjectsStore.getState().byId;
    case "workspace":
      return t.workspaceId in useWorkspacesStore.getState().byId;
    case "like":
      return t.threadId !== leaving && t.threadId in useThreadsStore.getState().byId;
    case "home":
      return true;
  }
}

/** The nearest target of `ids` that is still there, else the home composer. */
function nearestTarget(ids: readonly string[]): ComposeTarget {
  const known = useProjectsStore.getState().byId;
  const projectId = ids.find((id) => id in known);
  return projectId ? { kind: "project", projectId } : { kind: "home" };
}

/** The draft's place fields, kept to what still exists; the target's defaults for a target it no longer has. */
function placeOf(snap: SetupDraft, same: boolean): Partial<Draft> {
  if (!same) return { worktree: null, base: null, projects: null, workspace: null, primary: null };
  const projects = useProjectsStore.getState().byId;
  const workspaces = useWorkspacesStore.getState().byId;
  const kept = snap.projects?.filter((id) => id in projects) ?? null;
  const workspace = snap.workspace && !(snap.workspace in workspaces) ? "" : snap.workspace;
  const worktree = snap.worktree;
  const onDisk = worktree?.kind !== "existing" || Object.values(projects).some((p) => p.worktrees.some((w) => w.path === worktree.path));
  const primary = snap.primary;
  const primaryKept = primary === null || primary === WORKSPACE_PRIMARY ? workspace !== "" || primary === null : (kept ?? []).includes(primary) || primary in projects;
  return { worktree: onDisk ? worktree : null, base: kept?.length === snap.projects?.length ? snap.base : null, projects: kept, workspace, primary: primaryKept ? primary : null };
}

interface ReadBack {
  file: File;
  stagedPath: string;
}

/** Each staged file read back from the daemon, in order; null for one that is gone (attachments are reaped at 7 days). */
async function readStaged(list: readonly { path: string; name: string }[]): Promise<(ReadBack | null)[]> {
  return Promise.all(
    list.map(async ({ path, name }) => {
      const blob = await readAttachmentFile(path).catch(() => null);
      return blob ? { file: new File([blob], name || "attachment", { type: blob.type }), stagedPath: path } : null;
    }),
  );
}

/** Puts a sent message's attachments back in the draft and returns its text with the chips on them, and the names that are gone. */
async function restoreSent(key: string, m: SentMessage): Promise<{ text: string; missing: string[] }> {
  const names = sentAttachmentNames(m);
  const files = await readStaged(m.attachments.map((path, i) => ({ path, name: names[i] ?? "" })));
  const kept = files.flatMap((f, index) => (f ? [{ ...f, index }] : []));
  const added = addStagedAttachments(key, kept);
  const idByIndex = new Map(kept.map((f, j) => [f.index, added[j]?.id ?? ""]));
  const draft = draftOfSent(m, (i) => idByIndex.get(i), newCitationId);
  for (const c of draft.citations) putCitation(key, c);
  return { text: draft.text, missing: names.filter((_, i) => !files[i]) };
}

/** The same for a snapshot's prompt, which has the draft's own tags. */
async function restoreSnapshot(key: string, snap: SetupDraft, text: string): Promise<{ text: string; missing: string[] }> {
  const files = await readStaged(snap.attachments);
  const kept = files.flatMap((f, i) => (f ? [{ ...f, id: snap.attachments[i]?.id ?? "" }] : []));
  const added = addStagedAttachments(key, kept);
  const idOf = new Map(kept.map((f, j) => [f.id, added[j]?.id ?? ""]));
  for (const c of Object.values(snap.citations)) putCitation(key, c);
  return { text: remapAttachmentChips(text, (id) => idOf.get(id)), missing: snap.attachments.filter((_, i) => !files[i]).map((a) => a.name || a.path) };
}

function missingNotice(names: readonly string[]): string {
  return `${names.join(", ")}: no longer staged; attach ${names.length > 1 ? "them" : "it"} again`;
}

/**
 * Fills target `to`'s draft from what Discard gave back: the prompt (the snapshot's, else
 * the first message), the messages queued behind it, then whatever was typed in the
 * thread's composer, each after a blank line and after what the draft holds already. The
 * prompt is never lost: whichever parts could not be read, the text the daemon has goes in.
 */
async function fillDraft(to: ComposeTarget, snap: SetupDraft | null, sameTarget: boolean, gone: DiscardedSetup, notes: string[], typed: Draft | null): Promise<void> {
  const key = draftKey(to);
  const missing: string[] = [];
  const parts: string[] = [];
  if (snap?.text != null) {
    const r = await restoreSnapshot(key, snap, snap.text);
    parts.push(r.text);
    missing.push(...r.missing);
  } else if (gone.first) {
    const r = await restoreSent(key, gone.first);
    parts.push(r.text);
    missing.push(...r.missing);
  }
  for (const q of gone.queued) {
    const r = await restoreSent(key, q);
    parts.push(r.text);
    missing.push(...r.missing);
  }
  const cur = getDraft(key);
  let text = cur.text;
  for (const p of parts) if (p.trim()) text = appendToDraft(text, p);
  const attachments = [...cur.attachments, ...(typed?.attachments ?? [])];
  if (typed && typed.text.trim()) text = appendToDraft(text, typed.text);
  const citations = { ...cur.citations, ...typed?.citations };
  if (missing.length > 0) notes.push(missingNotice(missing));
  if (gone.keptWorktrees.length > 0) notes.push(keptNotice(gone.keptWorktrees));
  const options: Partial<Draft> = snap
    ? { ...(snap.model !== null && { model: snap.model }), ...(snap.effort !== null && { effort: snap.effort }), ...(snap.permission !== null && { permission: snap.permission }), ...placeOf(snap, sameTarget) }
    : {};
  updateDraft(key, { ...options, text, attachments, citations, phase: "idle", error: gone.error || null, notice: notes.length > 0 ? notes.join(" · ") : null });
}

/** Everything a discarded thread held as text, after what the draft has: the last resort when its draft cannot be rebuilt. */
export function plainDraftText(draft: string, snap: SetupDraft | null, gone: Pick<DiscardedSetup, "first" | "queued">, typed: Pick<Draft, "text"> | null): string {
  const sentText = (m: { text: string; composerText: string }) => m.composerText || m.text;
  const parts = [snap?.text ?? (gone.first ? sentText(gone.first) : ""), ...gone.queued.map(sentText), typed?.text ?? ""];
  return parts.reduce((text, p) => (p.trim() ? appendToDraft(text, p) : text), draft);
}

/**
 * The note's Edit: undoes the send. The composer shows first and the row leaves at once, so
 * the thread going is never seen from inside it (no stream ending on a thread that is gone,
 * no "not found"); the composer holds until the daemon has taken the thread away, which can
 * take a while with a worktree to remove, and if it refuses the thread comes back with the
 * reason on its error line.
 */
export async function editSetup(threadId: string): Promise<boolean> {
  const t = useThreadsStore.getState().byId[threadId];
  if (!t) return false;
  const threadKey = threadDraftKey(threadId);
  const ctx = threadContext(threadId);
  const own = sentFrom.get(threadId) ?? targetOfThread(t);
  const waitIn = targetExists(own, threadId) ? own : nearestTarget(t.projectIds);
  const waitKey = draftKey(waitIn);
  if (getDraft(waitKey).phase !== "idle") {
    updateDraft(threadKey, { error: "A new thread is being sent from that composer. Try Edit again in a moment." });
    return false;
  }
  updateDraft(threadKey, { error: null });
  updateDraft(waitKey, { phase: "starting", error: null, notice: null });
  showComposer(waitIn);
  const restore = hideThread(threadId);
  const failure = { message: "", tooLate: false };
  const res = await runCommandForResult(SETUP_COMMANDS.discard, { id: threadId }, {
    ctx,
    quiet: true,
    expected: (err) => {
      failure.tooLate = isFailedPrecondition(err);
      return true;
    },
    onError: (m) => {
      failure.message = m;
    },
  });
  if (!res) {
    restore();
    updateDraft(waitKey, { phase: "idle" });
    if (isDraftEmpty(getDraft(waitKey))) takeDraft(waitKey);
    useUiStore.getState().select({ kind: "thread", id: threadId }, { focusPrompt: true });
    updateDraft(threadKey, { error: failure.tooLate ? EDIT_TOO_LATE : failure.message || "Could not undo the send." });
    return false;
  }
  sentFrom.delete(threadId);
  const gone = parseDiscardedSetup(res.resultJson);
  const snap = parseSetupDraft(gone.draftJson);
  const notes: string[] = [];
  let to = waitIn;
  if (snap && targetExists(snap.target, threadId)) to = snap.target;
  else if (snap) {
    to = nearestTarget([...(snap.projects ?? []), ...t.projectIds]);
    notes.push(`What this was for is gone, so the draft is in ${targetName(to)} now`);
  } else {
    notes.push(`Only the message came back: this thread kept no draft to restore`);
  }
  const toKey = draftKey(to);
  if (toKey !== waitKey) {
    updateDraft(waitKey, { phase: "idle" });
    if (isDraftEmpty(getDraft(waitKey))) takeDraft(waitKey);
  }
  // What was typed in the thread's composer moves with it.
  const typed = takeDraft(threadKey);
  try {
    await fillDraft(to, snap, snap !== null && to === snap.target, gone, notes, typed);
  } catch {
    // The thread has gone, so this is the only copy left: the words at least stay.
    const cur = getDraft(toKey);
    updateDraft(toKey, { text: plainDraftText(cur.text, snap, gone, typed), phase: "idle", error: gone.error || null, notice: "Only the text came back: attach anything else again" });
  }
  // Only if the user is still here: they may have moved on while it was gone.
  const ui = useUiStore.getState();
  if (ui.selection.kind === "compose") {
    showComposer(to);
    requestAnimationFrame(() => {
      useUiStore.getState().focusComposer();
    });
  }
  return true;
}
