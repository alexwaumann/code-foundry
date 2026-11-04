import { ChevronDown, ChevronUp } from "lucide-react";
import { useCallback, useLayoutEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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

/** The toggle of folded text: `label` and a chevron down while folded, "Show less" and a chevron up once open. */
export function FoldToggle({ folded, label, testId, className, onClick }: { folded: boolean; label: string; testId: string; className?: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <Button variant="outline" size="xs" className={cn("bg-cf-surface", className)} aria-expanded={!folded} data-testid={testId} onClick={onClick}>
      {folded ? label : "Show less"}
      {folded ? <ChevronDown aria-hidden /> : <ChevronUp aria-hidden />}
    </Button>
  );
}
