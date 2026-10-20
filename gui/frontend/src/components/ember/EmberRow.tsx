import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { SquareKanban, Settings2 } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { emberStatusWords } from "@/lib/ember";
import type { StatusTone } from "@/lib/statusLine";
import { cn } from "@/lib/utils";
import { holdEmberBoard, useDoingCount, useFirstDoingTitle, useFlameState, useShownEmberThreadId, useWaitingThreads, useWorkingThreads } from "@/stores/ember";
import { EMBER_ROW_KEY, openEmber, openEmberBoard, openEmberSettings } from "@/stores/emberPanel";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { EMBER_VIEW } from "@/surfaces/emberTarget";
import { Flame } from "./Flame";

/** The sidebar's status colours (SidebarRow toneClasses). */
const TONE: Readonly<Record<StatusTone, string>> = {
  muted: "",
  sky: "text-info",
  amber: "text-warning",
  emerald: "text-success",
  red: "text-destructive",
};

/** Whether the selection shows Ember's chat (its thread, or the Ember view). */
function useEmberSelected(threadId: string): boolean {
  return useUiStore((s) => (s.selection.kind === "thread" && s.selection.id === threadId) || (s.selection.kind === "view" && s.selection.name === EMBER_VIEW));
}

/** "<Status> · <first doing task> · N threads", the status in the thread rows' colours (Needs input while a worker waits on the user). */
function EmberLine({ threadId }: { threadId: string }) {
  const doing = useDoingCount();
  const t = useThreadsStore(
    useShallow((s) => {
      const x = s.byId[threadId];
      return x ? { state: x.state, status: x.status, statusReason: x.statusReason, statusChangedAtMs: x.statusChangedAtMs } : undefined;
    }),
  );
  const waiting = useWaitingThreads();
  const words = emberStatusWords(t, doing, waiting);
  const title = useFirstDoingTitle();
  const working = useWorkingThreads();
  return (
    <span className="min-w-0 truncate text-caption-sm" data-testid="ember-row-line">
      <span className={TONE[words.tone]} data-testid="ember-row-status">
        {words.text}
      </span>
      {title && (
        <>
          <span aria-hidden> · </span>
          <span data-testid="ember-row-task">{title}</span>
        </>
      )}
      {working > 0 && (
        <>
          <span aria-hidden> · </span>
          <span className="tabular-nums" data-testid="ember-row-threads">
            {working} {working === 1 ? "thread" : "threads"}
          </span>
        </>
      )}
    </span>
  );
}

/**
 * Ember's pinned row (docs/notes/ember-3-gui.md): above New thread, while Ember is on and
 * its thread exists. The flame in its state, "Ember", and a line like a thread row's
 * status line. A click (or Enter from the thread list, whose arrows reach it) opens its
 * chat; its menu opens the board or Ember's settings. Never archived, snoozed or renamed.
 * Holds the board stream (inline) while shown.
 */
export function EmberRow() {
  const threadId = useShownEmberThreadId();
  if (!threadId) return null;
  return <EmberRowShown threadId={threadId} />;
}

function EmberRowShown({ threadId }: { threadId: string }) {
  useEffect(() => holdEmberBoard("inline"), []);
  const flame = useFlameState(threadId);
  const selected = useEmberSelected(threadId);
  const cursor = useUiStore((s) => s.cursorKey === EMBER_ROW_KEY);
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>
        <div
          id={`row-${EMBER_ROW_KEY}`}
          role="option"
          aria-selected={selected}
          data-testid="sidebar-ember"
          data-cursor={cursor || undefined}
          data-flame={flame}
          className={cn(
            "mt-1.5 flex h-12.5 shrink-0 cursor-default items-center gap-2.5 rounded-md px-2 select-none [--wails-draggable:no-drag]",
            selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/90 hover:bg-sidebar-accent/50",
            // The keyboard cursor while the thread list has focus (its arrows reach this row).
            cursor && "[[data-testid=sidebar-body]:has([data-testid=thread-list]:focus)_&]:ring-1 [[data-testid=sidebar-body]:has([data-testid=thread-list]:focus)_&]:ring-sidebar-ring [[data-testid=sidebar-body]:has([data-testid=thread-list]:focus)_&]:ring-inset",
          )}
          onClick={() => {
            useUiStore.getState().setCursor(null);
            openEmber(threadId);
          }}
        >
          <Flame state={flame} size="row" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-body font-semibold text-inherit" data-testid="ember-row-name">
              Ember
            </span>
            <EmberLine threadId={threadId} />
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent data-testid="ember-row-menu">
        <ContextMenuItem
          onSelect={() => {
            openEmber(threadId);
            openEmberBoard();
          }}
        >
          <SquareKanban />
          Open board
        </ContextMenuItem>
        <ContextMenuItem onSelect={openEmberSettings}>
          <Settings2 />
          Settings
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
