import { Tip } from "@/components/ui/tooltip";

/**
 * A message Claude has not read yet (docs/notes/orch-queued-placement.md): sent while
 * Claude worked, it waits in Claude Code's queue until its next tool call (or the end of
 * the reply it is writing). The daemon clears the flag and moves the message where Claude
 * read it, and the tag goes.
 */
export function QueuedTag() {
  return (
    <Tip label="Read by Claude at its next tool call">
      <span className="text-caption flex-none rounded-sm border px-1 select-none" data-testid="thread-queued">
        queued
      </span>
    </Tip>
  );
}
