# The row above the composer and its pill (2026-11-19)

Above a thread's composer the app docked separate pieces that stacked and pushed the
conversation: the waiting bar, the snooze bar (snoozed, saved, woken) and a floating Jump to
bottom chip, and nothing at the bottom said a turn was still working once its header had scrolled
away. Agreed with a user (turn sketches 7 and 8, section 1): one row of fixed height that is always
in the layout, and in it one pill of segments. Frontend only, apart from two mock controls.

## What it is

- `components/thread/ComposerRow.tsx`: the row (`composer-row`, 32px, always there) and the pill
  (`composer-pill`), centred, its segments left to right: **Working**, **Snooze**, **Waiting**,
  **Stop waiting** (idle only), **Jump to bottom**. Only the ones that apply; none, an empty row.
  Mounted in `ThreadPane`'s and `InlineThread`'s docks (the Needs-you popup and plugin thread nodes)
  in place of the two strips. Ember's chat and the subagent view keep the floating chip: they have
  no row (`TimelineList` draws the chip only without a `bridge`).
- `lib/composerPill.ts` (pure): `pillSegments` (which segments), `segmentForm` / `pillWidth` /
  `pillStep` (the shortening), the snooze and waiting words.
- `components/thread/pillData.ts`: the hooks the pill reads (`usePillSnooze`, `useWaitData`,
  `useStopWaiting`): the same stores the two strips read. Nothing opens a stream.
- `components/thread/WaitingPanel.tsx` (was `WaitingStrip.tsx`): the rows, unchanged, now in a
  panel with "Waiting on N" and "Stop waiting on all" in its header.
- `components/thread/PillSnoozeMenu.tsx`: the snooze segment's menu.
- `components/thread/timelineBridge.ts`: what the timeline tells the row: whether the list is
  away from its bottom, the list's own jump, and the live turn header's message id. A small
  external store read with `useSyncExternalStore`, so a scroll re-renders the row, not the pane.
- `DockStrip.tsx`, `SnoozeStrip.tsx` and the `.dock-strip` CSS are gone.

## Segments

- **Working** while `working` (the same flag that draws the live turn header; not while a
  permission or question waits, when the header goes too). The working `StatusCircle`, "Working"
  and the elapsed time. The time is the header's: the live header row's `since` (its message),
  that item's `createdAtMs`, or the setup's end when later, formatted by `formatDuration` with the
  header's units. The `Elapsed` child alone ticks on the shared 1 s clock. Not a button.
- **Snooze**: the alarm clock (amber, with the words, for a woken thread), then "Snoozed until
  <time>", "Saved for later" or "Snooze ended <ago>". A Radix dropdown opening upward: a label
  with the whole state ("Saved for later, no alarm" for a saved one), then Dismiss snooze
  (`thread.snooze --clear`) or, woken, Clear (`thread.snooze.clear`), then `SnoozePresetItems`,
  the same menu every other surface has. Every action the bar had is there, through the same
  commands. A snoozed thread's new time is `inView` (it stays open, no toast); a woken one snoozed
  again closes its tab, so it toasts, as the bar's Snooze again did.
- **Waiting**: the waiting circle, "Waiting on" and the bar's words ("2 threads, 1 PR and 1
  timer"). A Radix popover opening upward with the panel. Idle, **Stop waiting** is its own
  segment beside it; while working it is only in the panel ("Stop waiting on all"). With only
  subagents left neither shows, as before. The disabled-until-current rule and the hiding while
  the Watch fails carry over unchanged.
- **Jump to bottom**: the chip's action through the bridge (pin, drop the spacer, scroll down).
  `data-testid="thread-jump-bottom"` kept, with `data-shown="true"`; it is absent, not hidden,
  when the list is at its bottom.
- A button segment ends in a chevron, right when closed, up when open; hover, focus and open give
  it the control-hover background. Menus open over the conversation and close on outside click or
  Escape.

## Shrinking

The order: 1 the waiting list becomes a count ("Waiting on 6"), 2 snooze drops its time
("Snoozed", saved too; "Snooze ended"), 3 Working drops its word, 4 Waiting drops its words.
Jump to bottom and Stop waiting never shrink. `pillStep` returns the fewest steps that fit, the last
when none does. Each shortened segment's tooltip holds its full text (`Tip` with label "" when
it shows everything).

- **Measured, not guessed.** An invisible copy of every form of every present segment (same
  classes: padding, gaps, icons as boxes of their size, chevrons) is laid out in the row, clipped
  so it never overflows what holds the row. The border and one 1px divider per pair are added as
  `chrome`. The working segment is measured with "59m 59s" and "23h 59m" and the wider is taken,
  so a ticking timer never flips the form.
- **Before paint.** A layout effect after every render of the row and a ResizeObserver on the row
  and on the measuring copy set the step; React flushes a layout effect's state before paint, so
  no form that does not fit is ever drawn. A row not laid out (0 wide) keeps its step.
- **480px.** With all four at a 480px pane the row is 387px wide (the dock's 40px sides, the
  gutter). Measured there: Working (timer) 85, Snoozed 99, the waiting count 58, Jump to bottom
  124, so step 4 is 371px. The first build (10px padding, 6px gaps) did not fit even at step 4
  (401px); segments are 8px padding and 4px gaps. Step 3 is needed at 640 and step 4 at 480, so
  steps 1 and 2 alone are not enough, as the user suspected.

## Geometry

- The row takes the place of the dock's 32px top padding (`padding-top: 0` while the dock holds
  one): the pill sits at the row's top, 4px above the composer, and an empty dock is exactly as
  tall as it was before. The first try (8px padding, row, 4px gap) made the dock 12px taller and
  pushed a long answer's top under the tab strip.
- The row is always in the dock, so `bottomInset` (the dock's measured height) includes it and
  nothing moves when a segment comes or goes (`e2e/composer-row.spec.ts`).
- The row has `pointer-events: none`; only the pill takes the pointer, so the fade's margins stay
  click-through as the old padding was.
- The AskStrip and the docked permission and question cards are inside the composer card, under
  the row, unchanged. `useAskStrip` measures the dock, which now includes the row as it included
  the strips.

## Mock

- `POST /__mock/thread/wakes?id=s-r1`: the sample wakes on a thread in whatever state it is in
  (a working one too).
- `POST /__mock/thread/snooze?…&live=1`: only the snooze, the thread left running
  (`World.markSnoozed`), for Working and Snooze together. Today the daemon stops a thread it
  snoozes; another PR makes a message leave the snooze in place, and the pill already draws both
  when the data says so.

## Tests

- `lib/composerPill.test.ts`: segments per state, forms per step, the step over combinations and
  widths (all four at 640 and at 480), the words.
- `ComposerRow.test.tsx`: segments per thread state and order, the timer, Jump to bottom through
  the bridge, the snooze menu's contents and the command each item runs, shortening with laid-out
  widths and tooltips only on shortened segments.
- `WaitingPanel.test.tsx` (was `WaitingStrip.test.tsx`): the panel's rows and controls through
  the pill.
- e2e `composer-row.spec.ts` (was `waiting-strip.spec.ts`): nothing moves when the pill comes and
  goes, the panel opens over the conversation, the list over the stream, all four fit at 480 and
  640; SHOTS. `snooze.spec.ts`, `thread-dock-height.spec.ts`, `thread-switch-place.spec.ts` and
  `thread-message-fold.spec.ts` follow the new test ids (an absent jump segment is `toHaveCount(0)`:
  `not.toHaveAttribute` fails on a missing element).

## Gotchas

- Failing on origin/main as well, checked in a clean worktree, so not this change:
  `thread.spec.ts` "streaming: … Copy shows on hover" (the long answer's Copy button lies under
  the tab strip), and after #815 three `thread-switch-place.spec.ts` tests (row 119 is never
  drawn).
- The measuring copy must inherit the pill's type role: set on the row, not the pill, or it
  measures at the page's 16px and every pill shortens too far.
