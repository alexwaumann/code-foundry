import { useMemo } from "react";
import { Command, Sparkles, SquareTerminal } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { WorktreeOverview } from "@/components/overview/WorktreeOverview";
import { terminalLabel } from "@/lib/path";
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
import { startCommandNamed } from "@/keys/bindings";
import { useReposStore } from "@/stores/repos";
import { attentionIds, useSessionsStore } from "@/stores/sessions";
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
          <h2 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Sessions</h2>
          {sessions.length === 0 ? (
            <EmptyState text="No sessions here.">
              <CommandButton command="session.new" icon={Sparkles} label="New session" variant="outline" size="xs" keepFocus={false} data-testid="empty-new-session" />
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
      <div className="flex flex-wrap justify-center gap-2" data-testid="welcome-actions">
        <CommandButton command="session.new" icon={Sparkles} label="New session" variant="outline" whenUnavailable="disable" keepFocus={false} />
        <CommandButton command="terminal.new" icon={SquareTerminal} label="New terminal" variant="outline" keepFocus={false} />
        <CommandButton command="ui.palette.open" icon={Command} label="Command palette" title="Command Palette" variant="outline" keepFocus={false} />
      </div>
      <p className="text-sm text-muted-foreground">
        Sessions start in the worktree selected in the sidebar. Shortcuts are listed under{" "}
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground"
          onClick={() => {
            startCommandNamed("view.help");
          }}
        >
          Keyboard Shortcuts
        </button>
        .
      </p>
    </div>
  );
}

export function Dashboard() {
  const selection = useUiStore((s) => s.selection);
  // A repo row is its main worktree (as in deriveContext).
  if (selection.kind === "repo") return <WorktreeOverview repoId={selection.repoId} path={null} items={<WorktreeItems repoId={selection.repoId} path={null} />} />;
  if (selection.kind === "worktree") return <WorktreeOverview repoId={selection.repoId} path={selection.path} items={<WorktreeItems repoId={selection.repoId} path={selection.path} />} />;
  return (
    <section className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto p-10 outline-none" tabIndex={-1} data-focus-root data-region="content" aria-label="Overview">
      <div className="mt-[18vh]">
        <Welcome />
      </div>
    </section>
  );
}
