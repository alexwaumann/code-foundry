import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Kbd } from "@/components/ui/kbd";
import { useThreadActivity } from "@/components/thread/activity";
import { ThreadContext } from "@/components/thread/context";
import { ThreadComposer } from "@/components/thread/ThreadComposer";
import "@/components/thread/thread.css";
import { cn } from "@/lib/utils";
import { zoomFactor } from "@/lib/zoom";
import { clampFloat } from "@/shell/fullscreen";
import { useThreadName } from "@/shell/useThreadName";
import { useDraft } from "@/stores/compose";
import { requestPaneFocus, setFloating, useShellViewStore } from "@/stores/shellView";
import { startThreadWatch } from "@/stores/thread";
import { threadDraftKey } from "@/stores/threadActions";
import { useThreadsStore } from "@/stores/threads";
import { ThreadDot } from "./ThreadDot";

/** The chord that expands the floating composer and puts the keyboard in it (free in the keymap). */
export const FLOATING_CHORD = "⌘L";

/** Moves the keyboard into the composer's prompt once it is on screen. */
function focusPrompt(root: HTMLElement | null): void {
  requestAnimationFrame(() => {
    root?.querySelector<HTMLElement>('[data-testid="composer-input"]')?.focus();
  });
}

/** How far a press moves before it is a drag of the composer rather than a click on its chip, in screen px. */
const DRAG_SLOP = 3;

/**
 * The thread's chip: one button, collapsed (the pill: "Message", the thread, ⌘L) or expanded
 * ("to" and the thread, centred above the composer). A click toggles; a press that moves drags
 * the composer instead, in either state, and does not toggle.
 */
function FloatingChip({
  threadId,
  expanded,
  onToggle,
  onPress,
}: {
  threadId: string;
  expanded: boolean;
  onToggle: () => void;
  onPress: (e: ReactPointerEvent<HTMLElement>) => void;
}) {
  const name = useThreadName(threadId);
  return (
    <button
      type="button"
      aria-expanded={expanded}
      className={cn(
        "flex max-w-full min-w-0 cursor-default touch-none items-center gap-1.5 rounded-full border border-cf-border bg-cf-surface-raised text-body-sm outline-none select-none hover:bg-cf-control-hover focus-visible:ring-1 focus-visible:ring-cf-focus",
        expanded ? "h-7 px-3 shadow-xs" : "h-8 px-3.5 shadow-sm",
      )}
      data-testid={expanded ? "floating-composer-chip" : "floating-composer-pill"}
      onPointerDown={onPress}
      onClick={onToggle}
    >
      <span className="shrink-0 text-cf-text-muted">{expanded ? "to" : "Message"}</span>
      <ThreadDot threadId={threadId} />
      <span className="min-w-0 truncate font-medium text-cf-text">{name}</span>
      {!expanded && (
        <Kbd size="sm" className="ml-1">
          {FLOATING_CHORD}
        </Kbd>
      )}
    </button>
  );
}

/**
 * The expanded card's composer, under the chip: the thread's own (components/thread/
 * ThreadComposer: its draft, attachments, model controls, send or steer, docked asks). While
 * expanded it holds the thread's WatchThread (shared with any other view of the thread), which
 * the docked permissions and questions need; the pill holds nothing.
 */
function FloatingCard({ threadId }: { threadId: string }) {
  useEffect(() => startThreadWatch(threadId), [threadId]);
  const cwd = useThreadsStore((s) => s.byId[threadId]?.worktreePath ?? "");
  const ctx = useMemo(() => ({ threadId, cwd }), [threadId, cwd]);
  const { open, busy } = useThreadActivity(threadId);
  return (
    <ThreadContext.Provider value={ctx}>
      {/* Opaque and lifted: it floats over a busy surface (a diff), not the thread's own gradient. */}
      <div className="cf-thread w-full [&_.ccard]:bg-cf-surface-raised! [&_.ccard]:shadow-lg!">
        <ThreadComposer threadId={threadId} pending={open} busy={busy} focusRequests={false} />
      </div>
    </ThreadContext.Provider>
  );
}

/**
 * The thread's composer floating over a full-screened linked surface (docs/notes/shell-model.md,
 * "Full screen"): a pill naming the thread at the bottom centre; a click or ⌘L expands it into the
 * thread's real composer with the thread's chip centred above it. The pill and the chip are one
 * button (FloatingChip): a click toggles, a press that moves drags, in either state. The draft is
 * the thread's own (`thread:<id>` in the compose store), so it is the same text in the thread's
 * pane. A send that goes through collapses it back to the pill; Escape collapses it too. It always opens at the same spot: a drag lasts until full screen ends
 * (stores/shellView `floating`). See docs/notes/shell-19-rails-fullscreen.md.
 */
export function FloatingComposer({ threadId, paneId }: { threadId: string; paneId: string }) {
  const { expanded, x, y } = useShellViewStore((s) => s.floating);
  const ref = useRef<HTMLDivElement>(null);
  // A press that turned into a drag: its click does not toggle.
  const dragged = useRef(false);
  const [dragging, setDragging] = useState(false);
  const draftKey = threadDraftKey(threadId);
  const phase = useDraft(draftKey, "phase");
  const text = useDraft(draftKey, "text");
  const error = useDraft(draftKey, "error");

  const expand = () => {
    setFloating({ expanded: true });
    focusPrompt(ref.current);
  };
  const collapse = () => {
    setFloating({ expanded: false });
    requestPaneFocus(paneId);
  };

  // A send that went through (the draft back to idle, emptied, no error) collapses to the pill.
  const wasSending = useRef(false);
  useEffect(() => {
    if (phase !== "idle") {
      wasSending.current = true;
      return;
    }
    if (!wasSending.current) return;
    wasSending.current = false;
    if (text.trim() === "" && !error) setFloating({ expanded: false });
  }, [phase, text, error]);

  // ⌘L: expand, or put the keyboard back in the prompt. Ahead of a focused terminal (capture).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.key.toLowerCase() !== "l" || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      setFloating({ expanded: true });
      focusPrompt(ref.current);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, []);

  // A press on the chip that moves drags the card, collapsed or expanded; the pane is its bounds.
  const press = (e: ReactPointerEvent<HTMLElement>) => {
    const card = ref.current;
    const pane = card?.offsetParent;
    dragged.current = false;
    if (e.button !== 0 || !card || !(pane instanceof HTMLElement)) return;
    // The keyboard stays where it is (the prompt, expanded); the click still comes.
    e.preventDefault();
    const z = zoomFactor();
    const from = { px: e.clientX, py: e.clientY, x, y };
    const box = card.getBoundingClientRect();
    const area = pane.getBoundingClientRect();
    // Where the card would be with no drag, in the pane's layout px.
    const spot = { x: (box.left - area.left) / z - x, y: (box.top - area.top) / z - y, w: box.width / z, h: box.height / z };
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (!dragged.current && Math.hypot(ev.clientX - from.px, ev.clientY - from.py) < DRAG_SLOP) return;
      if (!dragged.current) {
        dragged.current = true;
        setDragging(true);
      }
      setFloating(clampFloat({ x: from.x + (ev.clientX - from.px) / z, y: from.y + (ev.clientY - from.py) / z }, spot, { w: area.width / z, h: area.height / z }));
    };
    const end = () => {
      setDragging(false);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  const toggle = () => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    if (expanded) collapse();
    else expand();
  };

  return (
    <div
      ref={ref}
      className={cn("absolute bottom-4 left-1/2 z-20 flex justify-center", expanded ? "w-[min(720px,calc(100%-24px))]" : "max-w-[calc(100%-24px)]")}
      // At the bottom centre, moved by the drag. Expanded it is the thread pane's composer width, narrower in a narrow pane.
      style={{ transform: `translate(calc(-50% + ${String(x)}px), ${String(y)}px)` }}
      data-testid="floating-composer"
      data-expanded={expanded || undefined}
      data-dragging={dragging || undefined}
      data-thread-id={threadId}
      onKeyDownCapture={(e) => {
        // Escape collapses to the pill (and full screen stays). Taken ahead of the prompt, whose
        // editor marks every Escape handled; left to it while its completion or history card is
        // open (the editor names the card: aria-controls). A picker's menu is portaled out of
        // this element, so its Escape is its own.
        if (e.key !== "Escape" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.nativeEvent.isComposing) return;
        const t = e.target instanceof Element ? e.target : null;
        if (!t || !ref.current?.contains(t) || t.closest("[aria-controls]")) return;
        e.preventDefault();
        e.stopPropagation();
        collapse();
      }}
    >
      <div className="flex w-full min-w-0 flex-col items-center gap-1.5">
        <FloatingChip threadId={threadId} expanded={expanded} onToggle={toggle} onPress={press} />
        {expanded && <FloatingCard threadId={threadId} />}
      </div>
    </div>
  );
}
