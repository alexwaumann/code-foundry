import { useMemo } from "react";
import { FolderGit2, GitBranch, SquareTerminal } from "lucide-react";
import { formatChord } from "@/keys/chord";
import { tildify, terminalLabel } from "@/lib/path";
import { placeTerminal } from "@/lib/tree";
import { decodeRepoKeys, decodeTerminalKeys, useRepoStructureKeys, useTerminalPlacementKeys } from "@/stores/context";
import { findWorktree, useReposStore } from "@/stores/repos";
import { useTerminalsStore } from "@/stores/terminals";
import { useUiStore } from "@/stores/ui";

function Kbd({ children }: { children: string }) {
  return <kbd className="rounded border bg-muted px-1.5 py-0.5 font-sans text-xs">{children}</kbd>;
}

/** Terminal ids placed under the given worktree (or any worktree of the repo). */
function useTerminalsIn(repoId: string, path: string | null): string[] {
  const repoKeys = useRepoStructureKeys();
  const termKeys = useTerminalPlacementKeys();
  return useMemo(() => {
    const worktrees = decodeRepoKeys(repoKeys).flatMap((r) => r.worktreePaths.map((p) => ({ repoId: r.id, path: p })));
    return decodeTerminalKeys(termKeys)
      .filter((t) => {
        const w = placeTerminal(t, worktrees);
        return w !== null && w.repoId === repoId && (path === null || w.path === path);
      })
      .map((t) => t.id);
  }, [repoKeys, termKeys, repoId, path]);
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
  const terminals = useTerminalsIn(repoId, path);
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
        <dl className="grid grid-cols-4 gap-4 rounded-lg border p-4 text-sm">
          {[
            ["upstream", st.upstream || "—"],
            ["ahead / behind", `${String(st.ahead)} / ${String(st.behind)}`],
            ["changes", st.dirty ? `${String(st.staged)} staged · ${String(st.modified)} modified · ${String(st.untracked)} new` : "clean"],
            ["default branch", repo.defaultBranch || "—"],
          ].map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-xs text-muted-foreground uppercase">{k}</dt>
              <dd className="truncate font-mono text-xs">{v}</dd>
            </div>
          ))}
        </dl>
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
  const running = useTerminalsStore((s) => s.order.reduce((n, id) => n + (s.byId[id]?.state === "running" ? 1 : 0), 0));
  return (
    <div className="flex max-w-md flex-col items-center gap-4 text-center">
      <SquareTerminal className="size-10 text-muted-foreground/60" />
      <div>
        <h1 className="text-lg font-semibold">No terminal selected</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {repos} {repos === 1 ? "repository" : "repositories"} · {running} running {running === 1 ? "terminal" : "terminals"}
        </p>
      </div>
      <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
        <li>
          <Kbd>{formatChord("cmd+k")}</Kbd> run a command
        </li>
        <li>
          <Kbd>{formatChord("cmd+1")}</Kbd>…<Kbd>{formatChord("cmd+9")}</Kbd> jump to a terminal
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
      {(selection.kind === "none" || selection.kind === "terminal") && (
        <div className="mt-[18vh]">
          <Welcome />
        </div>
      )}
    </section>
  );
}
