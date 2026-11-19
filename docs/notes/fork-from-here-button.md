# Fork from here: the turn gutter's button

The GUI half of fork-from-turn.md: an icon-only "Fork from here" in a finished turn's gutter
(turn-gutter.md), right after Copy, that forks the thread up to and including that turn.

## What it does

* `components/thread/ForkFromHere.tsx` (the button) and `forkFromTurn.ts` (`useForkFromTurn`,
  held by `GutterRow` so the gutter can stay shown while it runs). It calls
  `threadActions.forkThreadAt(id, at)`: `thread.fork` through the command registry with
  `{ at: <the turn's turn_end item id> }` and the thread's context, `inView` like the menu's
  Fork. The daemon selects the new thread, so it opens the way a whole-thread fork does.
* Shown on every finished turn's gutter, interrupted and failed ones too, with or without a
  reply to copy, at rest/hover exactly as Copy (it is inside the gutter's `.in`). A running
  turn has no gutter, so no button.
* Icon: lucide `GitFork`. Nothing in the app had a fork icon (the menus' Fork is text).
  Tooltip "Fork from here" (an icon-only control's name).

## Decisions

* **The daemon judges each turn** (fork-from-turn.md "How the GUI knows"): the GUI never
  predicts a refusal. A refusal (a /clear, a compaction that kept only a summary, the next
  turn's opening not written yet) comes back as the command's error and `runCommand` toasts
  it ("Fork Thread failed" with the daemon's words), as any failed command.
* **The whole-thread fork's known rules are mirrored** from `ThreadMenuItems`: no button for
  a thread whose setup did not finish (the menu leaves Fork out); disabled once Claude Code
  deleted the transcript (`transcriptMissing`, the menu's item is disabled), with the reason
  in the tooltip ("Fork from here: the transcript was deleted").
* **Disabled is `aria-disabled`, not `disabled`**, for both the transcript case and while
  the fork runs: a disabled button gets no pointer events (no tooltip), and the older turn's
  gutter shows only while the pointer or the keyboard focus is on its turn; a `disabled`
  button would drop the focus mid-fork and hide the gutter under the user.
* **Held while it runs**: a second click is ignored until `thread.fork` answers (success or
  refusal), and the gutter's `shown` includes `held`, as it includes Copy's check.
* No height change: the button is the same `.ib` box as Copy inside the fixed 26px row.

## Tests

* `ForkFromHere.test.tsx`: its place (Copy, Fork, info), interrupted and failed turns
  without a reply, none on a running turn, the tooltip, the command and args per turn, the
  held state (no second fork, the older gutter kept shown, let go after a refusal), the
  transcript-deleted state, none for an unfinished setup.
* `rows.test.tsx`: the gutter's children now include the button; "nothing to copy" checks
  look for Copy, not for any button.
* e2e: none new beyond `fork-from-here.spec.ts`, SHOTS-only screenshots. The existing
  "hovering an older turn shows its gutter and moves nothing" covers the row's boxes.

## Verified

`make drive` (mock, s-r1 `idle`): forking from the older turn opened "Fix stale PR badge
(fork)" with "Forked from … at turn 1 of 2" (the mock got `thread.fork` with
`at: s-r1-i26`); forking from the latest gave "turn 2 of 2"; after a `/compact`, forking
from turn 1 toasted "Fork Thread failed: the conversation was compacted after turn 1 …".
