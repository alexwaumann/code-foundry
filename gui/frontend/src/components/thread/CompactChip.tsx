import { FoldVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { compactOffer } from "@/lib/compact";
import { fmtTok } from "@/lib/usage";
import { useDraft } from "@/stores/compose";
import { compactThread, threadDraftKey } from "@/stores/threadActions";
import { useThreadsStore } from "@/stores/threads";

/**
 * The composer's Compact chip after the permission picker: a large context, Claude at its
 * prompt (lib/compact), and no message on its way. Its siblings open a list; this one acts, so
 * it has no chevron. The second click of a double click sends nothing, and the press leaves
 * the caret in the prompt: the chip goes away under it.
 */
export function CompactChip({ threadId }: { threadId: string }) {
  const tokens = useThreadsStore((s) => compactOffer(s.byId[threadId]));
  const phase = useDraft(threadDraftKey(threadId), "phase");
  if (tokens === null || phase !== "idle") return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      data-compose-stop
      data-testid="thread-compact"
      className="text-cf-text-muted hover:text-cf-text"
      onMouseDown={(e) => {
        e.preventDefault();
      }}
      onClick={(e) => {
        if (e.detail > 1) return;
        void compactThread(threadId);
      }}
    >
      <FoldVertical aria-hidden />
      <span className="truncate">Compact · {fmtTok(tokens)}</span>
    </Button>
  );
}
