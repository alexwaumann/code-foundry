import { useRef } from "react";
import { SIDEBAR_DEFAULT, useUiStore } from "@/stores/ui";

/**
 * Drag handle filling the shell gap right of the sidebar, its hairline in the middle (as
 * the side and bottom panels' handles fill theirs), so it covers nothing in the sidebar:
 * the status row's last button reaches the sidebar's edge (SidebarStatus). Double-click
 * resets the width.
 */
export function ResizeHandle() {
  const drag = useRef<{ x: number; w: number } | null>(null);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      className="absolute top-0 -right-shell z-10 h-full w-shell cursor-col-resize touch-none [--wails-draggable:no-drag] after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-transparent after:transition-colors hover:after:bg-ring active:after:bg-ring"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, w: useUiStore.getState().sidebarWidth };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) useUiStore.getState().setSidebarWidth(d.w + e.clientX - d.x);
      }}
      onPointerUp={(e) => {
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onDoubleClick={() => {
        useUiStore.getState().setSidebarWidth(SIDEBAR_DEFAULT);
      }}
    />
  );
}
