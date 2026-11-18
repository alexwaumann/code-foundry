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
- **`applyPlace` dispatches a `scroll` event after it scrolls**, so the virtualizer renders the
  place's rows in the same pass instead of a frame later. The list's own `onScroll` gets it too
  and finds nothing to do.
- **Not covered:** a thread opened for the first time still shows "Loading the conversation…"
  until its snapshot arrives, and a place whose log was dropped from the kept logs is put back
  only once the snapshot brings the rows (a frame of the last rows first).
- Measured in headless WebKit only, as each frame's DOM geometry. The real window was not
  recorded.

## Tests

- `src/lib/timelinePlace.test.ts`: which row stands for a place, its offset, the kept places.
- `e2e/thread-switch-place.spec.ts`: every frame of a return to a long thread has rows in view
  and no chip; a thread left scrolled up shows the same row at the same height in every frame of
  two visits, and follows the bottom again once left there. Both fail without the change.
