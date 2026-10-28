import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import { Plus, SquareTerminal, X } from "lucide-react";
import { ActionEcho, ActionStatusLine, ActionTabIcon, ActionTabStatusMark } from "@/components/actions/ActionTabParts";
import { CommandButton } from "@/components/command/CommandButton";
import { revealTab } from "@/components/panel/reveal";
import { useNoProjectThread } from "@/components/thread/useNoProject";
import { TerminalHost, type TerminalHostHandle } from "@/components/terminal/TerminalHost";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tip } from "@/components/ui/tooltip";
import { chordFromEvent, formatChord } from "@/keys/chord";
import { tildify } from "@/lib/path";
import { isActionLabels } from "@/lib/termlabel";
import { cn } from "@/lib/utils";
import { closeBottomTerminal, newBottomTerminal, paneContext } from "@/stores/bottomActions";
import {
  activateBottomTab,
  bottomVisible,
  bottomTabTitleOf,
  getBottomActiveId,
  requestBottomFocus,
  threadOfKey,
  toggleBottom,
  useBottomActiveId,
  useBottomHeight,
  useBottomOpen,
  useBottomStarting,
  useBottomStore,
  useBottomTabIds,
  useCurrentBottomKey,
} from "@/stores/bottomPanel";
import { useCommandsStore } from "@/stores/commands";
import { usePanelExpanded } from "@/stores/panel";
import { useTerminalsStore } from "@/stores/terminals";
import { bottomMax, useUiStore } from "@/stores/ui";
import { visibleBottomKey } from "@/stores/views";
import { BottomResizeHandle } from "./BottomResizeHandle";
import { bottomKeyAction, tabFocusIndex } from "./keys";

const BODY_ID = "bottom-panel-body";

function tabDomId(id: string): string {
  return `bottom-tab-${encodeURIComponent(id)}`;
}

/** Hides the panel (cmd+w with no tabs) and gives focus to the content pane. */
function hidePanel(panelKey: string): void {
  toggleBottom(panelKey, false);
  useUiStore.getState().focusContent();
}

/** Clicking a tab shows its terminal and puts the keyboard in it. */
function openTab(panelKey: string, id: string): void {
  activateBottomTab(panelKey, id);
  requestBottomFocus();
}

/** Whether a terminal is an action run's (kind=action): a primitive, for a narrow selector. */
function useIsAction(id: string | null): boolean {
  return useTerminalsStore((s) => (id === null ? false : isActionLabels(s.byId[id]?.labels ?? {})));
}

/**
 * One terminal's tab: icon, title (bottomTabTitleOf: duplicates numbered), × (on hover, keyboard focus, or when
 * active). Middle click closes. The tab's tooltip is the full cwd, which the title hides.
 * An action run's tab: the action's icon and name, then its status mark (running, exit 0,
 * failed); it stays after the command exits until it is closed.
 * `focusable` is the roving tabindex: only the active tab (and its ×) is in the Tab order.
 */
function TerminalTab({ panelKey, id, active, focusable }: { panelKey: string; id: string; active: boolean; focusable: boolean }) {
  const noProject = useNoProjectThread(threadOfKey(panelKey));
  const title = useTerminalsStore((s) => bottomTabTitleOf(s, panelKey, id, noProject));
  const cwd = useTerminalsStore((s) => s.byId[id]?.cwd ?? "");
  const action = useIsAction(id);
  const exited = useTerminalsStore((s) => s.byId[id]?.state === "exited") && !action;
  return (
    <div
      role="presentation"
      data-tab-id={id}
      data-exited={exited || undefined}
      data-kind={action ? "action" : "shell"}
      className={cn(
        "group relative flex h-7 max-w-48 shrink-0 items-center rounded-md pr-1 text-body-sm [--wails-draggable:no-drag]",
        active ? "bg-cf-control-hover text-cf-text dark:bg-cf-control-hover/50" : "text-cf-text-muted hover:bg-cf-control-hover/40 hover:text-cf-text",
      )}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault(); // middle click closes, below
      }}
      onAuxClick={(e) => {
        if (e.button === 1) void closeBottomTerminal(id);
      }}
    >
      {/* The tab's tooltip is the shell's working directory. */}
      <Tip label={tildify(cwd)}>
        <button
          type="button"
          role="tab"
          id={tabDomId(id)}
          aria-selected={active}
          aria-controls={active ? BODY_ID : undefined}
          tabIndex={focusable ? 0 : -1}
          className="flex h-full min-w-0 cursor-default items-center gap-1.5 rounded-md pr-1 pl-2 outline-none focus-visible:ring-1 focus-visible:ring-cf-focus"
          onClick={() => {
            openTab(panelKey, id);
          }}
        >
          {action ? <ActionTabIcon id={id} /> : <SquareTerminal className={cn("size-3.5 shrink-0", exited && "opacity-50")} aria-hidden />}
          <span className={cn("truncate", exited && "line-through opacity-60")}>{title}</span>
          {action && <ActionTabStatusMark id={id} />}
        </button>
      </Tip>
      <Tip label="Close terminal">
        <button
          type="button"
          tabIndex={focusable ? 0 : -1}
          aria-label={`Close ${title}`}
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-sm outline-none hover:bg-cf-text/10 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-cf-focus",
            active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
          onClick={() => void closeBottomTerminal(id)}
        >
          <X className="size-3" aria-hidden />
        </button>
      </Tip>
    </div>
  );
}

/**
 * Left/Right (and Home/End) move focus between the tabs and the "+" after them; Enter or
 * Space on a tab activates it, on "+" starts a shell.
 */
function onTabListKeyDown(e: KeyboardEvent<HTMLElement>): void {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"], [data-strip-stop]'));
  const i = tabs.findIndex((t) => t === document.activeElement || t.parentElement?.contains(document.activeElement));
  if (i < 0) return;
  const next = tabFocusIndex(e.key, i, tabs.length);
  if (next === null) return;
  e.preventDefault();
  e.stopPropagation();
  tabs[next]?.focus();
}

/** terminal.new's title and first chord as the registry lists them (the user may rebind it). */
function useNewTerminalCommand(): { title: string; chord: string | null } {
  const title = useCommandsStore((s) => s.commands.find((c) => c.name === "terminal.new")?.title ?? "New Terminal");
  const chord = useCommandsStore((s) => s.commands.find((c) => c.name === "terminal.new")?.keybindings[0] ?? null);
  return { title, chord };
}

/**
 * Whether "+" (and the empty state) has something to own a new shell: paneContext, the
 * context newBottomTerminal runs in, exists (a thread always; the Projects page through
 * its active tab's worktree). Re-read whenever the terminals or this panel's state change.
 */
function useCanStartTerminal(panelKey: string): boolean {
  // Re-renders when the remembered tab changes; the selector below re-runs on every
  // terminals change and every render, reading the rest (paneContext) as it is now.
  useBottomStore((s) => s.byKey[panelKey]?.activeTerminalId);
  return useTerminalsStore(() => paneContext(panelKey) !== null);
}

/** The "+" after the last tab: terminal.new in this panel's context; the new shell opens here, focused. */
function NewTerminalButton({ panelKey }: { panelKey: string }) {
  const { title } = useNewTerminalCommand();
  return (
    <Tip label={title}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="size-7 text-cf-text-muted [--wails-draggable:no-drag] hover:bg-cf-control-hover/40 hover:text-cf-text dark:hover:bg-cf-control-hover/40"
        aria-label={title}
        data-testid="bottom-new-terminal"
        data-strip-stop
        // Keeps focus where it is; the new terminal takes it when it shows up.
        onMouseDown={(e) => {
          e.preventDefault();
        }}
        onClick={() => void newBottomTerminal(panelKey)}
      >
        <Plus />
      </Button>
    </Tip>
  );
}

function TabStrip({ panelKey, ids, activeId }: { panelKey: string; ids: readonly string[]; activeId: string | null }) {
  const stripRef = useRef<HTMLDivElement>(null);
  const canStart = useCanStartTerminal(panelKey);
  // A new or activated tab may sit past the strip's scrolled edge: bring it into view.
  useEffect(() => {
    if (stripRef.current && activeId !== null) revealTab(stripRef.current, activeId);
  }, [activeId, ids.length]);
  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label="Terminals"
      aria-orientation="horizontal"
      className="relative flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
      data-testid="bottom-tabs"
      onKeyDown={onTabListKeyDown}
    >
      {ids.map((id) => (
        <TerminalTab key={id} panelKey={panelKey} id={id} active={id === activeId} focusable={id === activeId} />
      ))}
      {canStart && (
        <span className="flex shrink-0 [--wails-draggable:no-drag]">
          <NewTerminalButton panelKey={panelKey} />
        </span>
      )}
    </div>
  );
}

/**
 * No terminals: a button for terminal.new with its chord, like the side panel's surface
 * list. A fallback since cmd+j starts a shell in an empty panel and the last tab's exit
 * hides it: it shows when terminal.new failed, or on the Projects page, which has no
 * worktree to own a shell until it has a tab, so it points at the page's rows instead.
 */
function EmptyState({ panelKey }: { panelKey: string }) {
  const { title, chord } = useNewTerminalCommand();
  const canStart = useCanStartTerminal(panelKey);
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6" data-testid="bottom-empty">
      <div className="w-full max-w-64">
        <h2 className="mb-3 text-center text-subheading">No terminals</h2>
        {canStart ? (
          <ul className="flex flex-col gap-0.5">
            <li>
              <button
                type="button"
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-label hover:bg-cf-control-hover"
                data-testid="bottom-empty-new"
                onClick={() => void newBottomTerminal(panelKey)}
              >
                <SquareTerminal className="size-4 text-cf-text-muted" aria-hidden />
                <span className="flex-1 truncate">{title}</span>
                {chord && <Kbd>{formatChord(chord)}</Kbd>}
              </button>
            </li>
          </ul>
        ) : (
          <p className="text-center text-caption">Start one with New terminal on a project or worktree row.</p>
        )}
      </div>
    </div>
  );
}

/**
 * The header: tabs with "+" after them on the left, the close-panel button at the right
 * end. Not a drag surface (the window drags by the title band only).
 */
function BottomHeader({ panelKey, ids, activeId }: { panelKey: string; ids: readonly string[]; activeId: string | null }) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-cf-divider pr-1.5 pl-1 [--wails-draggable:no-drag]" data-testid="bottom-header">
      <TabStrip panelKey={panelKey} ids={ids} activeId={activeId} />
      <CommandButton command="view.bottom.toggle" icon={X} tooltip="Close bottom panel" className="shrink-0 [--wails-draggable:no-drag]" data-testid="bottom-close" />
    </div>
  );
}

function Panel({
  panelKey,
  height,
  max,
  asideRef,
  hostRef,
}: {
  panelKey: string;
  height: number;
  max: number;
  asideRef: RefObject<HTMLElement | null>;
  hostRef: RefObject<TerminalHostHandle | null>;
}) {
  const ids = useBottomTabIds(panelKey);
  const activeId = useBottomActiveId(panelKey);
  const activeIsAction = useIsAction(activeId);
  // A shell this window is starting for the panel: a blank body until it arrives.
  const starting = useBottomStarting(panelKey);

  // The active terminal changed under the keyboard (a tab closed, a new shell came in):
  // keep the keyboard in the panel, on the terminal now showing, or on the panel itself.
  const shownId = useRef(activeId);
  useEffect(() => {
    if (shownId.current === activeId) return;
    shownId.current = activeId;
    if (useUiStore.getState().focus !== "bottom") return;
    if (document.activeElement?.closest('[role="tablist"]')) return;
    if (activeId !== null) hostRef.current?.focus();
    else asideRef.current?.focus({ preventScroll: true });
  }, [activeId, asideRef, hostRef]);

  // Capture phase: cmd+w must not reach xterm, which has focus most of the time.
  const onKeyDownCapture = (e: KeyboardEvent<HTMLElement>) => {
    const chord = chordFromEvent(e.nativeEvent);
    if (!chord) return;
    const action = bottomKeyAction(chord, getBottomActiveId(panelKey));
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (action.kind === "close") void closeBottomTerminal(action.terminalId);
    else hidePanel(panelKey);
  };

  return (
    // Not clipped, so the resize handle can sit in the shell gap above it. The region (and
    // cmd+w) is the wrapper's, so the handle counts as the panel: cmd+j, cmd+w and the
    // palette's return work from it as from the terminal.
    <div className="relative mt-shell flex shrink-0" style={{ height }} data-region="bottom" data-testid="bottom-panel-wrapper" onKeyDownCapture={onKeyDownCapture}>
      <BottomResizeHandle panelKey={panelKey} height={height} max={max} />
      <aside
        ref={asideRef}
        tabIndex={-1}
        aria-label="Bottom panel"
        data-testid="bottom-panel"
        data-panel-key={panelKey}
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-pane border border-cf-divider bg-cf-surface shadow-xs outline-none"
      >
        <BottomHeader panelKey={panelKey} ids={ids} activeId={activeId} />
        <div
          id={BODY_ID}
          role={activeId === null ? undefined : "tabpanel"}
          aria-labelledby={activeId === null ? undefined : tabDomId(activeId)}
          className="flex min-h-0 flex-1 flex-col"
          data-testid="bottom-body"
          data-starting={(activeId === null && starting) || undefined}
        >
          {/* One host for every tab: switching tabs re-attaches the same xterm. Hidden
              (and detached) while there is no tab. */}
          {/* An action run: its command above the output and its status line under it. The
              host keeps its place among the siblings, so a tab switch never remounts it. */}
          {activeIsAction && activeId !== null && <ActionEcho key={`echo-${activeId}`} id={activeId} />}
          <TerminalHost ref={hostRef} terminalId={activeId} hidden={activeId === null} exitOverlay={!activeIsAction} testId="bottom-terminal-host" />
          {activeIsAction && activeId !== null && <ActionStatusLine key={`status-${activeId}`} id={activeId} />}
          {activeId === null && !starting && <EmptyState panelKey={panelKey} />}
        </div>
      </aside>
    </div>
  );
}

/**
 * The current selection's bottom terminal panel, under the content pane in the content
 * column (App.tsx). Unmounted (so its terminal detaches) when the selection has none
 * (only threads and the Projects page do), when it is closed, and while the side panel
 * fills the content area. A sheet (Settings, Themes, Usage) leaves it on screen.
 *
 * `columnHeight` is the content column's height in layout px (App.tsx), which bounds
 * the panel's (bottomMax).
 *
 * Focus requests (ui bottomFocusSeq) are handled here, not in the panel: this component
 * stays mounted, so a request with no panel showing is dropped instead of being acted on
 * by the next panel that mounts. The request comes after the panel is shown, so it is
 * mounted (and its terminal host with it) by the time this effect runs.
 */
export function BottomPanel({ columnHeight }: { columnHeight: number }) {
  const panelKey = useCurrentBottomKey();
  const open = useBottomOpen(panelKey);
  const sideExpanded = usePanelExpanded();
  const stored = useBottomHeight(panelKey ?? "");
  const focusSeq = useUiStore((s) => s.bottomFocusSeq);
  const asideRef = useRef<HTMLElement>(null);
  const hostRef = useRef<TerminalHostHandle>(null);
  const handled = useRef(focusSeq);
  const shown = bottomVisible(panelKey, open, sideExpanded);

  // Only on a new request, and only for a panel on screen.
  useEffect(() => {
    if (focusSeq === handled.current) return;
    handled.current = focusSeq;
    const key = visibleBottomKey();
    if (key === null) return;
    if (getBottomActiveId(key) !== null) hostRef.current?.focus();
    else asideRef.current?.focus({ preventScroll: true });
  }, [focusSeq]);

  if (!shown) return null;
  // bottomVisible narrows panelKey to a string here.
  // Bounded by the column there is now; the stored height comes back when the room does.
  const max = bottomMax(columnHeight);
  const height = columnHeight > 0 ? Math.min(stored, max) : stored;
  return <Panel panelKey={panelKey} height={height} max={max} asideRef={asideRef} hostRef={hostRef} />;
}
