import { GitFork } from "lucide-react";
import { Tip } from "@/components/ui/tooltip";
import { setupUnfinished } from "@/lib/threadSetup";
import { useThreadsStore } from "@/stores/threads";

/**
 * The whole-thread fork's rules the GUI knows without asking (ThreadMenuItems' Fork): none for a
 * setup that did not finish; disabled once Claude Code deleted the transcript. Whether this turn
 * can be forked from is the daemon's to say.
 */
function useForkAvailability(threadId: string): "hidden" | "missing" | "ok" {
  return useThreadsStore((s) => {
    const t = s.byId[threadId];
    if (setupUnfinished(t?.setup)) return "hidden";
    return t?.transcriptMissing === true ? "missing" : "ok";
  });
}

const LABEL = "Fork from here";

/**
 * The icon-only button in a turn's gutter, right after Copy (docs/notes/fork-from-here-button.md);
 * GutterRow holds its fork (useForkFromTurn), so the gutter shows while it runs.
 */
export function ForkFromHereButton({ threadId, held, onFork }: { threadId: string; held: boolean; onFork: () => void }) {
  const availability = useForkAvailability(threadId);
  if (availability === "hidden") return null;
  const missing = availability === "missing";
  // aria-disabled, not disabled: a disabled button gets no pointer events (no tooltip), and an
  // older turn's gutter shows only while one of its controls keeps the keyboard focus.
  const off = missing || held;
  return (
    <Tip label={missing ? "Fork from here: the transcript was deleted" : LABEL}>
      <button
        type="button"
        className="ib"
        aria-label={LABEL}
        aria-disabled={off || undefined}
        aria-busy={held || undefined}
        data-held={held || undefined}
        data-testid="thread-fork-here"
        onClick={() => {
          if (!off) onFork();
        }}
      >
        <GitFork aria-hidden />
      </button>
    </Tip>
  );
}
