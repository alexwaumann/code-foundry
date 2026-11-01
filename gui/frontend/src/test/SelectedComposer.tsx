import { Composer } from "@/components/compose/Composer";
import { useUiStore } from "@/stores/ui";

/** What App.tsx's Content shows for the selection: the composer it keys, else the thread's id. */
export function SelectedComposer() {
  const sel = useUiStore((s) => s.selection);
  if (sel.kind === "thread") return <div data-testid="selected-thread">{sel.id}</div>;
  if (sel.kind !== "compose") return <div data-testid="selected-view">{sel.kind === "view" ? sel.name : sel.kind}</div>;
  return (
    <Composer
      key={sel.likeThreadId ? `like:${sel.likeThreadId}` : sel.workspaceId ? `ws:${sel.workspaceId}` : sel.noProject ? "home:" : sel.projectId}
      projectId={sel.projectId}
      workspaceId={sel.workspaceId}
      noProject={sel.noProject}
      likeThreadId={sel.likeThreadId}
    />
  );
}
