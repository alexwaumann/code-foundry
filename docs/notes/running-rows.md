# Running rows

While a thread works, rows inside the turn showed lucide's `LoaderCircle` spinning once a
second: in place of the tool's icon on the collapsed strip row, at the right end of a running
tool row and of a running Agent row. One line below the turn header's slow dashed circle, it
read as a second, busier mark for the same state. A user picked the replacement from an
animated sketch of five options: option B ("no extra mark") at its calm speed. Their words:
it should look calm, nobody is expected to watch these rows, and it must still be obvious
that something is happening.

## Decisions

- **No mark on a running row.** The tool keeps its own icon, tinted with the info tone
  (`t-sky`, `--cf-info-text`), and its label carries the live header's shimmer. Elapsed time
  stays where it was. Applies to the strip row (`StripLatest`), a running tool row and a
  running Agent row (`ToolRow`; an Agent row counts as running while its run runs, also when
  the daemon already marked the call done, as the spinner did). A row waiting for permission
  is waiting, not running.
- **One shimmer.** `components/thread/Shimmer.tsx` is the header's mechanism, now shared: a
  `--cf-text-muted` → `--cf-text` → `--cf-text-muted` gradient clipped to the glyphs, its
  `background-position` moving (`thread.css` `cf-shimmer`). The live turn header, Ember's
  live work line and running rows use it. Theme tokens only, so it follows dark, light and
  custom themes; in light the band is the dark text tone over the muted one.
- **Calm timing.** The sketch's calm speeds: a row sweeps once in 2.4 s, the header in 2 s
  (`SHIMMER_PERIOD_MS`, `lib/shimmer.ts`). Shimmer.tsx sets the duration inline, so the CSS's `2s` is only the
  fallback for a bare `.shimmer` (SetupRow's "Setting up").
- **Phase and wave.** Like StatusCircle, each shimmer takes a negative `animation-delay` from
  the page clock when it mounts, so a row scrolled back into the virtualized list carries on
  where it was. A row's band also starts `ROW_STAGGER_MS` (140 ms, the sketch's) times its
  item's ordinal later, so tools running in parallel (consecutive items) read as one wave going
  down rather than N flickers. No per-row timer. The daemon's ordinals step by 1; the mock's
  step by 10, so in the mock a batch steps 1.4 s (mod 2.4 s) apart.
- **Plays under Reduce Motion.** It says something is running, it is not a transition
  (`working-circle.md`, `arrival-tilt.md`). Neither the header's shimmer nor the rows' had or
  has a `prefers-reduced-motion` gate.
- **Accessible name.** The running icon carries `role="img"` and `aria-label="Running"`, where
  the spinner had the label (now also on the strip row, whose spinner was hidden).
- **Ember's live work line** gets the header treatment: `StatusCircle tone="working"` in place
  of the spinner, and the same shimmer on "Working".
- **Left alone:** busy buttons and loading states, an Action tab's running mark, the plugin
  `running` tone, TerminalHost, SetupRow's live "Setting up" line (it still has a spinner; a
  turn-header analogue left for its own change).

## Differences from the sketch

- The sketch's shimmer is two counter-moving transforms over a masked copy of the label (its
  own note says "unlike the header's shimmer today"). Here it is the header's
  background-position shimmer, so the two stay one family and the label is not rendered twice.
- In the sketch the label's parts keep their colours and the band brightens them. With the
  gradient clipped to the label's text, every part takes the band while it runs: the bold
  target and mono command sit at the muted tone between sweeps, and go back to their own
  colours when the row finishes. A colour change only, nothing moves.
- The gradient spans twice the label's own width (as the header's does), so on a long label
  the band takes longer to cross than on "Working", and half of each cycle it is off the text.

## Gotchas

- `background-clip: text` on the shimmer span paints the band through the descendants' glyphs
  only if their own colour is transparent: `.row .lbl .shimmer *` sets that, beating
  `.row .lbl b` and the detail's `text-cf-text-muted`.
- The mock had no way to start a running tool in a live turn; `POST /__mock/thread/tool`
  (`command=…`, or `name=` and `input=<json>`) appends one, for the e2e and screenshots.

## Tests

- vitest: `rows.test.tsx` (running tool row among finished ones, waiting tool, parallel batch
  stagger, strip row), `agentRows.test.tsx` (running, done-but-run-running, failed and done
  runs), `Shimmer.test.tsx` (phase, remount), `EmberTimeline.test.tsx` (live line).
- e2e `running-rows.spec.ts`: under `reducedMotion: 'reduce'` a running row's label runs
  `cf-shimmer` for 2400 ms forever, clipped to text, its icon in the info tone, and the
  header's Working runs `cf-shimmer` for 2000 ms. SHOTS=<dir> saves the PR's screenshots.
