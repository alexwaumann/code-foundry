/**
 * Thread actions behind buttons, menus, inline edits and the follow-up composer. Each one
 * is a registry command invoked with an explicit thread context, so the palette,
 * keybindings, CLI, and these buttons all reach the same code in the daemon.
 *
 * The follow-up composer and controls (docs/notes/rendered-threads-2-gui.md).
 * Every action is a thread.* registry command invoked with the thread's context, like
 * the new-thread composer's session.new: thread.send (ThreadService.Send),
 * thread.interrupt, thread.respond, thread.set-model, thread.set-mode and thread.set-effort. The draft lives in the compose
 * store under `thread:<id>` (its text with the composer's tags as tokens, its images), so
 * switching threads keeps what was typed.
 */
import { toast } from "sonner";
import { isNotFound } from "@/api/errors";
import { stageAttachment } from "@/api/threads";
import { errorMessage } from "@/api/stream";
import type { ComposePermission } from "@/lib/compose";
import type { PermissionDecision } from "@/lib/threadRequest";
import { projectPrompt } from "@/lib/prompt";
import { sentComposerText } from "@/lib/userMessage";
import { invokeConfirmed, refreshCommands, runCommand, runCommandForResult, useCommandsStore } from "./commands";
import { clearDraft, getDraft, isDraftEmpty, updateDraft } from "./compose";
import { getUiContext } from "./context";
import { setAnswering } from "./thread";

export const THREAD_COMMANDS = {
  create: "thread.new",
  rename: "thread.rename",
  remove: "thread.remove",
  fork: "thread.fork",
  pin: "thread.pin",
  archive: "thread.archive",
  snooze: "thread.snooze",
  runIn: "thread.run-in",
  send: "thread.send",
  interrupt: "thread.interrupt",
  setModel: "thread.set-model",
  setMode: "thread.set-mode",
  respond: "thread.respond",
  setEffort: "thread.set-effort",
} as const;

/** The context of a thread (its worktree and workspace too), whether or not it is selected. */
export function threadContext(id: string) {
  return getUiContext({ kind: "thread", id });
}

/** The arg session.rename takes the new name in: its first required string arg, else "name". */
export function renameArgName(): string {
  const spec = useCommandsStore.getState().commands.find((c) => c.name === THREAD_COMMANDS.rename);
  return spec?.args.find((a) => a.required && a.type === "string")?.name ?? "name";
}

export function renameThread(id: string, name: string): Promise<boolean> {
  return runCommand(THREAD_COMMANDS.rename, { [renameArgName()]: name }, threadContext(id));
}

export function removeThread(id: string): Promise<boolean> {
  return runCommand(THREAD_COMMANDS.remove, {}, threadContext(id));
}

export function forkThread(id: string): Promise<boolean> {
  return runCommand(THREAD_COMMANDS.fork, {}, threadContext(id));
}

/** session.pin with an explicit value (the menu knows the current pin). */
export function pinThread(id: string, pinned: boolean): Promise<boolean> {
  return runCommand(THREAD_COMMANDS.pin, { pinned: String(pinned) }, threadContext(id));
}

/**
 * session.archive with an explicit value. Archiving stops Claude, removes the thread's
 * shells and unpins it; the daemon asks for confirmation (runCommand opens the dialog) only
 * while Claude is working, waiting on an answer or running background work. Unarchiving
 * never asks; a message starts Claude again.
 */
export function archiveThread(id: string, archived: boolean): Promise<boolean> {
  return runCommand(THREAD_COMMANDS.archive, { archived: String(archived) }, threadContext(id));
}

/**
 * session.snooze until an absolute time (epoch ms, sent as RFC 3339; the caller computes
 * presets such as "tomorrow 9 AM" itself), or null to unsnooze. Snoozing stops Claude,
 * removes the thread's shells and unpins and unarchives it; the daemon asks for
 * confirmation (runCommand opens the dialog) only while Claude is working or waiting on an
 * answer, and refuses a time that is not in the future. Unsnoozing never asks.
 */
export function snoozeThread(id: string, untilMs: number | null): Promise<boolean> {
  const args: Record<string, string> = untilMs === null ? { clear: "true" } : { until: new Date(untilMs).toISOString() };
  return runCommand(THREAD_COMMANDS.snooze, args, threadContext(id));
}

/** session.run-in ("Run in…"): moves a workspace thread to the member in repoId. */
export function runThreadIn(id: string, repoId: string): Promise<boolean> {
  return runCommand(THREAD_COMMANDS.runIn, { repo: repoId }, threadContext(id));
}

/** The compose store key of a thread's follow-up draft. */
export function threadDraftKey(threadId: string): string {
  return `thread:${threadId}`;
}

/**
 * Sends the thread's draft: stages its images, projects the prompt exactly like the
 * new-thread composer (image chips become `[Image: <name>; ref=<path>]`, skills `/name`,
 * files `@cf-file://…`, which the daemon resolves and stores as sent), then thread.send
 * with the staged paths and the composer's text (lib/userMessage sentComposerText) that
 * the message's bubble draws its tags from. On success the draft is cleared; on failure it stays with the
 * error. Allowed while Claude works: it queues the message or folds it in.
 */
export async function sendThreadDraft(threadId: string): Promise<boolean> {
  const key = threadDraftKey(threadId);
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
    const staged = new Map(cur.attachments.map((a) => [a.id, a]));
    const text = projectPrompt(cur.text, (id) => {
      const a = staged.get(id);
      return a?.stagedPath ? { name: a.file.name, ref: a.stagedPath } : undefined;
    }).trim();
    const sent = cur.attachments.filter((a) => a.stagedPath !== null);
    const attachments = sent.map((a) => a.stagedPath ?? "");
    const args: Record<string, string> = { id: threadId, text };
    if (attachments.length > 0) args.attachments = attachments.join(",");
    // The composer's own text, so the message's bubble draws the same tags (only when it
    // has any: without tags it is the text itself).
    const composer = sentComposerText(cur.text, (id) => sent.findIndex((a) => a.id === id)).trim();
    if (composer && composer !== text) args["composer-text"] = composer;
    const res = await invokeConfirmed(THREAD_COMMANDS.send, args, threadContext(threadId));
    if (!res) {
      updateDraft(key, { phase: "idle" });
      return false;
    }
    clearDraft(key);
    return true;
  } catch (err) {
    updateDraft(key, { phase: "idle", error: errorMessage(err) });
    return false;
  } finally {
    void refreshCommands();
  }
}

/**
 * Stops the running turn (thread.interrupt); pending requests are withdrawn. Quiet: the
 * timeline's footer says "Interrupted"; a failure still toasts.
 */
export async function interruptThread(threadId: string): Promise<boolean> {
  return (await runCommandForResult(THREAD_COMMANDS.interrupt, { id: threadId }, { ctx: threadContext(threadId), quiet: true })) !== null;
}

/**
 * Answers a pending request (thread.respond): a permission's decision with a deny's
 * reason, or a question's answers (question -> label, lib/threadRequest answersOf; deny
 * skips the questions). The prompt leaves at once and comes back if the answer fails
 * (the failure toasts). A request Claude withdrew meanwhile (NotFound: an interrupt, or
 * its turn ended) stays gone with a plain notice; the timeline row says "withdrawn".
 * Quiet otherwise: the timeline shows the outcome.
 */
export async function respondThread(threadId: string, requestId: string, decision: PermissionDecision, opts: { answers?: Record<string, string>; message?: string } = {}): Promise<boolean> {
  const args: Record<string, string> = { id: threadId, request: requestId, decision };
  if (opts.answers) args.answer = JSON.stringify(opts.answers);
  if (opts.message?.trim()) args.message = opts.message.trim();
  setAnswering(threadId, requestId, true);
  const failure = { withdrawn: false };
  const res = await runCommandForResult(THREAD_COMMANDS.respond, args, {
    ctx: threadContext(threadId),
    quiet: true,
    expected: (err) => (failure.withdrawn = isNotFound(err)),
  });
  if (res !== null) return true;
  if (failure.withdrawn) toast("Claude no longer needs that answer", { id: `withdrawn:${requestId}` });
  else setAnswering(threadId, requestId, false);
  return false;
}

/**
 * Changes the effort (thread.set-effort): Claude restarts with it, at once when idle, else
 * after the running turn (Session.effortPending says so meanwhile).
 */
export async function setThreadEffort(threadId: string, effort: string): Promise<boolean> {
  return (await runCommandForResult(THREAD_COMMANDS.setEffort, { id: threadId, effort }, { ctx: threadContext(threadId), quiet: true })) !== null;
}

/** Switches the model from the next request (thread.set-model). */
export function setThreadModel(threadId: string, model: string): Promise<boolean> {
  return runCommand(THREAD_COMMANDS.setModel, { id: threadId, model }, threadContext(threadId));
}

/** Switches the permission mode (thread.set-mode); Claude's default cannot be chosen live. */
export function setThreadPermission(threadId: string, permission: ComposePermission): Promise<boolean> {
  return runCommand(THREAD_COMMANDS.setMode, { id: threadId, permission }, threadContext(threadId));
}
