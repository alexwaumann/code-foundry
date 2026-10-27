# Inline pages: one live card per file, Expand over the pane (2026-10-27)

Two GUI changes to the HTML pages a thread shows (view.inline; inline-html.md,
inline-html-2-fixes.md, inline-page-frame.md). Frontend and mock only.

## A. Repeated shows collapse to the latest card

The daemon dedups a page only within a turn (`ShowHtml`'s `earlier_item_id`), so a page
the model shows again after each new message gave one card (and one frame) per show.

- **The path is structural.** `TimelineItem.page` is an html item's absolute path
  (`inlinePage(item).abs`, set in `structOf`), and it is part of `timelineKey`, so the
  rows rebuild when a show arrives but never on text deltas. Two shows of one file through
  different relative paths or bases resolve to the same path and group.
- **`linkRepeatShows(rows)`** (lib/threadTimeline.ts) runs last in `buildRows`, and in
  Ember's `buildEmberRows`. Of the top-level html rows with the same `page`, the last keeps
  its card. Each earlier one gets `later`, the row key of that last one. Rows that do not
  change keep their identity, and so does the list when nothing links. A page nested under
  a subagent's Agent row is not a top-level row, so it keeps its card.
- It works on the rows on screen, not on the turns. In Ember's chat a show folded into a
  closed work row does not count, so the latest show you can see is the card.
- **The link row** (`EarlierShow`, `thread-html-earlier`): the same icon and "Showed
  **name** dir" label, then "Shown again below" with lucide `ArrowDown` in `text-link`. It
  has no chevron, no card and no frame. It is a button, so Enter and Space work.
- **Click:** the card's row is opened (in case the reader closed it). The cite store's
  `showRow` then brings the card into view, and `flashPage` records `{id, at}` in
  `pageFlash`. The card's effect sets `data-flash` for what is left of `PAGE_FLASH_MS`
  (1 s) when it mounts, since the virtualizer may only mount it a frame or two later.
- **The ring** is `data-flash:` utilities: the border and a 3 px ring in `cf-focus`. The
  transition is 300 ms and turns off with reduced motion (`motion-reduce:transition-none`).
  The ring is drawn as a data attribute rather than state, so no setState runs in an effect.
- **Estimates:** a link row is 26 px, not 470 (Timeline and Ember).
- **Streaming:** a new show changes the older row from a card to a link. The row keeps its
  key, so the virtualizer measures the smaller row. Pinned, the list follows the bottom.
  Scrolled up, the anchor rule keeps the reader's top row in place (e2e).

### showRow and the composer

`showRow` counted a row as in view when it fitted the scroller's box. The composer floats
over the scroller's bottom, so a card under the composer counted as in view and nothing
scrolled. Now the band under `bottomInset` is out of view. Quoted rows from the cite layer
get the same fix.

## B. Expand is a modal over the thread pane's body

- **Placement:** `PaneOverlay` (InlineHtml.tsx) wraps the contents of the pane body's
  `relative` div: ThreadBody, EmberBody, SubagentPane and InlineThread (a plugin's thread
  node). It provides the body's scope through `PaneOverlayContext` and renders the open
  modal there, `absolute inset-0` with the box `SHELL_GAP` (12 px) in from each edge. The
  pane header, the sidebar and the side panel are outside it and stay usable (the e2e
  clicks the side panel while it is open).
- **Not a portal:** the modal is drawn by a host in the body, not by the card. The card's
  row can be gone (the virtualizer drops rows out of view, and the timeline remounts on
  return), and the modal has to come back anyway. The host renders it in place, so no
  portal target is needed.
- **The rest is unchanged:** the strip and its actions (file icon, path, PageErrors, Open in
  side panel, Source, bookmark placeholder, Close), Esc (a capture listener), Close, a click
  on the dim edge, and `cf:key` from the bridge. Focus goes to Close on open, and back to
  the card's Expand on close. Expand is found by `data-page` in the pane, and only while the
  pane is still mounted: leaving the thread moves no focus. The scrim keeps `bg-black/55`
  (palette allowlist updated). `aria-modal` is gone, because the rest of the window is not
  inert any more.
- **Scopes:** the thread's id for its body and Ember's, `<thread>/<run>` for a subagent
  view, and `inline:<thread>` for a plugin's thread node. They are kept apart because the
  subagent view and the thread body show the same thread one at a time, and a plugin's node
  can show it next to the content pane. Outside any `PaneOverlay`, a card has no Expand.
- **Remembered per thread:** `pageModals[scope] = {thread, id, source}` in stores/thread.ts.
  It is session only (no localStorage). `forgetTurnView` (leaving the thread) does not touch
  it. It is cleared by:
  - Close (`closePageModal`);
  - the thread being removed or archived (`prunePageModals` on every thread-list event,
    once the list is loaded);
  - the item leaving the log (the modal closes itself once the log is loaded and the item
    is not an html item in it).
  Whether the modal shows the page or its source is kept in the same entry, so it comes back
  as it was. The card's Source toggle stays local to the card.
- **One frame per file:** while a scope's modal shows a file (`usePageModalPath`), that
  file's card in the scope keeps its row and strip, but its body is a `bg-cf-surface` box
  of the same height (`thread-html-covered`) instead of the frame, and its page errors are
  hidden. With A, a thread has at most one frame per file in a pane.

## Tests

- Vitest:
  - threadTimeline: three shows across turns and between turns, folded or not; a show
    arriving in a live turn with strips; identity kept; pathless pages; a stale link
    cleared; `timelineKey` round-trips `page`.
  - stores/thread: scopes, survive `forgetTurnView`, source toggle no-ops, prune on a gone
    thread with its flash.
  - Existing html node expectations gained `page`/`later`.
- e2e (mock state `html-repeat`: docs/hello.html shown in three turns):
  - `inline-page-shows.spec.ts`: one card, two link rows and one frame. A click and Enter
    both bring the card into view, clear of the composer, and ring it for about 1 s.
  - Live shows through the mock's ShowHtml RPC: pinned, the list follows; scrolled to the
    start, the first row does not move.
  - `inline-html.spec.ts`: the box is 12 px inside the body, under the header and left of
    the side panel. The card has no frame while the modal is up. Esc returns focus to
    Expand, and a click on the dim edge closes the modal.
  - A new test: open, Source, a sidebar click to another thread, then back. The modal is up
    again with its source, and Close has focus. Close, away and back: no modal.
  - `bridge.spec.ts`: the old check that the card's frame cannot close the modal with
    `cf:key` is replaced by "the card has no frame", since it has none now.

## Gotchas

- Setting `scrollTop` from a test while the list is pinned snaps back to the bottom (no
  user input). Tests scroll with the mouse wheel.
- `data-at-bottom` renders as `"true"`, not as an empty attribute.
- Check the ring right after the click, not after the in-view poll: on a slow scroll it is
  gone by then.

## Daemon restart

Not needed: frontend and mock only.
