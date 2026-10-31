import { Folders } from "lucide-react";
import { cn } from "@/lib/utils";
import { keyOf } from "@/stores/panel";
import { isProjectsView, useUiStore } from "@/stores/ui";
import { ProjectPage } from "./ProjectPage";
import { ProjectsIndex } from "./ProjectsIndex";
import { WorkspacePage } from "./WorkspacePage";

/**
 * The Projects view (docs/notes/projects-redesign-1-index.md): the index (every project
 * and workspace as a row), or a project's or workspace's page, by the selection
 * (stores/ui.ts projectPage / workspacePage). Each page is its own selection with its own
 * side panel and scroll position; keyed by it so a page switch starts fresh.
 */
export function ProjectsPage() {
  const projectId = useUiStore((s) => (isProjectsView(s.selection) ? (s.selection.projectId ?? "") : ""));
  const workspaceId = useUiStore((s) => (isProjectsView(s.selection) ? (s.selection.workspaceId ?? "") : ""));
  const pageKey = useUiStore((s) => keyOf(s.selection) ?? "view:projects");
  if (projectId) return <ProjectPage key={pageKey} projectId={projectId} pageKey={pageKey} />;
  if (workspaceId) return <WorkspacePage key={pageKey} workspaceId={workspaceId} pageKey={pageKey} />;
  return <ProjectsIndex key={pageKey} pageKey={pageKey} />;
}

/**
 * Sidebar entry under Pull Requests: reopens the last Projects page shown (the index or a
 * page), or goes to the index from a project's or workspace's page (UiState.openProjects).
 */
export function ProjectsNav() {
  const active = useUiStore((s) => isProjectsView(s.selection));
  return (
    <button
      type="button"
      className={cn(
        "mt-0.5 flex h-7 items-center gap-2 rounded-md px-2 text-left text-body-sm",
        active ? "bg-cf-sidebar-row-selected text-cf-sidebar-foreground" : "text-cf-sidebar-foreground hover:bg-cf-sidebar-row-hover",
      )}
      data-testid="nav-projects"
      aria-current={active ? "page" : undefined}
      onClick={() => {
        useUiStore.getState().openProjects();
      }}
    >
      <Folders className="size-4 shrink-0 text-cf-icon-muted" aria-hidden />
      <span className="truncate">Projects</span>
    </button>
  );
}

