import { workspaceContents } from "@/lib/projects";
import { useWorkspacesStore } from "@/stores/workspaces";
import { MetaDot, TitleBlock, WorkspaceIcon } from "./bits";
import { workspaceMenu } from "./menus";
import { OverflowMenu } from "./OverflowMenu";
import { useWorkspaceTerminal } from "./workspaceHooks";
import { WORKSPACE_DROPDOWN_PARTS } from "./WorkspaceMenuParts";

/**
 * A workspace page's title block (docs/notes/project-page-1-title-block.md): the Layers icon
 * and its name, a meta line with how many projects and what it adds ("2 projects · CLAUDE.md ·
 * 3 skills"), and at the right only its ⋯ (menus.ts workspaceMenu, New thread first; the
 * index row's context menu).
 */
export function WorkspaceTitle({ workspaceId, members }: { workspaceId: string; members: number }) {
  const name = useWorkspacesStore((s) => s.byId[workspaceId]?.name ?? workspaceId);
  const contents = useWorkspacesStore((s) => {
    const w = s.byId[workspaceId];
    return w ? workspaceContents(w) : "";
  });
  const terminal = useWorkspaceTerminal(workspaceId);
  return (
    <TitleBlock
      testId="workspace-title"
      icon={<WorkspaceIcon />}
      name={name}
      meta={
        <>
          <span className="shrink-0" data-testid="workspace-meta">
            {members} {members === 1 ? "project" : "projects"}
          </span>
          {contents && (
            <>
              <MetaDot />
              <span className="min-w-0 truncate" data-testid="workspace-meta-contents">
                {contents}
              </span>
            </>
          )}
        </>
      }
      right={<OverflowMenu label="More workspace actions" testId="workspace-page-more" size="md" items={workspaceMenu(workspaceId, { folder: terminal })} parts={WORKSPACE_DROPDOWN_PARTS} />}
    />
  );
}
