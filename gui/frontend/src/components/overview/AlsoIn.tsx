import { useMemo } from "react";
import { CircleDot, Folder, GitBranch } from "lucide-react";
import { Tip } from "@/components/ui/tooltip";
import type { AlsoInRow } from "@/lib/alsoIn";
import { useNav, type NavItem } from "@/lib/nav";
import { NavProvider, NavRow } from "@/lib/NavRow";
import { findWorktree, useProjectsStore } from "@/stores/projects";
import { alsoInKey, openAlsoIn, useAlsoIn } from "@/stores/threadCheckouts";

/** One other checkout: project, branch (live from the projects slice when it knows the worktree), changed files. */
function AlsoInLine({ row }: { row: AlsoInRow }) {
  const branch = useProjectsStore((s) => findWorktree(s, row.projectId, row.path)?.branch || row.branch);
  const changes = useProjectsStore((s) => {
    const st = findWorktree(s, row.projectId, row.path)?.status;
    return st?.dirty ? Math.max(1, st.staged + st.modified + st.untracked + (st.conflicted ?? 0)) : 0;
  });
  const Icon = row.git ? GitBranch : Folder;
  return (
    <NavRow
      navKey={alsoInKey(row.path)}
      activateOnClick
      tip={row.path}
      className="flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5 text-body-sm"
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5" data-testid="also-in-row" data-project={row.projectId} data-path={row.path} data-missing={row.missing || undefined}>
        <Icon className="size-3.5 shrink-0 text-cf-text-muted" aria-hidden />
        <span className="shrink-0 font-medium" data-testid="also-in-name">
          {row.name}
        </span>
        {branch && (
          <span className="min-w-0 truncate text-code text-cf-text-muted" data-testid="also-in-branch">
            {branch}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-1 text-caption-sm tabular-nums">
          {row.missing && (
            <span className="text-cf-text-muted" data-testid="also-in-missing">
              made at the next start
            </span>
          )}
          {changes > 0 && (
            <Tip label={`${String(changes)} changed`}>
              <span className="flex items-center gap-0.5 text-cf-warning-text" data-testid="also-in-dirty">
                <CircleDot className="size-3" aria-label="uncommitted changes" />
                {changes}
              </span>
            </Tip>
          )}
        </span>
      </span>
    </NavRow>
  );
}

/**
 * "Also in": the thread's other checkouts under the primary's facts, one compact row each;
 * a click (or Enter in the tab's list) opens that checkout as its own Worktree tab. Rows
 * join the list of the NavProvider around them.
 */
export function AlsoIn({ rows }: { rows: readonly AlsoInRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-1" data-testid="worktree-also-in">
      <h3 className="text-subheading">Also in</h3>
      <div className="-mx-1.5 flex flex-col">
        {rows.map((r) => (
          <AlsoInLine key={r.path} row={r} />
        ))}
      </div>
    </section>
  );
}

/** AlsoIn with a keyboard list of its own, for a tab body that has none (a folder without git). */
export function StandaloneAlsoIn({ path }: { path: string }) {
  const rows = useAlsoIn(path);
  const items = useMemo<NavItem[]>(() => rows.map((r) => ({ key: alsoInKey(r.path), activate: () => { openAlsoIn(r); } })), [rows]);
  const nav = useNav(items);
  if (rows.length === 0) return null;
  return (
    <NavProvider value={nav.ctx}>
      <div tabIndex={0} role="listbox" aria-label="Also in" aria-activedescendant={nav.activeDescendant} className="outline-none" onKeyDown={nav.onKeyDown}>
        <AlsoIn rows={rows} />
      </div>
    </NavProvider>
  );
}
