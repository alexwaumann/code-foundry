import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import { Copy, Pencil, Plus } from "lucide-react";
import { ACTION_ICON } from "@/components/actions/actionIcons";
import { FinderIcon } from "@/components/icons/AppIcon";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { copyText } from "@/lib/clipboard";
import { useNow } from "@/lib/clock";
import { tildify } from "@/lib/path";
import { actionsDetail, refreshedText, remoteDetail, worktreesDetail } from "@/lib/projects";
import { cn } from "@/lib/utils";
import { openActionEditor } from "@/stores/actionDialog";
import { useAction, useProjectActionIds } from "@/stores/actions";
import { runCommand } from "@/stores/commands";
import { worktreeContext } from "@/stores/context";
import { findWorktree, useProjectsStore } from "@/stores/projects";
import { LinkButton, SectionHeader } from "./bits";

function DetailRow({ label, children, testId }: { label: string; children: React.ReactNode; testId: string }) {
  return (
    <div className="flex min-h-9 items-center gap-4 border-b border-cf-divider py-1.5 last:border-b-0" data-testid={testId}>
      <span className="w-30 shrink-0 text-caption text-cf-text-muted">{label}</span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-1 text-body-sm text-cf-text-secondary">{children}</span>
    </div>
  );
}

const Dot = () => <span aria-hidden>·</span>;

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
      <Pencil className="text-cf-text-muted" aria-hidden />
    </DropdownMenuItem>
  );
}

/** "2 project actions · Edit" (a menu of them, each opens the editor), or "none · Add an action". */
function ActionsRow({ projectId }: { projectId: string }) {
  const ids = useProjectActionIds(projectId);
  return (
    <DetailRow label="Actions" testId="details-actions">
      <span>{actionsDetail(ids.length)}</span>
      <Dot />
      {ids.length === 0 ? (
        <LinkButton testId="details-add-action" onClick={() => { openActionEditor({ mode: "new", projectId, from: "projects" }); }}>
          Add an action
        </LinkButton>
      ) : (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button type="button" tabIndex={-1} className="text-link hover:underline" data-testid="details-edit-actions">
              Edit
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-52" data-testid="details-actions-menu">
            {ids.map((id) => (
              <EditActionItem key={id} id={id} projectId={projectId} />
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem data-testid="details-new-action" onSelect={() => { openActionEditor({ mode: "new", projectId, from: "projects" }); }}>
              <Plus aria-hidden />
              New action…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </DetailRow>
  );
}

function RefreshedText({ at, failed }: { at: number | null; failed: boolean }) {
  const now = useNow(30_000);
  return (
    <span className={cn(failed && "text-cf-error-text")} data-testid="details-refreshed" data-failed={failed || undefined}>
      {refreshedText(at, now, failed)}
    </span>
  );
}

async function copyPath(path: string): Promise<void> {
  try {
    await copyText(path);
    toast.success("Path copied", { description: path });
  } catch {
    toast.error("Copy failed");
  }
}

/**
 * The project's facts: path (Open in Finder, Copy), default branch and when git status was
 * last read (red after a failed refresh), remote, where its worktrees live, and its project
 * actions. A folder without git has the path and actions only.
 */
export function ProjectDetails({ projectId }: { projectId: string }) {
  const path = useProjectsStore((s) => s.byId[projectId]?.path ?? "");
  const git = useProjectsStore((s) => s.byId[projectId]?.git !== false);
  const defaultBranch = useProjectsStore((s) => s.byId[projectId]?.defaultBranch ?? "");
  const remote = useProjectsStore((s) => {
    const r = s.byId[projectId];
    return r ? remoteDetail(r) : "";
  });
  const main = useProjectsStore((s) => s.byId[projectId]?.worktrees.find((w) => w.isMain)?.path ?? s.byId[projectId]?.path ?? "");
  const refreshedAt = useProjectsStore((s) => findWorktree(s, projectId, main)?.status.refreshedAtMs ?? null);
  const failed = useProjectsStore((s) => (findWorktree(s, projectId, main)?.status.error ?? "") !== "");
  const worktrees = useProjectsStore(useShallow((s) => (s.byId[projectId]?.worktrees ?? []).filter((w) => !w.isMain).map((w) => w.path)));
  const managed = useProjectsStore((s) => (s.byId[projectId]?.worktrees ?? []).filter((w) => !w.isMain && w.managed === true).length);
  return (
    <div data-testid="project-details">
      <SectionHeader label="Details" />
      <div className="rounded-lg border bg-cf-surface px-4 py-1">
        <DetailRow label="Path" testId="details-path">
          <span>{tildify(path)}</span>
          <Dot />
          <LinkButton testId="details-reveal" onClick={() => void runCommand("worktree.reveal", { worktree: main }, worktreeContext(projectId, main))}>
            <FinderIcon aria-hidden />
            Open in Finder
          </LinkButton>
          <Dot />
          <LinkButton testId="details-copy-path" onClick={() => void copyPath(path)}>
            <Copy aria-hidden />
            Copy
          </LinkButton>
        </DetailRow>
        {git && (
          <DetailRow label="Default branch" testId="details-default-branch">
            <span>{defaultBranch || "—"}</span>
            <Dot />
            <RefreshedText at={refreshedAt} failed={failed} />
          </DetailRow>
        )}
        {git && remote && (
          <DetailRow label="Remote" testId="details-remote">
            {remote}
          </DetailRow>
        )}
        {git && worktrees.length > 0 && (
          <DetailRow label="Worktrees" testId="details-worktrees">
            {worktreesDetail(worktrees, managed)}
          </DetailRow>
        )}
        <ActionsRow projectId={projectId} />
      </div>
    </div>
  );
}
