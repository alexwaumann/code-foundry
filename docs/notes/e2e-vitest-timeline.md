# e2e → vitest: the thread pane's timeline, prompts and rows

Part of the series in e2e-unit-duplicates.md. Area: the thread pane's timeline and its rows,
the docked prompts, the follow-up composer, the prompt rail, inline pages, citations' send
path, path chips, the subagent view and agent rows, the transcript-deleted and cold-cache
notes, and the thread panel's item actions (47 audited cases in 13 spec files).

## What moved

New component tests:

* `components/thread/PendingPrompt.test.tsx` (12): the docked permission prompt (title, the mode
  hint once, the session rule, numbered buttons), deny with a reason, Allow leaving at once,
  a withdrawn request (a plain notice, no error), parallel requests stacked oldest first (an
  Edit's change, the older answered by the editor's key), a subagent's label, the question
  pager, Other, a multi-select, the editor's digits and Enter, Escape skipping, and a
  question's page and picks surviving the timeline re-rendering. Answers go through the faked
  daemon's `thread.respond` (`src/test/daemonFakes.ts`).
* `components/thread/ThreadComposer.test.tsx` (11): the placeholder and the one Interrupt by
  busy, the effort picker (busy waits for the turn, idle applies at once, the restart line),
  the API-retry line and its countdown on fake timers, a refused message (the daemon's text,
  the draft kept, cleared by the next send), a steer through `thread.send`, a PDF follow-up
  (tile, chip with its pages, sent as `[PDF: …; ref=…-3p.pdf]`), the transcript-deleted
  composer (no cold-cache line, prompt disabled, Send and Attach disabled), and a pasted
  quote no draft has ("Nothing to send…", the chip reading "Quote", nothing sent).
* `components/compose/SlashCommandCard.test.tsx` (2): the running thread's "/" card (groups,
  Claude Code last, hint, first-line description) and the list following the process's
  commands, falling back to the disk scan when there are none.
* `components/thread/PromptRail.test.tsx` (6): no rail for one prompt, tick labels, the
  tooltip's text and time, a click scrolling its row, ticks added as prompts arrive, wakes
  left out.
* `components/thread/InlineHtml.test.tsx` (5): Source swapping the frame for the code view, a
  page that cannot be rendered, open in side panel, the turn's fold never touching a card
  (only its row; leaving the thread forgets), and the Expand modal kept per pane scope.
* `components/thread/timeline.test.tsx` (12): the rows over a copy of the mock's s-r1 "Fix
  stale PR badge": the first message's tags, turn 1 folded with its header, the explore
  groups, thinking, the asked question, Write, the failing run, a Grep's matches, the Edit's
  +6 and Copy diff, the subagent's one line and report, the answer's table and Go highlight,
  the question row, headers with and without the daemon's cost and model, streaming into the
  finished header in place, leaving the thread forgetting the folds, the idle answer's path
  chips, and a claude that did not start.
* `components/threadinfo/LineageAgents.test.tsx` (1): the card's agent rows opening their run,
  the finished ones under Previous agents.

Additions: `agentRows.test.tsx` (background runs in a finished turn: the failed note folded,
a run ending over the stream into done, its report only and a finished note; a background
shell's call running until its item ends), `SubagentPane.test.tsx` (the mock's done Explore
and failed run), `SidebarRow.test.tsx` ("did not start" and "transcript deleted" on line 3),
`rows.test.tsx` (a resolved request stops waiting; a denied one says so).

`src/test/threadWorld.ts` is a hand copy of the mock's s-r1 history (turn 1 and turn 2 for
the idle, permission, question and streaming states) as view models, with `publishThread`
and `rowsOf`. It does not import `mock/`: when mock/thread.ts's script changes, change it too.

Product code: `useSlashSource` moved out of ThreadComposer into `compose/useCompletion.ts`
(the running process's list, else the disk scan), so the card test renders the composer's
own choice. Same hooks in the same order; no behaviour change.

## e2e removed (27 cases) and shortened (19)

Removed (73.6 s of the audit's dev-server time): thread-prompts' permission panel, question
panel, Allow at once, parallel requests, effort, withdrawn answer and streaming picks (the
panel screenshots are a SHOTS-only test now); thread.spec's headers, docked question, PDF
follow-up, thread.* palette, did not start, placeholder and steer (SHOTS-only tests keep the
crashed, starting and steer shots); inline-html's source toggle, failed page, side panel and
fold (a SHOTS-only folded-open shot); the slash card (SHOTS-only) and its commands events;
thread-retry's countdown; the prompt rail's one-prompt case; path-chips' answer chips
(SHOTS-only); agents-panel's two timeline tests; subagent-view's strip and card test;
transcript-deleted's Archive and Remove.

Shortened to their browser part (70.2 s on the dev server before, 43.1 s on the bundled
build with two workers after): the timeline (wheel to an earlier turn, the diff's lines in
@pierre/diffs' shadow root, the table's computed header), streaming (the caret, following
the bottom, Copy's hover opacity), the permission's amber and place (both schemes), leaving
a thread (pinned at the bottom on return), the first message's PDFs (pdf.js thumbnails and
pages), the retry and cold-cache notes' place above the editor, the subagent label's
truncation tooltip, the question keys from the real editor, the refused command cleared by
typing, the rail tooltip's clamp and cap and one real send, the open page kept per thread
(the sidebar under the modal, its frame loading again), the hover-only Opens in
subagent-view, the transcript-deleted prompt taking no typing, Go to source not replayed,
and the panel items arriving over the stream.

Kept as it was: thread-slash-commands' "a built-in inserts plain text; a skill keeps its
tag" (it is already only the ProseMirror part; the hook's logic is in useCompletion.test).

## Rules that belong in Go

The thread.* palette test asserted the mock's availability rule; the daemon's is
`internal/command/commands_thread_test.go` TestThreadCommandsAvailability. That test lists
send, respond, interrupt, items and set-*, not thread.fork, which the e2e test also checked
on a page. What follows an answer (Claude's reply, the denied or ran row), the effort's
"Set effort to" note, the refusals and their aliases, and the restart after a failed start
are the daemon's script too.

## Gotchas

* The real ProseMirror editor runs in jsdom far enough for these tests: `insertChips` makes a
  PDF chip, and a draft set before the composer mounts shows its tags, but tag node views
  render through React a tick later (wait for them). A draft changed after mount does not
  reach the editor; `sendThreadDraft` reads the store, so sending still works.
* @pierre/diffs renders only its icon sprite in jsdom (lines come later, off the main
  path): assert `diffs-container`, leave the lines to e2e.
* PendingPrompt focuses the deny reason and Other in a `requestAnimationFrame`; running the
  callback at once finds no input yet. The test queues frames and flushes them.
* A fixture needs turn ends: without one, the next user message is a steer, not a turn.
* Path chips take the project from the thread's `projectId` in the threads store.
* PromptRail measures its scroller: give the fake one a `clientHeight`.
* `oxlint`'s react rule rejects a component writing to a module variable during render; hand
  the component a module-level ref object instead.
