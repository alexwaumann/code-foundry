/**
 * The thread composer's "your message was not sent" notice
 * (docs/notes/composer-failed-notice.md): which prompt got no reply because its turn
 * failed, and the line that says why; and that prompt back as a draft for its Edit. Pure.
 */
import type { ThreadItemView } from "@/api/thread";
import type { ThreadStateView, ThreadStatusView } from "@/api/threads";
import { citeToken, splitCiteLinks, type Citation } from "./citation";
import { parsePrompt, serializePrompt } from "./prompt";

export interface FailedPromptInput {
  /** The thread's items in the log's order (stores/thread ThreadLog). */
  order: readonly string[];
  byId: Readonly<Record<string, ThreadItemView>>;
  state: ThreadStateView;
  status: ThreadStatusView;
  statusReason: string;
  /** When status last changed, epoch ms; null when unknown. */
  statusChangedAtMs: number | null;
  /** Prompts docked in the composer (pending requests). */
  pending: number;
  /** Claude Code deleted the transcript: nothing can be sent. */
  transcriptMissing: boolean;
}

export interface FailedPrompt {
  /** The user message that got no reply. */
  itemId: string;
  ordinal: number;
  /** "Claude did not start, so your message was not sent." */
  line: string;
}

type Reason = { kind: "didNotStart" } | { kind: "stopped" } | { kind: "failed"; subtype: string } | { kind: "unknown" };

/** The daemon's error items (internal/store/thread stream.go, lifecycle.go). */
const DID_NOT_START = "Claude did not start";
const STOPPED = "Claude stopped";

/** "error_during_execution" -> "error during execution"; "" for none or "success". */
function shortSubtype(subtype: string): string {
  return subtype === "success" ? "" : subtype.replace(/_+/g, " ").trim();
}

function lineOf(r: Reason): string {
  switch (r.kind) {
    case "didNotStart":
      return "Claude did not start, so your message was not sent.";
    case "stopped":
      return "Claude stopped before replying, so your message was not sent.";
    case "failed": {
      const short = shortSubtype(r.subtype);
      return `The request failed${short ? ` (${short})` : ""}, so your message was not sent.`;
    }
    case "unknown":
      return "Your message didn't go through.";
  }
}

/**
 * The thread's last user prompt when it got no reply because its turn failed, else null.
 * Failed: after the prompt there is no assistant text (nor a command's output), the thread
 * is not working, and Claude did not start (the daemon's "Claude did not start" error item,
 * or status error "did not start"), Claude stopped (a "Claude stopped …" error item, or
 * another status error), the turn ended in error (a turn end with is_error or a subtype
 * other than success, not an interrupt) or some other error item followed the prompt. The
 * status counts only when it changed at or after the prompt (an older failure's status
 * says nothing about a prompt just sent). Subagent items, a wake message (the daemon's, not
 * the user's) and a message Claude has not read yet never qualify; nor does anything while
 * prompts are docked or the transcript is gone.
 */
export function failedPrompt(input: FailedPromptInput): FailedPrompt | null {
  const { order, byId, state, status } = input;
  if (input.pending > 0 || input.transcriptMissing) return null;
  const running = state !== "disconnected" && state !== "closing";
  if (running && (status === "busy" || state === "starting")) return null;
  // Walking back from the end: the first error after the prompt, the last turn end.
  let error: string | null = null;
  let turnFailed: string | null = null;
  for (let i = order.length - 1; i >= 0; i--) {
    const it = byId[order[i] ?? ""];
    if (!it || it.parentToolUseId !== "") continue;
    switch (it.kind) {
      case "text":
      case "commandOutput":
        if (it.text.trim() !== "") return null;
        break;
      case "error":
        error = it.text;
        break;
      case "turnEnd":
        if (!it.interrupted && (it.isError || shortSubtype(it.subtype) !== "")) turnFailed ??= it.subtype;
        break;
      case "user": {
        if (it.wake || it.queued) return null;
        const fresh = status === "error" && input.statusChangedAtMs !== null && it.createdAtMs !== null && input.statusChangedAtMs >= it.createdAtMs;
        const reason = reasonOf(error, turnFailed, fresh ? input.statusReason : null);
        return reason ? { itemId: it.id, ordinal: it.ordinal, line: lineOf(reason) } : null;
      }
      default:
        break;
    }
  }
  return null;
}

/** statusReason: the error status's reason when it is the prompt's, else null. */
function reasonOf(error: string | null, turnFailed: string | null, statusReason: string | null): Reason | null {
  if (error?.startsWith(DID_NOT_START) || statusReason === "did not start") return { kind: "didNotStart" };
  if (error?.startsWith(STOPPED)) return { kind: "stopped" };
  if (turnFailed !== null) return { kind: "failed", subtype: turnFailed };
  if (error !== null) return { kind: "unknown" };
  if (statusReason !== null) return { kind: "stopped" };
  return null;
}

/** A sent user message as the timeline has it. */
export interface SentMessage {
  /** What Claude got. */
  text: string;
  /** The composer's text with its tag tokens; "" when sent without tags (or without the composer). */
  composerText: string;
  /** The staged paths, in the order the composer text's image chips index them. */
  attachments: readonly string[];
}

/** The last segment of a path. */
function baseName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

/** Each attachment's name: its first chip's label, else its staged file's name. */
export function sentAttachmentNames(m: SentMessage): string[] {
  const names = m.attachments.map((p) => baseName(p));
  const named = new Set<number>();
  for (const line of parsePrompt(m.composerText)) {
    for (const p of line) {
      if (p.kind !== "tag" || p.tagKind !== "image" || !/^\d+$/.test(p.id)) continue;
      const i = Number(p.id);
      if (i < names.length && !named.has(i) && p.name.trim()) {
        names[i] = p.name.trim();
        named.add(i);
      }
    }
  }
  return names;
}

/**
 * A sent message back as draft text: its composer text (its text when it has none) with
 * each image chip pointing at idOf(its attachment's index) (a chip whose attachment is not
 * put back is dropped), and each citation link (lib/citation citeLink) a draft citation
 * token again, its body with a fresh id from newId. Other tags stay as they are.
 */
export function draftOfSent(m: SentMessage, idOf: (index: number) => string | undefined, newId: () => string): { text: string; citations: Citation[] } {
  const citations: Citation[] = [];
  const withCites = splitCiteLinks(m.composerText || m.text)
    .map((p) => {
      if (p.kind === "text") return p.text;
      const c: Citation = { ...p.cite, id: newId() };
      citations.push(c);
      return citeToken(c.id);
    })
    .join("");
  const lines = parsePrompt(withCites).map((line) =>
    line.flatMap((p) => {
      if (p.kind !== "tag" || p.tagKind !== "image") return [p];
      const id = /^\d+$/.test(p.id) ? idOf(Number(p.id)) : undefined;
      return id === undefined ? [] : [{ ...p, id }];
    }),
  );
  return { text: serializePrompt(lines).trim(), citations };
}

/** The draft with `added` after it: a blank line between when the draft has text already. */
export function appendToDraft(draft: string, added: string): string {
  const head = draft.trimEnd();
  return head === "" ? added : `${head}\n\n${added}`;
}
