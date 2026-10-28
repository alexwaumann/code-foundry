# Thread prompt rail (2026-10-28)

A user asked for up-arrow prompt recall. Part of the reason was orientation: "a quick way
to cycle back and see what I asked". That is a reading job, so the thread pane gets a
prompt rail instead. Each user prompt gets one small tick in the timeline's left gutter.
Hovering a tick shows the prompt; clicking it jumps there. This is PR C of four, GUI only,
with no daemon change.

## What it does

- Where: `components/thread/PromptRail.tsx`, drawn by `TimelineList` as an overlay outside
  the scroller. It sits in the 40px left gutter the rows already leave (`left-2`, a 24px
  button around an 8px bar), so it adds no width. It is centred between the body's top
  and the dock, with 16px clear at each end. Only ThreadBody turns it on (`<Timeline
  rail>`). The inline thread view, the subagent pane and Ember's chat do not show it.
- Ticks: one per `user` row in the timeline's row model (lib/threadTimeline buildRows),
  minus wakes (the daemon's subscription messages render as WakeNotes, not bubbles). A tick
  is an 8×2 `rounded-full` bar. At rest it is `bg-cf-text-muted/45`; the hovered, focused
  and in-view ticks are `bg-cf-text`. There is no background and no border.
- In view: the last prompt whose row top is at or above the middle of the area above the
  composer. At the list's end (within 4px) the last prompt counts as in view, even when its
  turn is too short to reach the middle. Without that rule, a short final turn left the
  previous tick lit while the reader was looking at the last turn. Row tops come from the
  virtualizer's `measurementsCache` (measured, else estimated), so unmounted rows count.
  The rail reads the scroll in one rAF per frame and sets state only when the index
  changes. TimelineList already re-renders on scroll, but the rail is `memo` with stable
  props (`list` is memoized on the virtualizer), so only the rail updates.
- Tooltip: the repo's `Tip`, side right, `max-w-65` (the 260px cap). It shows the prompt
  clamped to two lines, then "<sent time> · n of N" in `text-caption` muted. The text is
  `promptPreview`: tags read as their labels (/skill, file name, thread name, #PR,
  "Assistant quote"), images and PDFs are left out, and whitespace is collapsed. A prompt
  with attachments only reads "Attachments only".
- Click or Enter: `list.scrollToRow(index)` unpins the list first, the same as the cite
  layer's `showRow`; otherwise the pinned list's scroll handler would pull back to the
  bottom. It then calls the virtualizer's `scrollToIndex(index, { align: "start" })`, which
  re-measures until estimated rows above have settled. The new `scrollPaddingStart: 16`
  lands the row 16px under the top; it only affects start/auto alignment, and the cite
  layer uses center. `onMouseDown` preventDefault keeps the focus in the composer.
- Fit: `railGap(count, available)` tries gaps of 6, 3 and 2px. Each tick takes its bar plus
  one gap (the gap is the button's hit area, split above and below the bar). If no gap
  fits, there is no rail; it never overflows. With fewer than two prompts there is no rail
  either. `available` is the scroller's clientHeight less the dock height and margins,
  measured once per resize by a ResizeObserver.
- Accessibility: `nav` "Prompts" around an `ol`. Each tick is a button labelled "Prompt n
  of N: <first 60 characters>…", the in-view one has `aria-current="location"`, and the
  focus-visible ring is `ring-2 ring-cf-focus/50`.

## Other changes

- UserBubble's `timeOf` moved to `lib/format.ts` as `sentTime`, shared by the bubble and
  the tooltip's meta line.
- `TimelineList` takes `overlay` (a render prop) and exposes `TimelineListApi` (`scroller`,
  `rowStart`, `scrollToRow`) to it.

## Gotchas

- `pnpm run e2e -- e2e/<spec>` passes a literal `--` to Playwright, which then ignores the
  file filter and starts the whole suite. Use `E2E_MOCK_PORT=7830 E2E_VITE_PORT=9330
  E2E_WORKERS=1 pnpm exec playwright test e2e/thread-prompt-rail.spec.ts --workers 1`.
  Killing the runner can leave its mock servers holding the ports.
- The skill tag in the mock's first prompt is followed directly by "." in the parsed text
  ("/tdd."). The space in the composer text belongs to the token.

## Verification

`make check`. `src/lib/promptRail.test.ts` has table tests for the gap fit, the in-view
index (including the end rule), the preview text and the tick label.
`e2e/thread-prompt-rail.spec.ts` covers: the rail on the idle thread's two prompts
(inside the gutter, above the composer, 8×2 bars); no rail on the one-prompt streaming
thread; the tooltip's text, two-line clamp, 260px cap and side; a click scrolling the row
near the top with the composer keeping focus; the in-view tick following scroll; keyboard
Enter; and sent prompts adding ticks. With `SHOTS=<dir>` it writes the PR's dark and light
screenshots. The spec passed with `--repeat-each 3`.
