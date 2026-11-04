import { useContext, useRef, type MouseEvent, type ReactNode } from "react";
import { FOLD_PX, FOLD_SLACK_PX, FoldToggle, useTallerThan } from "@/lib/fold";
import { cn } from "@/lib/utils";
import { messageFoldKey, setRowExpanded, useRowExpanded } from "@/stores/thread";
import { FoldInPlaceContext, useThreadCtx } from "./context";
import { FOLD_FADE_PX, FOLDED_ATTR, foldHides } from "./foldDom";

/** Clear a little before the box's edge: the tops of a cut line would show as specks under the button. */
const FADE = `linear-gradient(to bottom, black calc(100% - ${String(FOLD_FADE_PX)}px), transparent calc(100% - 6px))`;

/**
 * A user message's text inside its bubble: shown whole when short; otherwise cut at
 * FOLD_PX and faded out (a mask: the bubble is tinted, there is no colour to fade to) under
 * a centred Show more, which opens it in place. The choice is the thread's, per message
 * (`foldKey`), so it survives the row unmounting and a visit to another thread.
 *
 * Only the box clips: the whole text stays in the DOM, for a selection and for find and Go
 * to source, which open the message when what they look for is under the fold (foldDom).
 * Before the first measure the box already stops at the most a message may show unfolded,
 * so the row never measures its full height on the way to folded (a long row scrolling in).
 * `overflow: clip`, not hidden: nothing can scroll the box, neither a drag selecting past
 * its edge nor a tag taking focus.
 */
export function MessageFold({ foldKey, findItem, children }: { foldKey: string; findItem?: string | undefined; children: ReactNode }) {
  const { threadId } = useThreadCtx();
  const foldInPlace = useContext(FoldInPlaceContext);
  const key = messageFoldKey(foldKey);
  const open = useRowExpanded(threadId, key, false);
  const [contentRef, taller] = useTallerThan(FOLD_PX);
  const boxRef = useRef<HTMLDivElement>(null);
  const folded = taller && !open;

  const toggle = (e: MouseEvent<HTMLButtonElement>) => {
    const change = () => {
      setRowExpanded(threadId, key, !open);
    };
    const box = boxRef.current;
    const list = box?.closest(".scroller");
    if (!box || !list) {
      change();
      return;
    }
    // What is being read stays put: the text's top. Folding a message whose top scrolled
    // away would take the whole message with it, so there the button stays instead.
    const offTop = box.getBoundingClientRect().top < list.getBoundingClientRect().top;
    foldInPlace(open && offTop ? e.currentTarget : box, change);
  };

  return (
    <>
      <div
        ref={boxRef}
        className={cn(!open && "overflow-y-clip")}
        style={open ? undefined : { maxHeight: folded ? FOLD_PX : FOLD_PX + FOLD_SLACK_PX, ...(folded && { maskImage: FADE, WebkitMaskImage: FADE }) }}
        data-testid="thread-user-fold"
        data-folded={folded}
        {...(folded && { [FOLDED_ATTR]: "" })}
        onFocus={(e) => {
          // Tabbing to a tag under the fold: it would take focus out of sight.
          if (e.target.matches(":focus-visible") && foldHides(e.target, [e.target.getBoundingClientRect()])) setRowExpanded(threadId, key, true);
        }}
      >
        <div ref={contentRef} data-testid="thread-user-content" data-find-item={findItem}>
          {children}
        </div>
      </div>
      {taller && (
        // Folded, the row takes no height and the button hangs up from the box's edge, over
        // the fade (relative: the mask makes the box a stacking context, which would paint
        // over it); it still widens a bubble of short lines to fit.
        <div className={cn("relative flex justify-center select-none", folded ? "h-0 items-end" : "mt-1.5")}>
          {/* Solid in both schemes: the fading text runs behind it. */}
          <FoldToggle folded={folded} label="Show more" testId="thread-user-fold-toggle" className="hover:bg-cf-surface-raised dark:bg-cf-surface dark:hover:bg-cf-surface-raised" onClick={toggle} />
        </div>
      )}
    </>
  );
}
