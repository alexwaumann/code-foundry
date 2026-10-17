# Thread fold 3: the turn header at the top, copy on the answer

A finished turn ended with a footer ("Worked for 4m 08s · 12 steps · $1.12 · Opus") whose
chevron folded the work above it, and a running turn ended with a separate "Working 3m 52s"
row. Alex: the control sat below what it opened, it moved away from the click, and
everything shifted. The design he signed off moves that line to the top of the turn's
work. Frontend only.

## What changed

* **Rows** (`lib/threadTimeline.ts buildRows`): per turn, its user message(s), then a
  `header` row, then the body (minus what the fold hides). The `footer` and `working` row
  types are gone. The header carries the turn_end id (`""` while live), the turn key, the
  fold, the step count and `finals`, plus `since` (the item the live time counts from:
  the turn's last opening message, else its first item). A system note's turn (no user,
  no end) has no header.
* **One row key for both forms**: `h:<turn key>`. The live header becomes the finished
  one in place: the virtualizer keeps its measured row and React keeps the `div.thead`
  (`HeaderRow` is one component; the e2e checks the element survives the turn_end).
* **Live form**: shown for the last open turn while `working` (the old meaning: busy or
  starting, and no request waits). Sky spinner, "Working" with the shimmer, then "· N
  steps" (left out at 0) and "· 1m 12s", ticking each second. Never a button. With no turn
  to head (an empty thread starting, a fork whose only turn is its note) a lone live header
  `h:` is added at the end.
* **Finished form** (`rows.tsx HeaderRow`): the same text and colours as the footer
  (interrupted and failed wording, the first part red when `isError`), chevron on the left
  in a 22px slot lined up with the work rows' icons, rotated 90° when open. A `button.fold`
  with the hover background on itself only; `steps === 0` renders a plain `span.line`
  (no chevron, not focusable). 26px tall, `text-caption`, no hairline.
* **Copy on the answer**: the first final text row of a finished turn carries `answer`
  (the turn's final text ids joined by "\n": a string, so the memoized `TextRow` stays
  equal across rebuilds). `CopyAnswer` is a 24px button with a shadcn `Tip` "Copy answer",
  shown while the answer is hovered or the button has the keyboard; it copies all final
  texts joined by blank lines. None on a running turn (the answer may still grow) or a turn
  without final text.
* **Spacing**: the footer used to separate turns. Now the last row of a turn before the
  next user message or system note gets `data-turn-end` on its virtual wrapper (16px
  padding, `Timeline.tsx`). The opening bubble's bottom margin went from 18 to 12px since
  the header follows it.
* **Theme gallery**'s mini thread shows the header (open) under the bubble instead of the
  footer.

## Scroll anchoring (Timeline.tsx)

* **A click on a header keeps the header where it is.** `KeepRowContext` hands the header
  a `keepRow(key)` that records its offset from the viewport's top before
  `setTurnFolded`. The next rows-change layout effect puts it back: rows above it do not
  change, so its `start` is the same and `scrollTop` is restored. The list unpins unless
  that place is now past the bottom (folding the latest turn at the bottom: the content
  shrinks below the header, the browser clamps, and the list pins again). This replaces
  the pinned follow for that one change: unfolding at the bottom no longer jumps to the
  end of the opened work. `atBottom` is set there too, as an unchanged `scrollTop` fires
  no scroll event (the Jump to bottom chip would otherwise not show).
* **A fold on end while scrolled up**: the anchor row (top of the viewport) is kept when
  it survives; when it folded away the nearest surviving row *before* it takes its place
  (the turn's header, or a steer or note between the header and the anchor), at the
  viewport's top; only if none, the nearest after it. The old rule searched forward (the
  answer and footer were below the work). Past the new bottom, the list pins, as before.
* **Pinned**: unchanged, the list follows the bottom; the end-of-turn fold leaves the
  bubble, header and answer in view when they fit (e2e).

## Gotchas

* **The status can say idle before the turn_end arrives.** The status comes over the
  EventService and the items over the Watch (batched per frame), so `working` can go
  false a moment before the turn_end item lands. The live header then vanished and the
  finished one mounted fresh, and a reader scrolled into the work was anchored to the
  bubble rather than the header (both seen in the e2e against the mock). `ThreadPane`
  passes the timeline `useLinger(working, 2000)` (`lib/linger.ts`): the live header
  outlasts a stop by up to 2 s, but not a docked request (ms 0: a waiting permission or
  question still drops the header at once).
* **Test id clash**: the pane's title bar is already `thread-header`. The turn header is
  `thread-turn-header` (`data-live` on the live form, `data-folded` when folded), its
  plain line `thread-turn-header-line`; `thread-working` stays on the live line. e2e
  specs count finished headers with `[data-testid="thread-turn-header"]:not([data-live])`.
* **Clicking a header above the viewport in e2e**: Playwright's scroll-into-view is not a
  user scroll, so a pinned list follows the bottom back and the click never lands. The
  timeline spec scrolls up with the wheel first (`wheelUpTo`).
* The copy button sits in the 40px gutter right of the answer, not inside it, so it never
  covers a code block's own actions at the block's top right.

## Tests

* `threadTimeline.test.ts`: the new order everywhere, header fields (key, turn_end id,
  turn, steps, fold), `answer` on the first final row only, the live header's key equal to
  the finished one's, a still-starting turn, a running turn with no copy, no live header
  while a request waits, a turn Claude starts itself counting from its first item, the
  note turn without a header and the lone live header.
* `rows.test.tsx`: live (spinner, "Working·1 step·1m 12s", no button, no copy), folded,
  unfolded, interrupted (red first part, no copy), plain at zero steps, failed, still
  starting ("Working·3s"), copy of all finals joined by blank lines.
* `linger.test.tsx`: the hold, its end, restarts, ms 0.
* e2e (`thread.spec.ts` and the specs that used `thread-footer`): the live header under
  the message turning into the finished one (same element), copy hidden until hover and
  not on the header, header and answer in view after the fold on end, the fold-on-end
  anchors to the header at the top, a click unfolding and folding the 12-step turn while
  pinned keeps the header's y.

## Verified live

`make gui-build`, this worktree's GUI with `CODE_FOUNDRY_HOME=/tmp/cf-fold3`, a no-project
haiku thread (`claude-haiku-5-5[1m]`, medium, auto) asked to run `sleep 15` three times
and reply in two sentences. Mid-run the header read "Working · 2 steps · 27s" under the
message with the rows below (`thread-fold-3-header/live-dark.png`). At the turn_end it
became "Worked for 51s · 3 steps · <$0.01 · Haiku 5.5" in place with the work folded under
it (`folded-dark-light.png`, light via the isolated home's `appearance.theme`, reset
afterwards). A click opened the three Bash rows below it; the header did not move, and
hovering the answer showed the copy button in the gutter (`open-dark.png`). A second click
folded it back with the header in place. The home was removed afterwards.
