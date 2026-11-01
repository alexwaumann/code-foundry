import { cn } from "@/lib/utils";
import { ContextGroup } from "./ContextGroup";
import { GitGroup } from "./GitGroup";
import { LineageGroup } from "./LineageGroup";
import { McpGroup } from "./McpGroup";
import { PlaceGroup } from "./PlaceGroup";
import { ShellsGroup } from "./ShellsGroup";

/**
 * The thread info card (docs/notes/thread-info-card.md, design docs/sketches/thread-info
 * v14): a 320px column laid over the right of the conversation, in the sidebar's colour.
 * Groups follow each other with a divider and no headings; a group or row with nothing to
 * say is left out. Read-only facts and the commands that already exist: it adds no user
 * action of its own.
 *
 * It is drawn inside the timeline's scroller (Timeline's pinnedLayer: a box stuck to the
 * list's top that takes no height), over the scroller's right padding: the conversation
 * keeps clear of it (ThreadPane sets --ti-inset) and the list's scrollbar stays at the
 * pane's edge, in the card's gutter. It is placed from the scroller's padding box, whose
 * right edge moves in by the scrollbar's width once the list scrolls (--timeline-sb), so
 * the card stays 12px from the pane's edge either way. The column takes no pointer events
 * of its own, so a wheel beside or under the card reaches the list; one over the card
 * scrolls the card while it is taller than the pane, and otherwise chains to the list
 * natively, which counts it as the reader's input (docs/notes/thread-info-wheel-native.md).
 * Without room beside the conversation the same content floats over it instead
 * (ThreadInfoOverlay), which scrolls only itself.
 */
export function ThreadInfoCard({ threadId }: { threadId: string }) {
  return (
    <aside
      className="pointer-events-none absolute top-0 right-[calc(var(--ti-gutter)-var(--ti-inset)-var(--timeline-sb,0px))] flex max-h-(--timeline-h) w-[calc(var(--ti-card)-var(--ti-gutter))] flex-col overflow-y-auto py-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      aria-label="Thread info"
      data-testid="thread-info"
    >
      <ThreadInfoContent threadId={threadId} className="pointer-events-auto rounded-lg border bg-cf-sidebar" />
    </aside>
  );
}

/** The card's groups, in the inline column's box or the overlay's. */
export function ThreadInfoContent({ threadId, className }: { threadId: string; className?: string }) {
  return (
    <div className={cn("flex flex-none flex-col py-1", className)} data-testid="thread-info-card">
      <PlaceGroup threadId={threadId} />
      <GitGroup threadId={threadId} />
      <ShellsGroup threadId={threadId} />
      <LineageGroup threadId={threadId} />
      <McpGroup threadId={threadId} />
      <ContextGroup threadId={threadId} />
    </div>
  );
}
