/**
 * Hooks a terminal tab and the quick terminal read (narrow selectors over the terminals and
 * threads stores): the tab's name and icon, and the directory hint.
 * See docs/notes/shell-13-terminals.md.
 */
import { useMemo } from "react";
import { cwdHint, terminalName, type TerminalName } from "@/lib/terminalName";
import type { TabEntry } from "@/stores/layout";
import { useTerminalsStore } from "@/stores/terminals";
import { useThreadsStore } from "@/stores/threads";

/** A terminal tab's name and icon (lib/terminalName.ts), from its manual name and its terminal's facts. */
export function useTerminalTabName(tab: Pick<TabEntry, "name" | "params">): TerminalName {
  const t = useTerminalsStore((s) => s.byId[tab.params.terminal ?? ""]);
  const manual = tab.name;
  return useMemo(() => terminalName({ manual, argv: t?.argv ?? [], dir: t?.liveCwd || t?.cwd || "", foreground: t?.foreground ?? "" }), [manual, t]);
}

/** Where a terminal is now: its live directory, else where it started; "" for no such terminal. */
export function useTerminalDir(terminalId: string): string {
  return useTerminalsStore((s) => {
    const t = s.byId[terminalId];
    return t ? t.liveCwd || t.cwd : "";
  });
}

/**
 * The directory hint for a terminal (lib/terminalName.ts cwdHint): its thread's directory when
 * the shell has moved away from it, else null. A terminal of no thread, or one that is not
 * running, has none.
 */
export function useTerminalCwdHint(terminalId: string): { threadDir: string } | null {
  const live = useTerminalsStore((s) => {
    const t = s.byId[terminalId];
    return t?.state === "running" ? t.liveCwd : "";
  });
  const thread = useTerminalsStore((s) => s.byId[terminalId]?.labels.thread ?? "");
  const dir = useThreadsStore((s) => s.byId[thread]?.worktreePath ?? "");
  return useMemo(() => cwdHint(live, dir), [live, dir]);
}
