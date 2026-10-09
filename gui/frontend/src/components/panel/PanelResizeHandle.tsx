import { useRef, type KeyboardEvent } from "react";
import { resetPanelWidth, setPanelWidth } from "@/stores/panel";
import { PANEL_MIN } from "@/stores/ui";

/** Arrow-key step; with Shift, four times that. */
const STEP = 16;

/**
 * Drag handle in the 8px gap left of the side panel (same pattern as the sidebar's
 * ResizeHandle, mirrored: dragging left widens the panel). It sizes one panel (`panelKey`): every
 * selection's panel has its own width. Double-click resets that panel to PANEL_DEFAULT.
 * Focusable: Left/Right resize (Left widens), Home/End go to the minimum/maximum.
 *
 * `width` is the rendered width, which is below the stored one when the room shrank
 * (window, sidebar); drags and keys start from it, so they act at once.
 */
export function PanelResizeHandle({ panelKey, width, max }: { panelKey: string; width: number; max: number }) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const set = (w: number) => {
    setPanelWidth(panelKey, w);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const step = e.shiftKey ? STEP * 4 : STEP;
    const next = e.key === "ArrowLeft" ? width + step : e.key === "ArrowRight" ? width - step : e.key === "Home" ? PANEL_MIN : e.key === "End" ? max : null;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    set(next);
  };
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize side panel"
      aria-valuenow={Math.round(width)}
      aria-valuemin={PANEL_MIN}
      aria-valuemax={Math.max(PANEL_MIN, max)}
      data-testid="panel-resize-handle"
      className="absolute top-0 -left-2 z-10 h-full w-2 cursor-col-resize touch-none [--wails-draggable:no-drag] outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-transparent after:transition-colors hover:after:bg-ring focus-visible:after:bg-ring active:after:bg-ring"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const rendered = e.currentTarget.parentElement?.getBoundingClientRect().width ?? width;
        drag.current = { x: e.clientX, w: rendered };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) set(d.w - (e.clientX - d.x));
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
        resetPanelWidth(panelKey);
      }}
    />
  );
}
