import { useEffect, useRef } from "react";
import { Plus, Search } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { CommandButton } from "@/components/command/CommandButton";
import { EmberLine, EmberRowMenu } from "@/components/ember/EmberRow";
import { useEmberSelected } from "@/components/ember/useEmberSelected";
import { Flame } from "@/components/ember/Flame";
import { DaemonStatus } from "@/components/status/DaemonStatus";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Tip } from "@/components/ui/tooltip";
import { startCommandNamed } from "@/keys/bindings";
import type { ShellRow } from "@/lib/shellSections";
import { searchRow } from "@/lib/searchActivity";
import type { HeaderRow, FooterSection } from "@/lib/tree";
import { cn } from "@/lib/utils";
import { holdEmberBoard, useFlameState, useShownEmberThreadId } from "@/stores/ember";
import { EMBER_ROW_KEY, openEmber } from "@/stores/emberPanel";
import { useSearchActivityStore } from "@/stores/searchActivity";
import { useUiStore } from "@/stores/ui";
import { PaletteButton, SettingsButton, UsageButton } from "../SidebarStatus";
import { useSidebarDashboard } from "../useLinkedPrs";
import { useShellListRows } from "../shell/listRows";
import { ThreadListbox } from "../shell/ThreadListbox";
import { RailGroup, type RailScrollTo } from "./RailGroup";
import { RAIL_NEEDS_MAX, RAIL_WIDTH, railTileClass } from "./railLook";
import { RailArchived, RailSnoozed, RailWorking } from "./RailSections";

/**
 * The collapsed sidebar: a 40px rail of icons that keeps the sidebar's whole feature set
 * (docs/notes/sidebar-rail.md). Top to bottom: New thread and search in a small pane, Ember's
 * flame, Needs you (at most four icons tall, then it scrolls), Active (the height left, scrolls),
 * then pinned to the bottom Working, Snoozed and Archived, and the footer's palette, usage and
 * settings buttons and the daemon's dot. Each row's icon behaves as its expanded row does; no
 * section headers, no scope toggle (the rail lists by the scope in force), no resize handle.
 */
export function SidebarRail() {
  useSidebarDashboard();
  return (
    <aside className="relative flex shrink-0 flex-col bg-cf-sidebar" style={{ width: RAIL_WIDTH }} data-testid="sidebar-rail">
      <div className="flex min-h-0 flex-1 flex-col items-center pl-shell" data-testid="sidebar-rail-body">
        <RailMenu />
        <RailEmber />
        <RailList />
      </div>
    </aside>
  );
}

/** A 16px wide hairline in the divider colour between the rail's groups. */
function RailSeparator() {
  return <div className="my-1.5 h-px w-4 shrink-0 bg-cf-divider" role="separator" data-testid="rail-separator" />;
}

/** The footer's buttons on the rail: the 26px target around their own 14px glyph (the expanded footer's, as the sketch has them). */
const RAIL_BUTTON = "h-[26px] w-7 rounded-md";

/** The menu pane's two buttons, the expanded pane's look (surface, divider border, pane radius). */
function RailMenu() {
  const composing = useUiStore((s) => s.selection.kind === "compose");
  return (
    <div className="mb-1.5 flex w-7 shrink-0 flex-col items-center rounded-pane border border-cf-divider bg-cf-surface p-px [--wails-draggable:no-drag]" data-testid="rail-menu">
      {/* New thread: the expanded row's command (thread.new), selected while the new-thread composer shows. */}
      <CommandButton
        command="thread.new"
        icon={Plus}
        tooltipSide="right"
        whenUnavailable="disable"
        current={composing}
        className={cn("h-7 w-full rounded-lg text-cf-sidebar-foreground [&_svg]:size-4", composing ? "bg-cf-sidebar-row-selected hover:bg-cf-sidebar-row-selected dark:hover:bg-cf-sidebar-row-selected" : "hover:bg-cf-sidebar-row-hover dark:hover:bg-cf-sidebar-row-hover")}
        data-testid="rail-new-thread"
      />
      <RailSearch />
    </div>
  );
}

/**
 * Search: the normal thread find (search.open). While an agent search has something to say (the
 * expanded menu's search row, SearchNav), a dot marks it, the tooltip says what the row says, and
 * a click opens that search.
 */
function RailSearch() {
  const dialogOpen = useUiStore((s) => s.palette.open && s.palette.page === "search");
  const row = useSearchActivityStore(useShallow((s) => searchRow(s.activity)));
  const active = dialogOpen ? null : row;
  const label = active ? active.label : "Search Threads";
  return (
    <Tip label={label} side="right">
      <button
        type="button"
        tabIndex={-1}
        aria-label={label}
        className="relative flex h-7 w-full items-center justify-center rounded-lg text-cf-icon-muted outline-none hover:bg-cf-sidebar-row-hover hover:text-cf-sidebar-foreground"
        data-testid="rail-search"
        data-state={active?.kind}
        onMouseDown={(e) => {
          e.preventDefault();
        }}
        onClick={() => {
          startCommandNamed("search.open", active ? { id: active.id } : undefined);
        }}
      >
        <Search className="size-4 shrink-0" aria-hidden />
        {active && <span className={cn("absolute top-1 right-1 size-1.5 rounded-full", active.kind === "failed" ? "bg-cf-error" : active.count > 0 ? "bg-cf-warning" : "bg-cf-info")} aria-hidden data-testid="rail-search-mark" />}
      </button>
    </Tip>
  );
}

/** Ember's flame alone, while Ember's row would show: the row's click and menu; its name and line in the tooltip. A separator under it. */
function RailEmber() {
  const threadId = useShownEmberThreadId();
  if (!threadId) return null;
  return <RailEmberShown threadId={threadId} />;
}

function RailEmberShown({ threadId }: { threadId: string }) {
  useEffect(() => holdEmberBoard(), []);
  const flame = useFlameState(threadId);
  const selected = useEmberSelected(threadId);
  const cursor = useUiStore((s) => s.cursorKey === EMBER_ROW_KEY);
  return (
    <>
      <ContextMenu modal={false}>
        <Tip
          side="right"
          label={
            <span className="flex flex-col">
              <span className="font-semibold">Ember</span>
              <EmberLine threadId={threadId} />
            </span>
          }
        >
          <ContextMenuTrigger asChild>
            <div
              id={`row-${EMBER_ROW_KEY}`}
              role="option"
              aria-selected={selected}
              aria-label="Ember"
              data-testid="rail-ember"
              data-cursor={cursor || undefined}
              data-flame={flame}
              className={cn(
                railTileClass(selected, false),
                "[--wails-draggable:no-drag]",
                // The keyboard cursor while the rail's list has focus (its arrows reach this icon).
                cursor && "[[data-testid=sidebar-rail-body]:has([data-testid=rail-list]:focus)_&]:ring-1 [[data-testid=sidebar-rail-body]:has([data-testid=rail-list]:focus)_&]:ring-cf-focus [[data-testid=sidebar-rail-body]:has([data-testid=rail-list]:focus)_&]:ring-inset",
              )}
              onClick={() => {
                useUiStore.getState().setCursor(null);
                openEmber(threadId);
              }}
            >
              <Flame state={flame} size="nav" />
            </div>
          </ContextMenuTrigger>
        </Tip>
        <EmberRowMenu threadId={threadId} />
      </ContextMenu>
      <RailSeparator />
    </>
  );
}

/** Needs you's rows and Active's (drafts and threads), as the expanded list orders them. */
function splitMain(main: readonly ShellRow[]): { needs: ShellRow[]; active: ShellRow[] } {
  const needs: ShellRow[] = [];
  const active: ShellRow[] = [];
  for (const r of main) {
    if (r.kind === "header") continue;
    if (r.section === "needs") needs.push(r);
    else active.push(r);
  }
  return { needs, active };
}

/**
 * The rail's list and footer: Needs you and Active in the expanded list's listbox behaviour
 * (ThreadListbox: keys, cursor, click, context menu), each group scrolling on its own; then the
 * bottom of the rail.
 */
function RailList() {
  const { main, headers } = useShellListRows({ expandMain: true });
  const { needs, active } = splitMain(main);
  const keyRows = [...needs, ...active];
  const scrollNeeds = useRef<RailScrollTo>(null);
  const scrollActive = useRef<RailScrollTo>(null);
  const scrollToRow = (row: ShellRow) => {
    const inNeeds = needs.indexOf(row);
    if (inNeeds >= 0) scrollNeeds.current?.(inNeeds);
    else scrollActive.current?.(active.indexOf(row));
  };
  return (
    <>
      <ThreadListbox rows={keyRows} scrollToRow={scrollToRow} testId="rail-list" className="w-full items-center">
        {({ selectedKey, cursorKey, activate }) => (
          <>
            {needs.length > 0 && (
              <>
                <RailGroup rows={needs} selectedKey={selectedKey} cursorKey={cursorKey} onActivate={activate} scrollTo={scrollNeeds} maxIcons={RAIL_NEEDS_MAX} testId="rail-needs" />
                <RailSeparator />
              </>
            )}
            {active.length > 0 && <RailGroup rows={active} selectedKey={selectedKey} cursorKey={cursorKey} onActivate={activate} scrollTo={scrollActive} testId="rail-active" />}
          </>
        )}
      </ThreadListbox>
      <RailFooter headers={headers} />
    </>
  );
}

/** Working, Snoozed and Archived (each while the expanded sidebar shows it) after a separator, then the footer's buttons and the daemon's dot. */
function RailFooter({ headers }: { headers: Readonly<Record<FooterSection, HeaderRow | null>> }) {
  const { working, snoozed, archived } = headers;
  return (
    <div className="flex w-full shrink-0 flex-col items-center pb-2" data-testid="rail-footer">
      {(working || snoozed || archived) && (
        <>
          <RailSeparator />
          {working && <RailWorking count={working.count} />}
          {snoozed && <RailSnoozed count={snoozed.count} />}
          {archived && <RailArchived count={archived.count} />}
        </>
      )}
      <RailSeparator />
      <PaletteButton className={RAIL_BUTTON} tooltipSide="right" />
      <UsageButton className={RAIL_BUTTON} tooltipSide="right" />
      <SettingsButton className={RAIL_BUTTON} tooltipSide="right" />
      <span className="flex h-[18px] w-7 shrink-0 items-center justify-center text-caption-sm">
        <DaemonStatus dotOnly />
      </span>
    </div>
  );
}
