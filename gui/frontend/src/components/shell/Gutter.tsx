import { useRef } from "react";
import type { GutterRect } from "@/shell/geometry/types";
import { cn } from "@/lib/utils";
import { zoomFactor } from "@/lib/zoom";

/**
 * The gap between two kids of a split: dragging it resizes them (PaneGrid previews the sizes as
 * the pointer moves and commits them with pane.resize on release). A double click does nothing
 * yet. A `fixed` gutter (beside a rail) does not resize and draws nothing to grab.
 */
export function Gutter({
  gutter,
  onDrag,
  onEnd,
  onStart,
}: {
  gutter: GutterRect;
  /** Starts a drag; false when the gutter cannot move. */
  onStart: () => boolean;
  /** The pointer moved this far (layout px, right or down positive) since the drag started. */
  onDrag: (delta: number) => void;
  onEnd: (moved: boolean) => void;
}) {
  const start = useRef<{ at: number; id: number; moved: boolean } | null>(null);
  if (gutter.fixed) return null;
  const pos = (e: React.PointerEvent) => (gutter.row ? e.clientX : e.clientY);
  return (
    <div
      role="separator"
      aria-orientation={gutter.row ? "vertical" : "horizontal"}
      aria-label="Resize panes"
      data-testid="shell-gutter"
      data-split={gutter.split}
      data-index={gutter.i}
      className={cn(
        "group absolute z-10 flex touch-none items-center justify-center [--wails-draggable:no-drag]",
        gutter.row ? "cursor-col-resize" : "cursor-row-resize",
      )}
      style={{ left: gutter.x, top: gutter.y, width: gutter.w, height: gutter.h }}
      onPointerDown={(e) => {
        if (e.button !== 0 || !onStart()) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { at: pos(e), id: e.pointerId, moved: false };
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s || s.id !== e.pointerId) return;
        const delta = (pos(e) - s.at) / zoomFactor();
        if (delta !== 0) s.moved = true;
        onDrag(delta);
      }}
      onPointerUp={(e) => {
        const s = start.current;
        if (!s || s.id !== e.pointerId) return;
        start.current = null;
        onEnd(s.moved);
      }}
      onPointerCancel={() => {
        if (start.current) onEnd(false);
        start.current = null;
      }}
    >
      {/* A short handle shows on hover and while dragging. */}
      <span aria-hidden className={cn("rounded-full bg-cf-divider opacity-0 transition-opacity group-hover:opacity-100 group-active:opacity-100", gutter.row ? "h-8 w-1" : "h-1 w-8")} />
    </div>
  );
}
