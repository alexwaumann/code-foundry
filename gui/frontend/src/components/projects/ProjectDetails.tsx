import { useShallow } from "zustand/react/shallow";
import { ChevronDown } from "lucide-react";
import { ACTION_ICON } from "@/components/actions/actionIcons";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { tildify } from "@/lib/path";
import { actionsDetail, remoteDetail, worktreesDetail } from "@/lib/projects";
import { openActionEditor } from "@/stores/actionDialog";
import { useAction, useActionsStore, useProjectActionIds } from "@/stores/actions";
import { mainWorktreePath, useProjectsStore } from "@/stores/projects";
import { SectionHeader } from "./bits";
import { CopyPath, DetailRow } from "./DetailRow";
import { OpenInFinder } from "./OpenInFinder";

function EditActionItem({ id, projectId }: { id: string; projectId: string }) {
  const action = useAction(id);
  if (!action) return null;
  const Icon = ACTION_ICON[action.icon];
  return (
    <DropdownMenuItem
      data-testid="details-action-edit"
      data-action={id}
      onSelect={() => {
        openActionEditor({ mode: "edit", actionId: id, projectId, from: "projects" });
      }}
    >
      <Icon aria-hidden />
      <span className="min-w-0 flex-1 truncate">{action.name}</span>
    </DropdownMenuItem>
  );
}

/**
 * The project's actions by name ("none" without one). At the right "Edit ⌄", a menu of them
 * (each opens its editor) and New action; without any, "Add action" opens a new one's editor.
 */
function ActionsRow({ projectId }: { projectId: string }) {
  const ids = useProjectActionIds(projectId);
  const names = useActionsStore(useShallow((s) => ids.map((id) => s.byId[id]?.name ?? "").filter((n) => n !== "")));
  const add = () => {
    openActionEditor({ mode: "new", projectId, from: "projects" });
  };
  const right =
    ids.length === 0 ? (
      <Button type="button" variant="ghost" size="sm" tabIndex={-1} className="h-7 text-cf-text-secondary" data-testid="details-add-action" onClick={add}>
        Add action
      </Button>
    ) : (
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="sm" tabIndex={-1} className="h-7 gap-1 text-cf-text-secondary aria-expanded:bg-cf-control-hover aria-expanded:text-cf-text" data-testid="details-edit-actions">
            Edit
            <ChevronDown aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52" data-testid="details-actions-menu">
          <DropdownMenuLabel className="text-caption font-normal text-cf-text-muted">Edit an action</DropdownMenuLabel>
          {ids.map((id) => (
            <EditActionItem key={id} id={id} projectId={projectId} />
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem data-testid="details-new-action" onSelect={add}>
            New action
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  return <DetailRow label="Actions" testId="details-actions" value={actionsDetail(names)} right={right} />;
}

/**
 * The project's facts (docs/notes/project-page-1-title-block.md): its path (Copy, and Open
 * in Finder with its Open in list), remote, its worktrees, and its project actions. A folder
 * without git has the path and actions only. The default branch and when git status was
 * last read are the title block's. `compact`: Open in Finder shows its icon only.
 */
export function ProjectDetails({ projectId, compact }: { projectId: string; compact: boolean }) {
  const path = useProjectsStore((s) => s.byId[projectId]?.path ?? "");
  const git = useProjectsStore((s) => s.byId[projectId]?.git !== false);
  const remote = useProjectsStore((s) => {
    const r = s.byId[projectId];
    return r ? remoteDetail(r) : "";
  });
  const main = useProjectsStore((s) => mainWorktreePath(s, projectId));
  const worktrees = useProjectsStore(useShallow((s) => (s.byId[projectId]?.worktrees ?? []).filter((w) => !w.isMain).map((w) => w.path)));
  const managed = useProjectsStore((s) => (s.byId[projectId]?.worktrees ?? []).filter((w) => !w.isMain && w.managed === true).length);
  return (
    <div data-testid="project-details">
      <SectionHeader label="Details" />
      <div className="rounded-lg border bg-cf-surface">
        <DetailRow
          label="Path"
          testId="details-path"
          value={tildify(path)}
          full={path}
          right={
            <>
              <CopyPath path={path} />
              <OpenInFinder projectId={projectId} path={main} compact={compact} />
            </>
          }
        />
        {git && remote && (
          <DetailRow label="Remote" testId="details-remote" value={remote} />
        )}
        {git && worktrees.length > 0 && (
          <DetailRow label="Worktrees" testId="details-worktrees" value={worktreesDetail(worktrees, managed)} />
        )}
        <ActionsRow projectId={projectId} />
      </div>
    </div>
  );
}
