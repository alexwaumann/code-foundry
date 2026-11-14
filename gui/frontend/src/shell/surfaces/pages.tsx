import { Folders, GitPullRequest } from "lucide-react";
import { ProjectsPageAt } from "@/components/projects/ProjectsPage";
import { PullRequestsPage } from "@/components/prs/PullRequestsPage";
import type { ShellSurface } from "./types";

/** The Pull Requests page as a tab (one per space). Its header stays: it holds the page's controls and freshness. */
export const prsSurface: ShellSurface = {
  kind: "prs",
  icon: GitPullRequest,
  useTitle: () => "Pull Requests",
  render: () => <PullRequestsPage />,
};

/**
 * The Projects pages as a tab (one per space): the index, or a project's or workspace's page as
 * the tab's `project` or `workspace` param says (stores/selectionBridge.ts moves it).
 */
export const projectsSurface: ShellSurface = {
  kind: "projects",
  icon: Folders,
  useTitle: () => "Projects",
  render: (tab) => <ProjectsPageAt projectId={tab.params.project ?? ""} workspaceId={tab.params.workspace ?? ""} />,
};
