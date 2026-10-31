import type { SVGProps } from "react";
import type { ProjectKind } from "@/lib/projects";
import { PROJECT_KIND_ICONS, useProjectKind } from "./projectKind";

/**
 * Wherever a project is depicted, its kind's icon (projectKind.ts): the sidebar card, the
 * composer, the thread menus, the palette, the thread info card and the header crumb read
 * the same. Sized by className; a colour there applies to the folder kinds, the GitHub mark
 * keeps its info tint.
 */
export function ProjectKindIcon({ kind, ...props }: { kind: ProjectKind } & SVGProps<SVGSVGElement>) {
  const Icon = PROJECT_KIND_ICONS[kind];
  return <Icon aria-hidden data-project-kind={kind} {...props} />;
}

/** ProjectKindIcon for a project id. */
export function ProjectIcon({ projectId, ...props }: { projectId: string } & SVGProps<SVGSVGElement>) {
  return <ProjectKindIcon kind={useProjectKind(projectId)} {...props} />;
}
