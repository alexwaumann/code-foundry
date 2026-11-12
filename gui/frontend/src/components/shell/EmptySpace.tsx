import { Composer } from "@/components/compose/Composer";

/**
 * A space with no pane (a new space, the first load, the last tab closed) shows the home
 * composer filling the content area, drawn as one pane (docs/notes/shell-model.md, "The
 * composer"; plan question 11). Sending from it opens the thread's tab in a new pane in its
 * place (stores/selectionBridge.ts).
 */
export function EmptySpace() {
  return (
    <main className="absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-pane border border-cf-divider bg-cf-surface shadow-xs" data-testid="shell-empty-space">
      <Composer key="home:" projectId="" noProject />
    </main>
  );
}
