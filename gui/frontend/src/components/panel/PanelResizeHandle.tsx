import { useRef } from "react";
import { PANEL_DEFAULT, useUiStore } from "@/stores/ui";

/**
 * Drag handle in the 8px gap left of the side panel (same pattern as the sidebar's
 * ResizeHandle, mirrored: dragging left widens the panel). Double-click resets the width.
 */
export function PanelResizeHandle() {
  const drag = useRef<{ x: number; w: number } | null>(null);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize side panel"
      data-testid="panel-resize-handle"
      className="absolute top-0 -left-2 z-10 h-full w-2 cursor-col-resize touch-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-transparent after:transition-colors hover:after:bg-ring active:after:bg-ring"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, w: useUiStore.getState().panelWidth };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) useUiStore.getState().setPanelWidth(d.w - (e.clientX - d.x));
      }}
      onPointerUp={(e) => {
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onDoubleClick={() => {
        useUiStore.getState().setPanelWidth(PANEL_DEFAULT);
      }}
    />
  );
}
