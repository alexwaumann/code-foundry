/**
 * When a plugin's thread or terminal node holds a live stream: each opens its own server
 * stream (WatchThread, Attach), and only while it is near the screen.
 */
import { useEffect, useState } from "react";

/** How far outside the panel's visible box a node still counts as on screen. */
const ON_SCREEN_MARGIN = "160px 0px";

/**
 * Whether the element is on screen (or within ON_SCREEN_MARGIN of it) in its scroll box
 * (the side panel's [data-scroll-root]). False until the first observation; true where
 * there is no IntersectionObserver (unit tests).
 */
export function useOnScreen(el: HTMLElement | null): boolean {
  const [on, setOn] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (!el || typeof IntersectionObserver === "undefined") return;
    const root = el.parentElement?.closest<HTMLElement>("[data-scroll-root]") ?? null;
    const io = new IntersectionObserver(
      (entries) => {
        const last = entries.at(-1);
        if (last) setOn(last.isIntersecting);
      },
      { root, rootMargin: ON_SCREEN_MARGIN },
    );
    io.observe(el);
    return () => {
      io.disconnect();
    };
  }, [el]);
  return on;
}
