import { targetOf } from "@/shell/host";
import { isProjectsView, projectPage, PROJECTS_INDEX, useUiStore, workspacePage } from "@/stores/ui";
import { ProjectPage } from "./ProjectPage";
import { ProjectsIndex } from "./ProjectsIndex";
import { WorkspacePage } from "./WorkspacePage";

/**
 * The Projects view (docs/notes/projects-redesign-1-index.md): the index (every project
 * and workspace as a row), or a project's or workspace's page, by the selection
 * (stores/ui.ts projectPage / workspacePage). Each page is its own selection with its own
 * scroll position; keyed by it so a page switch starts fresh.
 */
export function ProjectsPage() {
  const projectId = useUiStore((s) => (isProjectsView(s.selection) ? (s.selection.projectId ?? "") : ""));
  const workspaceId = useUiStore((s) => (isProjectsView(s.selection) ? (s.selection.workspaceId ?? "") : ""));
  return <ProjectsPageAt projectId={projectId} workspaceId={workspaceId} />;
}

/**
 * One of the Projects pages by its location rather than the selection: the window shell's
 * Projects tab says which page it shows in its params (shell/surfaces/pages.tsx).
 */
export function ProjectsPageAt({ projectId, workspaceId }: { projectId: string; workspaceId: string }) {
  const pageKey = targetOf(projectId ? projectPage(projectId) : workspaceId ? workspacePage(workspaceId) : PROJECTS_INDEX) ?? "view:projects";
  if (projectId) return <ProjectPage key={pageKey} projectId={projectId} pageKey={pageKey} />;
  if (workspaceId) return <WorkspacePage key={pageKey} workspaceId={workspaceId} pageKey={pageKey} />;
  return <ProjectsIndex key={pageKey} pageKey={pageKey} />;
}

