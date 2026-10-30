import { ContextGroup } from "./ContextGroup";
import { GitGroup } from "./GitGroup";
import { LineageGroup } from "./LineageGroup";
import { McpGroup } from "./McpGroup";
import { PlaceGroup } from "./PlaceGroup";
import { ShellsGroup } from "./ShellsGroup";

/**
 * The thread info card (docs/notes/thread-info-card.md, design docs/sketches/thread-info
 * v14): a 320px column right of the conversation and its composer, in the sidebar's
 * colour. Groups follow each other with a divider and no headings; a group or row with
 * nothing to say is left out. It scrolls when taller than the pane. Read-only facts and the
 * commands that already exist: it adds no user action of its own.
 */
export function ThreadInfoCard({ threadId }: { threadId: string }) {
  return (
    <aside className="flex w-80 shrink-0 flex-col overflow-y-auto py-3 pr-3" aria-label="Thread info" data-testid="thread-info">
      <div className="flex flex-none flex-col rounded-lg border bg-cf-sidebar py-1" data-testid="thread-info-card">
        <PlaceGroup threadId={threadId} />
        <GitGroup threadId={threadId} />
        <ShellsGroup threadId={threadId} />
        <LineageGroup threadId={threadId} />
        <McpGroup threadId={threadId} />
        <ContextGroup threadId={threadId} />
      </div>
    </aside>
  );
}
