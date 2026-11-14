/**
 * When a shell pane draws its thread's ask as the one-line strip above the composer instead of
 * the full card (docs/notes/shell-17-needs-you.md; the rule is lib/needsAsk askAsStrip). Each ask
 * is drawn as the full card first and measured; a ResizeObserver on the thread's body and dock
 * (its callbacks run after layout, before paint) swaps in the strip in the same frame when the
 * conversation would keep less than ASK_MIN_ROOM of the body, and back when the pane grows.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { askAsStrip } from "@/lib/needsAsk";

export function useAskStrip(on: boolean, bodyEl: RefObject<HTMLElement | null>, dockEl: RefObject<HTMLElement | null>, key: string): boolean {
  const [strip, setStrip] = useState({ key: "", on: false });
  // Another ask (key) is drawn as the card again, to be measured.
  const showing = on && strip.key === key && strip.on;
  const showingRef = useRef(showing);
  const card = useRef({ key: "", height: 0 });
  useLayoutEffect(() => {
    showingRef.current = showing;
  });
  useLayoutEffect(() => {
    const body = bodyEl.current;
    const dock = dockEl.current;
    if (!on || !body || !dock) return;
    const measure = () => {
      const stack = dock.querySelector<HTMLElement>('[data-testid="thread-prompts"]');
      if (stack) card.current = { key, height: stack.offsetHeight };
      const next = askAsStrip({
        body: body.offsetHeight,
        dock: dock.offsetHeight,
        card: card.current.key === key ? card.current.height : 0,
        strip: dock.querySelector<HTMLElement>('[data-testid="ask-strip"]')?.offsetHeight ?? 0,
        showingStrip: showingRef.current,
      });
      if (next !== showingRef.current) {
        showingRef.current = next;
        setStrip({ key, on: next });
      }
    };
    const ro = new ResizeObserver(measure);
    ro.observe(body);
    ro.observe(dock);
    return () => {
      ro.disconnect();
    };
  }, [on, key, bodyEl, dockEl]);
  return showing;
}
