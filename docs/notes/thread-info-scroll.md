# Thread info card: laid over the conversation

Status: done on branch `cf/thread-info-scroll` (one PR, GUI only). Follows
`docs/notes/thread-info-card.md`, whose card was a flex column beside the conversation: a
wheel over that column (beside or under the card) did nothing, and the conversation's
scrollbar sat left of the card instead of at the pane's edge.

Superseded for the wheel: since `docs/notes/thread-info-wheel-native.md` the card is
inside the timeline's scroller and a wheel over it chains to the list natively; the
forwarding below (and its gotchas) is gone.

## Behaviour

* The card lays over the right of the thread body (`absolute inset-y-0 right-0`,
  `w-(--ti-card)`: 320 card + a 12px gutter). `ThreadPane` sets `--ti-inset` on the body
  to `var(--ti-card)` while the card shows, else `0px`; `.cf-thread` defines `--ti-card`,
  `--ti-gutter` and a `0px` `--ti-inset`, so a thread view nested inside a body starts
  clear.
* The timeline's scroller (`.scroller` in `Timeline.tsx`) spans the whole body with
  `padding-right: var(--ti-inset)`, so the conversation stays centred left of the card and
  the scrollbar sits at the pane's edge, in the card's gutter. The scrollbar is a thin
  custom WebKit one (12px transparent track, 4px thumb via a transparent border and
  `background-clip: padding-box`, text colour at 16%, 28% on hover).
* The dock's `right` is `calc(var(--ti-inset) + var(--ti-gutter))`: the composer centres in
  the same space and its gradient does not cover the scrollbar. "Jump to bottom" centres on
  that space too.
* Wheels (superseded, see thread-info-wheel-native.md): the card's column (`aside`) is `pointer-events-none`, the card
  `pointer-events-auto`, so a wheel beside or under the card hits the list. Over the card,
  the column scrolls while the card is taller than the pane (its own scrollbar hidden);
  otherwise `onWheel` hands it to the timeline: a synthetic `wheel` event on the scroller
  first (Timeline's `markInput` counts it as the reader's input, so the list unpins from
  the bottom instead of being put back), then `scrollBy`. Line and page delta modes are
  converted; pinch (ctrl) and sideways wheels are not forwarded.
* What else lives in the body keeps clear of the card: the catching-up chip
  (`right-[calc(var(--ti-inset)+1rem)]`), the loading and empty messages
  (`right-(--ti-inset)`), the page modal (`InlineHtml` Lightbox,
  `right-[var(--ti-inset,0px)]`; the card stays usable beside it as before), and the cite
  layer (`reveal.ts` `paneBox`: the body's box cut at the card's left edge, used for the
  Cite button's and popover's clamp).

## Decisions

* **Overlay, not a sibling column.** A sibling column can never hand its wheel to the
  list natively, and the list's scrollbar is always at the list's edge. Laying the card
  over a full-width scroller fixes both with CSS; only the over-the-card case needs code.
* **`paneBox` measures the card**, not `--ti-inset`: the card's left edge is what the
  surfaces must not cross, and a rect needs no conversion between CSS lengths and the
  rects under the app's CSS `zoom`.
* Ember's chat, the subagent view and the inline thread share `.cf-thread`: they get the
  thin scrollbar and the dock's 12px gutter, nothing else (their `--ti-inset` is `0px`).
* `cardFits` / `data-info-room` are unchanged: the card still steps aside under 480px of
  conversation, measured on the same row. Focus order is unchanged (the card is still after
  the body in the DOM).

## Gotchas

* React bubbles events through portals: a wheel over a row's menu or hover card (portalled
  to the body) reaches the card's `onWheel`. The handler forwards only wheels whose target
  is inside the card's DOM, or scrolling a long menu would scroll the conversation.
* A bare `scrollBy` on the timeline is treated as a scroll nobody asked for while it is
  pinned, and is put back at the bottom: the synthetic wheel must come first.
* With a custom `::-webkit-scrollbar` the scrollbar takes layout space (12px) instead of
  overlaying; the conversation's column centres in what is left.

## Tests

* `e2e/thread-info.spec.ts`: the geometry (scroller to the pane's edge with a 12px
  scrollbar, rows and composer left of the card) and a wheel under the card; a wheel over
  a card shorter than the pane scrolls the list, which stays up with "Jump to bottom"
  shown left of the card, and a wheel down returns to the bottom; a card taller than the
  pane scrolls itself; a page's Expand leaves the card uncovered and usable.
* `e2e/citations.spec.ts`: a selection let go over the card puts the Cite button and its
  popover left of the card.
* The over-the-card wheel and the cite tests fail with their fix reverted.
