import type { ThreadView } from "@/api/threads";
import { statusKind, threadBadge } from "./thread";
import { setupUnfinished } from "./threadSetup";

/** Past this many context tokens, on any model, a thread offers to compact (docs/notes/compact-button.md). */
export const COMPACT_OFFER_TOKENS = 400_000;

type CompactInput = Pick<ThreadView, "state" | "status" | "statusReason" | "contextTokens" | "effortPending" | "setup"> & Partial<Pick<ThreadView, "resident" | "owner" | "transcriptMissing">>;

/**
 * The context tokens to show on a thread's Compact chip and card row, or null when neither
 * shows: the context is at or under the threshold, Claude works, compacts, starts, restarts
 * or waits for an answer, or the thread is not one a person compacts (Ember, a plugin's).
 * A stopped thread offers it (the command starts it), and so does a finished or failed turn.
 */
export function compactOffer(t: CompactInput | undefined): number | null {
  if (!t || !(t.contextTokens > COMPACT_OFFER_TOKENS)) return null;
  if (t.resident || t.owner || t.transcriptMissing || t.effortPending || setupUnfinished(t.setup)) return null;
  const badge = threadBadge(t);
  if (badge === "busy" || badge === "unknown") return null;
  const kind = statusKind(t);
  if (kind === "permission" || kind === "question") return null;
  return t.contextTokens;
}
