import { Broom, FileDiff, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { useNow } from "@/lib/clock";
import { holdsWork, lastArchivedOn, leftoverReason, removeCleanLabel } from "@/lib/leftovers";
import { NavRow } from "@/lib/NavRow";
import { tildify } from "@/lib/path";
import { threadLabel } from "@/lib/prompt";
import { projectWorktreeKey, terminalHolds } from "@/lib/projects";
import { cn } from "@/lib/utils";
import { openChangesTab } from "@/stores/changesPanel";
import { cleanupMergedWorktrees, removeWorktree } from "@/stores/projectActions";
import { findWorktree, useProjectsStore } from "@/stores/projects";
import { useTerminalsStore } from "@/stores/terminals";
import { useThreadsStore } from "@/stores/threads";
import { SectionHeader } from "./bits";
import { LEFTOVER_MENU_PARTS } from "./CheckoutMenuParts";
import { leftoverMenu } from "./menus";
import { RowContextMenu } from "./RowContextMenu";
import { RowAction } from "./RowAction";
import { useCleanableCount } from "./useCleanable";

/** The section's hint, beside its title. */
const LEFTOVER_HINT = "a thread's worktree goes on its own once its work is on main";

/**
 * Branch (as wide as a usual branch, shrinking first), Why it stayed (the rest; it truncates),
 * and the two 24px icon slots with their 4px gap. No column ever drops.
 */
const TEMPLATE = "minmax(6rem,14rem) minmax(0,1fr) 3.25rem";

/** The last thread archived on the worktree, with its label, read when the menu opens. */
function archivedOn(path: string): { id: string; name: string } | null {
  const s = useThreadsStore.getState();
  const last = lastArchivedOn(s, path);
  if (!last) return null;
  return { id: last.id, name: threadLabel(s.byId[last.id]?.name ?? "", last.id) };
}

/**
 * One leftover: a dot (amber while it holds work, grey when clean), the branch (its path as
 * the tooltip), why it stayed, and at the right Show diff (while it holds work; the slot stays
 * empty otherwise, so the icons line up) and Remove worktree. The row has no click and no
 * hover tint: its right-click menu (menus.ts leftoverMenu) holds the rest.
 */
function LeftoverRow({ projectId, path }: { projectId: string; path: string }) {
  const wt = useProjectsStore((s) => findWorktree(s, projectId, path));
  const defaultBranch = useProjectsStore((s) => s.byId[projectId]?.defaultBranch ?? "");
  const archivedAtMs = useThreadsStore((s) => lastArchivedOn(s, path)?.archivedAtMs ?? null);
  const terminal = useTerminalsStore((s) => terminalHolds(s, path));
  const now = useNow(60_000);
  if (!wt) return null;
  const work = holdsWork(wt);
  const reason = leftoverReason(wt, { defaultBranch, archivedAtMs, terminal, now });
  const branch = wt.branch || path.slice(path.lastIndexOf("/") + 1);
  const navKey = projectWorktreeKey(projectId, path);
  const items = () => {
    const w = findWorktree(useProjectsStore.getState(), projectId, path);
    return leftoverMenu({ projectId, path, branch: w?.branch ?? "", work: w ? holdsWork(w) : false, archived: archivedOn(path) });
  };
  return (
    <RowContextMenu navKey={navKey} testId="leftover-menu" items={items} parts={LEFTOVER_MENU_PARTS}>
      <NavRow navKey={navKey} passive className="h-9 rounded-md">
        <span className="grid h-full items-center gap-3 px-2 text-body" style={{ gridTemplateColumns: TEMPLATE }} data-testid="leftover-row" data-path={path} data-work={work || undefined}>
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn("size-1.5 shrink-0 rounded-full", work ? "bg-cf-warning" : "bg-cf-border-strong")} data-testid="leftover-dot" aria-hidden />
            <Tip label={tildify(path)} align="start">
              <span className="min-w-0 truncate text-code" data-testid="leftover-branch">
                {branch}
              </span>
            </Tip>
          </span>
          <Tip label={reason} whenTruncated align="start">
            <span className="min-w-0 truncate text-body-sm text-cf-text-secondary" data-testid="leftover-reason">
              {reason}
            </span>
          </Tip>
          <span className="flex items-center justify-end gap-1">
            {work ? (
              <RowAction label="Show diff" testId="leftover-show-diff" onClick={() => { openChangesTab("current", projectId, path); }}>
                <FileDiff />
              </RowAction>
            ) : (
              <span className="size-6 shrink-0" aria-hidden />
            )}
            <RowAction label="Remove worktree" destructive testId="leftover-remove" onClick={() => void removeWorktree(projectId, path)}>
              <Trash2 />
            </RowAction>
          </span>
        </span>
      </NavRow>
    </RowContextMenu>
  );
}

/**
 * "Worktrees without threads" on a project's page (docs/notes/project-page-3-leftovers.md):
 * the worktrees that are not main and that no open thread is on (pageHooks.ts
 * useLeftoverPaths), in the Checkouts table's grammar: Branch | Why it stayed | icons. The
 * title's "Remove the N that are clean" is project.worktree.cleanup, counted like the project
 * menu's Clean up merged worktrees (N) and the index's "N worktrees to tidy" (useCleanableCount).
 * Its rows are on the page's keyboard list after the checkouts', so a worktree shown from
 * elsewhere (ui.focus.project after worktree.create) gets the cursor and scrolls into view.
 */
export function LeftoverWorktrees({ projectId, paths }: { projectId: string; paths: readonly string[] }) {
  const clean = useCleanableCount(projectId);
  return (
    <div data-testid="leftover-worktrees" data-project={projectId}>
      <SectionHeader
        label="Worktrees without threads"
        count={paths.length}
        detail={LEFTOVER_HINT}
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
      {paths.length === 0 ? (
        <p className="rounded-lg border px-3 py-2 text-body-sm text-cf-text-muted" data-testid="leftover-empty">
          Nothing kept. Every worktree here has a thread.
        </p>
      ) : (
        <div className="rounded-lg border" data-testid="leftover-table">
          <div className="grid gap-3 border-b px-2 py-1 text-overline" style={{ gridTemplateColumns: TEMPLATE }} data-testid="leftover-head">
            <span className="truncate">Branch</span>
            <span className="truncate">Why it stayed</span>
            <span aria-hidden />
          </div>
          <div className="p-0.5">
            {paths.map((p) => (
              <LeftoverRow key={p} projectId={projectId} path={p} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
