import { useCallback, useEffect, useState, type RefObject } from "react";

/**
 * Whether the page may put an element in full screen (the Fullscreen API). The Wails window
 * allows it once its WKWebView has element full screen turned on (gui/main.go,
 * `FullscreenEnabled`); a webview without it answers false, and the player shows no button.
 */
export function fullscreenAvailable(doc: Document = document): boolean {
  // Not `as boolean`: jsdom and older engines leave it undefined.
  return (doc.fullscreenEnabled as boolean | undefined) === true && typeof doc.documentElement.requestFullscreen === "function";
}

/** The player's full screen: whether `ref`'s element is the one in full screen, and the toggle. */
export function useFullscreen(ref: RefObject<HTMLElement | null>): { available: boolean; active: boolean; toggle: () => void } {
  const [available] = useState(fullscreenAvailable);
  const [active, setActive] = useState(false);
  useEffect(() => {
    const changed = () => {
      setActive(ref.current !== null && document.fullscreenElement === ref.current);
    };
    document.addEventListener("fullscreenchange", changed);
    return () => {
      document.removeEventListener("fullscreenchange", changed);
    };
  }, [ref]);
  const toggle = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // A refusal (no user gesture, the webview's policy) leaves things as they were.
    if (document.fullscreenElement === el) document.exitFullscreen().catch(() => undefined);
    else el.requestFullscreen().catch(() => undefined);
  }, [ref]);
  return { available, active, toggle };
}
