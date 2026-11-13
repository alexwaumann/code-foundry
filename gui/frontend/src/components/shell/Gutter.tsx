import { useRef } from "react";
import type { GutterRect } from "@/shell/geometry/types";
import { cn } from "@/lib/utils";
import { zoomFactor } from "@/lib/zoom";
import { gutterKeyDelta } from "@/shell/resize";

/**
 * The gap between two kids of a split: dragging it resizes them (PaneGrid previews the sizes as
 * the pointer moves and commits them with pane.resize on release). It takes the keyboard, as the
 * side panel's edge and divider did: the arrows move it (shell/resize.ts gutterKeyDelta), and a
 * double click shares the two kids evenly. A `fixed` gutter (beside a rail) does not resize and
 * draws nothing to grab.
 */
export function Gutter({
  gutter,
  onDrag,
  onEnd,
  onStart,
  onStep,
  onReset,
}: {
  gutter: GutterRect;
  /** Starts a drag; false when the gutter cannot move. */
  onStart: () => boolean;
  /** The pointer moved this far (layout px, right or down positive) since the drag started. */
  onDrag: (delta: number) => void;
  onEnd: (moved: boolean) => void;
  /** A key moved it this far (layout px, right or down positive; ±Infinity: to a bound). */
  onStep: (delta: number) => void;
  /** A double click: the two kids beside it even. */
  onReset: () => void;
}) {
  const start = useRef<{ at: number; id: number; moved: boolean } | null>(null);
  if (gutter.fixed) return null;
  const pos = (e: React.PointerEvent) => (gutter.row ? e.clientX : e.clientY);
  return (
    <div
      role="separator"
      aria-orientation={gutter.row ? "vertical" : "horizontal"}
      aria-label="Resize panes"
      tabIndex={0}
      data-testid="shell-gutter"
      data-split={gutter.split}
      data-index={gutter.i}
      className={cn(
        "group absolute z-10 flex touch-none items-center justify-center outline-none [--wails-draggable:no-drag]",
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
      onKeyDown={(e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const delta = gutterKeyDelta(e.key, e.shiftKey);
        if (delta === null) return;
        e.preventDefault();
        e.stopPropagation();
        onStep(delta);
      }}
      onDoubleClick={onReset}
    >
      {/* A short handle shows on hover, while dragging and with the keyboard. */}
      <span
        aria-hidden
        className={cn(
          "rounded-full bg-cf-divider opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:bg-cf-focus group-focus-visible:opacity-100 group-active:opacity-100",
          gutter.row ? "h-8 w-1" : "h-1 w-8",
        )}
      />
    </div>
  );
}
