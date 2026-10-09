import { createElement } from "react";
import { GitPullRequest } from "lucide-react";
import { SurfacePlaceholder } from "./Placeholder";
import type { SurfaceSpec } from "./types";

/**
 * Pull request: the selection's pull request. Disabled with no default tab until its
 * chunk lands; it will derive availability and `openDefault` (a tab whose params name
 * the pull request) from the selection's worktree branch.
 */
export const pullRequestSurface: SurfaceSpec = {
  kind: "pullrequest",
  title: "Pull request",
  icon: GitPullRequest,
  hotkey: "p",
  available: () => "disabled",
  render: () => createElement(SurfacePlaceholder, { icon: GitPullRequest, title: "Pull request" }),
  openDefault: () => null,
};
