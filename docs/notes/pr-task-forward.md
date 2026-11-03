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
  name for a renamed repository). A row that is not `child` makes its thread the owner. A
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
- `SubscribeThreadRequest.after` (Timestamp), thread targets only: the target meets the
  condition only once its `StatusChangedAt` is at or after this time. An existing
  subscription with the same subscriber, target and condition is returned unchanged
  (existed): its repeat flag and note stay. So Ember's or a lead's `--notify` repeat
  subscription is never turned into a one-shot, and T is still woken once (by that
  subscription). Not persisted: after a daemon restart it fires on the next transition,
  as any subscription does.
- `pr.task --thread T` (`commands_prtask.go`, `commands_prtask_forward.go`):
  1. Get T (removed: thread.send's removed answer, as before), then PullRequestOwner. An
     error there, or an owner that cannot be read, sends to T (logged).
  2. Forward: build the follow-up prompt with a second line, "The user sent this task
     from thread `<T name> (<T id>)`, which has this PR through you; it is woken with
     your report when you finish, so end with `code-foundry thread report` as usual."
     From an agent's CLI the line reads "This task was sent …" (`ForwardedByUser` is the
     GUI's ActiveView). Then send it to the owner (`by_thread_id` as before). If the
     owner was removed between the read and the send, the task goes to T instead, with
     no note and no wake.
  3. Note in T: `Sent to <owner name> (<owner id>): <task title> (#N)`, N the pull request.
  4. Subscribe T to the owner: settled, one-shot, `after` = the time taken just before the
     send, note `pr.task forwarded from you: <task title> on <slug>#N` (the wake carries
     it, plus the owner's report and last message as every thread wake does).
  5. Result `{threadId: owner, viaThreadId: T, sent, ordinal}`, message
     `Sent to <owner> for <T> (#N); <next>`. The note and the wake are best effort: the
     task went out, so their failures are logged, not returned.
  When T owns the link itself (or has none), nothing changes: no note, no wake.
- `prTask.title` names each kind for the note and the wake: "Fix the failing checks",
  "Address the requested changes", "Address the unresolved conversations", "Resolve the
  conflicts", "Bring the branch up to date", "Review it (read-only)".

## Why `after` and not "next transition"

The first version armed a "next" subscription, which fires on the target's next
transition into settled and never at once. On the scratch daemon, fakeclaude replays a
turn in milliseconds, inside the 100 ms status debounce. The child went from idle "at
prompt" straight to needs attention "finished", which is settled to settled, so no
transition happened and the parent was never woken. A real turn takes longer than the
debounce, but a turn that ends before the subscription lands has the same shape. Gating
on `StatusChangedAt >= send time` covers all of these:

- a busy status that is published fires on the settle that follows;
- busy debounced away still fires on the settled status that changed after the send;
- a turn already over when Subscribe runs fires at once;
- a stale settled status from before the send never fires.

The one blind spot: a status that is identical before and after ("finished" → busy
debounced away → "finished") leaves `StatusChangedAt` unchanged. That needs a whole turn
inside 100 ms of a thread already at "finished", which a real model does not do.

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
  `forwardToast`: "Sent to <owner name> for this thread" when sent from the selected
  thread, else "… for <sender name>" (a thread picked in the menu), with names from the
  threads store (id when unnamed). Open selects the owner, a child thread included: the
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
  `TestSubscribeAfter` (busy then finished, finished straight from idle, one-shot, still
  working, an old status published again), `TestSubscribeAfterAlreadySettled`,
  `TestSubscribeAfterKeepsExisting`, and `TestPullRequestTask` cases: forward from the
  GUI, forward from an agent's CLI, unreadable owner, owner removed before the send,
  both slugs. Also `TestPRTaskPromptForwarded` (every kind; backticks and `@`
  neutralized in the name).
- Vitest: `taskRouting.test.ts` (every rule above), `useTaskRouting.test.ts`
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
- Mock (`make drive`): lineage fixture, `link-pr` on `s-l-child` with `up=1`, #145 opened
  in "Fix login redirect"'s panel. The menu read "In this thread ✓ / In Fix resize race /
  In a new thread" (the child not listed). "In this thread" toasted "Sent to Add retry to
  login redirect for this thread" with Open, and the note showed in the parent's
  conversation. Open selected `s-l-child`. Dark and light screenshots are in the PR.
