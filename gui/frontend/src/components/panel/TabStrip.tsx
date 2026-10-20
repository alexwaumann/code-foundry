import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { closestCenter, DndContext, defaultDropAnimation, PointerSensor, useSensor, useSensors, type Announcements, type DragCancelEvent, type DragEndEvent, type DragStartEvent, type ScreenReaderInstructions, type UniqueIdentifier } from "@dnd-kit/core";
import { restrictToHorizontalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
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
import { revealElement, revealTab, tabNode } from "./reveal";

/** The active tab (and the "+" while picking): full tint in the focused group, lighter in the other one. */
const ACTIVE_FOCUSED = "bg-accent text-accent-foreground dark:bg-accent/50";
const ACTIVE_UNFOCUSED = "bg-accent/40 text-foreground dark:bg-accent/25";

/**
 * One tab, sortable: a pointer drag (past 4px, so clicks, the × and middle click work as
 * before) slides it along the strip, and its neighbours make room. `focusable` is the
 * roving tabindex: the active tab, or the first one while picking (no tab is active
 * then), so Tab still reaches the strip. dnd-kit's `attributes` (role="button",
 * tabIndex 0) are not spread on the wrapper, which stays presentation: only its
 * description (how to move a tab with the keyboard) goes on the tab. `focused` is
 * whether its group has focus (always on an unsplit panel): the active tab of the other
 * group is tinted lighter.
 */
function TabButton({ panelKey, group, tab, active, focused, focusable }: { panelKey: string; group: GroupIndex; tab: Tab; active: boolean; focused: boolean; focusable: boolean }) {
  const Icon = surfaceOf(tab.kind)?.icon;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
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
        isDragging ? "z-10 bg-accent text-accent-foreground shadow-md ring-1 ring-border" : active ? (focused ? ACTIVE_FOCUSED : ACTIVE_UNFOCUSED) : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
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
        className="flex h-full min-w-0 cursor-default items-center gap-1.5 rounded-md pr-1 pl-2 outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
            "flex size-4 shrink-0 items-center justify-center rounded-sm outline-none hover:bg-foreground/10 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring",
            active || isDragging ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
          onClick={() => {
            closeTab(panelKey, tab.id);
          }}
        >
          <X className="size-3" aria-hidden />
        </button>
      </Tip>
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
  // While a tab is lifted, the strip's keys wait for the drop (Escape cancels the drag: see liftedTab).
  if (liftedTab(strip)) return;
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
            ? "bg-accent text-accent-foreground hover:bg-accent hover:text-accent-foreground dark:bg-accent/50 dark:hover:bg-accent/50"
            : "bg-accent/40 text-foreground hover:bg-accent/40 hover:text-foreground dark:bg-accent/25 dark:hover:bg-accent/25"
          : "text-muted-foreground hover:bg-accent/40 hover:text-foreground dark:hover:bg-accent/40",
      )}
      data-testid="panel-new-tab"
    />
  );
}

/** dnd-kit's announcements, in tab titles and 1-based positions instead of ids. */
function tabAnnouncements(tabs: readonly Tab[]): Announcements {
  const title = (id: UniqueIdentifier) => tabs.find((t) => t.id === id)?.title ?? "tab";
  const at = (id: UniqueIdentifier) => `position ${String(tabs.findIndex((t) => t.id === id) + 1)} of ${String(tabs.length)}`;
  return {
    onDragStart: ({ active }) => `Picked up tab ${title(active.id)}.`,
    onDragOver: ({ active, over }) => (over ? `Tab ${title(active.id)} is over ${at(over.id)}.` : `Tab ${title(active.id)} is no longer over the tabs.`),
    onDragEnd: ({ active, over }) => (over ? `Tab ${title(active.id)} was dropped at ${at(over.id)}.` : `Tab ${title(active.id)} was dropped.`),
    onDragCancel: ({ active }) => `Moving tab ${title(active.id)} was cancelled.`,
  };
}

/**
 * Scrolling the strip while a tab is dragged near its edge: only sideways, and slower
 * than dnd-kit's default (10), which crossed a dozen tabs in half a second and made the
 * dragged tab lag the scroll visibly.
 */
const autoScroll = { acceleration: 4, threshold: { x: 0.2, y: 0 } };

/** What a tab's aria-describedby reads: the keyboard way to move it (dnd-kit's own keyboard sensor is not used). */
const screenReaderInstructions: ScreenReaderInstructions = { draggable: "To move this tab, press Option with Left Arrow or Right Arrow." };

/**
 * One group's tabs, sortable by dragging (dnd-kit, in place: the dragged tab follows the
 * pointer along the strip, its neighbours slide aside, and the strip scrolls when the
 * pointer nears its edge). The "+" is not sortable and stays after the last tab; dropping
 * a tab over it puts the tab last. Each group's strip has its own DndContext, so a tab
 * stays in its group (dragging between groups is a later change).
 */
export function TabStrip({ panelKey, group, focused, label }: { panelKey: string; group: GroupIndex; focused: boolean; label: string }) {
  const grp = usePanelGroup(panelKey, group);
  const tabs = grp?.tabs ?? emptyGroup.tabs;
  const activeTabId = grp?.activeTabId ?? null;
  const picking = usePanelPicking(panelKey, group);
  const stripRef = useRef<HTMLDivElement>(null);
  const newTabRef = useRef<HTMLSpanElement>(null);
  const ids = useMemo(() => tabs.map((t) => t.id), [tabs]);
  const announcements = useMemo(() => tabAnnouncements(tabs), [tabs]);
  // A drag starts after 4px of travel, so a click (and the ×, and middle click) is still a click.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  // A new or activated tab may sit past the strip's scrolled edge (e.g. a PR row opened
  // its tenth tab): bring it into view. Picking brings the highlighted "+" into view.
  useEffect(() => {
    if (!stripRef.current) return;
    if (activeTabId !== null) revealTab(stripRef.current, activeTabId);
    else if (newTabRef.current) revealElement(stripRef.current, newTabRef.current);
  }, [activeTabId, tabs.length]);
  // The drop: dnd-kit's drop animation belongs to a DragOverlay, and in place the dragged
  // tab would jump from under the pointer to its slot. So the drop records where it is
  // on screen and, once it sits in its slot, slides it the rest of the way (FLIP) with
  // dnd-kit's default drop animation timing. A tab picked up again while it settles drops
  // the animation, which would otherwise override dnd-kit's transform (the lifted tab
  // would not follow the pointer until it ended).
  const settle = useRef<{ id: string; left: number } | null>(null);
  const settling = useRef(new Map<string, Animation>());
  const [settleSeq, setSettleSeq] = useState(0);
  const drop = (id: string) => {
    const el = stripRef.current && tabNode(stripRef.current, id);
    if (!el) return;
    settle.current = { id, left: el.getBoundingClientRect().left };
    setSettleSeq((n) => n + 1);
  };
  useLayoutEffect(() => {
    const s = settle.current;
    settle.current = null;
    const el = s && stripRef.current && tabNode(stripRef.current, s.id);
    if (!s || !el || typeof el.animate !== "function") return;
    const dx = s.left - el.getBoundingClientRect().left;
    if (Math.abs(dx) < 1) return;
    const anim = el.animate([{ transform: `translate3d(${String(dx)}px, 0, 0)`, zIndex: 10 }, { transform: "translate3d(0, 0, 0)", zIndex: 10 }], {
      duration: defaultDropAnimation.duration,
      easing: defaultDropAnimation.easing,
    });
    const running = settling.current;
    running.set(s.id, anim);
    anim.onfinish = () => {
      if (running.get(s.id) === anim) running.delete(s.id);
    };
  }, [settleSeq]);
  const onDragStart = ({ active }: DragStartEvent) => {
    const id = String(active.id);
    settling.current.get(id)?.cancel();
    settling.current.delete(id);
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    // dnd-kit's sensor outlives the strip: a release after the panel unmounted (the
    // selection switched mid-drag) still ends the drag here. Its panel is gone, so it
    // moves nothing.
    if (!stripRef.current) return;
    const id = String(active.id);
    drop(id);
    if (!over || active.id === over.id) return;
    // arrayMove semantics: the dragged tab takes the index of the tab it was dropped on.
    const to = ids.indexOf(String(over.id));
    if (to >= 0) movePanelTab(panelKey, id, to);
  };
  const onDragCancel = ({ active }: DragCancelEvent) => {
    drop(String(active.id));
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToHorizontalAxis, restrictToParentElement]}
      accessibility={{ announcements, screenReaderInstructions }}
      autoScroll={autoScroll}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
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
            <TabButton key={t.id} panelKey={panelKey} group={group} tab={t} active={t.id === activeTabId} focused={focused} focusable={t.id === activeTabId || (picking && i === 0)} />
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
    </DndContext>
  );
}
