# Long user messages fold

A user message taller than the fold fades out with a centred Show more, like a PR's
description. Sketch variant A (the top bubble).

## What it is

- `lib/fold.tsx` holds what the PR description and the bubble share: `FOLD_PX`
  (170), `FOLD_SLACK_PX` (24), `useTallerThan` and `FoldToggle`. The description only moved
  onto them; it still says Show all and fades to its surface.
- `components/thread/MessageFold.tsx` is the bubble's box. The fade is a CSS mask on the text,
  because the bubble is tinted and has no colour to fade to.
- The toggle is solid in both schemes (the outline button's dark background is see-through,
  and the fading text runs behind it). Its row is `relative`: the mask makes the box a
  stacking context, which otherwise paints over the button and takes its clicks. The row
  has no height while folded, so a bubble of short lines still widens to fit the button.
- The mask ends 6px before the edge. Without that the tops of the cut line show as specks
  under the button.
- `overflow: clip`, not hidden: nothing can scroll the box, neither a drag selection nor a
  tag taking focus.
- Before the first measure the box already stops at 194px, the most a message may show
  unfolded. A long row scrolling in never measures its whole height on the way to folded.

## Which messages fold

| Message | Folds | Why |
| --- | --- | --- |
| A turn's bubble | yes | the request |
| A steer | yes, same height | a long paste mid-turn is as long as any other |
| A queued message | yes | the same bubble and item id, so the choice carries over when it lands |
| A subagent's prompt | yes, the label stays on top | these are often very long; keyed by `prompt:<tool use id>` |
| Ember's chat | yes | the same row |
| Search preview, theme gallery | no | no `foldKey`: the preview shows a hit in the message |

Attachment tiles sit above the bubble and never fold. A message of images only has no bubble.

## Where the choice lives

In the thread store's `expanded` map under `msg:<id>` (`messageFoldKey`).
`forgetTurnView` keeps those keys and drops the rest: leaving a thread forgets its rows, not
the messages it opened. This reuses find's put-back (`changed`, `restore`, the watch for the
user's own change) with no new slice. `pruneThreadLogs` does not touch them, because it also
runs for the kept-logs limit, where the thread still exists. An entry for a removed thread
stays until the app restarts; it is a short string.

## Scroll

`FoldInPlaceContext` (from `TimelineList`) runs the toggle's change and keeps an element's
top in place in the same task (`flushSync`, then `restoreHeld`). Measured each frame in
WebKit, top of the held element:

| Case | Result |
| --- | --- |
| Show more, pinned newest message | no movement, list unpins, Jump to bottom shows |
| Show more, top off screen | no movement |
| Show less, top off screen, button held | within 1px (a hold applied a frame late jumped 488 to -141 and back) |
| Show less at the list's end | settles over the composer, no spacer, stays pinned |

- Show more holds the text's top. Show less holds it too, unless the top scrolled away:
  holding it would carry the whole message off screen, so the button stays instead.
- The hold differs from a page card's in three ways. The click is not scroll input
  (`userInput` is cleared, or the first scroll would end the hold). `pinned` is re-read
  even when nothing moved (otherwise the list jumps to the bottom on the next delta). No spacer.
- A fold's hold ends once the rows' height changed. A fixed 400 ms hold unpinned the list
  when a new row arrived inside it.
- `showRow` and the rail's jump end any hold. Clicking a rail tick right after a toggle was
  undone by the hold before this.
- The virtualizer needs no override: by default it only adjusts for rows wholly above the
  view, and the toggled row never is.

## Find and Go to source

- `foldDom.foldHides` compares the target's line rects with the start of the fade. Clipped
  text keeps its boxes. Rects are zoomed px, so the fade is scaled by `zoomFactor`.
- Find opens the message only when the current match is hidden: `revealMatch` checks once
  the row renders, because a row that is not mounted has no geometry. Opening every message
  with a match would shift the list on each step. `openThreadFindMessage` records it in the
  session's `opened`, so it folds again when the match leaves the item or the bar closes,
  like a question's row. A message the user opened stays open; so does a later choice of theirs.
- A `{ reveal: false }` pick (a re-pick as text streams, the in-place first pick) opens
  nothing, so such a match can sit under the fold until the next step.
- Go to source and agent search's reveal go through `revealQuote`, which opens the message
  and leaves it open: the user went there.
- `data-find-item` moved from the bubble to the content inside the box, so the toggle is
  outside what find and quotes read.

## Gotchas

- A drag that ends on something unselectable under the bubble (the time) stops at the fold's
  edge: WebKit selects what the box shows. A drag on into the next selectable row has the
  whole text, and the button's label is never in it. The DOM always has all of it.
- The prompt rail reads `rowStart` only, so it needs no change. Its in-view tick reads on
  scroll, so after a toggle with no scroll it can be stale until the next one, as after any
  row that opens.
- Tabbing to a tag under the fold opens the message; a mouse click on a tag in the fade does
  not (`:focus-visible`).
- Setting `scrollTop` in a test does not unpin the list; only real input does. The e2e spec
  wheels. Its message sends read the log, because scrolled rows do not render.
