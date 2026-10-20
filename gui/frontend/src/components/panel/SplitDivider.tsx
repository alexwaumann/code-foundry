import { useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { RATIO_MAX, RATIO_MIN, setPanelRatio } from "@/stores/panel";
import { clampSplitRatio, DIVIDER, dividerKeyRatio, groupMin, type SplitOrientation } from "./splitLayout";

/** The split's length on its axis (the divider excluded), read from the split container, the divider's parent. */
function splitSize(el: HTMLElement, o: SplitOrientation): { start: number; size: number } {
  const r = el.parentElement?.getBoundingClientRect();
  if (!r) return { start: 0, size: 0 };
  return o === "side" ? { start: r.left, size: r.width - DIVIDER } : { start: r.top, size: r.height - DIVIDER };
}

/**
 * The line between a split panel's two tab groups: 1px of pane border, with a wider hit
 * area (4px either side) that drags the split's ratio (setPanelRatio, clamped so each
 * group keeps its minimum: groupMin). It tints like the panel's resize handle while
 * hovered, focused or dragged. Focusable: the arrows move it 16px (Shift: 64px), Home and
 * End go to the bounds, and a double-click puts it back in the middle (the store's default).
 */
export function SplitDivider({ panelKey, orientation, ratio }: { panelKey: string; orientation: SplitOrientation; ratio: number }) {
  const drag = useRef<{ start: number; size: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const min = groupMin(orientation);
  const side = orientation === "side";
  const end = () => {
    drag.current = null;
    setDragging(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const next = dividerKeyRatio(e.key, e.shiftKey, ratio, splitSize(e.currentTarget, orientation).size, min);
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    setPanelRatio(panelKey, next);
  };
  return (
    <div
      role="separator"
      tabIndex={0}
      // A separator's orientation is its line's: side by side, the line is vertical.
      aria-orientation={side ? "vertical" : "horizontal"}
      aria-label="Resize tab groups"
      aria-valuenow={Math.round(ratio * 100)}
      // The store's bounds; the drag and keys also keep each group at its minimum size.
      aria-valuemin={Math.round(RATIO_MIN * 100)}
      aria-valuemax={Math.round(RATIO_MAX * 100)}
      data-testid="panel-split-divider"
      data-orientation={orientation}
      data-dragging={dragging || undefined}
      className={cn(
        "relative z-10 shrink-0 touch-none bg-pane-border transition-colors outline-none [--wails-draggable:no-drag] after:absolute hover:bg-ring focus-visible:bg-ring data-dragging:bg-ring",
        side ? "w-px cursor-col-resize after:inset-y-0 after:-inset-x-1" : "h-px cursor-row-resize after:inset-x-0 after:-inset-y-1",
      )}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = splitSize(e.currentTarget, orientation);
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.size <= 0) return;
        const at = (side ? e.clientX : e.clientY) - d.start;
        setPanelRatio(panelKey, clampSplitRatio(at / d.size, d.size, min));
      }}
      onPointerUp={(e) => {
        end();
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      // Capture can end without a pointerup (the element unmounts, the system takes the
      // pointer); stop dragging so a later hover does not resize.
      onLostPointerCapture={end}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        setPanelRatio(panelKey, undefined);
      }}
    />
  );
}
