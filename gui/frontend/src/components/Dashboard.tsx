import { useMemo } from "react";
import { FolderGit2, GitBranch, SquareTerminal } from "lucide-react";
import { formatChord } from "@/keys/chord";
import { tildify, terminalLabel } from "@/lib/path";
import { SessionStatusIcon } from "@/components/session/SessionStatusIcon";
import { badgeLabels, sessionBadge } from "@/lib/session";
import { ownedTerminalIds, placeSession, placeTerminal } from "@/lib/tree";
import {
  decodeRepoKeys,
  decodeSessionKeys,
  decodeTerminalKeys,
  useRepoStructureKeys,
  useSessionPlacementKeys,
  useTerminalPlacementKeys,
} from "@/stores/context";
import { findWorktree, useReposStore } from "@/stores/repos";
import { attentionIds, useSessionsStore } from "@/stores/sessions";
import { useTerminalsStore } from "@/stores/terminals";
import { useUiStore } from "@/stores/ui";

/** "2 staged · 4 modified · 1 new", omitting zero counts; "clean" when nothing changed. */
function describeChanges(st: { staged: number; modified: number; untracked: number; dirty: boolean }): string {
  const parts = [
    st.staged > 0 && `${String(st.staged)} staged`,
    st.modified > 0 && `${String(st.modified)} modified`,
    st.untracked > 0 && `${String(st.untracked)} new`,
  ].filter(Boolean);
  if (parts.length > 0) return parts.join(" · ");
  return st.dirty ? "dirty" : "clean";
}

function Kbd({ children }: { children: string }) {
  return <kbd className="rounded border bg-muted px-1.5 py-0.5 font-sans text-xs">{children}</kbd>;
}

/** Session and (unowned) terminal ids placed under the given worktree (or any worktree of the repo). */
function useItemsIn(repoId: string, path: string | null): { sessions: string[]; terminals: string[] } {
  const repoKeys = useRepoStructureKeys();
  const termKeys = useTerminalPlacementKeys();
  const sessionKeys = useSessionPlacementKeys();
  return useMemo(() => {
    const worktrees = decodeRepoKeys(repoKeys).flatMap((r) => r.worktreePaths.map((p) => ({ repoId: r.id, path: p })));
    const inHere = (w: { repoId: string; path: string } | null) => w !== null && w.repoId === repoId && (path === null || w.path === path);
    const sessions = decodeSessionKeys(sessionKeys);
    const terms = decodeTerminalKeys(termKeys);
    const owned = ownedTerminalIds(sessions, terms);
    return {
      sessions: sessions.filter((s) => inHere(placeSession(s, worktrees))).map((s) => s.id),
      terminals: terms.filter((t) => !owned.has(t.id) && inHere(placeTerminal(t, worktrees))).map((t) => t.id),
    };
  }, [repoKeys, termKeys, sessionKeys, repoId, path]);
}

function SessionLink({ id }: { id: string }) {
  const name = useSessionsStore((s) => s.byId[id]?.name || "New session");
  const badge = useSessionsStore((s) => badgeLabels[sessionBadge(s.byId[id])]);
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
      onClick={() => {
        useUiStore.getState().select({ kind: "session", id }, { focusTerminal: true });
      }}
    >
      <span className="flex size-4 items-center justify-center">
        <SessionStatusIcon id={id} />
      </span>
      <span className="truncate">{name}</span>
      <span className="ml-auto text-xs text-muted-foreground">{badge}</span>
    </button>
  );
}

function TerminalLink({ id }: { id: string }) {
  const label = useTerminalsStore((s) => {
    const t = s.byId[id];
    return t ? terminalLabel(t) : id;
  });
  const state = useTerminalsStore((s) => s.byId[id]?.state);
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
      onClick={() => {
        useUiStore.getState().select({ kind: "terminal", id }, { focusTerminal: true });
      }}
    >
      <SquareTerminal className="size-4 text-muted-foreground" />
      <span className="truncate">{label}</span>
      <span className="ml-auto text-xs text-muted-foreground">{state}</span>
    </button>
  );
}

function WorktreeOverview({ repoId, path }: { repoId: string; path: string | null }) {
  const repo = useReposStore((s) => s.byId[repoId]);
  const mainPath = repo?.worktrees.find((w) => w.isMain)?.path ?? repo?.path ?? "";
  const wt = useReposStore((s) => findWorktree(s, repoId, path ?? mainPath));
  const { sessions, terminals } = useItemsIn(repoId, path);
  const sessionsAvailable = useSessionsStore((s) => s.availability !== "unavailable");
  if (!repo) return <p className="text-sm text-muted-foreground">Repository not found.</p>;
  const st = wt?.status;
  return (
    <div className="flex w-full max-w-2xl flex-col gap-6">
      <header className="flex items-start gap-3">
        {path ? <GitBranch className="mt-1 size-5 text-violet-400" /> : <FolderGit2 className="mt-1 size-5 text-sky-400" />}
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">{path ? wt?.branch || path : repo.name}</h1>
          <p className="truncate text-sm text-muted-foreground">{tildify(path ?? repo.path)}</p>
        </div>
      </header>
      {st && (
        <dl className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto] gap-x-8 gap-y-4 rounded-lg border p-4 text-sm">
          {[
            ["upstream", st.upstream || "—"],
            ["ahead / behind", `${String(st.ahead)} / ${String(st.behind)}`],
            ["changes", describeChanges(st)],
            ["default branch", repo.defaultBranch || "—"],
          ].map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-xs text-muted-foreground uppercase">{k}</dt>
              <dd className="truncate font-mono text-xs">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {sessionsAvailable && (
        <section>
          <h2 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Sessions</h2>
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No sessions here. Press <Kbd>{formatChord("cmd+n")}</Kbd> to start Claude.
            </p>
          ) : (
            <div className="flex flex-col">
              {sessions.map((id) => (
                <SessionLink key={id} id={id} />
              ))}
            </div>
          )}
        </section>
      )}
      <section>
        <h2 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Terminals</h2>
        {terminals.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No terminals here. Press <Kbd>{formatChord("cmd+k")}</Kbd> to start one.
          </p>
        ) : (
          <div className="flex flex-col">
            {terminals.map((id) => (
              <TerminalLink key={id} id={id} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Welcome() {
  const repos = useReposStore((s) => s.order.length);
  const sessions = useSessionsStore((s) => s.order.reduce((n, id) => n + (s.byId[id]?.state === "disconnected" ? 0 : 1), 0));
  const waiting = useSessionsStore((s) => attentionIds(s).length);
  return (
    <div className="flex max-w-md flex-col items-center gap-4 text-center">
      <SquareTerminal className="size-10 text-muted-foreground/60" />
      <div>
        <h1 className="text-lg font-semibold">Nothing selected</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {repos} {repos === 1 ? "repository" : "repositories"} · {sessions} connected {sessions === 1 ? "session" : "sessions"}
          {waiting > 0 && ` · ${String(waiting)} waiting on you`}
        </p>
      </div>
      <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
        <li>
          <Kbd>{formatChord("cmd+k")}</Kbd> run a command
        </li>
        <li>
          <Kbd>{formatChord("cmd+1")}</Kbd>…<Kbd>{formatChord("cmd+9")}</Kbd> jump to a session or terminal
        </li>
        <li>
          <Kbd>{formatChord("cmd+shift+a")}</Kbd> next session that needs you
        </li>
        <li>
          <Kbd>{formatChord("cmd+b")}</Kbd> toggle the sidebar
        </li>
      </ul>
    </div>
  );
}

export function Dashboard() {
  const selection = useUiStore((s) => s.selection);
  return (
    <section className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto p-10" data-region="content" aria-label="Overview">
      {selection.kind === "repo" && <WorktreeOverview repoId={selection.repoId} path={null} />}
      {selection.kind === "worktree" && <WorktreeOverview repoId={selection.repoId} path={selection.path} />}
      {(selection.kind === "none" || selection.kind === "terminal" || selection.kind === "session") && (
        <div className="mt-[18vh]">
          <Welcome />
        </div>
      )}
    </section>
  );
}
