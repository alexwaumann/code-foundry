import { useShallow } from "zustand/react/shallow";
import type { UiContextView } from "@/api/command";
import {
  placeSession,
  placeTerminal,
  SESSION_LABEL,
  WORKTREE_LABEL,
  type ListSession,
  type PlaceableTerminal,
  type TreeRepo,
  type TreeSession,
  type WorktreeRef,
} from "@/lib/tree";
import { useReposStore, type ReposData } from "./repos";
import { useSessionsStore, type SessionsData } from "./sessions";
import { attentionTier } from "@/lib/session";
import { useTerminalsStore, type TerminalsData } from "./terminals";
import { useUiStore, type Selection } from "./ui";

export const emptyContext: UiContextView = {
  activeTerminalId: "",
  activeSessionId: "",
  activeRepoId: "",
  activeWorktreePath: "",
  activeView: "dashboard",
  activeWorkspaceId: "",
};

function allWorktrees(repos: ReposData): WorktreeRef[] {
  return repos.order.flatMap((id) => repos.byId[id]?.worktrees.map((w) => ({ repoId: id, path: w.path })) ?? []);
}

/** The context of an action on one worktree (the Projects page's rows, the panel's worktree tab): no selection involved. */
export function worktreeContext(repoId: string, path: string): UiContextView {
  return { ...emptyContext, activeRepoId: repoId, activeWorktreePath: path, activeView: "projects" };
}

/** The context of an action on one project (the Projects page's rows). */
export function repoContext(repoId: string): UiContextView {
  return { ...emptyContext, activeRepoId: repoId, activeView: "projects" };
}

/**
 * Derives the UiContext the daemon sees from the current selection. A terminal's
 * repo/worktree come from the same placement the sidebar uses. The composer looks only
 * at its repo. A session contributes its attached terminal (if any) so terminal.*
 * commands apply to it. Actions on a worktree that is not selected (the Projects page,
 * the panel's worktree tab) build their context with worktreeContext / repoContext.
 */
export function deriveContext(sel: Selection, terminals: TerminalsData, repos: ReposData, sessions: SessionsData = { byId: {}, order: [] }): UiContextView {
  switch (sel.kind) {
    case "none":
      return emptyContext;
    case "terminal": {
      const t = terminals.byId[sel.id];
      const place = t ? placeTerminal({ cwd: t.cwd, worktreeLabel: t.labels[WORKTREE_LABEL] ?? "" }, allWorktrees(repos)) : null;
      const sessionId = t?.labels[SESSION_LABEL] ?? "";
      return {
        ...emptyContext,
        activeTerminalId: sel.id,
        activeSessionId: sessionId,
        activeWorkspaceId: sessions.byId[sessionId]?.workspaceId ?? "",
        activeRepoId: place?.repoId ?? "",
        activeWorktreePath: place?.path ?? "",
        activeView: "terminal",
      };
    }
    case "session": {
      const s = sessions.byId[sel.id];
      const place = s ? placeSession(s, allWorktrees(repos)) : null;
      return {
        ...emptyContext,
        activeSessionId: sel.id,
        activeTerminalId: s?.terminalId ?? "",
        activeRepoId: place?.repoId ?? s?.repoId ?? "",
        activeWorktreePath: place?.path ?? s?.worktreePath ?? "",
        activeView: "session",
        activeWorkspaceId: s?.workspaceId ?? "",
      };
    }
    // The composer has no worktree yet (it may make one): only the repo, which is
    // what session.new needs to be available.
    case "compose":
      return { ...emptyContext, activeRepoId: sel.repoId, activeView: "compose", activeWorkspaceId: sel.workspaceId ?? "" };
    case "view":
      return { ...emptyContext, activeView: sel.name };
  }
}

export function contextKey(c: UiContextView): string {
  return [c.activeView, c.activeTerminalId, c.activeSessionId, c.activeRepoId, c.activeWorktreePath, c.activeWorkspaceId].join("\u0000");
}

/** Current context, read imperatively (keybindings, invoke). */
export function getUiContext(sel: Selection = useUiStore.getState().selection): UiContextView {
  return deriveContext(sel, useTerminalsStore.getState(), useReposStore.getState(), useSessionsStore.getState());
}

const SEP = "\u0001";

/** One string per repo: id + worktree paths. Shallow-stable across unrelated updates. */
export function useRepoStructureKeys(): string[] {
  return useReposStore(useShallow((s) => s.order.map((id) => [id, ...(s.byId[id]?.worktrees.map((w) => w.path) ?? [])].join(SEP))));
}

/** One string per terminal: id + the inputs that decide where (and whether) it sits in the tree. */
export function useTerminalPlacementKeys(): string[] {
  return useTerminalsStore(
    useShallow((s) =>
      s.order.map((id) => {
        const t = s.byId[id];
        return [id, t?.cwd ?? "", t?.labels[WORKTREE_LABEL] ?? "", t?.labels[SESSION_LABEL] ?? ""].join(SEP);
      }),
    ),
  );
}

/** One string per session: id + worktree + attached terminal (status/name changes don't rebuild). */
export function useSessionPlacementKeys(): string[] {
  return useSessionsStore(
    useShallow((s) =>
      s.order.map((id) => {
        const x = s.byId[id];
        return [id, x?.worktreePath ?? "", x?.terminalId ?? ""].join(SEP);
      }),
    ),
  );
}

export function decodeRepoKeys(keys: readonly string[]): TreeRepo[] {
  return keys.map((k) => {
    const [id = "", ...worktreePaths] = k.split(SEP);
    return { id, worktreePaths };
  });
}

export function decodeTerminalKeys(keys: readonly string[]): PlaceableTerminal[] {
  return keys.map((k) => {
    const [id = "", cwd = "", worktreeLabel = "", sessionLabel = ""] = k.split(SEP);
    return { id, cwd, worktreeLabel, sessionLabel };
  });
}

export function decodeSessionKeys(keys: readonly string[]): TreeSession[] {
  return keys.map((k) => {
    const [id = "", worktreePath = "", terminalId = ""] = k.split(SEP);
    return { id, worktreePath, terminalId };
  });
}

/**
 * One string per session for the sidebar list: id + attached terminal + pin + attention
 * tier (name, model, busy/idle and the status line's text don't rebuild the list; a
 * question turning into a finished turn does, since it moves). In the store's order.
 */
export function useSessionListKeys(): string[] {
  return useSessionsStore(
    useShallow((s) =>
      s.order.map((id) => {
        const x = s.byId[id];
        return [id, x?.terminalId ?? "", x?.pinned ? "1" : "", x ? attentionTier(x) : ""].join(SEP);
      }),
    ),
  );
}

export function decodeSessionListKeys(keys: readonly string[]): ListSession[] {
  return keys.map((k) => {
    const [id = "", terminalId = "", pinned = "", attention = ""] = k.split(SEP);
    return { id, terminalId, pinned: pinned === "1", attention: attention === "prompt" || attention === "done" ? attention : "" };
  });
}

/** Sidebar list inputs read imperatively (cmd+1..9, cmd+shift+a). */
export function getListInputs(): { sessions: ListSession[]; terminals: PlaceableTerminal[] } {
  const t = useTerminalsStore.getState();
  const s = useSessionsStore.getState();
  return {
    sessions: s.order.flatMap((id) => {
      const x = s.byId[id];
      return x ? [{ id, terminalId: x.terminalId, pinned: x.pinned, attention: attentionTier(x) }] : [];
    }),
    terminals: t.order.map((id) => {
      const term = t.byId[id];
      return { id, cwd: term?.cwd ?? "", worktreeLabel: term?.labels[WORKTREE_LABEL] ?? "", sessionLabel: term?.labels[SESSION_LABEL] ?? "" };
    }),
  };
}
