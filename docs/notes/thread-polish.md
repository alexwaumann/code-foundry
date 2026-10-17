# Thread polish: no Escape interrupt, finished turns fold, lighter pane, distinct user messages

Feedback from daily use, decisions confirmed by Alex.

## Escape no longer interrupts

* `thread.interrupt` has no keybinding (`internal/command/commands_thread.go`; a Go test
  pins that). The thread composer's editor no longer interrupts on Escape either
  (`ThreadComposer.tsx` dropped its `onEscape`; `PromptEditor`'s `onEscape` is optional
  now). The composer's Interrupt button is the only way in the GUI; the palette still
  offers Interrupt Thread, and the CLI verb is unchanged.
* `keys/bindings.ts` lost `chordGuards` and `activeThreadInterruptible`: thread.interrupt was
  their only user. `chordFires(chord, target)` keeps the bare-key rule (a chord without
  cmd/ctrl/alt fires only inside the content pane and outside `[data-keys-local]`) for any
  future bare-key command; its unit tests use a stand-in `demo.bare` command.
* The mock's thread.interrupt has `keybindings: []`. e2e: Escape in the empty editor and in
  the timeline sends no interrupt; the palette row shows no shortcut.

## Every finished turn folds, the latest included

* `defaultFolded(turn)` (`lib/threadTimeline.ts`) is `turn.end !== ""`: a turn folds under its
  footer the moment its `turn_end` arrives, whatever the user scrolled to or expanded
  meanwhile; a running turn is open. The footer's choice (`setTurnFolded`) still wins both
  ways. A running turn has no footer, so no choice can fold it.
  (Since `thread-fold-4-pinned-fold.md` a turn folds as it ends only while the list is
  pinned at the bottom; scrolled up, it stays open until the list pins again.)
* Timeline (`components/thread/Timeline.tsx`): pinned, nothing new is needed; the row change
  re-runs `toBottom` and the ResizeObserver keeps the bottom while rows are re-measured, so
  the new footer lands just above the composer.
* Scrolled up, the Timeline now keeps an anchor: the row at the top of the viewport and its
  offset, captured on every scroll and after every row change. When rows change it puts
  that row back at the same offset, or, when the row folded away, the next row of the old
  list that is still there (the turn's final text or footer). This matters when the user is
  reading the answer while the work above it folds: without it, `scrollTop` stays and the
  answer jumps up by the height of the folded rows. A row that takes the anchor's place
  starts at the viewport's top: it does not inherit how far the user had scrolled into the
  row that folded away (an open Edit or Bash row is hundreds of px; inheriting it hid the
  start of the answer). If the kept place is past the new bottom (the fold left too little
  below), the list pins instead so the footer shows.
* Gotcha: the anchor's new start comes from `v.measurementsCache` in a layout effect after
  render (the render already recomputed measurements via `getVirtualItems`); keys are
  stable, so measured heights carry over. An earlier version also pinned when the kept
  place was within `PIN_SLACK` of the bottom; on the mock's short thread that snapped a
  user who had scrolled to the top down by ~150px, so it pins only past the bottom.
* e2e (`thread.spec.ts`): the latest turn folds when it ends and the footer sits above the
  composer (pinned); scrolled up, a streamed delta does not move the list and the fold
  keeps the turn's bubble in place; reading a long answer, the work above it folds and the
  answer stays put (this one fails with the anchor disabled); scrolled into the work rows,
  the list pins; scrolled 150px into an open Edit row, the answer that replaces it starts at
  the viewport's top. Specs that checked a tool row after a turn ended reopen the turn first
  (`unfoldLatest` in `thread-prompts.spec.ts`).

## Lighter dark pane, user bubble variant B

* Dark `--pane` `#060606` → `#080808` (`src/index.css`), and the dark xterm `background` /
  `cursorAccent` (`src/terminal/theme.ts`) with it, so shells still read as part of the
  pane. `gui/main.go`'s `BackgroundColour` is the sheet (black), not the pane: unchanged.
  The old value stays in the static sketches under `docs/sketches` and in older notes.
* User bubble: `--t-bubble` and a new `--t-bubble-border` in `components/thread/thread.css`;
  the `.u .bubble` rule only references them. Dark `oklch(1 0 0 / 13%)` with a
  `oklch(1 0 0 / 14%)` 1px border; light `oklch(0 0 0 / 7%)` with `oklch(0 0 0 / 10%)`.
  Radius and padding unchanged (the border adds 2px to the box). `--t-bubble` has no other
  user; the composer tags inside the bubble keep their own tints and still read.

Screenshots (dark, light; the mock's streaming turn just after it ended, folded):
`thread-polish/folded-dark.png`, `thread-polish/folded-light.png`, from
`SHOTS=<dir> pnpm exec playwright test e2e/thread.spec.ts -g "folds when it ends"`.
