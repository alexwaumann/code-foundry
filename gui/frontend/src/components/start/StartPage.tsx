import { Fragment, useMemo, type ReactNode } from "react";
import { Command, FolderPlus, SquarePen } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Backdrop } from "@/components/backdrop/Backdrop";
import { CommandButton } from "@/components/command/CommandButton";
import { DragBand } from "@/components/window/DragBand";
import { ThreadLink } from "@/components/thread/ThreadLink";
import { useNoProjectThread } from "@/components/thread/useNoProject";
import { greeting } from "@/lib/greeting";
import { NO_PROJECT } from "@/lib/threadRow";
import { placeThread } from "@/lib/tree";
import { cn } from "@/lib/utils";
import { decodeRepoKeys, useRepoStructureKeys } from "@/stores/context";
import { useReposStore } from "@/stores/repos";
import { openHelp } from "@/stores/views";
import { activeThreadIds, attentionIds, isAttention, runningCount, useThreadsStore } from "@/stores/threads";

/** Rows in the start page's thread list before "+N more". */
const MAX_THREADS = 6;

/** A heading and a muted line under it. */
function Header({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h1 className="text-title" data-testid="start-heading">
        {title}
      </h1>
      <div className="mt-1 text-body text-muted-foreground">{children}</div>
    </div>
  );
}

/** Zero projects: what the app is and the one way to start. */
function Onboarding() {
  return (
    <>
      <Header title="Welcome to Code Foundry">
        <p>A single surface for all your agents.</p>
      </Header>
      <div className="flex flex-wrap justify-center gap-2" data-testid="welcome-actions">
        <CommandButton command="repo.add" icon={FolderPlus} label="Add a project" variant="default" whenUnavailable="disable" keepFocus={false} />
        <CommandButton command="ui.palette.open" icon={Command} label="Command palette" variant="outline" className="backdrop-blur-sm" keepFocus={false} />
      </div>
    </>
  );
}

/** The registered project a thread's worktree belongs to, by name; "No project" for a thread without one; null when it cannot be placed. */
function useThreadProject(id: string): string | null {
  const noProject = useNoProjectThread(id);
  const worktreePath = useThreadsStore((s) => s.byId[id]?.worktreePath ?? "");
  const repoKeys = useRepoStructureKeys();
  const repoId = useMemo(() => {
    const worktrees = decodeRepoKeys(repoKeys).flatMap((r) => r.worktreePaths.map((path) => ({ repoId: r.id, path })));
    return placeThread({ worktreePath }, worktrees)?.repoId ?? null;
  }, [repoKeys, worktreePath]);
  const name = useReposStore((s) => (repoId ? (s.byId[repoId]?.name ?? null) : null));
  return noProject ? NO_PROJECT : name;
}

function StartThreadRow({ id }: { id: string }) {
  const waiting = useThreadsStore((s) => {
    const x = s.byId[id];
    return x !== undefined && isAttention(x);
  });
  const project = useThreadProject(id);
  const dot = <span aria-hidden className={cn("size-[7px] rounded-full", waiting ? "bg-warning" : "bg-success")} />;
  return <ThreadLink id={id} icon={dot} detail={`${waiting ? "waiting" : "running"}${project ? ` · ${project}` : ""}`} />;
}

/** Threads waiting on the user, then running ones; hidden when there are none. */
function ActiveThreads() {
  const ids = useThreadsStore(useShallow((s) => activeThreadIds(s)));
  if (ids.length === 0) return null;
  const more = ids.length - MAX_THREADS;
  return (
    <section className="w-full max-w-[420px] text-left" aria-label="Threads" data-testid="start-threads">
      <h2 className="px-2 pb-1.5 text-overline">Threads</h2>
      {ids.slice(0, MAX_THREADS).map((id) => (
        <StartThreadRow key={id} id={id} />
      ))}
      {more > 0 && (
        <p className="px-2 pt-1 text-caption" data-testid="start-threads-more">
          +{more} more
        </p>
      )}
    </section>
  );
}

/** The fleet's counts, showing only the ones that are non-zero; nothing at all when every count is zero. */
function Counts({ running, waiting }: { running: number; waiting: number }) {
  const parts: ReactNode[] = [];
  if (running > 0) parts.push(<span key="running">{running} running</span>);
  if (waiting > 0) {
    parts.push(
      <span key="waiting" className="text-warning" data-testid="start-waiting">
        {waiting} waiting on you
      </span>,
    );
  }
  if (parts.length === 0) return null;
  return (
    <p data-testid="start-counts">
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && " · "}
          {part}
        </Fragment>
      ))}
    </p>
  );
}

/** Projects exist: a greeting, the fleet's counts, actions, and the threads that matter now. */
function Fleet() {
  const running = useThreadsStore((s) => runningCount(s));
  const waiting = useThreadsStore((s) => attentionIds(s).length);
  return (
    <>
      <Header title={greeting(new Date().getHours())}>
        <Counts running={running} waiting={waiting} />
      </Header>
      <div className="flex flex-wrap justify-center gap-2" data-testid="welcome-actions">
        <CommandButton command="thread.new" icon={SquarePen} label="New thread" variant="default" whenUnavailable="disable" keepFocus={false} />
        <CommandButton command="ui.palette.open" icon={Command} label="Command palette" variant="outline" className="backdrop-blur-sm" keepFocus={false} />
      </div>
      <ActiveThreads />
      <button
        type="button"
        className="text-caption underline underline-offset-2 hover:text-foreground"
        onClick={() => {
          // Straight to the shortcuts tab (view.help opens the guide).
          openHelp("shortcuts");
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
      <DragBand />
    </div>
  );
}
