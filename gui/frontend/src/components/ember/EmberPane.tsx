import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { Eye, Loader2 } from "lucide-react";
import { PanelToggle } from "@/components/panel/PanelToggle";
import { AgentsStrip } from "@/components/thread/AgentsStrip";
import { useElementHeight, useThreadActivity } from "@/components/thread/activity";
import { PathPlaceContext, ThreadContext } from "@/components/thread/context";
import { ThreadComposer } from "@/components/thread/ThreadComposer";
import { Button } from "@/components/ui/button";
import { PaneHeader } from "@/components/window/PaneHeader";
import { projectPlace, type ProjectRoot } from "@/lib/pathChips";
import { cn } from "@/lib/utils";
import { clearWorkRowChoices, holdEmberBoard, useEmberEnabled, useFlameState, useHeaderSummary, useWorkingThreads } from "@/stores/ember";
import { toggleEmberBoard, useEmberBoardShown } from "@/stores/emberPanel";
import { keyOf } from "@/stores/panel";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { EmberTimeline } from "./EmberTimeline";
import { Flame } from "./Flame";
import "@/components/thread/thread.css";

const PLACEHOLDER = "Tell Ember what you want done…";
const BUSY_PLACEHOLDER = "Tell Ember more; it reads it mid-turn…";

/** A header toggle: muted text, the accent background while on. */
const TOGGLE = "gap-1.5 px-2 text-label font-medium text-muted-foreground [--wails-draggable:no-drag] [&_svg]:size-3.5";
const TOGGLE_ON = "bg-accent text-foreground hover:bg-accent dark:bg-accent/50";

/** "2 threads working · 1 queued" from the board, with a sky dot while workers run. */
function HeaderStatus() {
  const summary = useHeaderSummary();
  const working = useWorkingThreads();
  return (
    <span className="flex min-w-0 shrink items-center gap-1.5 px-1 text-caption whitespace-nowrap text-muted-foreground" data-testid="ember-header-status">
      {working > 0 && <span className="size-1.5 shrink-0 rounded-full bg-info shadow-[0_0_0_2px_color-mix(in_oklab,var(--info)_25%,transparent)]" aria-hidden />}
      <span className="truncate">{summary || "Nothing in progress"}</span>
    </span>
  );
}

/** Board (the side panel on the Board surface) and Show work (every work row open), then the panel toggle. */
function HeaderActions({ threadId }: { threadId: string }) {
  const enabled = useEmberEnabled();
  const panelKey = useUiStore((s) => keyOf(s.selection));
  const board = useEmberBoardShown(panelKey);
  const showWork = useUiStore((s) => s.emberShowWork);
  return (
    <span className="-mr-1.5 flex items-center gap-1 [--wails-draggable:no-drag]" data-testid="pane-actions">
      {enabled && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className={cn(TOGGLE, board && TOGGLE_ON)}
          aria-pressed={board}
          data-testid="ember-board-toggle"
          onMouseDown={(e) => {
            e.preventDefault();
          }}
          onClick={() => {
            toggleEmberBoard();
          }}
        >
          Board
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className={cn(TOGGLE, showWork && TOGGLE_ON)}
        aria-pressed={showWork}
        data-testid="ember-show-work"
        onMouseDown={(e) => {
          e.preventDefault();
        }}
        onClick={() => {
          clearWorkRowChoices(threadId);
          useUiStore.getState().setEmberShowWork(!showWork);
        }}
      >
        <Eye aria-hidden />
        Show work
      </Button>
      <PanelToggle />
    </span>
  );
}

/** Every project's checkouts as "<project id> <path>" (a primitive list, so a git refresh does not re-render the chat). */
function useProjectRoots(): readonly string[] {
  return useProjectsStore(useShallow((s) => s.order.flatMap((id) => (s.byId[id]?.worktrees ?? []).map((w) => `${id} ${w.path}`))));
}

/**
 * Path chips in Ember's chat: Ember's own directory is no checkout, and the paths it
 * writes belong to whichever project it talks about, so only an absolute path under a
 * project's checkout is a chip (opening in that project); any other stays plain code.
 */
function EmberPathPlace({ children }: { children: ReactNode }) {
  const keys = useProjectRoots();
  const resolve = useMemo(() => {
    const roots: ProjectRoot[] = keys.map((k) => ({ project: k.slice(0, k.indexOf(" ")), path: k.slice(k.indexOf(" ") + 1) }));
    return (path: string) => projectPlace(roots, path);
  }, [keys]);
  return <PathPlaceContext.Provider value={resolve}>{children}</PathPlaceContext.Provider>;
}

/**
 * Ember's chat in the content pane (docs/notes/ember-3-gui.md): its thread's Watch and
 * timeline machinery (ThreadPane's WatchedThread holds the stream), with its own header
 * (the flame, "Ember", the board's summary, Board and Show work) and rows (EmberTimeline),
 * and the thread composer. Holds the board stream (core) while shown.
 */
export function EmberBody({ threadId }: { threadId: string }) {
  useEffect(() => holdEmberBoard("core"), []);
  const cwd = useThreadsStore((s) => s.byId[threadId]?.worktreePath ?? "");
  const flame = useFlameState(threadId);
  const { loaded, empty, catchingUp, watchError, open, busy, working, timelineWorking } = useThreadActivity(threadId);
  const dockRef = useRef<HTMLDivElement>(null);
  const dockHeight = useElementHeight(dockRef);
  const ctx = useMemo(() => ({ threadId, cwd }), [threadId, cwd]);
  return (
    <ThreadContext.Provider value={ctx}>
      <section className="cf-thread flex min-h-0 min-w-0 flex-1 flex-col outline-none" tabIndex={-1} aria-label="Ember" data-thread-id={threadId} data-testid="ember-pane" data-region="content">
        <PaneHeader className="gap-2 px-3" data-testid="thread-header">
          <span className="flex min-w-0 shrink-0 items-center gap-1.5 px-0.5" data-testid="ember-title">
            <Flame state={flame} size="header" />
            <span className="text-label text-foreground">Ember</span>
          </span>
          <HeaderStatus />
          <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-muted-foreground tabular-nums">
            <HeaderActions threadId={threadId} />
          </span>
        </PaneHeader>
        <div className="relative flex min-h-0 flex-1 flex-col">
          {loaded && catchingUp && (
            <div
              className="pointer-events-none absolute top-2 right-4 z-10 flex items-center gap-1.5 rounded-md border bg-popover/90 px-2 py-0.5 text-caption-sm"
              data-testid="thread-catching-up"
            >
              <Loader2 className="size-3 animate-spin" />
              catching up…
            </div>
          )}
          {!loaded && <p className="absolute inset-x-0 top-10 text-center text-body text-muted-foreground">{watchError ? `Cannot load the conversation: ${watchError}` : "Loading the conversation…"}</p>}
          {loaded && empty && !working && (
            <div className="absolute inset-x-0 top-1/3 flex flex-col items-center gap-3 px-10 text-center" data-testid="ember-empty">
              <Flame state="idle" size="hero" />
              <p className="text-body text-muted-foreground">Tell Ember what you want done. It plans the work, starts worker threads and reports back here.</p>
            </div>
          )}
          <EmberPathPlace>
            <EmberTimeline key={threadId} threadId={threadId} working={timelineWorking} bottomInset={dockHeight} />
          </EmberPathPlace>
          <div className="dock" ref={dockRef}>
            <AgentsStrip threadId={threadId} />
            <ThreadComposer key={threadId} threadId={threadId} pending={open} busy={busy} placeholder={PLACEHOLDER} busyPlaceholder={BUSY_PLACEHOLDER} />
          </div>
        </div>
      </section>
    </ThreadContext.Provider>
  );
}
