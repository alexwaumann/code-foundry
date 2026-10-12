/**
 * A rendered thread's follow-up composer and controls (docs/notes/rendered-threads-2-gui.md).
 * Every action is a thread.* registry command invoked with the thread's context, like
 * the new-thread composer's session.new: thread.send (ThreadService.Send),
 * thread.interrupt, thread.set-model and thread.set-mode. The draft lives in the compose
 * store under `thread:<id>` (its text with the composer's tags as tokens, its images), so
 * switching threads keeps what was typed.
 */
import { stageAttachment } from "@/api/session";
import { errorMessage } from "@/api/stream";
import type { ComposePermission } from "@/lib/compose";
import { projectPrompt } from "@/lib/prompt";
import { invokeConfirmed, refreshCommands, runCommand } from "./commands";
import { clearDraft, getDraft, isDraftEmpty, updateDraft } from "./compose";
import { sessionContext } from "./sessionActions";

export const THREAD_COMMANDS = {
  send: "thread.send",
  interrupt: "thread.interrupt",
  setModel: "thread.set-model",
  setMode: "thread.set-mode",
  respond: "thread.respond",
} as const;

/** The compose store key of a rendered thread's follow-up draft. */
export function threadDraftKey(sessionId: string): string {
  return `thread:${sessionId}`;
}

/**
 * Sends the thread's draft: stages its images, projects the prompt exactly like the
 * new-thread composer (image chips become `[Image: <name>; ref=<path>]`, skills `/name`,
 * files `@cf-file://…`, which the daemon resolves and stores as sent), then thread.send
 * with the staged paths. On success the draft is cleared; on failure it stays with the
 * error. Allowed while Claude works: it queues the message or folds it in.
 */
export async function sendThreadDraft(sessionId: string): Promise<boolean> {
  const key = threadDraftKey(sessionId);
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
    const attachments = cur.attachments.flatMap((a) => (a.stagedPath ? [a.stagedPath] : []));
    const args: Record<string, string> = { id: sessionId, text };
    if (attachments.length > 0) args.attachments = attachments.join(",");
    const res = await invokeConfirmed(THREAD_COMMANDS.send, args, sessionContext(sessionId));
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

/** Stops the running turn (thread.interrupt); pending requests are withdrawn. */
export function interruptThread(sessionId: string): Promise<boolean> {
  return runCommand(THREAD_COMMANDS.interrupt, { id: sessionId }, sessionContext(sessionId));
}

/** Switches the model from the next request (thread.set-model). */
export function setThreadModel(sessionId: string, model: string): Promise<boolean> {
  return runCommand(THREAD_COMMANDS.setModel, { id: sessionId, model }, sessionContext(sessionId));
}

/** Switches the permission mode (thread.set-mode); Claude's default cannot be chosen live. */
export function setThreadPermission(sessionId: string, permission: ComposePermission): Promise<boolean> {
  return runCommand(THREAD_COMMANDS.setMode, { id: sessionId, permission }, sessionContext(sessionId));
}
