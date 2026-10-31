import type { ComponentType, SVGProps } from "react";
import { Folder, FolderGit2 } from "lucide-react";
import { projectKind, type ProjectKind } from "@/lib/projects";
import { useProjectsStore } from "@/stores/projects";
import { GithubProjectMark } from "./GithubProjectMark";

/**
 * The one glyph per project kind (docs/notes/icon-system.md): a GitHub repository is the
 * GitHub mark in the info tint, a git repository without GitHub (another remote, or none)
 * FolderGit2, a plain folder without git Folder. Plain svg components sized by className,
 * for icon props that take a component (the composer's pickers); elsewhere ProjectKindIcon.
 */
export const PROJECT_KIND_ICONS: Readonly<Record<ProjectKind, ComponentType<SVGProps<SVGSVGElement>>>> = {
  github: GithubProjectMark,
  git: FolderGit2,
  nogit: Folder,
};

/** A project's kind from the projects store (a narrow selector: the kind string); "git" while the project is unknown. */
export function useProjectKind(projectId: string): ProjectKind {
  return useProjectsStore((s) => {
    const p = s.byId[projectId];
    return p ? projectKind(p).kind : "git";
  });
}
