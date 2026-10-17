import { useEffect, useState } from "react";

/**
 * `value`, held true for `ms` after it turns false; with `ms` 0 it follows `value` at once.
 * The thread pane's live turn header uses it: the thread's status (EventService) can say
 * idle a moment before the turn_end arrives on the Watch, and the header should turn into
 * the finished one in place rather than vanish and come back
 * (docs/notes/thread-fold-3-header.md).
 */
export function useLinger(value: boolean, ms: number): boolean {
  const [held, setHeld] = useState(value);
  // Adjusting state to a new value during render (React's documented pattern).
  if (value && !held) setHeld(true);
  useEffect(() => {
    if (value || !held) return;
    const t = setTimeout(() => {
      setHeld(false);
    }, ms);
    return () => {
      clearTimeout(t);
    };
  }, [value, held, ms]);
  return value || (ms > 0 && held);
}
