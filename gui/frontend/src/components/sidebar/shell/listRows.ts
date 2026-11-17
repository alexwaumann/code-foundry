import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { sidebarAnchor } from "@/lib/inSidebar";
import { buildShellSections, draftKey, shellRows, type MainRow, type ShellRow } from "@/lib/shellSections";
import { isSnoozed } from "@/lib/snooze";
import { FOOTERS, keyedRowCache, threadKey, type FooterSection, type HeaderRow, type Row } from "@/lib/tree";
import { decodeThreadListKeys, useThreadListKeys } from "@/stores/context";
import { useCurrentSpaceId, useLayoutStore } from "@/stores/layout";
import { useCurrentDrafts, useNeedsScope, useThreadSpaces } from "@/stores/shellList";
import { useShellSidebarStore } from "@/stores/shellSidebar";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";

/**
 * The shell sidebar's rows as both of its presentations draw them: the expanded list
 * (ShellSidebarList) and the collapsed icon rail (sidebar/rail). docs/notes/shell-16-sidebar.md,
 * docs/notes/sidebar-rail.md.
 */
export interface ListRows {
  rows: ShellRow[];
  main: MainRow[];
  headers: Readonly<Record<FooterSection, HeaderRow | null>>;
  footers: Readonly<Record<FooterSection, Row[]>>;
}

function splitFooter(rows: readonly ShellRow[]): [HeaderRow | null, Row[]] {
  const [first, ...rest] = rows as Row[];
  return first?.kind === "header" ? [first, rest] : [null, [...(rows as Row[])]];
}

/** The open thread's id while it is snoozed or archived (its row stays under a collapsed footer), else null. */
function useOpenPutAwayId(): string | null {
  const id = useUiStore((s) => (s.selection.kind === "thread" ? s.selection.id : null));
  return useThreadsStore((s) => {
    const t = id === null ? undefined : s.byId[id];
    return t !== undefined && (t.archivedAtMs !== null || isSnoozed(t)) ? t.id : null;
  });
}

/**
 * The list's rows by panel. `expandMain` (the rail, which has no headers to open them with)
 * lists Needs you's and Active's rows whether or not their headers are collapsed in the
 * expanded sidebar.
 */
export function useShellListRows({ expandMain = false }: { expandMain?: boolean } = {}): ListRows {
  const threadKeys = useThreadListKeys();
  const spaces = useThreadSpaces();
  const drafts = useCurrentDrafts();
  const currentSpaceId = useCurrentSpaceId();
  const needsScope = useNeedsScope();
  const { needsCollapsed, activeCollapsed } = useShellSidebarStore(
    useShallow((s) => ({ needsCollapsed: s.needsCollapsed && !expandMain, activeCollapsed: s.activeCollapsed && !expandMain })),
  );
  const workingCollapsed = useUiStore((s) => s.workingCollapsed);
  const snoozedCollapsed = useUiStore((s) => s.snoozedCollapsed);
  const archivedCollapsed = useUiStore((s) => s.archivedCollapsed);
  const openThreadId = useOpenPutAwayId();
  const [stable] = useState(() => keyedRowCache<ShellRow>());
  return useMemo(() => {
    const threads = decodeThreadListKeys(threadKeys).map((t, i) => ({ ...t, spaceId: spaces[i] ?? "" }));
    const sec = buildShellSections(threads, {
      currentSpaceId,
      needsScope,
      needsCollapsed,
      activeCollapsed,
      drafts,
      workingCollapsed,
      snoozedCollapsed,
      archivedCollapsed,
      openThreadId,
    });
    const rows = stable(shellRows(sec));
    const headers: Record<FooterSection, HeaderRow | null> = { working: null, snoozed: null, archived: null };
    const footers: Record<FooterSection, Row[]> = { working: [], snoozed: [], archived: [] };
    let at = sec.main.length;
    for (const f of FOOTERS) {
      [headers[f], footers[f]] = splitFooter(rows.slice(at, at + sec[f].length));
      at += sec[f].length;
    }
    return { rows, main: rows.slice(0, sec.main.length) as MainRow[], headers, footers };
  }, [stable, threadKeys, spaces, drafts, currentSpaceId, needsScope, needsCollapsed, activeCollapsed, workingCollapsed, snoozedCollapsed, archivedCollapsed, openThreadId]);
}

/**
 * The row the window's focus highlights: the focused tab's thread (its nearest shown ancestor for
 * a hidden child), or the draft whose composer is the focused tab.
 */
export function useSelectedRowKey(): string | null {
  const id = useUiStore((s) => (s.selection.kind === "thread" ? s.selection.id : null));
  const anchor = useThreadsStore((s) => (id === null ? null : sidebarAnchor(s.byId, id)));
  const draft = useLayoutStore((s) => {
    const pane = s.panes[s.spaces[s.currentSpaceId]?.focus ?? ""];
    const tab = s.tabs[pane?.active ?? ""];
    return tab?.kind === "compose" ? (tab.params.draft ?? "") : "";
  });
  if (anchor !== null) return threadKey(anchor);
  return draft ? draftKey(draft) : null;
}
