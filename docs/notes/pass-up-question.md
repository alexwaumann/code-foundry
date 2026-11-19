# Pass a worker's question up to the user (2026-11-19)

A lead answered every question its workers asked, and a user wanted one more option: when a
worker's question is a product decision the lead genuinely does not know, the lead hands it
to the user without answering and without stopping. Agreed design: turn sketch 6 section 3
and sketch 5 section 4, with the brief winning where they differ. Code:
`internal/store/thread/passup.go`, `internal/command/commands_thread_passup.go`,
`gui/frontend/src/lib/passUp.ts`.

## What was agreed

- One new verb for the lead, `thread pass-up <worker> [--request <id>]`. Questions only (the
  worker's pending question-tool prompt, or its `thread ask`), never a permission prompt;
  only the lead's own workers; only an open question; only once.
- To the user it is a question from the lead: the lead is in Needs you with a Question line
  "From <worker>: <question>" (the worker stays out of Needs you), the hover card and the
  popup say "<worker> has a question" with one line under the title ("Passed up by this
  thread." and, for a `thread ask`, "Until you answer, it assumes: …"), and with the lead's
  thread open it docks above the composer where the lead's own questions do (the AskStrip
  rule applies as to any ask). The worker's line in the worker card reads "asks you".
- The answer goes straight to the worker (its question tool answered as in its own thread; a
  `thread ask` answered as the lead's message) and the lead is told; the item leaves Needs you.
- The model is told, in the agreed words: "A worker's question is yours to answer. Answer it
  when you know the answer or can infer what the user wants. Pass it up (thread pass-up) only
  for a product decision you are genuinely unsure of; then keep working. Never pass up a
  permission prompt: approve or deny it yourself."

## Decisions made here

- **The name.** "pass up" is the user's word, says the direction (above the lead) and that
  the lead hands it on instead of answering. "escalate" reads as a problem, "forward" has no
  direction, "ask-user" would read as the lead's own question. Title "Pass a Question Up to
  the User"; NoPalette (an agent verb). `--by` is the lead ($CODE_FOUNDRY_THREAD).
- **The passed-up question is a question item on the lead.** `Request.PassedUp` (worker,
  its name then, kind `question`|`ask`, the worker's request id, the assumption) on a
  `KindQuestion` item the verb appends to the lead's log (on its runner while it runs, so it
  lands inside the turn that ran `thread pass-up`). The existing pending list, Needs you, the
  hover card's read, the popup, its stepper and the docked card show it with no new plumbing;
  the item persists as JSON in `thread_items.data`, so **no migration**. A `thread ask` has no
  options: its item is one question with none, answered in Other.
- **The lead's status** shows it: an overlay like the waiting one (`waiting.go shownLocked`):
  while the lead has an open pass-up and its own status is no request of its own, it reads
  NeedsAttention "question: From <worker>: <question>". So the sidebar, the dock badge and
  the window title count it like any ask on the lead with no frontend rule, and a snoozed
  lead is listed under Needs you by #813's rule and goes back to Snoozed once it is answered
  (its snooze time unchanged). The row keeps the raw status in the database
  (`commitLocked` saves `rawThread()` under this overlay), and `Thread.PassedUp` counts the
  open ones (in memory) so the events source lists a stopped lead's pending request.
- **Its own process ending does not cancel it.** `unfinished()` leaves passed-up items out,
  so `closeUnfinished`, `closeLostRun` and the effort restart leave them alone.
- **The open pass-ups are in memory** (`Manager.passUps`). A daemon restart withdraws them:
  the workers' prompts die with their processes, and a `thread ask`'s worker went on with its
  assumption. The leftover item is cancelled ("withdrawn: the app restarted") when the lead's
  log next loads (`withdrawStale`).
- **Who may pass up**: a thread above the worker by the creator chain (`createdByLocked`, as
  `holds.go` defines "created"), so a lead's lead may too. A question already passed up, a
  `thread ask` the lead answered (any message from it after the ask), a permission prompt (the
  refusal says to approve or deny it and prints the `thread respond` line), an archived or
  removed worker or lead, and nothing open are each refused with FailedPrecondition.
  Without `--request` it takes the worker's oldest pending question, else its latest ask.
- **Answering** is `Respond` on the lead with the item's request id (`pu-…`): the GUI's cards
  run `thread.respond --id <lead> --request pu-… --answer {…}` as for any question.
  `answerPassUp` claims the pass-up, then a question-tool one is `Respond` on the worker with
  the same decision (a skip is the same deny a skip in its own thread is); a `thread ask` is
  `Send` to the worker by the lead with `--reply none`: "The user answered the question you
  asked (your lead passed it up to them):" and the answer quoted. A skipped ask sends nothing
  (the worker's assumption stands). The lead's item resolves (answers, or denied "skipped").
- **The lead is told by a wake** (`kind: "answer"`), the quietest channel there is: on a
  running lead it arrives at its next tool call and starts no turn; on an idle one it starts a
  turn whose reply the worker card hides when it is `[nothing new]`. It ends with
  `WakeReplyNote` and says the answer went straight to the worker ("do not pass it on") and
  that unless it changes the lead's plan the user needs no reply. It goes outside the wake
  limit (the user caused it; it cannot loop). The GUI reads it as the worker's: `wake.ts`
  draws it "answered"/"skipped", and `workerRuns.partState` counts it as the worker working
  on (one line), so the turn joins the worker card.
- **Withdrawn**, item cancelled and Needs you cleared, when: the worker's prompt leaves pending
  any other way (answered in its thread, cancelled by an interrupt or its process ending:
  `saveItem` hears every resolved request item); the worker or the lead is archived or being
  removed (`commitLocked`). The lead hears nothing of a withdrawal: it gets the worker's own
  wakes as before.
- **The lead archived or removed**: its pass-ups are withdrawn. The existing cascade archives
  or removes its workers with it, so a worker's prompt goes with its process; only a worker
  the cascade failed to take keeps its own pending prompt, which is then the user's (the
  sidebar shows a thread whose creator is gone). A `thread ask` has nothing to fall back to:
  the worker goes on with its assumption.
- **The texts a lead reads** carry the agreed sentences, with the command: a `thread ask`
  wake, a pending question in a wake to its creator (`pendingText`, not to a permission and
  not to a subscriber that did not create the thread), and `thread wait`'s lines (an ask that
  ended the wait, a pending question of a thread the waiter created). The command's help has
  the whole rule. The orchestrate skill's body is at its budget: it got one pointer line
  (paid for by dropping the `thread new` output sentence, which the output says itself, and
  an id example); the rule and what happens after went into `reference/wakes.md` ("A worker's
  question"), and `reference/patterns.md` §5 no longer tells a lead to relay a question as
  plain text. The guide's index gained the verb; the duplicate "dotted name or spaces" line
  (the index's own note says it) paid for it.
- **Frontend**: generated types only in `api/thread.ts` (`ThreadRequestView.passedUp`,
  `ThreadPendingView.fromThreadId`). The worker card's "asks you" comes from the lead's own
  pending list (`stores/thread usePassedUpFrom`, `lib/passUp withPassedUp` in
  `stores/lineage useWorkers`): no stream on the worker. `requestLines` draws the line for a
  single passed-up request too. A passed-up request does not make the lead's composer "busy"
  (`activity.ts`): the lead may be idle. The hover card's context line skips `[nothing new]`.

## Differences from the brief and the sketches

- **A passed-up `thread ask` is not withdrawn when the worker's turn ends**, only when it is
  archived or removed. The brief says "if the worker ends"; a worker that finished on its
  assumption can still use the user's correction (the answer starts its next turn), and the
  lead keeps the same choice it had before. A question-tool prompt is withdrawn when its turn
  is cut, since the prompt itself is gone.
- **The fallback when the lead is archived or removed** is the existing cascade's: the worker
  goes too (see above), so the leaning ("falls back to the worker's own pending prompt")
  applies only to a worker the cascade could not take.
- **Pass-ups do not survive a daemon restart** (above): they are withdrawn.
- **A lead's lead may pass up** its grandchild's question: the creator chain the brief pointed
  at (`holds.go`) includes it.
- Sketch 5's step 3 shows the worker line "working · you answered"; per the brief it returns
  to its normal state.
- Sketch 6's popup line reads "a thread this one started · passed up to you · until you answer
  it assumes: …"; the cards here use one line everywhere: "Passed up by this thread. Until you
  answer, it assumes: …" (the hover card's wording in the sketch).
- The Ember skill was not changed (Ember relays its workers' questions its own way).

## Limits

- While a pass-up is open the lead's shown status is the question even when its Claude is
  working: its composer then offers no Interrupt (the status hides the busy). Sending it a
  message still works.
- If a lead ran `thread pass-up` from outside a turn (a stopped lead's CLI), the item would be
  appended after its last turn's end; the worker card then treats the next wake as a steer.
  A lead runs it from its turn, where the item lands inside it.

## Tests

- Go (`passup_test.go`): refusals (no lead, not its worker, a worker passing up its lead's, nothing
  open, an ask the lead answered, an unknown request, an archived worker), each leaving no item;
  a `thread ask` passed up (the item, the pending From, the overlay and `PassedUp`, twice
  refused, no answer refused, the answer as the lead's `--reply none` message, the wake with
  `kind: answer`, the overlay gone); skipped (nothing to the worker, the skipped wake); a
  question-tool prompt (same input, the worker's control response with the answer, its item
  answered, the wake); a permission refused with and without `--request`; withdrawn when
  answered in the worker's thread, its process closed, it archived, removed, the lead
  archived, and no wake to the lead; the lead's process ending keeps it and a restart withdraws
  it (no overlay saved); a snoozed lead keeps its snooze time through the answer and the wake;
  a grand-lead; the pass-up line in the texts. Commands: `thread.pass-up`'s requests, messages
  and refusal, and its help carrying the rule. Skills: rules for the body's pointer and the
  reference's rule (`rules_test.go`).
- vitest: the hover card's title and line for both kinds (`NeedsCard.test.tsx`), the docked
  card's title, line, Other's answer and Skip running `thread.respond` on the lead with
  `pu-…` (`PendingPrompt.test.tsx`), the Needs you line for one passed-up request
  (`ShellSidebarList.test.tsx`, `lib/needsAsk.test.ts`), the worker card's "asks you" and back
  (`stores/lineage.test.ts`, `lib/passUp.test.ts`), the answer wake's line and sender
  (`lib/wake.test.ts`, `lib/workerRuns.test.ts`), the API mapping (`api/thread.test.ts`), the
  composer not busy (`activity.test.ts`), the mock scenario (`mock/passUp.test.ts`).
- e2e: `e2e/pass-up.spec.ts` only saves the PR's screenshots (SHOTS=<dir>); nothing here needs a
  browser beyond what `shell-needs` and `worker-card` cover.

## Mock

`POST /__mock/workers?state=passup`: s-wl-lead with s-wl-2's `thread ask` passed up (the
item inside the lead's turn that ran `thread pass-up`), the lead in Needs you. Its
`thread.respond` answers it as the daemon does: the item resolves, the worker's log (when it
has one) gets the lead's message, the lead's status goes back, and a `kind: answer` wake with
a `[nothing new]` turn lands (`mock/passUp.ts`).

## End to end (2026-11-19)

`make drive DAEMON=dev` on a scratch home under `/tmp` and a scratch repository under the
home folder, `claude-haiku-5-5[1m]` at effort low for every thread:

- A lead started a worker told to `thread ask` whether a collapsed pane's body drags too,
  assuming only the gutters. The worker asked and kept working. **The lead (Haiku) did not pass
  it up on its own**: it ended the wake turn with `[nothing new]` (its assumption was fine as
  far as it could tell). Told by the user "this is a product decision I want to make: pass it
  up", it ran `code-foundry thread pass-up <worker>` and kept going. The lead appeared under
  Needs you with "From Document collapsed pane dragging in README: …"; its hover card and the
  popup read "Document collapsed pane dragging in README has a question" with the assumption
  line. Answered in the popup's Other: the worker got "The user answered the question you
  asked (your lead passed it up to them)" as its lead's message and amended its README
  commit; the lead got the answer wake, did not relay it, and replied one line; the row left
  Needs you. (After this run the wake gained "unless it changes your plan, the user needs no
  reply to it".)
- In the same lead, a second worker asked with its question tool (two shortcut options). The
  lead, now in a conversation where the user had said such decisions are theirs, passed it
  up on its own. Answered in the popup by picking an option: the worker's prompt read
  `= cmd+shift+[` exactly as if answered in its thread, it committed, and the lead was told.

The daemon was stopped with the drive (its own stop), and the scratch home, the repository
and the three Claude transcript folders the threads wrote were deleted.

## Daemon restart

Yes: a new RPC and verb, new request fields, the status overlay and new wake texts. No migration.
