import { useCallback, useLayoutEffect, useState } from "react";

/** How tall long text shows before it fades out behind its toggle (a PR's description, a long user message). */
export const FOLD_PX = 170;
/** Text up to this much taller than the fold shows whole: cutting it would hide less than the toggle costs. */
export const FOLD_SLACK_PX = 24;

/**
 * Whether the element is taller than limit plus FOLD_SLACK_PX (read on mount and on
 * resize). Give it the unclipped content, not the folded wrapper: the wrapper stays at the
 * fold whatever its content does, so it would never see a shrink back under the limit.
 */
export function useTallerThan(limit: number): [(el: HTMLElement | null) => void, boolean] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [taller, setTaller] = useState(false);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => {
      setTaller(el.offsetHeight > limit + FOLD_SLACK_PX);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [el, limit]);
  return [useCallback((e: HTMLElement | null) => {
    setEl(e);
  }, []), taller];
}
