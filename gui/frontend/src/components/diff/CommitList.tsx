import { useEffect, useMemo } from "react";
import { ChevronRight } from "lucide-react";
import type { CompareCommitView, CompareLogView } from "@/api/compare";
import { Age } from "@/components/prs/PrBits";
import { RowList } from "@/components/prs/RowList";
import { useNav, type NavItem } from "@/lib/nav";
import { NavProvider, NavRow } from "@/lib/NavRow";
import { cn } from "@/lib/utils";
import { COMMIT_ROW_H, COMMITS_HEADING_H, commitRows } from "./commits";

/** A commit: its subject, cut short, then its short sha and age. */
function CommitLine({ c }: { c: CompareCommitView }) {
  return (
    <NavRow navKey={`c:${c.sha}`} activateOnClick tip={c.subject} tipWhenTruncated className="flex h-full min-w-0 items-center gap-2 px-1.5 text-body-sm">
      <span className="min-w-0 flex-1 truncate" data-testid="commit-subject">
        {c.subject}
      </span>
      <span className="shrink-0 font-mono text-caption-sm" data-testid="commit-sha">
        {c.shortSha}
      </span>
      <Age ms={c.authoredAtMs} className="shrink-0" />
    </NavRow>
  );
}

const rowKey = (c: CompareCommitView): string => `c:${c.sha}`;
const renderRow = (c: CompareCommitView) => <CommitLine c={c} />;

/**
 * The branch's commits, at the foot of the file list: folded by default, with a count. A click
 * compares the commit with its parent, and the list stays as it is so the next one is a click
 * away. Arrows and Enter work while it has focus. `current` is the commit on screen.
 */
export function CommitList({ log, current, open, onOpen, onPick, rail, height }: { log: CompareLogView; current: string; open: boolean; onOpen: (open: boolean) => void; onPick: (c: CompareCommitView) => void; rail: boolean; height: number }) {
  const items = useMemo<NavItem[]>(
    () =>
      log.commits.map((c) => ({
        key: rowKey(c),
        activate: () => {
          onPick(c);
        },
      })),
    [log, onPick],
  );
  const nav = useNav(items);
  const { setCursor } = nav;
  useEffect(() => {
    if (current) setCursor(`c:${current}`);
  }, [current, setCursor]);
  const rows = commitRows(log.commits.length, height, rail);
  return (
    <section className="shrink-0 border-t border-cf-divider" data-testid="diff-commits" data-open={open}>
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-3 text-body-sm hover:bg-cf-control-hover/50"
        style={{ height: COMMITS_HEADING_H }}
        data-testid="diff-commits-toggle"
        onClick={() => {
          onOpen(!open);
        }}
      >
        <ChevronRight className={cn("size-3.5 shrink-0 text-cf-text-muted transition-transform", open && "rotate-90")} aria-hidden />
        Commits
        <span className="ml-auto text-caption tabular-nums" data-testid="diff-commits-count">
          {log.total}
        </span>
      </button>
      {open && (
        <NavProvider value={nav.ctx}>
          <div tabIndex={0} role="listbox" aria-label="Commits" aria-activedescendant={nav.activeDescendant} className="px-1.5 pb-1 outline-none" onKeyDown={nav.onKeyDown}>
            <RowList rows={log.commits} rowKey={rowKey} rowHeight={COMMIT_ROW_H} render={renderRow} capped keepPlace maxHeight={rows * COMMIT_ROW_H} testId="diff-commit-rows" />
          </div>
          {log.total > log.commits.length && (
            <p className="border-t border-cf-divider px-3 py-1 text-caption-sm" data-testid="diff-commits-capped">
              First {log.commits.length} of {log.total} commits
            </p>
          )}
        </NavProvider>
      )}
    </section>
  );
}
