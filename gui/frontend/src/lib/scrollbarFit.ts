/**
 * Keeps a sideways-scrolling box's parents the right height when a classic (always visible)
 * scrollbar appears or goes.
 *
 * WebKit settles an `overflow: auto` box's scrollbars after the outermost flex container
 * around it has finished its layout. The box then grows by the bar and lays itself out
 * again, but its parents kept the height they read before, so it covers what follows. Every
 * thread and panel sits inside flex containers, and CSS has no fix: moving the scroller to
 * a wrapper only moves the stale height up a level (docs/notes/code-box-scrollbar.md).
 *
 * So when a box's bar changes, this dirties the box: the layout that follows reads its
 * real height all the way up, in the same frame. Overlay scrollbars take no space, so
 * nothing here runs for them.
 */

const barShown = new WeakMap<Element, boolean>();

/** Whether a bar takes height from the box. Past 1px: offsetHeight and clientHeight round. */
function takesHeight(el: HTMLElement): boolean {
  const borders = el.clientTop + parseFloat(getComputedStyle(el).borderBottomWidth);
  return el.offsetHeight - el.clientHeight - borders > 1;
}

function onResize(entries: readonly ResizeObserverEntry[]): void {
  for (const { target } of entries) {
    const el = target as HTMLElement;
    const shown = takesHeight(el);
    if (shown === (barShown.get(el) ?? false)) continue;
    barShown.set(el, shown);
    // A real style change, so WebKit lays the box out again; no box here is under 1px tall.
    el.style.minHeight = el.style.minHeight ? "" : "1px";
  }
}

let observer: ResizeObserver | undefined;

/** A ref for a box with `overflow-x: auto` and an automatic height. One observer serves all. */
export function fitScrollbar(el: HTMLElement | null): (() => void) | undefined {
  if (!el) return undefined;
  observer ??= new ResizeObserver(onResize);
  const watching = observer;
  watching.observe(el);
  return () => {
    watching.unobserve(el);
  };
}
