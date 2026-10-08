import { create } from "zustand";
import { daemon } from "@/api/endpoint";
import { listRepos, watchRepos, type RepoEventView, type RepoView, type WorktreeView } from "@/api/repo";
import { runStream, type StreamStatus } from "@/api/stream";

export interface ReposData {
  byId: Readonly<Record<string, RepoView>>;
  /** Repo ids sorted by name. */
  order: readonly string[];
}

interface ReposState extends ReposData {
  loaded: boolean;
  stream: StreamStatus;
  streamError: string | null;
}

export const emptyRepos: ReposData = { byId: {}, order: [] };

/** Main worktree first, then by branch (falling back to path). */
export function sortWorktrees(ws: readonly WorktreeView[]): WorktreeView[] {
  return [...ws].sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    return (a.branch || a.path).localeCompare(b.branch || b.path);
  });
}

function sortedOrder(byId: Readonly<Record<string, RepoView>>): string[] {
  return Object.values(byId)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((r) => r.id);
}

function normalizeRepo(r: RepoView): RepoView {
  return { ...r, worktrees: sortWorktrees(r.worktrees) };
}

export function replaceRepos(list: readonly RepoView[]): ReposData {
  const byId: Record<string, RepoView> = {};
  for (const r of list) byId[r.id] = normalizeRepo(r);
  return { byId, order: sortedOrder(byId) };
}

export function applyRepoEvent(prev: ReposData, ev: RepoEventView): ReposData {
  switch (ev.kind) {
    case "repoUpdated": {
      const byId = { ...prev.byId, [ev.repo.id]: normalizeRepo(ev.repo) };
      return { byId, order: sortedOrder(byId) };
    }
    case "repoRemoved": {
      if (!(ev.id in prev.byId)) return prev;
      const { [ev.id]: _removed, ...byId } = prev.byId;
      return { byId, order: prev.order.filter((id) => id !== ev.id) };
    }
    case "worktreeUpdated": {
      const w = ev.worktree;
      const repo = prev.byId[w.repoId];
      if (!repo) return prev; // the repo event will carry it
      const rest = repo.worktrees.filter((x) => x.path !== w.path);
      const next = { ...repo, worktrees: sortWorktrees([...rest, w]) };
      return { byId: { ...prev.byId, [repo.id]: next }, order: prev.order };
    }
    case "worktreeRemoved": {
      const repo = prev.byId[ev.repoId];
      if (!repo?.worktrees.some((x) => x.path === ev.path)) return prev;
      const next = { ...repo, worktrees: repo.worktrees.filter((x) => x.path !== ev.path) };
      return { byId: { ...prev.byId, [repo.id]: next }, order: prev.order };
    }
  }
}

export const useReposStore = create<ReposState>()(() => ({
  ...emptyRepos,
  loaded: false,
  stream: "connecting",
  streamError: null,
}));

export function findWorktree(data: ReposData, repoId: string, path: string): WorktreeView | undefined {
  return data.byId[repoId]?.worktrees.find((w) => w.path === path);
}

/** Keeps the repos slice in sync: List on every (re)connect, then Watch events. */
export function startRepoSync(): () => void {
  const set = useReposStore.setState;
  return runStream({
    open: (signal) => watchRepos(signal),
    onConnect: async (signal) => {
      const list = await listRepos(daemon, signal);
      set({ ...replaceRepos(list), loaded: true });
    },
    onEvent: (ev) => {
      set((s) => applyRepoEvent(s, ev));
    },
    onStatus: (stream, err) => {
      set({ stream, streamError: err ?? null });
    },
    onError: () => {
      daemon.invalidate();
    },
  });
}
