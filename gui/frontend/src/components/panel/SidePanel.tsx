import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { chordFromEvent } from "@/keys/chord";
import { cn } from "@/lib/utils";
import {
  activeTab,
  focusPanelGroup,
  getPanel,
  isPicking,
  openSurface,
  stopPanelPicking,
  useCurrentPanelKey,
  usePanelExpanded,
  usePanelFocusedGroup,
  usePanelPicking,
  usePanelRatio,
  usePanelSplit,
  usePanelStore,
  usePanelWidth,
  type GroupIndex,
} from "@/stores/panel";
import { PANEL_MIN, expandedPanelWidth, panelMax, useUiStore, visibleSidebarWidth } from "@/stores/ui";
import { selectPageOpen, useViewsStore } from "@/stores/views";
import { surfaceOf, surfaces } from "@/surfaces/registry";
import { closeTab, hidePanel, liftedTab } from "./actions";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { FOCUS_OTHER_GROUP_CHORD, isPanelChord, panelKeyAction } from "./keys";
import { PanelDnd } from "./PanelDnd";
import { groupMin, splitOrientation, type SplitOrientation } from "./splitLayout";
import { SplitDivider } from "./SplitDivider";
import { keepPanelFocus, surfaceContext } from "./surfaceList";
import { TabGroup } from "./TabGroup";

function isEditable(el: EventTarget): boolean {
  return el instanceof HTMLElement && (el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement);
}

/** The focused group's active tab's surface handles a chord (SurfaceSpec.onKey); true if it did. */
function surfaceKey(panelKey: string, chord: string): boolean {
  const tab = activeTab(getPanel(panelKey));
  return tab ? (surfaceOf(tab.kind)?.onKey?.(chord, tab) ?? false) : false;
}

/**
 * Moves the keyboard into a split panel's other group (cmd+alt+\): the group element
 * takes focus, and its focus handler makes it the focused group.
 */
function focusGroup(aside: HTMLElement, panelKey: string, group: GroupIndex): void {
  const el = aside.querySelector<HTMLElement>(`[data-panel-group="${String(group)}"]`);
  if (el) el.focus({ preventScroll: true });
  else focusPanelGroup(panelKey, group);
}

/**
 * A group's size along the split: its share of the axis (the ratio for the first group,
 * the rest for the second) as a flex grow from a zero basis, and never under the
 * orientation's minimum (groupMin) on that axis.
 */
function groupStyle(o: SplitOrientation, share: number): CSSProperties {
  const min = groupMin(o);
  return { flex: `${String(share)} 1 0px`, ...(o === "side" ? { minWidth: min } : { minHeight: min }) };
}

function Panel({ panelKey, max, expanded, asideRef }: { panelKey: string; max: number; expanded: boolean; asideRef: RefObject<HTMLElement | null> }) {
  // This panel's own width, bounded by the room there is now (the stored one comes back
  // when the room does). Expanded, it takes the whole row instead and keeps the width
  // for when the split comes back.
  const width = Math.min(usePanelWidth(panelKey), max);
  // Expanded, the width it renders at is derived from the window and sidebar (the row
  // less the wrapper's margins), never measured, like the width above.
  const fullWidth = useUiStore((s) => expandedPanelWidth(s.windowWidth, visibleSidebarWidth(s)));
  const split = usePanelSplit(panelKey);
  const ratio = usePanelRatio(panelKey);
  const focused = usePanelFocusedGroup(panelKey);
  // The aside's data-picking is the focused group's (each group carries its own too).
  const picking = usePanelPicking(panelKey);
  // A split panel's orientation follows its rendered width (never stored), expanded or
  // not. While the panel's resize handle is dragged it holds still (the groups would jump
  // between rows and columns under the pointer) and catches up on release; a window
  // resize applies at once.
  const live = splitOrientation(expanded ? fullWidth : width);
  const [held, setHeld] = useState<SplitOrientation | null>(null);
  const orientation = held ?? live;
  // While a tab is dragged the aside carries data-dragging, and its iframes ignore the
  // pointer (index.css): over a frame the pointer's events go to the frame's document,
  // which dnd-kit's sensor (on the app's) never hears, and the drag would freeze there.
  const [dragging, setDragging] = useState(false);

  // Surfaces keep what their availability reads loaded while this panel shows.
  useEffect(() => {
    const ctx = surfaceContext(panelKey);
    const releases = surfaces.map((s) => s.warm?.(ctx));
    return () => {
      for (const release of releases) release?.();
    };
  }, [panelKey]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const chord = chordFromEvent(e.nativeEvent);
    if (!chord) return;
    if (chord === "escape" && liftedTab(e.currentTarget)) return;
    // cmd+w and cmd+alt+\ apply in text fields too (they are no editing chords); letters do not.
    if (chord !== "cmd+w" && chord !== FOCUS_OTHER_GROUP_CHORD && isEditable(e.target)) return;
    // The panel's own keys (cmd+w, cmd+alt+\, the surface letters, Escape while picking)
    // are never offered to a surface.
    if (!isPanelChord(chord, isPicking(getPanel(panelKey))) && surfaceKey(panelKey, chord)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const action = panelKeyAction(chord, getPanel(panelKey), surfaceContext(panelKey));
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.target instanceof Element && (action.kind === "stopPicking" || action.kind === "open")) keepPanelFocus(e.target);
    if (action.kind === "close") closeTab(panelKey, action.tabId);
    else if (action.kind === "hide") hidePanel(panelKey);
    else if (action.kind === "stopPicking") stopPanelPicking(panelKey);
    else if (action.kind === "focusGroup") focusGroup(e.currentTarget, panelKey, action.group);
    else openSurface(panelKey, action.tab, { group: action.group });
  };

  // The panel's expand and toggle buttons stay in its top-right corner: the first
  // group's header when unsplit or stacked, the second's side by side.
  const side = split && orientation === "side";
  return (
    // The wrapper is not clipped so the resize handle can sit in the gap to its left.
    // Expanded, the content pane is hidden: the wrapper fills the row with the content
    // pane's own shell-gap margins, and there is nothing to resize against.
    <div
      className={cn("relative flex", expanded ? "m-shell min-w-0 flex-1" : "mt-shell mr-shell mb-shell shrink-0")}
      style={expanded ? undefined : { width }}
      data-testid="side-panel-wrapper"
      data-expanded={expanded || undefined}
    >
      {!expanded && (
        <PanelResizeHandle
          panelKey={panelKey}
          width={width}
          max={max}
          onDragChange={(dragging) => {
            setHeld(dragging ? live : null);
          }}
        />
      )}
      <aside
        ref={asideRef}
        tabIndex={-1}
        aria-label="Side panel"
        data-region="panel"
        data-testid="side-panel"
        data-panel-key={panelKey}
        data-picking={picking || undefined}
        data-dragging={dragging || undefined}
        className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-pane border border-cf-divider bg-cf-surface shadow-xs outline-none"
        onKeyDown={onKeyDown}
      >
        {/* One element split or not, so the first group stays mounted (its surface keeps its state) across a split and an unsplit. */}
        <div
          className={cn("flex min-h-0 min-w-0 flex-1", side ? "flex-row" : "flex-col")}
          data-testid="panel-split"
          data-split={split || undefined}
          data-orientation={split ? orientation : undefined}
        >
          {/* One drag context around both groups: a tab can move between them, or split the panel (PanelDnd). */}
          <PanelDnd panelKey={panelKey} orientation={orientation} panel={asideRef} onDragChange={setDragging}>
            <TabGroup panelKey={panelKey} group={0} split={split} focused={focused === 0} controls={!side} style={split ? groupStyle(orientation, ratio) : undefined} />
            {split && (
              <>
                <SplitDivider panelKey={panelKey} orientation={orientation} ratio={ratio} />
                <TabGroup panelKey={panelKey} group={1} split focused={focused === 1} controls={side} style={groupStyle(orientation, 1 - ratio)} />
              </>
            )}
          </PanelDnd>
        </div>
      </aside>
    </div>
  );
}

/**
 * The current selection's side panel, right of the content pane. Unmounted (with its
 * resize handle) when the selection has none open, while the settings or usage page is up, and
 * while the window has no room for it beside the content pane (panelMax < PANEL_MIN; it
 * stays open and comes back when there is room). An expanded panel always shows: it
 * replaces the content pane (App.tsx hides it) instead of sharing the row. A split panel
 * shows its two tab groups (TabGroup) side by side or stacked (splitLayout.ts).
 *
 * Focus requests (ui panelFocusSeq) are handled here, not in the panel: this component
 * stays mounted, so a request with no panel showing is dropped instead of being acted on
 * by the next panel that mounts (e.g. after a selection switch). The request comes after
 * the panel is shown (stores/panel.ts update), so its aside is mounted by then.
 */
export function SidePanel() {
  const panelKey = useCurrentPanelKey();
  const open = usePanelStore((s) => (panelKey === null ? false : (s.byKey[panelKey]?.open ?? false)));
  const expanded = usePanelExpanded();
  const pageOpen = useViewsStore(selectPageOpen);
  const max = useUiStore((s) => panelMax(s.windowWidth, visibleSidebarWidth(s)));
  const focusSeq = useUiStore((s) => s.panelFocusSeq);
  const asideRef = useRef<HTMLElement>(null);
  const handled = useRef(focusSeq);

  useEffect(() => {
    if (focusSeq === handled.current) return;
    handled.current = focusSeq;
    asideRef.current?.focus({ preventScroll: true });
  }, [focusSeq]);

  if (panelKey === null || !open || pageOpen || (max < PANEL_MIN && !expanded)) return null;
  return <Panel key={panelKey} panelKey={panelKey} max={max} expanded={expanded} asideRef={asideRef} />;
}
