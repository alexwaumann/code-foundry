/** Where the timeline's scroller was: its scrollTop and scrollHeight. */
export interface ScrollSample {
  top: number;
  height: number;
}

/**
 * Who moved the timeline in a scroll it saw (components/thread/Timeline.tsx): the user, whose
 * scroll away from the bottom unpins the list and ends a held card's hold, or the layout (the
 * virtualizer keeping rows in place, the browser clamping a shrinking list), which the list
 * undoes while pinned.
 *
 * The user's: right after their own input in the list (`input`: a wheel, touch, scroll key or
 * the scrollbar); or, with the pointer over a page's frame (`overFrame`), any upward scroll
 * over content that did not shrink. A wheel over a frame goes to the frame's document, never
 * the app's, and once the page cannot scroll further up WebKit moves the timeline instead,
 * with no event in the app to say so (docs/notes/inline-page-frame.md). The layout never moves
 * the list up without the content shrinking (a clamp, a row above measured smaller), so the
 * upward scroll is the reader's. Downward ones are left alone: they end at the bottom, which
 * pins the list anyway.
 */
export function scrollIntent({ input, overFrame, prev, now }: { input: boolean; overFrame: boolean; prev: ScrollSample; now: ScrollSample }): "user" | "layout" {
  if (input) return "user";
  if (overFrame && now.top < prev.top && now.height >= prev.height) return "user";
  return "layout";
}
