import { useMemo, type ReactNode } from "react";
import { Command, FolderPlus, Sparkles } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import logo from "@/assets/logo.webp";
import { Backdrop } from "@/components/backdrop/Backdrop";
import { CommandButton } from "@/components/command/CommandButton";
import { SessionLink } from "@/components/session/SessionLink";
import { startCommandNamed } from "@/keys/bindings";
import { greeting } from "@/lib/greeting";
import { placeSession } from "@/lib/tree";
import { cn } from "@/lib/utils";
import { decodeRepoKeys, useRepoStructureKeys } from "@/stores/context";
import { useReposStore } from "@/stores/repos";
import { activeThreadIds, attentionIds, connectedCount, isAttention, runningCount, useSessionsStore } from "@/stores/sessions";

/** Rows in the start page's thread list before "+N more". */
const MAX_THREADS = 6;

const STEPS = [
  { n: "01", title: "Add a project", text: "Clone from GitHub or pick a local repo." },
  { n: "02", title: "Start a thread", text: "Each thread gets its own worktree and branch." },
  { n: "03", title: "Ship it", text: "Review the diff, open the PR, merge from here." },
] as const;

/** The logo tile, a heading and a muted line under it. */
function Header({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <img src={logo} alt="" draggable={false} className="size-10 rounded-[10px] shadow-sm" />
      <div>
        <h1 className="text-xl font-semibold tracking-tight" data-testid="start-heading">
          {title}
        </h1>
        <div className="mt-1 text-sm text-muted-foreground">{children}</div>
      </div>
    </>
  );
}

/** Zero projects: what the app is, how to start, and the three steps. */
function Onboarding() {
  return (
    <>
      <Header title="Welcome to Code Foundry">
        <p>Run fleets of Claude Code threads across git worktrees.</p>
        <p>Start by adding a project.</p>
      </Header>
      <div className="flex flex-wrap justify-center gap-2" data-testid="welcome-actions">
        <CommandButton command="repo.register" icon={FolderPlus} label="Add a project" variant="default" whenUnavailable="disable" keepFocus={false} />
        <CommandButton command="ui.palette.open" icon={Command} label="Command palette" title="Command Palette" variant="outline" className="backdrop-blur-sm" keepFocus={false} />
      </div>
      <ol className="mt-1.5 grid w-full grid-cols-3 gap-2 text-left" data-testid="onboarding-steps">
        {STEPS.map((s) => (
          <li key={s.n} className="rounded-[10px] border border-border bg-pane/70 px-3 py-2.5 backdrop-blur-md">
            <span className="mb-1 block text-[10px] tracking-wide text-muted-foreground/80">{s.n}</span>
            <span className="mb-0.5 block text-xs font-semibold">{s.title}</span>
            <span className="block text-[11.5px] leading-snug text-muted-foreground">{s.text}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

/** The registered project a session's worktree belongs to, by name; null when it cannot be placed. */
function useSessionProject(id: string): string | null {
  const worktreePath = useSessionsStore((s) => s.byId[id]?.worktreePath ?? "");
  const repoKeys = useRepoStructureKeys();
  const repoId = useMemo(() => {
    const worktrees = decodeRepoKeys(repoKeys).flatMap((r) => r.worktreePaths.map((path) => ({ repoId: r.id, path })));
    return placeSession({ worktreePath }, worktrees)?.repoId ?? null;
  }, [repoKeys, worktreePath]);
  return useReposStore((s) => (repoId ? (s.byId[repoId]?.name ?? null) : null));
}

function ThreadRow({ id }: { id: string }) {
  const waiting = useSessionsStore((s) => {
    const x = s.byId[id];
    return x !== undefined && isAttention(x);
  });
  const project = useSessionProject(id);
  const dot = <span aria-hidden className={cn("size-[7px] rounded-full", waiting ? "bg-amber-500 dark:bg-amber-400" : "bg-emerald-500 dark:bg-emerald-400")} />;
  return <SessionLink id={id} icon={dot} detail={`${waiting ? "waiting" : "running"}${project ? ` · ${project}` : ""}`} />;
}

/** Threads waiting on the user, then running ones; hidden when there are none. */
function ActiveThreads() {
  const ids = useSessionsStore(useShallow((s) => activeThreadIds(s)));
  if (ids.length === 0) return null;
  const more = ids.length - MAX_THREADS;
  return (
    <section className="w-full max-w-[420px] text-left" aria-label="Threads" data-testid="start-threads">
      <h2 className="px-2 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Threads</h2>
      {ids.slice(0, MAX_THREADS).map((id) => (
        <ThreadRow key={id} id={id} />
      ))}
      {more > 0 && (
        <p className="px-2 pt-1 text-xs text-muted-foreground" data-testid="start-threads-more">
          +{more} more
        </p>
      )}
    </section>
  );
}

/** Projects exist: a greeting, the fleet's counts, actions, and the threads that matter now. */
function Fleet() {
  const connected = useSessionsStore((s) => connectedCount(s));
  const running = useSessionsStore((s) => runningCount(s));
  const waiting = useSessionsStore((s) => attentionIds(s).length);
  return (
    <>
      <Header title={greeting(new Date().getHours())}>
        <p data-testid="start-counts">
          {connected} connected · {running} running ·{" "}
          <span className={cn(waiting > 0 && "text-amber-600 dark:text-amber-400")} data-testid="start-waiting">
            {waiting} waiting on you
          </span>
        </p>
      </Header>
      <div className="flex flex-wrap justify-center gap-2" data-testid="welcome-actions">
        <CommandButton command="session.new" icon={Sparkles} label="New thread" variant="default" whenUnavailable="disable" keepFocus={false} />
        <CommandButton command="ui.palette.open" icon={Command} label="Command palette" title="Command Palette" variant="outline" className="backdrop-blur-sm" keepFocus={false} />
      </div>
      <ActiveThreads />
      <button
        type="button"
        className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        onClick={() => {
          startCommandNamed("view.help");
        }}
      >
        Keyboard Shortcuts
      </button>
    </>
  );
}

/**
 * The content pane with nothing selected. Onboarding until a project is registered,
 * then a greeting with the fleet at a glance. Centred both ways over the backdrop.
 */
export function StartPage() {
  const onboarding = useReposStore((s) => s.loaded && s.order.length === 0);
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <Backdrop />
      {/* Auto margins in a column flexbox centre the block and, unlike justify-center,
          fall back to 0 (scrollable from the top) when it outgrows the pane. */}
      <section
        className="relative flex min-h-0 flex-1 flex-col overflow-y-auto p-10 outline-none"
        tabIndex={-1}
        data-focus-root
        data-region="content"
        aria-label="Overview"
        data-testid="start-page"
        data-state={onboarding ? "onboarding" : "fleet"}
      >
        <div className="m-auto flex w-full max-w-[440px] flex-col items-center gap-[18px] text-center">{onboarding ? <Onboarding /> : <Fleet />}</div>
      </section>
    </div>
  );
}
