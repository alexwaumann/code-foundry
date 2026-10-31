import type { RefObject, WheelEvent } from "react";
import { cn } from "@/lib/utils";
import { ContextGroup } from "./ContextGroup";
import { GitGroup } from "./GitGroup";
import { LineageGroup } from "./LineageGroup";
import { McpGroup } from "./McpGroup";
import { PlaceGroup } from "./PlaceGroup";
import { ShellsGroup } from "./ShellsGroup";

/** A line-mode wheel's line in px (WebKit sends pixels; a mouse elsewhere may send lines). */
const LINE_PX = 16;

/**
 * The thread info card (docs/notes/thread-info-card.md, design docs/sketches/thread-info
 * v14): a 320px column laid over the right of the conversation, in the sidebar's colour.
 * Groups follow each other with a divider and no headings; a group or row with nothing to
 * say is left out. Read-only facts and the commands that already exist: it adds no user
 * action of its own.
 *
 * The conversation keeps clear of it (ThreadPane sets --ti-inset) and its scrollbar stays
 * at the pane's edge, in the card's gutter. The column takes no pointer events of its own,
 * so a wheel beside or under the card reaches the conversation; one over the card scrolls
 * the card while it is taller than the pane, and is handed to the conversation otherwise
 * (`scrollerRef`: the body the timeline scrolls in). Without room beside the conversation
 * the same content floats over it instead (ThreadInfoOverlay), which scrolls only itself.
 */
export function ThreadInfoCard({ threadId, scrollerRef }: { threadId: string; scrollerRef?: RefObject<HTMLElement | null> }) {
  const forward = (e: WheelEvent<HTMLElement>) => {
    const own = e.currentTarget;
    // A row's menu or hover card is portalled out of the card but bubbles here through React: it scrolls itself. A pinch (ctrl) or sideways wheel is not a scroll of the list.
    if (!(e.target instanceof Node) || !own.contains(e.target) || e.ctrlKey || e.deltaY === 0) return;
    const canScroll = e.deltaY > 0 ? own.scrollTop + own.clientHeight < own.scrollHeight - 1 : own.scrollTop > 0;
    if (canScroll) return;
    const scroller = scrollerRef?.current?.querySelector<HTMLElement>('[data-testid="thread-timeline"]');
    if (!scroller) return;
    // The timeline counts a wheel as the reader's input (it unpins from the bottom); a bare scrollBy would be put back.
    scroller.dispatchEvent(new window.WheelEvent("wheel", { deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, bubbles: true }));
    const unit = e.deltaMode === window.WheelEvent.DOM_DELTA_LINE ? LINE_PX : e.deltaMode === window.WheelEvent.DOM_DELTA_PAGE ? scroller.clientHeight : 1;
    scroller.scrollBy({ top: e.deltaY * unit });
  };
  return (
    <aside
      className="pointer-events-none absolute inset-y-0 right-0 flex w-(--ti-card) flex-col overflow-y-auto py-3 pr-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      aria-label="Thread info"
      data-testid="thread-info"
      onWheel={forward}
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
