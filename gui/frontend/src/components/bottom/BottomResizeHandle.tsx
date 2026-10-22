import { useRef, type KeyboardEvent } from "react";
import { zoomFactor } from "@/lib/zoom";
import { resetBottomHeight, setBottomHeight } from "@/stores/bottomPanel";
import { BOTTOM_MIN, clamp } from "@/stores/ui";

/** Arrow-key step; with Shift, four times that. */
const STEP = 16;

/**
 * Drag handle filling the shell gap above the bottom panel (PanelResizeHandle turned on its
 * side: dragging up makes the panel taller). It sizes one panel (`panelKey`). Double-click
 * resets it to BOTTOM_DEFAULT. Focusable: Up/Down resize (Up grows), Home/End go to the
 * minimum/maximum.
 *
 * `height` is the rendered height, below the stored one when the column shrank; drags
 * and keys start from it, so they act at once. `max` is bottomMax for the column now.
 * Pointer distances are in viewport px and heights in layout px: the page zoom divides.
 */
export function BottomResizeHandle({ panelKey, height, max }: { panelKey: string; height: number; max: number }) {
  const drag = useRef<{ y: number; h: number } | null>(null);
  const set = (h: number) => {
    setBottomHeight(panelKey, clamp(Math.round(h), BOTTOM_MIN, max));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const step = e.shiftKey ? STEP * 4 : STEP;
    const next = e.key === "ArrowUp" ? height + step : e.key === "ArrowDown" ? height - step : e.key === "Home" ? BOTTOM_MIN : e.key === "End" ? max : null;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    set(next);
  };
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label="Resize bottom panel"
      aria-valuenow={Math.round(height)}
      aria-valuemin={BOTTOM_MIN}
      aria-valuemax={max}
      data-testid="bottom-resize-handle"
      className="absolute inset-x-0 -top-shell z-10 h-shell cursor-row-resize touch-none [--wails-draggable:no-drag] outline-none after:absolute after:inset-x-0 after:top-1/2 after:h-px after:bg-transparent after:transition-colors hover:after:bg-cf-focus focus-visible:after:bg-cf-focus active:after:bg-cf-focus"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const rendered = e.currentTarget.parentElement?.getBoundingClientRect().height;
        drag.current = { y: e.clientY, h: rendered === undefined ? height : rendered / zoomFactor() };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) set(d.h - (e.clientY - d.y) / zoomFactor());
      }}
      onPointerUp={(e) => {
        drag.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      // Capture can end without a pointerup (the element unmounts, the system takes the
      // pointer); stop dragging so a later hover does not resize.
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        resetBottomHeight(panelKey);
      }}
    />
  );
}
