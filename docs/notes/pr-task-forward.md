# PR panel redesign, PR E: a task sent to a parent reaches the thread that owns the link

The readiness rows' ▾ menu (D2, `pr-panel-tasks.md`) now lists only the user's own
threads, and `pr.task --thread <T>` forwards the task to the thread whose work the pull
request is when T has the link only through a thread it created.

## Why

A thread's linked pull requests include its created threads' (transitively,
`prlink_children.go`), and child threads are never in the sidebar while their creator is
alive. So the user sees the pull request on the parent (a lead thread, or Ember, which
creates every worker), not on the child that opened it. Sending the task to the parent
would make it do the work itself or re-delegate by hand. The daemon now does the hop.

## Daemon

- `ThreadService.PullRequestOwner(id, repo_slugs, number)` → `owner_thread_id`
  (`internal/store/thread/prlink_owner.go`). `LinkOwner` is pure: it finds T's row for the
  pull request (number plus any of the slugs, case aside: the argument and GitHub's current
  name for a renamed repository; `findLink` takes the first matching row, so a thread
  holding rows for the same pull request under an old and a new slug, which is rare,
  answers by the first of them). A row that is not `child` makes its thread the owner. A
  `child` row follows `via_thread_id` (the direct child) hop by hop. A hop that is gone or
  being removed, a hop without the row, an empty via, a cycle, or more than
  `MaxLineageDepth` hops answers T itself: T can delegate. An archived owner is still the
  owner (the send revives it, as thread.send does). An unknown or removed T is NotFound or
  RemovedError, as Get answers.
- `ThreadService.AddNote(thread_id, text)` (`note.go`): a `note` item at the thread's
  current position through `verbItem` (the runner's goroutine while it runs, else the
  stopped thread's log), as ShowHtml places a page. No turn starts and the thread is not
  unarchived. Text goes on one line, capped at 500 characters. No new item kind: the GUI
  already renders notes (fork, move, project-set notes use the same kind).
- A note that arrives while a turn is open stays inside that turn (any note: a
  background shell's stop, an agent's note, the forward's). Before, both the daemon's
  `openTurn` (`turnclose.go`) and the GUI's `buildTurns` (`lib/threadTimeline.ts`) ended
  the turn at a note, so a forward noted in a working parent split its turn in two: a
  header and fold for the half before the note, the rest as a turn of its own. Now a
  note is in the open turn's body (a `system` row, which never folds away; a final
  answer before it stays final, `markFinal` skips it), a message after it is a steer,
  and it starts no turn of its own (`startsTurn`). Between turns it stands alone as
  before, also after an error alone (a process that ended after its turn): the
  daemon's `startsTurn` and the GUI's `holdsTurn` agree that errors, notes, pages,
  themes and command output alone are no turn (`[user, turnEnd, error, note]` is the
  turn, the error, then the note on its own). The one note that still ends a turn is a fork's (`note-fork-<parent>`,
  `forkNotePrefix`, `isForkNote` on both sides): it ends the copied history, which may
  stop mid-turn.
- `Thread.HandledThrough` (`handled.go`): the highest ordinal of a message that a turn
  which ended took in. The log keeps the highest ordinal of a top-level message Claude
  took in (appended not queued, or read since: `consume`, or left unread by a process
  that ended: `closeUnfinished`), and copies it at each top-level turn end. The runner
  publishes it with the status (`publishStatus`; a turn that ends with the status it
  had, "finished" then "finished", publishes it alone) and when the process ends
  (`finish`, after `cutTurn`'s synthetic turn end). In memory: zero after a daemon
  restart until the thread runs.
- A message sent while the thread starts (`runner.queue`, held for the handshake behind
  the first prompt) is written `Queued` and stays so until it goes out; `sendMessage`
  then sets the flag to what Claude does with it (queued when it works on the first
  prompt, taken in at once otherwise). Before, it was written not queued, so it counted
  as taken at once and the first prompt's turn end moved `HandledThrough` past it: a
  forward to a starting owner woke the sender before the owner read the task. A send
  during a restart is held unwritten and written when the new process takes it
  (`onRestarted`), so the interrupted turn's end never counted it.
- `SubscribeThreadRequest.before_send` and `after_ordinal`, thread targets only, not
  both (in memory, as `subRec.unarmed`, `through`, `armReq`):
  - `before_send` makes a subscription that never fires until armed. With the same
    subscription (subscriber, target, condition) existing, it leaves that one as it is
    (existed). Its target may be archived: the send unarchives it (an archived owner is
    still the owner). Before, it was refused ("thread X is archived"), so the forward
    promised no wake for a reason the send itself made untrue. Should the owner stay
    archived (the send failed), the arming is refused as before. An archived target's
    publish drops subscriptions to it (`observeLocked`); should one between the
    subscription and the send drop it, the arming makes a new one.
  - `after_ordinal` (the sent message's ordinal) arms an unarmed one, or makes one: the
    target meets the condition only once its `HandledThrough` reached the ordinal, or
    when it waits on a pending request other than the one pending at the arming. It
    fires at once when that already happened (a turn that ended before the arming).
    With an armed one existing (another forward's), it waits for the later of the two
    messages. With any other existing (a `--notify` repeat one), the repeat flag, note
    and gate stay; the arming's note goes on one wake only (`subRec.extra`, joined after
    the stored note with "; "): the first whose target's `HandledThrough` reached the
    arming's ordinal (`extraNote.through`, `dueExtra`), so it does not ride on an
    earlier wake about a turn from before the task; two forwards close together put
    both notes on the wake after both were handled, each on its own wake otherwise. The
    same note armed twice waits for the later ordinal. A held lead wake
    (`subscriptions_hold.go`) keeps those notes when a new fire replaces it, handed on
    one by one (`Subscription.wakeExtra`, in memory) so a note said again is not
    repeated.
  - Not persisted: after a daemon restart the subscription fires on the next
    transition, as any subscription does. So one left unarmed (the daemon stopped
    between the subscription and the send, or between the send and the arming) or
    gated (the task not handled yet) becomes an ordinary one-shot settled subscription:
    it can fire on the owner's next transition even though the owner never handled the
    task, or never got it (the send did not happen). The wake then reads as any
    settled wake with the forward's note; the sender can check the owner's timeline.
- `pr.task --thread T` (`commands_prtask.go`, `commands_prtask_forward.go`):
  1. Get T (removed: thread.send's removed answer, as before), then PullRequestOwner. An
     error there, or an owner that cannot be read, sends to T (logged).
  2. Subscribe T to the owner, before the send: settled, one-shot, `before_send`, note
     `pr.task forwarded from you: <task title> on <slug>#N` (the wake carries it, plus
     the owner's report and last message as every thread wake does).
  3. Build the follow-up prompt with a second line, "The user sent this task from thread
     `<T name> (<T id>)`, which has this PR through you; it is woken with your report
     when you finish, so end with `code-foundry thread report` as usual." From an agent's
     CLI the line reads "This task was sent …" (`ForwardedByUser` is the GUI's
     ActiveView). When step 2 was refused (T archived, or the owner already subscribes
     to T, which would wake them in a loop), the line ends at "through you." and
     promises nothing (`ForwardedNoWake`). Then send it to the owner (`by_thread_id` as
     before). If the owner was removed between the read and the send, the subscription
     made in step 2 is dropped (not one that existed) and the task goes to T instead,
     with no note and no wake.
  4. Arm the subscription with the message's ordinal (`after_ordinal`). If that fails,
     or the send answered no ordinal (a real send always does; arming on 1 instead, as
     before, would have fired on whatever turn ended first), the subscription made in
     step 2 is dropped and the note and the message say no wake comes ("the send did
     not say which message to wait for"; the prompt already went out).
  5. Note in T: `Sent to <owner name> (<owner id>): <task title> (#N)`, N the pull
     request, then `; it will not wake this thread: <why>` when there is no wake.
  6. Result `{threadId: owner, viaThreadId: T, sent, ordinal}`, message
     `Sent to <owner> for <T> (#N); <next>`, then `; <T> will not be woken: <why>` when
     there is no wake. The note and the arming are best effort: the task went out, so
     their failures are logged, not returned.
  When T owns the link itself (or has none), nothing changes: no note, no wake.
- `prTask.title` names each kind for the note and the wake: "Fix the failing checks",
  "Address the requested changes", "Address the unresolved conversations", "Resolve the
  conflicts", "Bring the branch up to date", "Review it (read-only)".

## Why the handled ordinal

The first version armed a "next" subscription, which fires on the target's next
transition into settled and never at once. On the scratch daemon, fakeclaude replays a
turn in milliseconds, inside the 100 ms status debounce: the child went from idle "at
prompt" straight to needs attention "finished", settled to settled, so no transition
happened and the parent was never woken.

The second gated on `StatusChangedAt` at or after the send. Review found it fired early:
any status change after the send counts, such as a lead's "waiting on N threads" count
changing or a viewed "finished" cleared to idle, before the owner even read the task. It
could also never fire: "finished", a turn inside the debounce, "finished" again leaves
`StatusChangedAt` unchanged.

Now the wake waits for a turn that took the message in to end. The message's ordinal
alone does not say that: a message sent while Claude works is queued and read either by
the running turn (at its next tool call) or, when it came as the reply ended, by the
next turn, so the running turn's end can come after the ordinal without having read it.
`HandledThrough` counts a message only once it was taken in, and only at the turn end
after that. It covers all of the above: an early status change never fires; a turn
inside the debounce fires on the published handled ordinal; a turn that ended before the
arming fires at once; a queued message waits for the turn that read it.

Subscribing before the send (an unarmed subscription, armed after it) is what lets the
prompt promise the wake only when it will come: a refusal is known before the message is
written.

## GUI

- `useTaskRouting.ts`: `userThread(t, byId)` is `t.resident === "ember"` or
  (`!isOwned(t) && inSidebar(t, byId)`). Those are the sidebar's own two rules (plugin
  and resident threads are left out of its lists; `lib/inSidebar.ts` hides a child whose
  creator exists), not a copy of them. The candidates are the threads that link the pull
  request, encoded as string keys (id, archived, activity, links, user, name) and compared
  with `useShallow`, as before. `headPaths` and the projects-store read for it are gone.
- `taskRouting.ts`: targets = the selection when it is a user thread linking the pull
  request ("this thread", the default), then the other user threads linking it that are
  not archived, by most recent activity then id, uncapped, then "In a new thread" (the
  default otherwise, still listed last). Ember is a target like any other user thread: it
  is "this thread" when its chat is selected and it links the PR. A selected child thread
  (opened from its creator) is not "this thread". `OTHER_THREADS`, `onHead` and `ember`
  are gone.
- `stores/prTasks.ts`: `parseTaskResult` reads `viaThreadId`. A forwarded result toasts
  `forwardToast`: "Sent to <owner name> for this thread" when sent from the thread that
  was selected when the button was pressed (`runPrTask` reads the selection first, so a
  user who moved on before the daemon answered still reads "for this thread"), else
  "… for <sender name>" (a thread picked in the menu), with names from the threads store
  (id when unnamed). Open selects the owner, a child thread included: the
  ui store selects hidden threads as the lineage group does, and the sidebar highlights
  its anchor.

## Mock

`mock/prTask.ts` mirrors the forward: `linkOwner` over the mock's links, where `via` marks
a child copy (new optional field on `MockThread.linkedPullRequests`). It sends to the
owner with a stand-in forwarded line, adds the note through `logs.addNote`, and returns
`viaThreadId`. The wake is not mirrored (the mock's threads never settle from a task).
`POST /__mock/link-pr?thread=…&slug=…&number=…&up=1` copies a link up the creator chain
with `via`, as the daemon does; without `up`, nothing changes for existing tests.
`mock/prTask.test.ts` covers `linkOwner`.

## Gotchas

- A one-shot settled wake also fires on the owner's first permission prompt or question
  asked after the arming: the parent may then step in (answer it, or tell the user). The
  owner's next turn end does not wake the parent again; the one-shot is gone.
- A deeper chain can wake the lead twice. Lead → sub-lead → worker, the worker owning
  the link: the lead's forward wakes the lead when the worker's turn ends, and the
  sub-lead's own `--notify` on the worker wakes the sub-lead, whose turn end then wakes
  the lead through the lead's `--notify` on the sub-lead. Not fixed: suppressing the
  second wake would need the lead's subscription on the sub-lead to know the sub-lead's
  turn was only about the forwarded task.

- In the GUI `CallerThreadID` is the selected thread (Invoke overlays it), so after a
  forward `sendNext` lists the sender's subscriptions and finds the one just made: the
  message's tail reads "you are subscribed (…)". The toast cuts that tail anyway.
- `commandtest.Thread` gained `Owners`, `GetErrs` and `SendErrs` (per-thread answers) and
  implements PullRequestOwner and AddNote. `threadtest.Fake` implements them with
  `thread.LinkOwner` over its threads.
- The guide lists `pr.task` by name only; the `thread` argument's description now says
  the task may be forwarded, so `pr.task --help` and the pull-request topic tell agents.

## Verification

- Go: `TestLinkOwner` (direct; branch and manual links are own links; no link; one and
  two hops; an intermediate thread's own link; removed hop; removed owner; hop without
  the link; empty via; cycles; renamed slug, case aside), `TestLinkOwnerDepth`,
  `TestPullRequestOwnerManager` (a real creator chain, archived owner, removed hop,
  removed T), `TestAddNote` (live and stopped, no message and no turn, empty refused),
  `TestOpenTurn` (a note mid-turn, right after the message, between turns, before a
  message, before a turn Claude starts itself; a fork's note after an open copied
  turn), `TestCloseOpenTurn` (the turn closed after a mid-turn note is the message's),
  `TestHandledThrough` (queued then read, a subagent's turn end, left unread by a
  process that ended, loaded from the database), `TestHandledThroughPublished` (a live
  runner, "finished" twice), `TestSubscribeSendGate` (the handling turn's end fires
  once; early changes, a turn ending without reading a queued message, a prompt pending
  at the arming and a still working target do not; a turn already over at the arming,
  "finished" twice, a new prompt do), `TestSubscribeSendGateUnarmed`,
  `TestSubscribeSendGateExisting` (a `--notify` repeat one: two forwards' notes on its
  first wake after both were handled only, the stored one unchanged; another forward's one-shot waits for the
  later message and carries both notes), `TestSubscribeSendGateRefused`,
  `TestLeadWakeHeldKeepsForwardNote`, and `TestPullRequestTask` cases: forward from the
  GUI, forward from an agent's CLI, a send answering no ordinal (no wake, why in the
  note and the message), unreadable owner, owner
  removed before the send (the subscription made for it dropped; one that existed
  kept), a sender that cannot be woken, arming that fails after the send, both slugs.
  Also `TestPRTaskPromptForwarded` (every kind; backticks and `@` neutralized in the
  name; the no-wake line).
- Second review round: `TestSubscribeSendGateArchivedTarget` (an archived owner: before
  the send accepted, armed refused without a send, the send revives it, one wake after
  the turn that read it, nothing left), `TestHandledThroughHeldWhileStarting` (a message
  sent during StateStarting behind a first prompt is queued until delivered and still
  queued once sent; the first prompt's turn end leaves `HandledThrough` below it and
  wakes no forward), `TestHandledThroughHeldByRestart` (a send during a busy restart:
  not counted while the new process's turn that reads it waits on a permission prompt,
  counted and one wake after it ends), `TestSubscribeSendGateExisting` (a `--notify`
  wake from a turn before the forward has the stored note alone, the wake after the
  child handled both forwards has both notes, the next one the stored note alone),
  `TestLeadWakeHeldKeepsForwardNote` (the held wake's note handed on to the replacing
  fire once, with a second forward's note, the same task forwarded again not
  repeated), `threadTimeline.test.ts` (`[user, text, turnEnd, error, note, user]`: the
  note stands alone).
- Vitest: `threadTimeline.test.ts` (`[user, tool, note, tool, text, turnEnd]` is one
  turn with the note in its body, kept when folded, the answer final; a note after the
  answer; a note keeps a running turn open and a message after it is a steer; a note
  after an error; a fork's note still ends a cut turn), `prTasksRun.test.ts` (the toast
  wording follows the thread selected when the button was pressed, not when the answer
  came), `taskRouting.test.ts` (every rule above), `useTaskRouting.test.ts`
  (`userThread`, key round trip, the hook against the stores including an orphaned child
  becoming the user's, result stability), `prTasks.test.ts` (`viaThreadId`,
  `forwardToast`), `PrTasks.test.tsx` (menu without the child, forwarded toast, Open
  selects the child, no "In this thread" when not linked).
- Scratch daemon (`CODE_FOUNDRY_HOME=/tmp/cf-fwd-home`; `advanced.claude_path` is a
  wrapper running `cmd/fakeclaude` on `text-table.jsonl`, so turns end at once and no
  real Claude ran): no-project "Parent lead" and "Child worker" (`--created-by` parent);
  `thread pr link alexwaumann/code-foundry#493 --id <child>` gave the parent the copy.
  - `pr task alexwaumann/code-foundry 493 review-request --thread <parent> --json` printed
    `{"threadId":"<child>","viaThreadId":"<parent>","sent":true,"ordinal":2}`. The child
    got the prompt with the forwarded line and the parent got the note.
  - With the first ("next") version the parent was not woken; that is what led to `after`.
  - After the change: with the daemon stopped, `pr task … conversations --thread <parent>`
    started the stopped child with the task. Its turn ended within about 140 ms of the
    subscription, and the parent was woken once ("Thread "Child worker" … needs attention:
    finished without a report"), with no subscription left.
  - `--thread <child>`: sent there, no note, no subscription.
  - `AlexWaumann/Code-Foundry` as the slug was still forwarded.
- Review fixes, scratch daemon (`CODE_FOUNDRY_HOME=/tmp/cf-fwd2-home`, fakeclaude from
  this branch on a capture of `text-table.jsonl` repeated six times with ids made unique
  per turn; the first runs replayed the same ids each turn, so a second turn rewrote the
  first in place). No real Claude ran.
  - Forward to a running child: `{"threadId":"<child>","viaThreadId":"<parent>",
    "sent":true,"ordinal":5}`; the child's turn end came at #7, after the message, and
    the parent was woken once, with no subscription left.
  - A child made with `--notify`: with fakeclaude as is, its turn ends inside the status
    debounce, so the existing repeat subscription sees no transition and the forward
    woke nothing (the edge-triggered `--notify` misses such a turn too; a real turn is
    far longer than 100 ms). With the wrapper slowed to 50 ms a line (a turn of about a
    second), the parent got one more wake, whose note was the forward's alone, and the
    repeat subscription stayed (fired 2, no note).
  - Refused: the child subscribed to the parent with `--repeat`; the forward said
    "Parent two (…) will not be woken: thread <child> already subscribes to thread
    <parent> (…); subscribing back would wake them in a loop", the note said "it will not
    wake this thread: …", and the child's prompt line ended at "which has this PR through
    you."
  - A stopped child (after a daemon restart): the send started it, its turn end came
    after the message, and the parent was woken once.
- Mock (`make drive`): lineage fixture, `link-pr` on `s-l-child` with `up=1`, #145 opened
  in "Fix login redirect"'s panel. The menu read "In this thread ✓ / In Fix resize race /
  In a new thread" (the child not listed). "In this thread" toasted "Sent to Add retry to
  login redirect for this thread" with Open, and the note showed in the parent's
  conversation. Open selected `s-l-child`. Dark and light screenshots are in the PR.
