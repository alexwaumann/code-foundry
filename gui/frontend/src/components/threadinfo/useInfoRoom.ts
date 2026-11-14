import { useEffect, type RefObject } from "react";
import { cardFits } from "@/lib/threadInfo";
import { useWidth } from "@/lib/useWidth";
import { dropCardRoom, hideThreadInfoOverlay, setCardRoom, useCardRoom } from "@/stores/threadInfoOverlay";

/**
 * Whether the thread body keeps room for the inline card (lib/threadInfo cardFits: the
 * conversation keeps CONVERSATION_MIN beside it); else the toggle floats it
 * (ThreadInfoOverlay). The ref goes on the body's row. A thread's page and a subagent's
 * share it, so the card behaves the same on both.
 */
export function useInfoRoom(threadId: string): [ref: RefObject<HTMLDivElement | null>, fits: boolean] {
  const [rowRef, rowWidth] = useWidth(1280);
  const fits = cardFits(rowWidth);
  useEffect(() => {
    setCardRoom(fits, threadId);
  }, [fits, threadId]);
  // Another thread hides the overlay (unless it was shown for that one: the sidebar's linked PRs tag).
  useEffect(() => {
    if (useCardRoom.getState().overlayFor !== threadId) hideThreadInfoOverlay();
  }, [threadId]);
  useEffect(
    () => () => {
      dropCardRoom(threadId);
      setCardRoom(true);
      if (useCardRoom.getState().overlayFor === threadId) hideThreadInfoOverlay();
    },
    [threadId],
  );
  return [rowRef, fits];
}
