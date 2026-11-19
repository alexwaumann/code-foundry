/**
 * Lines for the other threads a thread talks to (docs/notes/other-thread-lines.md): two
 * lead threads, neither a worker of the other, exchanging short one-off messages. Where a
 * run of a thread's own workers reads as a card (lib/workerRuns), each other thread this
 * thread messaged in a run reads as one line that changes in place: a dot, its name, what
 * happened in a few words and the time. lib/workerRuns places the lines; this file holds
 * what they say.
 *
 * The words follow the exchange, with a small vocabulary that matches the daemon's sender
 * note (internal/store/thread/replies.go sentText). The head is this thread's first message
 * to the other thread in the run:
 *
 * - `told · no reply needed` (no reply wanted)
 * - `asked · waiting for a reply`, then `replied`; `asked · no answer yet` (the other
 *   thread ended its turn without one, or, frozen, none had come by then);
 *   `asked · no answer: archived` / `removed`
 * - `answered` (it answered a question the other thread asked first)
 * - `replied` alone when the line starts with the answer to a question asked in an earlier
 *   run (the conversation resumed after the user's message)
 *
 * Then, after " · ", what came after the head, in the order it began:
 *
 * - `then asked 1 question` / `2 questions` (the other thread asked this one), with
 *   `, answered` once this thread answered them all
 * - `then sent 1 message` / `2 messages` (the other thread told this one something that
 *   wanted no reply)
 * - `then asked it 1 question` (this thread asked again), with `, replied`,
 *   ` · waiting for a reply` or `, no answer yet`
 */
import type { SentMessageView } from "@/api/replies";
import { formatDuration } from "./duration";
import { sentTime } from "./format";
import { statusTimeUnits } from "./statusRegistry";
import type { PeerRow } from "./threadTimeline";

/** What became of a sent message: "" no reply was wanted, else waiting, replied, or why no answer came. */
export type SentState = "" | "waiting" | "replied" | "ended" | "archived" | "removed";

/** A sent-message note, decoded (TimelineItem.sent). */
export interface SentDesc {
  to: string;
  wanted: boolean;
  state: SentState;
  /** The answer's item in this thread's timeline; "" until it came. */
  replyItem: string;
}

const UNANSWERED: Readonly<Record<string, SentState>> = { "turn ended": "ended", archived: "archived", removed: "removed" };

/**
 * A note's sent record as one string for its timeline item, "" unless it went to another
 * thread (relation other): a message to this thread's lead stays a plain note, and none is
 * written for one to its own worker (its card shows those).
 */
export function sentDescOf(sent: SentMessageView | undefined): string {
  if (sent?.relation !== "other" || sent.toThreadId === "") return "";
  let state: SentState = "";
  if (sent.reply === "wanted") state = sent.repliedAtMs !== null ? "replied" : (UNANSWERED[sent.unanswered] ?? "waiting");
  return [sent.toThreadId, sent.reply === "wanted" ? "w" : "n", state, sent.replyItemId].join("/");
}

const STATES: ReadonlySet<string> = new Set<SentState>(["", "waiting", "replied", "ended", "archived", "removed"]);

/** sentDescOf's string back; null for none. */
export function decodeSent(s: string | undefined): SentDesc | null {
  if (!s) return null;
  const [to = "", mark = "", state = "", replyItem = ""] = s.split("/");
  if (!to || !STATES.has(state)) return null;
  return { to, wanted: mark === "w", state: state as SentState, replyItem };
}

/** One thing in an exchange, in timeline order: this thread sent, or the other thread's message arrived. */
export type PeerEvent =
  | { kind: "sent"; wanted: boolean; state: SentState; replyItem: string; at: number | null }
  /** `answer`: it is the answer to one of this thread's questions (a sent note's reply item). */
  | { kind: "got"; wanted: boolean; item: string; answer: boolean; at: number | null };

/** A line's words and dot. */
export interface PeerWords {
  words: string;
  tone: PeerRow["tone"];
}

const count = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

/**
 * What a line says (see the file's comment), from the run's events with the other thread.
 * `live`: the current run's line; a frozen one reads in the past ("no answer yet" for a
 * reply still awaited) and counts a sent question replied only when its answer came in the
 * run (`events` holds it). Null when this thread sent nothing and got no answer in the run:
 * no line.
 */
export function peerWords(events: readonly PeerEvent[], live: boolean): PeerWords | null {
  const got = new Set(events.flatMap((e) => (e.kind === "got" ? [e.item] : [])));
  // The answers to this thread's questions: the line's "replied", never news of their own.
  const replies = new Set(events.flatMap((e) => (e.kind === "sent" && e.replyItem ? [e.replyItem] : [])));
  const replied = (e: Extract<PeerEvent, { kind: "sent" }>) => e.state === "replied" && (live || e.replyItem === "" || got.has(e.replyItem));
  /** A question's outcome: replied, waiting (live only), or no answer. */
  const outcome = (e: Extract<PeerEvent, { kind: "sent" }>): "replied" | "waiting" | "none" | "archived" | "removed" => {
    if (replied(e)) return "replied";
    if (e.state === "archived" || e.state === "removed") return e.state;
    return live && (e.state === "waiting" || e.state === "replied") ? "waiting" : "none";
  };

  const first = events.findIndex((e) => e.kind === "sent" || e.answer);
  const head = events[first];
  if (!head) return null;

  let words: string;
  let tone: PeerRow["tone"] = "success";
  let waiting = false;
  // Questions after the head: the other thread's (answered by this thread's next message), and this thread's own.
  let theirs = 0;
  let told = 0;
  let open = false;
  let mine: Extract<PeerEvent, { kind: "sent" }>[] = [];
  const order: ("theirs" | "told" | "mine")[] = [];

  if (head.kind === "got") {
    words = "replied";
  } else if (events.slice(0, first).some((e) => e.kind === "got" && e.wanted)) {
    words = "answered";
    if (head.wanted) {
      mine = [head];
      order.push("mine");
    }
  } else if (!head.wanted) {
    words = "told · no reply needed";
    tone = "info";
  } else {
    const o = outcome(head);
    words = o === "replied" ? "replied" : o === "waiting" ? "asked · waiting for a reply" : o === "none" ? "asked · no answer yet" : `asked · no answer: ${o}`;
    if (o === "waiting") waiting = true;
    else if (o !== "replied") tone = "muted";
  }

  for (const e of events.slice(first + 1)) {
    if (e.kind === "got") {
      if (e.answer || replies.has(e.item)) continue;
      if (!e.wanted) {
        told++;
        if (!order.includes("told")) order.push("told");
        continue;
      }
      theirs++;
      open = true;
      if (!order.includes("theirs")) order.push("theirs");
      continue;
    }
    open = false;
    if (e.wanted) {
      mine.push(e);
      if (!order.includes("mine")) order.push("mine");
    }
  }

  const tail: string[] = [];
  for (const part of order) {
    if (part === "told") {
      tail.push(`then sent ${count(told, "message", "messages")}`);
      continue;
    }
    if (part === "theirs") {
      tail.push(`then asked ${count(theirs, "question", "questions")}${open ? "" : ", answered"}`);
      tone = tone === "info" ? "success" : tone;
      continue;
    }
    const last = mine[mine.length - 1];
    if (!last) continue;
    const o = outcome(last);
    const asked = `then asked it ${count(mine.length, "question", "questions")}`;
    if (o === "waiting") {
      tail.push(`${asked} · waiting for a reply`);
      waiting = true;
    } else {
      tail.push(o === "replied" ? `${asked}, replied` : `${asked}, no answer yet`);
      if (o !== "replied") tone = "muted";
      else if (tone === "info") tone = "success";
    }
  }
  if (waiting) tone = "warning";
  return { words: [words, ...tail].join(" · "), tone };
}

/** When a line's exchange began: its first event's time, else null. */
export function peerStart(events: readonly PeerEvent[]): number | null {
  for (const e of events) if (e.at !== null) return e.at;
  return null;
}

/**
 * The time at a line's right: while it is the current run's, how long since the exchange
 * began (the sidebar's units, as a worker card's lines); frozen, the time the user's next
 * message froze it, as message times read.
 */
export function peerTime(row: Pick<PeerRow, "live" | "start" | "end">, now: number): string {
  if (!row.live) return sentTime(row.end);
  if (row.start === null) return "";
  const ms = Math.max(0, now - row.start);
  return formatDuration(ms, statusTimeUnits(ms));
}

/** A message's first line that has text, for the row's summary. */
export function firstLine(text: string): string {
  for (const l of text.split("\n")) {
    const t = l.trim();
    if (t !== "") return t;
  }
  return "";
}
