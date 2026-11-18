# Thread switch: no flash, and the list opens where it was left

A user reported that switching between threads flashes, and asked that a thread come back where
they left it instead of at the bottom.

## Cause of the flash

A tab's body is mounted only while it is the active one, so every switch mounts the conversation
list anew. The list mounted with the virtualizer at offset 0 and a layout effect then scrolled it
to the bottom. The virtualizer only hears of a scroll from the scroll event, a frame later, and
with `useFlushSync: false` its re-render lands after that frame has painted. Recorded frame by
frame (headless WebKit, the mock's 120-row thread), a switch to a thread longer than its pane
showed:

1. the first rows rendered under a viewport already at the bottom: a blank list;
2. about 30 ms later the last rows at estimated heights, the last one under the composer;
3. about 20 ms later the measured rows, settled;
4. meanwhile the Jump to bottom chip fading in and out, from a stale `bottom` in `onScroll`.

It happened on a return to a thread whose log was kept as much as on a first open, so it was
never about loading. A thread that fits its pane did not flash.

## Fix

- `initialOffset` on the virtualizer: it starts where the list will be. At the bottom that is
  `Number.MAX_SAFE_INTEGER` (the browser clamps the overshoot), so the first render is the last
  rows.
- `onScroll` sets the chip's state from `bottom || pinned`: a pinned list that is not at the
  bottom yet was just sent there.

## The place a list was left at

`lib/timelinePlace.ts` keeps, per thread, the row at the top of the viewport and how far it
starts from the viewport's top, whenever the list is scrolled up. `TimelineList` takes the id
as `place` (a thread's timeline, the plugin thread node's, and Ember's chat; not a subagent
run's view) and mounts at that place, unpinned, with the chip showing.

## Decisions

- **A row and an offset, not a scroll offset.** Rows above are estimates until they render, and
  leaving a thread still forgets its fold choices, so the same number of pixels is another place.
  A row that folded away is stood in for by the nearest row before it (its turn's header), at the
  viewport's top: the same rule a change of rows already used while scrolled up, now shared
  (`placeRow`, `placeTop`).
- **Only a list scrolled up has a place.** One left following the bottom opens at the bottom,
  where the rows that arrived meanwhile are.
- **In memory, 64 lists, least recently left first out.** A reload opens every list at the
  bottom. A place holds the rows array it was taken from (keys only), not the log.
- **Fold choices are still forgotten on leaving.** Keeping them was not asked for and is its own
  decision (`thread-fold-4-pinned-fold.md`).
- **The same thread in two panes shares one place**: the last one scrolled wins.

## Gotchas

- **The place is put back more than once.** The place's row and the rows above it are measured
  only once rendered, and each measurement moves the row. For 600 ms after the first rows
  (`PLACE_MS`) every layout pass scrolls to the place again (`applyPlace`: the rows effect, the
  resize observer, a scroll nobody asked for). The user's input, a pin, or a jump to a row ends
  it at once. While it lasts the kept place is not overwritten, or a half-settled position
  would replace it (seen: row 83 drifting to 92, then 101, then lost on the next visit).
- **`initialOffset` for a place is the row's start, never further into the row.** The
  virtualizer adds to its offset what a row that starts above it grows by when first measured. An
  offset inside the place's row therefore jumps past that row once it is measured, and the row
  unmounts: the first frame showed the rows after it with a gap above.
- **`applyPlace` tells the virtualizer after it scrolls** (`syncOffset`, below), so the place's
  rows render in the same pass instead of a frame later.
- **Not covered:** a thread opened for the first time still shows "Loading the conversation…"
  until its snapshot arrives, and a place whose log was dropped from the kept logs is put back
  only once the snapshot brings the rows (a frame of the last rows first).
- Measured in headless WebKit only, as each frame's DOM geometry. The real window was not
  recorded.

## Follow-up: two shifts left after the first fix

A user still saw the conversation move on some switches, on threads waiting on child threads.
Two causes, both recorded frame by frame:

- **The waiting strip arrived after the pane.** It showed only once the Watch's snapshot had
  come, about 45 ms after the switch, so the dock grew and the list moved up. It now shows at
  once from the kept list, its actions disabled until the snapshot (`waiting-strip.md`).
- **Short rows at the end.** At offset `MAX_SAFE_INTEGER` the virtualizer renders the last row
  and its overscan: nine rows. Folded turns and wake notes are 30 to 80 px each, so nine of them
  do not fill a pane; the rest came a frame later, when the scroll event told the virtualizer
  where the scroller really was. The first fix was only tested on a thread ending in one tall
  row. Now the list settles before its first paint: a layout effect with no dependencies runs
  after every render, scrolls to the bottom (or the place) again and tells the virtualizer the
  scroller's offset (`syncOffset`), which renders the rows of that offset in the same pass,
  until nothing moves.

Gotchas:

- **`syncOffset` goes through `observeElementOffset`**, the virtualizer's own option, wrapped to
  keep its callback: calling it is what a scroll event does, minus the wait. A dispatched
  `scroll` event does the same but marks the virtualizer as scrolling, which puts off measuring
  the rows it then renders to the resize observer, a frame later. `applyPlace` uses
  `syncOffset` too now.
- **It only calls the callback when the offsets differ**, which is what ends the loop.
- **The settle effect scrolls only when the rows' height changed.** A pinned list may sit up to
  `PIN_SLACK` above the bottom (a small scroll up stays pinned). Scrolling to the bottom on every
  render took that away: a hover's re-render snapped the list back, and Playwright could no
  longer bring an answer's Copy button into view (`thread.spec.ts`, streaming).
- The mock's `short-turns` state is the fixture: forty exchanges of one-line rows.

## Tests

- `src/lib/timelinePlace.test.ts`: which row stands for a place, its offset, the kept places.
- `e2e/thread-switch-place.spec.ts`: every frame of a return to a long thread has rows in view
  and no chip; a thread left scrolled up shows the same row at the same height in every frame of
  two visits, and follows the bottom again once left there. Both fail without the change.
- The follow-up: a thread ending in short rows opens with its pane full and the same rows in
  every frame; a waiting thread's dock is the same height in every frame
  (`e2e/thread-switch-place.spec.ts`), and the strip's actions wait for the snapshot
  (`WaitingStrip.test.tsx`). The two e2e tests fail without it.
