import { useMemo } from "react";
import { Sparkles, SquareTerminal } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { WorktreeOverview } from "@/components/overview/WorktreeOverview";
import { terminalLabel } from "@/lib/path";
import { SessionLink } from "@/components/session/SessionLink";
import { StartPage } from "@/components/start/StartPage";
import { ownedTerminalIds, placeSession, placeTerminal } from "@/lib/tree";
import {
  decodeRepoKeys,
  decodeSessionKeys,
  decodeTerminalKeys,
  useRepoStructureKeys,
  useSessionPlacementKeys,
  useTerminalPlacementKeys,
} from "@/stores/context";
import { useSessionsStore } from "@/stores/sessions";
import { useTerminalsStore } from "@/stores/terminals";
import { useUiStore } from "@/stores/ui";

/** An empty list: a line of text and the button that fills it. */
function EmptyState({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <p className="text-sm text-muted-foreground">{text}</p>
      {children}
    </div>
  );
}

/** Thread (session) and (unowned) terminal ids placed under the given worktree (or any worktree of the repo). */
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

/**
 * The sessions and terminals placed on a worktree (or, with path null, anywhere in the
 * repo). Rendered by the worktree overview (components/overview).
 */
export function WorktreeItems({ repoId, path }: { repoId: string; path: string | null }) {
  const { sessions, terminals } = useItemsIn(repoId, path);
  const sessionsAvailable = useSessionsStore((s) => s.availability !== "unavailable");
  return (
    <div className="flex flex-col gap-6">
      {sessionsAvailable && (
        <section>
          <h2 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Threads</h2>
          {sessions.length === 0 ? (
            <EmptyState text="No threads here.">
              <CommandButton command="session.new" icon={Sparkles} label="New thread" variant="outline" size="xs" keepFocus={false} data-testid="empty-new-session" />
            </EmptyState>
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
          <EmptyState text="No terminals here.">
            <CommandButton command="terminal.new" icon={SquareTerminal} label="New terminal" variant="outline" size="xs" keepFocus={false} data-testid="empty-new-terminal" />
          </EmptyState>
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

export function Dashboard() {
  const selection = useUiStore((s) => s.selection);
  // A repo row is its main worktree (as in deriveContext).
  if (selection.kind === "repo") return <WorktreeOverview repoId={selection.repoId} path={null} items={<WorktreeItems repoId={selection.repoId} path={null} />} />;
  if (selection.kind === "worktree") return <WorktreeOverview repoId={selection.repoId} path={selection.path} items={<WorktreeItems repoId={selection.repoId} path={selection.path} />} />;
  return <StartPage />;
}
