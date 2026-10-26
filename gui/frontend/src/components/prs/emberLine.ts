import type { PullRequestView } from "@/api/gh";
import type { AuthoredRow } from "./authoredStatus";

/** The inbox-zero card's title. */
export const EMBER_TITLE = "Nothing waiting on you";

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** 3 -> "three" (up to ten), 12 -> "12"; capitalised at the start of a sentence. */
function count(n: number, start = false): string {
  const w = WORDS[n] ?? String(n);
  return start ? w.charAt(0).toUpperCase() + w.slice(1) : w;
}

const QUIET = ["Inbox zero. Enjoy it while it lasts.", "Nothing in the queue. Go write something.", "The forge is quiet. Nothing is waiting on you."];

function dayOfYear(d: Date): number {
  return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) / 86_400_000);
}

/**
 * Ember's one line under the inbox-zero card, from what the viewer's own pull requests
 * need (first match wins): ready to merge, conflicts or failing CI, reviews still owed,
 * merges this week, else a quiet line that changes daily. A stand-in until a model writes it.
 */
export function emberLine(authored: readonly AuthoredRow[], merged: readonly PullRequestView[], viewer: string, now: Date): string {
  const ready = authored.filter((r) => r.status.kind === "ready");
  const first = ready[0];
  if (first) {
    return ready.length === 1
      ? `The forge is quiet. #${String(first.pr.number)} is approved and green, want to ship it?`
      : `${count(ready.length, true)} of yours are approved and green, want to ship them?`;
  }
  const broken = authored.filter((r) => r.status.kind === "conflicts" || r.status.kind === "ci_failing").length;
  if (broken > 0) return broken === 1 ? "Nothing to review. One of yours needs a hand, though." : `Nothing to review. ${count(broken, true)} of yours need a hand, though.`;
  const owed = new Set(authored.filter((r) => r.status.kind === "awaiting_review").flatMap((r) => r.pr.reviewRequests.map((l) => l.toLowerCase()))).size;
  if (owed > 0) return owed === 1 ? "Nothing to review. A teammate still owes you a review." : `Nothing to review. ${count(owed, true)} teammates still owe you a review.`;
  const mine = viewer === "" ? 0 : merged.filter((p) => p.author.toLowerCase() === viewer.toLowerCase()).length;
  if (mine > 0) return `Quiet queue. You merged ${count(mine)} this week.`;
  return QUIET[dayOfYear(now) % QUIET.length] ?? "";
}
