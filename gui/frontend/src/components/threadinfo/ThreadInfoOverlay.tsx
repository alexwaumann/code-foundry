import { useEffect, useRef } from "react";
import { hideThreadInfoOverlay, useCardRoom } from "@/stores/threadInfoOverlay";
import { ThreadInfoContent } from "./ThreadInfoCard";

/** The header's toggle (ThreadInfoToggle), which focus returns to and whose press is not "outside". */
const TOGGLE = '[data-command-button="view.thread-info"]';
/** Where Escape belongs to something else: a text field, or a menu, list or dialog that has focus. */
const OWNS_ESCAPE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [role="menu"], [role="listbox"], [role="dialog"]';

/**
 * The thread info card while the pane has no room for its column
 * (docs/notes/thread-info-overlay.md): the same content in a floating box at the top right
 * of the thread body, over the conversation (which does not reflow), as wide as the inline
 * card and inset by the same gap, scrolling inside. A non-modal region: Escape (outside a
 * field or menu), a press outside it, another thread or room again hide it.
 */
export function ThreadInfoOverlay({ threadId }: { threadId: string }) {
  const shown = useCardRoom((s) => s.overlayFor === threadId);
  return shown ? <Overlay threadId={threadId} /> : null;
}

function Overlay({ threadId }: { threadId: string }) {
  const ref = useRef<HTMLElement>(null);
  // A press inside, menus and hover cards the card portals out included (React events follow the tree).
  const inside = useRef(false);
  useEffect(() => {
    if (useCardRoom.getState().focusOverlay) {
      useCardRoom.setState({ focusOverlay: false });
      ref.current?.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      if (e.target instanceof Element && e.target.closest(OWNS_ESCAPE)) return;
      e.preventDefault();
      hideThreadInfoOverlay();
      document.querySelector<HTMLElement>(TOGGLE)?.focus();
    };
    const onDown = (e: PointerEvent) => {
      const hit = inside.current;
      inside.current = false;
      if (hit || (e.target instanceof Element && e.target.closest(TOGGLE))) return;
      // A modal menu is up (Radix sets this): the press closes it, not the overlay.
      if (document.body.style.pointerEvents === "none") return;
      hideThreadInfoOverlay();
    };
    // Capture, ahead of a menu's own Escape (which would close it before this sees it open).
    document.addEventListener("keydown", onKey, true);
    // Bubble, after React has dispatched the press (onPointerDownCapture below).
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown);
    };
  }, []);
  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-label="Thread info"
      className="absolute top-3 right-3 z-30 flex max-h-[calc(100%-1.5rem)] w-77 flex-col overflow-y-auto rounded-lg border bg-cf-sidebar shadow-lg outline-none"
      data-testid="thread-info-overlay"
      onPointerDownCapture={() => {
        inside.current = true;
      }}
    >
      <ThreadInfoContent threadId={threadId} />
    </section>
  );
}
