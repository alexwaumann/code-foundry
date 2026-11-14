# Shell 25e: three red e2e tests after the keys and drafts step

On `origin/shell` at 0e21864e2 three e2e tests failed every run. All three pass on #712's merge
(0e1b1631e) and fail on #713's (cf/shell-25c-keys-drafts): the suite is not part of `make check`,
so that step's PR did not run it in full. None was a product regression: each test asserted, or
raced, behaviour that `shell-25c-keys-drafts.md` changed on purpose.

## plugin-gaps.spec.ts: a flagged row opens the plugin's surface

- **Failure.** `s:s-3`'s `data-section` was `attention`, not `needs`.
- **Cause.** f922b830a (Needs you lists only actionable asks): a plugin's attention flag is a
  nudge now. The row goes to the top of Active, shows the flag in its status (the plugin's name
  for screen readers) and has no Needs you card.
- **Fix (stale test).** The test reads the row in Active with its `flagAttention` status and
  "Hello", then clicks the row's title, which runs `selectThreadAndFlag` as the card's Go to
  thread did. What it is kept for is unchanged: the surface going live beside the thread.

## lineage.spec.ts: cmd+shift+a and cmd+1..9 walk the shown rows only

- **Failure.** The cmd+shift+a walk over the orphans never reached a third thread.
- **Cause.** The same commit: `s-l-allow` waits with `error: overloaded`, an API error at the
  prompt, which is no longer an ask. Only `s-2` and `s-l-cookie` (a permission) are in the round.
- **Fix (stale test).** The walk expects those two and checks `s-l-allow` sits in Active as a
  nudge.

## terminal-find.spec.ts: cmd+f follows the keyboard

- **Failure.** No thread composer: cmd+t had opened a free home terminal ("zsh · ~") in the
  thread's pane instead of a terminal linked to s-3 in a pane beside it.
- **Cause.** f4a0f4407 (cmd+t opens a free home terminal where no thread is focused): cmd+t now
  reads the focused tab's thread, not the sidebar's selection. The spec's `shell()` helper pressed
  cmd+t right after the row's click, before the layout committed the thread's tab, so the focused
  tab was still the space's empty composer. Before, the selection was set synchronously by the
  click. The decision says the focused tab decides; a person cannot press the chord inside that
  window, so the product is left as it is.
- **Fix (the race).** `shell()` waits for s-3's thread pane before cmd+t, as `terminal-tabs.spec.ts`
  `openThreadTab` already does. The other tests of the file shared the race but did not notice: a
  free terminal satisfied them.

## The whole suite

One full run on this branch (4 workers): 558 passed, 163 skipped (the SHOTS-gated screenshots),
no other failure. The three tests also passed five times each in a row.
