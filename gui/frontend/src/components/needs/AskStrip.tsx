import { MessageCircleQuestionMark, ShieldAlert } from "lucide-react";
import type { ThreadPendingView } from "@/api/thread";
import { askTarget } from "@/lib/needsAsk";
import { questionsOf } from "@/lib/threadRequest";
import { openNeedsPopup } from "@/stores/needs";
import { useThreadItem } from "@/stores/thread";
import { useThreadsStore } from "@/stores/threads";
import { NeedsHoverCard } from "./NeedsCard";

/** The start of what the ask is about: the command, file or question; the thread source's summary until the item is in the log. */
function useAskText(threadId: string, p: ThreadPendingView): string {
  const item = useThreadItem(threadId, p.itemId);
  const cwd = useThreadsStore((s) => s.byId[threadId]?.worktreePath ?? "");
  if (item?.kind === "question") return questionsOf(item.request.inputJson)[0]?.question || p.summary;
  if (item?.kind === "permission") return askTarget(item.request, cwd)?.text.split("\n")[0] || p.summary;
  return p.summary;
}

/**
 * The ask as one line above the composer, in a shell pane too short for the full card
 * (docs/notes/shell-model.md, "In a pane"; shell/askStrip.ts decides): its icon, its kind, the
 * start of the command or question, and how many more wait. Hovering or focusing it shows the
 * Needs-you hover card; a click opens the popup, which has the full card.
 */
export function AskStrip({ threadId, pending, paneId }: { threadId: string; pending: readonly ThreadPendingView[]; paneId: string }) {
  const first = pending[0];
  const text = useAskText(threadId, first ?? { requestId: "", itemId: "", question: false, toolName: "", summary: "" });
  if (!first) return null;
  const anchor = `strip:${paneId}`;
  const Icon = first.question ? MessageCircleQuestionMark : ShieldAlert;
  return (
    <NeedsHoverCard threadId={threadId} anchor={anchor} side="top" align="start">
      <button
        type="button"
        className="ask-strip flex h-8 min-w-0 items-center gap-2 px-3 text-left text-body-sm outline-none hover:bg-cf-control-hover focus-visible:ring-1 focus-visible:ring-cf-focus focus-visible:ring-inset"
        data-testid="ask-strip"
        data-ask={first.question ? "question" : "permission"}
        onClick={() => {
          openNeedsPopup(threadId, anchor);
        }}
      >
        <Icon className="size-3.5 shrink-0 text-cf-warning-text" aria-hidden />
        <span className="shrink-0 font-medium text-cf-warning-text">{first.question ? "Question" : "Permission"}</span>
        <span className={first.question ? "min-w-0 flex-1 truncate" : "min-w-0 flex-1 truncate font-mono text-code"} data-testid="ask-strip-text">
          {text}
        </span>
        {pending.length > 1 && <span className="shrink-0 text-cf-text-muted tabular-nums">+{pending.length - 1}</span>}
      </button>
    </NeedsHoverCard>
  );
}
