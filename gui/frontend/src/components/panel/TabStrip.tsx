import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Plus, X } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { Tip } from "@/components/ui/tooltip";
import { chordFromEvent } from "@/keys/chord";
import { cn } from "@/lib/utils";
import { activatePanelTab, emptyGroup, focusPanelGroup, movePanelTab, usePanelGroup, usePanelPicking, type GroupIndex, type Tab } from "@/stores/panel";
import { surfaceOf } from "@/surfaces/registry";
import { bodyDomId, closeTab, liftedTab, tabDomId } from "./actions";
import { tabMoveIndex } from "./keys";
import { usePanelDrop } from "./panelDrop";
import { revealElement, revealTab } from "./reveal";

/** The active tab (and the "+" while picking): full tint in the focused group, lighter in the other one. */
const ACTIVE_FOCUSED = "bg-cf-control-hover text-cf-text dark:bg-cf-control-hover/50";
const ACTIVE_UNFOCUSED = "bg-cf-control-hover/40 text-cf-text dark:bg-cf-control-hover/25";

/**
 * One tab, sortable: a pointer drag (past 4px, so clicks, the × and middle click work as
 * before) lifts a copy of it (PanelDnd's ghost) and leaves its slot dimmed, which slides
 * along the strip as the neighbours make room. `drop` marks where a tab dragged from the
 * other group would land: before this tab, or after it (the last one). `focusable` is the
 * roving tabindex: the active tab, or the first one while picking (no tab is active
 * then), so Tab still reaches the strip. dnd-kit's `attributes` (role="button",
 * tabIndex 0) are not spread on the wrapper, which stays presentation: only its
 * description (how to move a tab with the keyboard) goes on the tab. `focused` is
 * whether its group has focus (always on an unsplit panel): the active tab of the other
 * group is tinted lighter.
 */
function TabButton({
  panelKey,
  group,
  tab,
  active,
  focused,
  focusable,
  drop,
}: {
  panelKey: string;
  group: GroupIndex;
  tab: Tab;
  active: boolean;
  focused: boolean;
  focusable: boolean;
  drop?: "before" | "after" | "first" | undefined;
}) {
  const Icon = surfaceOf(tab.kind)?.icon;
  const data = useMemo(() => ({ kind: "tab", group }), [group]);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id, data });
  return (
    <div
      ref={setNodeRef}
      role="presentation"
      data-tab-id={tab.id}
      data-dragging={isDragging || undefined}
      // Translate, not Transform: tabs differ in width, and a scale would stretch the text.
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "group relative flex h-7 max-w-48 shrink-0 items-center rounded-md pr-1 text-body-sm [--wails-draggable:no-drag]",
        active ? (focused ? ACTIVE_FOCUSED : ACTIVE_UNFOCUSED) : "text-cf-text-muted hover:bg-cf-control-hover/40 hover:text-cf-text",
        // The lifted tab's slot: the ghost under the pointer is the tab now.
        isDragging && "opacity-40",
      )}
      {...listeners}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault(); // middle click closes, below
      }}
      onAuxClick={(e) => {
        if (e.button === 1) closeTab(panelKey, tab.id);
      }}
    >
      {/* Roving tabindex: Tab reaches the active tab (and its ×); arrows move between tabs. */}
      <button
        type="button"
        role="tab"
        id={tabDomId(tab.id)}
        aria-selected={active}
        aria-controls={active ? bodyDomId(group) : undefined}
        aria-describedby={attributes["aria-describedby"]}
        tabIndex={focusable ? 0 : -1}
        className="flex h-full min-w-0 cursor-default items-center gap-1.5 rounded-md pr-1 pl-2 outline-none focus-visible:ring-1 focus-visible:ring-cf-focus"
        onClick={() => {
          activatePanelTab(panelKey, tab.id);
        }}
      >
        {Icon && <Icon className="size-3.5 shrink-0" aria-hidden />}
        <span className="truncate">{tab.title}</span>
      </button>
      <Tip label="Close tab">
        <button
          type="button"
          tabIndex={focusable ? 0 : -1}
          aria-label={`Close ${tab.title}`}
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-sm outline-none hover:bg-cf-text/10 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-cf-focus",
            active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
          onClick={() => {
            closeTab(panelKey, tab.id);
          }}
        >
          <X className="size-3" aria-hidden />
        </button>
      </Tip>
      {drop && (
        // In the 4px gap beside the tab (at the strip's start, inside the first tab's edge, which the strip would clip).
        <span
          aria-hidden
          data-testid="panel-drop-marker"
          className={cn("pointer-events-none absolute inset-y-1 w-0.5 rounded-full bg-cf-focus", drop === "first" ? "left-0" : drop === "before" ? "-left-[3px]" : "-right-[3px]")}
        />
      )}
    </div>
  );
}

/**
 * Left/Right (and Home/End) move focus between tabs; Enter or Space on a tab activates it.
 * alt+Left/Right moves the focused tab one slot (clamped at the ends); focus stays on it
 * (or on its ×), and the strip scrolls if the move took it past the edge.
 */
function onTabListKeyDown(e: KeyboardEvent<HTMLElement>, panelKey: string): void {
  const strip = e.currentTarget;
  // While a tab of the panel is lifted, the strips' keys wait for the drop (Escape cancels the drag: see liftedTab).
  if (liftedTab(strip.closest(`[data-region="panel"]`) ?? strip)) return;
  const tabs = Array.from(strip.querySelectorAll<HTMLElement>('[role="tab"]'));
  const i = tabs.findIndex((t) => t === document.activeElement || t.parentElement?.contains(document.activeElement));
  if (i < 0) return;
  const chord = chordFromEvent(e.nativeEvent);
  const to = chord === null ? null : tabMoveIndex(chord, i, tabs.length);
  if (to !== null) {
    e.preventDefault();
    e.stopPropagation();
    const wrapper = tabs[i]?.parentElement;
    const id = wrapper?.dataset.tabId;
    if (!wrapper || id === undefined || to === i) return;
    // Synchronously, so the tab is in its new place to reveal. Focus stays where it was:
    // React restores it after a commit that moved the focused node.
    flushSync(() => {
      movePanelTab(panelKey, id, to);
    });
    revealElement(strip, wrapper);
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const next = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
  if (next < 0) return;
  e.preventDefault();
  e.stopPropagation();
  tabs[next]?.focus();
}

/**
 * The "+" after the last tab (view.panel.new-tab): it scrolls with the tabs, like a
 * browser's. While picking it is highlighted like an active tab (and pressed), since the
 * body shows the surface list in place of a tab. The command acts on the focused group,
 * and a press on a group's "+" focuses that group first (its wrapper, below, and the
 * group's own pointerdown), so each group's "+" picks in its own group.
 */
function NewTabButton({ picking, focused }: { picking: boolean; focused: boolean }) {
  return (
    <CommandButton
      command="view.panel.new-tab"
      icon={Plus}
      tooltip="New tab"
      pressed={picking}
      className={cn(
        "size-7 [--wails-draggable:no-drag]",
        picking
          ? focused
            ? "bg-cf-control-hover text-cf-text hover:bg-cf-control-hover hover:text-cf-text dark:bg-cf-control-hover/50 dark:hover:bg-cf-control-hover/50"
            : "bg-cf-control-hover/40 text-cf-text hover:bg-cf-control-hover/40 hover:text-cf-text dark:bg-cf-control-hover/25 dark:hover:bg-cf-control-hover/25"
          : "text-cf-text-muted hover:bg-cf-control-hover/40 hover:text-cf-text dark:hover:bg-cf-control-hover/40",
      )}
      data-testid="panel-new-tab"
    />
  );
}

/** Where the marker for a tab from the other group goes on the tab at `i` of `count`, with that group's drop at `slot`. */
function dropMark(slot: number | null, i: number, count: number): "before" | "after" | "first" | undefined {
  if (slot === null) return undefined;
  if (slot === i) return i === 0 ? "first" : "before";
  return slot >= count && i === count - 1 ? "after" : undefined;
}

/**
 * One group's tabs, sortable by dragging (dnd-kit; the DndContext is the panel's,
 * PanelDnd, around both groups). A tab dragged along its strip reorders it (its
 * neighbours slide aside, and the strip scrolls when the pointer nears its edge); onto
 * the other group's strip it moves there, at the slot the marker shows. The "+" is not
 * sortable and stays after the last tab; dropping a tab of this strip over it puts the
 * tab last.
 */
export function TabStrip({ panelKey, group, focused, label }: { panelKey: string; group: GroupIndex; focused: boolean; label: string }) {
  const grp = usePanelGroup(panelKey, group);
  const tabs = grp?.tabs ?? emptyGroup.tabs;
  const activeTabId = grp?.activeTabId ?? null;
  const picking = usePanelPicking(panelKey, group);
  const stripRef = useRef<HTMLDivElement>(null);
  const newTabRef = useRef<HTMLSpanElement>(null);
  const ids = useMemo(() => tabs.map((t) => t.id), [tabs]);
  // A tab from the other group over this strip: the slot it would take.
  const { target } = usePanelDrop();
  const slot = target?.kind === "strip" && target.group === group ? target.index : null;
  // A new or activated tab may sit past the strip's scrolled edge (e.g. a PR row opened
  // its tenth tab): bring it into view. Picking brings the highlighted "+" into view.
  useEffect(() => {
    if (!stripRef.current) return;
    if (activeTabId !== null) revealTab(stripRef.current, activeTabId);
    else if (newTabRef.current) revealElement(stripRef.current, newTabRef.current);
  }, [activeTabId, tabs.length]);
  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      className="relative flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
      data-testid="panel-tabs"
      onKeyDown={(e) => {
        onTabListKeyDown(e, panelKey);
      }}
    >
      <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
        {tabs.map((t, i) => (
          <TabButton
            key={t.id}
            panelKey={panelKey}
            group={group}
            tab={t}
            active={t.id === activeTabId}
            focused={focused}
            focusable={t.id === activeTabId || (picking && i === 0)}
            drop={dropMark(slot, i, tabs.length)}
          />
        ))}
      </SortableContext>
      <span
        ref={newTabRef}
        className="flex shrink-0 [--wails-draggable:no-drag]"
        // The command picks in the focused group: this one, before it runs (a click
        // without a pointerdown, e.g. from assistive tech, too).
        onClickCapture={() => {
          focusPanelGroup(panelKey, group);
        }}
      >
        <NewTabButton picking={picking} focused={focused} />
      </span>
    </div>
  );
}
