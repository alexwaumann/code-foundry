# Instant threads 3: the GUI renders a setup

PR 3 of 4. The daemon publishes `Thread.setup` (PRs 1 and 2); this PR shows it. Nothing in
the GUI sends `background_setup` yet and there are no buttons: PR 4 adds the composer side.
A blocking `thread new` already shows its thread during setup, so this ships value alone.

## What changed

- `ThreadView.setup` (`api/threads.ts`), compared by value in `sameThread`.
- `lib/threadSetup.ts`: every rule, pure. `setupRevealAt` (when the checklist shows),
  `setupRowPhase` (what the row model needs), `setupLines` (one per step, or per project),
  `setupView` (what the row shows now), and the sidebar's words. `isUnplaced` is the daemon's
  `Thread.unplaced`.
- `components/thread/SetupRow.tsx`: one timeline row, `{ type: "setup" }`, placed by `buildRows`
  after the first user row, or at the end for a thread with no prompt.
- Three status kinds: `settingUp`, `setupFailed`, `setupCancelled` (`lib/statusLine.ts`,
  `lib/statusRegistry.ts`).
- `mock/setup.ts` and `POST /__mock/thread/setup?id=…&state=…`: one script per state. PR 4 adds
  its actions next to `World.scriptSetup`.

## Decisions

- **One row, not a row per step.** A step changing rebuilds no rows and the virtualizer measures
  one height. The row is in the model from the first moment and renders nothing until its time,
  so the rows appearing moves nothing that is not under it.
- **The 300ms rule works from times only.** `setupRevealAt` is the first moment a step has run
  300ms, or a warned step's end. Nothing shows before it. After it every line shows except those
  that ended before it. So a line once shown stays, a fast step after a slow one keeps its row,
  and a fast step before a slow one never gets one. Failed shows every row whatever the times:
  nothing flashes, since it stays. So does an opened fold.
- **The fold line follows the same rule.** A setup whose every step was fast has none, and neither
  has one that only started Claude. A start-only setup that runs reads as today's "Working",
  in the timeline and the sidebar, however long the spawn takes: rows that went at the end
  would be the jump the design rules out. Only if it fails does it show.
- **"Working" counts from the setup's end**, not the message: "Working · 2s" under "Set up in
  6.8s", as the design has it. The turn's own `durationMs` is the daemon's and unchanged.
- **The fold warning is one phrase after the time**: "using origin/main from 2h ago", or "could not
  reach origin" when there is no such ref, or "2 projects on an old base". A warning's age is
  measured at the step's end, so a thread reopened in a month says what it said then.
- **Several projects: a warned fetch keeps its own line** above the project's. Otherwise the
  project's line moves on to the worktree and the warning goes with it. Projects keep worktree
  order, so a fetch leaving the list moves nothing.
- **A project between its fetch and its worktree shows a spinner on "Creating the worktree".** It
  is waiting for the branch's name at most. A check that went back to a spinner, or a spinner
  that went back to a dim circle, reads as going backwards.
- **The sidebar's current step is the first running one**, else the next pending. Name before
  fetch gives "Naming the branch", then "Fetching origin/main": the order things finish in.
- **`setupFailed` wins over a plugin's flag, `settingUp` and `setupCancelled` do not**: the same
  order as Claude's own errors against working and idle.
- **`setupFailed` keeps the error kinds' icon** (CircleAlert). The sketch's row had none, an artefact
  of editing text into a "Working" row.
- **The fold's expanded state is a turn fold** (`setTurnFolded`, key `setup`), which leaving the
  thread forgets, not `useRowExpanded`, which a visit survives. That is what makes it folded on a
  thread reopened later.
- **The fold keeps its place with `FoldInPlaceContext`, not `KeepRowContext`.** KeepRow's pass runs
  when rows change, before a row has its new height, so it read `scrollHeight` as still short and
  pinned the list. A turn's work opens as rows of their own; these steps open inside one row.
- **Every header in a stopped setup's thread is the synthetic one.** Such a thread has had no
  Claude, so `buildRows` drops headers for `stopped` wholesale rather than picking out the turn.
- **`failedPrompt` takes `setupUnfinished`.** The failed setup's status is fresh and the turn end
  has `process_ended`, which read as "Claude stopped before replying". ColdCacheNote, RetryNote and
  the waiting strip have nothing to read on such a thread: tests only.
- **@-files, skills and the file finder read the project's own checkout during setup**, which is
  what `threadCheckouts` resolves an unrecorded member to. A tag sent then is rewritten to the
  worktree (`rewriteFileRefs`), so this is right, not only harmless. The finder lists no changes:
  those of the main checkout are not the thread's. `useCollisions` skips such a thread, or a thread
  still in its setup would read as holding the main checkout.
- **Refused actions are left out, not left to toast.** Run in, Fork, Move, New thread on this branch
  and a new terminal go while the daemon would refuse them, Snooze and the composer's three
  pickers while a setup runs. `terminal.new` from a chord or the palette opens the panel on its empty
  state, through its presenter. The palette still lists what `When` cannot tell apart (`thread.fork`
  and the like), and those keep the daemon's refusal, which reads well.
- **`QueuedTag` says "Goes to Claude once it starts"** on a setup that has not finished. The
  tooltip it had is wrong there, and it stays queued through a failure and a restart.
- **The MCP panel says when**: "MCP servers show here once Claude has started", with no Refresh,
  which would ask the daemon for a start it refuses.
- **The error box is `text-caption font-mono`**, not `text-code`: that role is inline, 0.92em of
  whatever holds it.

## Gotchas

- In the row model, a `data-turn-end` on the setup row would give an empty row 16px. Timeline leaves
  it out, and a message after the row has its own space.
- `formatDuration` is "" under 50ms, so "Working ·" with nothing after it showed for a moment
  once the time counted from the setup's end. Live times fall back to "0s".
- `exactOptionalPropertyTypes`: `mock/setup.ts` builds timestamps by spreading, never `undefined`.
- The mock's terminal.new now refuses a thread with no cwd, as `shellOwner` does.

## For PR 4

- `Interrupt` still shows during a setup and does nothing there: it is PR 4's Cancel. Sending
  during a blocking setup is refused with a toast, which is the daemon's word on it.
- `setupStopped` and `setupUnfinished` are what the note and the placeholder need. `setupFailure`
  is the failed step's title without "so your message was not sent".
- `FailedPromptNote` stays silent on such a thread, so the setup's note has that slot to itself.
- The mock has no setup actions yet: `World.scriptSetup` moves a thread between states and
  sends the snapshot a retry sends.

## Seen end to end

A `--dev` daemon on a scratch `HOME` and `CODE_FOUNDRY_HOME` under `/tmp`, `cmd/fakeclaude` first
on `PATH` as `claude` replaying `bash.jsonl`, two scratch repos, each with a bare remote behind an
`ext::` script that sleeps; the GUI under Vite in WebKit. The fake answers the namer with nothing
usable, so branches are `cf/<id>`, the name step is too fast to get a row, and the provisional name
never swaps by itself: the swap was seen on the mock only, italic to plain in the header and the
sidebar in the same update, since both read `name` and `nameProvisional` from the one thread.

- Blocking `thread new --new-worktree`, 4s remote: the sidebar row read "Setting up 2s" and
  "Fetching origin/main". Its Create returned, the thread opened, "Set up in 4.3s" above "Working".
- `--background-setup`, 5s remote: back in 28ms. The timeline read "Setting up · 2s" over the fetch
  and two dim rows; a `thread send` during it read `queued`; then "Set up in 5.2s".
- `--projects alpha,beta`: a line per project with its fetch, the Claude line single, then
  "Set up in 3.3s".
- An unreachable origin: done, the fold line "Set up in 3.2s · using origin/main from 1m ago".
- `--branch main` with the main checkout on it: "Setup failed" and "Could not create the worktree"
  in the sidebar, a red row with the daemon's text in the box, the dim "Fetching origin/main" and
  "Starting Claude". No turn header, no failed note. A `thread send` kept the message queued
  under the rows after it failed again.
- On that thread: cmd+J and cmd+T open the panel on "A terminal can start here once the worktree
  is ready", the info card shows Context and Usage only, the file finder finds `src/main.go` in
  the main checkout, the MCP panel says when. No toast at any point.
- `thread setup cancel` at 2s: "Setup cancelled after 2s", "Cancelled" in the sidebar, no error
  colour. `thread setup retry`: back to "Setting up", then "Set up in 1.3s", the last run's time.
