import { useShallow } from "zustand/react/shallow";
import { ArchiveRestore, Broom, FileDiff, SquarePen, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { useNow } from "@/lib/clock";
import { holdsWork, isLeftover, lastArchivedOn, leftoverReason, removeCleanLabel } from "@/lib/leftovers";
import { terminalHolds } from "@/lib/projects";
import { cn } from "@/lib/utils";
import { openChangesTab } from "@/stores/changesPanel";
import { composeIn } from "@/stores/compose";
import { cleanupMergedWorktrees, removeWorktree, resumeWorktree } from "@/stores/projectActions";
import { findWorktree, useProjectsStore } from "@/stores/projects";
import { useTerminalsStore } from "@/stores/terminals";
import { useThreadsStore } from "@/stores/threads";
import { SectionHeader } from "./bits";
import { useCleanableCount } from "./useCleanable";

const GONE_ON_THEIR_OWN = "Worktrees made for a thread go on their own once its last thread is archived and the work is on main.";

/** A row's labelled action button (Show diff, Resume, New thread). */
function RowButton({ icon, label, testId, onClick }: { icon: React.ReactNode; label: string; testId: string; onClick: () => void }) {
  return (
    <Button type="button" variant="outline" size="sm" className="h-7" data-testid={testId} onClick={onClick}>
      {icon}
      {label}
    </Button>
  );
}

/**
 * One leftover: dot (amber while it holds work, grey when clean), branch, why it stayed, and
 * its actions: Show diff and Resume while it holds work, New thread when clean, Remove… on
 * every row (icon only when narrow).
 */
function LeftoverRow({ projectId, path, narrow }: { projectId: string; path: string; narrow: boolean }) {
  const wt = useProjectsStore((s) => findWorktree(s, projectId, path));
  const defaultBranch = useProjectsStore((s) => s.byId[projectId]?.defaultBranch ?? "");
  const archivedId = useThreadsStore((s) => lastArchivedOn(s, path)?.id ?? null);
  const archivedAtMs = useThreadsStore((s) => lastArchivedOn(s, path)?.archivedAtMs ?? null);
  const terminal = useTerminalsStore((s) => terminalHolds(s, path));
  const now = useNow(60_000);
  if (!wt) return null;
  const work = holdsWork(wt);
  const reason = leftoverReason(wt, { defaultBranch, archivedAtMs, terminal, now });
  const branch = wt.branch || path.slice(path.lastIndexOf("/") + 1);
  return (
    <div className="flex min-h-12 items-center gap-3 border-b px-4 py-2" data-testid="leftover-row" data-path={path} data-work={work || undefined}>
      <span className={cn("size-1.5 shrink-0 rounded-full", work ? "bg-cf-warning" : "bg-cf-border-strong")} data-testid="leftover-dot" aria-hidden />
      <span className="shrink-0 text-code" data-testid="leftover-branch">
        {branch}
      </span>
      <Tip label={reason} whenTruncated>
        <span className="min-w-0 flex-1 truncate text-body-sm text-cf-text-secondary" data-testid="leftover-reason">
          {reason}
        </span>
      </Tip>
      <span className="flex shrink-0 items-center gap-1.5">
        {work ? (
          <>
            <RowButton icon={<FileDiff />} label="Show diff" testId="leftover-show-diff" onClick={() => { openChangesTab("current", projectId, path); }} />
            <RowButton icon={<ArchiveRestore />} label="Resume" testId="leftover-resume" onClick={() => void resumeWorktree(projectId, path, archivedId)} />
          </>
        ) : (
          <RowButton icon={<SquarePen />} label="New thread" testId="leftover-new-thread" onClick={() => { composeIn(projectId, path); }} />
        )}
        <Tip label={narrow ? "Remove worktree…" : null}>
          <Button
            type="button"
            variant="ghost"
            size={narrow ? "icon-sm" : "sm"}
            className={cn("h-7 text-cf-error-text hover:bg-cf-error-surface hover:text-cf-error-text", narrow && "w-7")}
            aria-label="Remove worktree…"
            data-testid="leftover-remove"
            onClick={() => void removeWorktree(projectId, path)}
          >
            <Trash2 />
            {!narrow && "Remove…"}
          </Button>
        </Tip>
      </span>
    </div>
  );
}

/**
 * "Worktrees without threads" on a project's page: the worktrees that are not main and that
 * no thread (archived ones aside) has as a checkout, with why each stayed. The header's
 * "Remove the N that are clean" is project.worktree.cleanup, counted like the project menu's
 * Clean up merged worktrees (N) and the index's "N worktrees to tidy" (useCleanableCount).
 * docs/notes/projects-redesign-2-leftovers.md.
 */
export function LeftoverWorktrees({ projectId, narrow }: { projectId: string; narrow: boolean }) {
  const candidates = useProjectsStore(useShallow((s) => (s.byId[projectId]?.worktrees ?? []).filter((w) => !w.isMain).map((w) => w.path)));
  const paths = useThreadsStore(useShallow((s) => candidates.filter((p) => isLeftover({ path: p, isMain: false }, s))));
  const clean = useCleanableCount(projectId);
  return (
    <div data-testid="leftover-worktrees" data-project={projectId}>
      <SectionHeader
        label="Worktrees without threads"
        detail={paths.length > 0 ? `${String(paths.length)} kept` : ""}
        testId="leftover-title"
        right={
          clean > 0 ? (
            <Button type="button" variant="ghost" size="sm" className="h-6 text-cf-text-secondary" data-testid="leftover-remove-clean" onClick={() => void cleanupMergedWorktrees(projectId)}>
              <Broom />
              {removeCleanLabel(clean)}
            </Button>
          ) : undefined
        }
      />
      <div className="rounded-lg border bg-cf-surface">
        {paths.length === 0 ? (
          <p className="px-4 py-3 text-body-sm text-cf-text-muted" data-testid="leftover-empty">
            Nothing kept. {GONE_ON_THEIR_OWN}
          </p>
        ) : (
          <>
            {paths.map((p) => (
              <LeftoverRow key={p} projectId={projectId} path={p} narrow={narrow} />
            ))}
            <p className="px-4 py-2 text-caption text-cf-text-muted" data-testid="leftover-footer">
              {GONE_ON_THEIR_OWN} These stayed because they still hold something.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
