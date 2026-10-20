# Ember fixes 1: the GUI findings G1–G6 (2026-10-20)

The first Ember battle test (`ember-experiments-2026-10-20.md`) found six GUI problems.
This PR fixes them. It touches the daemon in one place: the board's view of a task's
thread now carries the threads below it (G3).

## G3: a lead's team on the board

**Daemon.** `EmberTaskThread` gains these fields:

- `descendants_working` (13), `descendants_waiting` (14) and `descendants_total` (15);
- `descendants` (16): up to 10 `EmberTaskDescendant {id, name, status, status_reason,
  report_status, report_summary, state, last_activity_at, depth}`.

`internal/store/ember/team.go` derives them in `publishLocked`:

- It builds one `teamIndex` per publish (threads by id plus their lineage).
- It walks `thread.Subtree`, the same walk as `--descendants-of`.
- Archived threads are left out.
- Working means busy, starting, or idle "waiting on …" (a sub-lead).
- Waiting means NeedsAttention with a `permission:` or `question:` reason while the
  process runs. The rule is the same as the thread store's `requestKey`, which is not
  exported, so `team.go` has its own copy.

The store already republishes on every thread event and deep-compares the result, so a
change to any descendant publishes the board again.

The team is derived only for **open** tasks (todo, doing, blocked). A done task's team
does not matter on the board, and leaving it out keeps the team's activity from
republishing the board. The CLI's JSON view (`commands_ember*`) does not show the team;
that file belongs to the skill/CLI PR.

**GUI** (`lib/ember.ts`):

- A doing or blocked card draws its thread's team under that thread's row (`teamRows`):
  - each row is indented by its depth (`pl-4`, `pl-7`, `pl-10`), with dot, name, report
    or words, and age, and opens its thread on click;
  - "+N more threads" follows when the daemon lists fewer than the total;
  - a thread that already has a subtask row is not repeated.
- A subtask's own worker can be a lead, so its team shows too.
- A thread "waiting on N child threads" reads **Working** (sky) in `workerWords` and counts
  in `workerBusy`. This applies everywhere: the card, the worker row, and Ember's own
  thread on the pinned row.
- `workingThreads` (the header's "N threads working", the row's "N threads", a link's "N
  working") counts distinct ids over task threads and listed team members. It adds the
  daemon's counts for members past the first ten. A lead waiting on its team counts as one
  working thread, as the brief asked: notes + lead + two busy workers read "4 threads".

## G2: a worker waiting on the user reaches the row and the bell

`waitingThreads(tasks)` counts the threads waiting on the user's answer, over the workers
of **doing and blocked** tasks and their teams. Blocked is included beyond the brief's
"doing": Ember may block a task while its worker asks.

When that count is above zero:

- the pinned row says **Needs input** (amber);
- the flame shows attention;
- the bell counts Ember once (`emberAttentionId(threads, enabled, workersWaiting)`);
- the bell's click or cmd+shift+a selects Ember first (the existing order);
- a lead's card says Needs input instead of Working.

Opening Ember's chat does not clear it: the count comes from the board, so only an answer
does.

Order of the row's words: Ember's own prompt or error, then a worker's Needs input, then
Ember's Finished or Working, then Working while a task is doing, else Idle.

The board stream is held by the sidebar row, so the bell is current whenever the sidebar
shows. With the sidebar hidden, cmd+shift+a reads the last board the stream sent, which
may be stale.

## G1: path chips in Ember's chat

- `PathPlaceContext` takes a `PathPlaceSource`: a fixed place, or a function that may
  refuse a path. `EmberBody` provides `projectPlace(roots, path)`, which accepts only an
  absolute path under a registered project's worktree (the deepest root wins; that root
  becomes the base and the project the owner).
- A refused path renders as plain `<code>` (`data-testid="path-plain"`), and a tool row's
  path is not a button. Relative and `~/` paths are refused: Ember's directory is no
  checkout.
- The roots come from a `useShallow` list of `"<id> <path>"` strings, so a git refresh
  does not re-render the chat.
- `matchPath` now rejects a segment with `..` inside it (anything but `..` itself). That
  covers git ranges like `main..cf/x` and `origin/main...cf/x`, in code and prose.

## G4: blocked outcome clamped

A blocked card's outcome is a button with `line-clamp-3` and `whitespace-pre-line`. A
click opens it in full and closes it again (`aria-expanded`). There is no tooltip: a long
npm error is too big for one.

## G5: skipped

The row would need Ember's last reply text. The thread list does not carry it, and the
chat's items are loaded only while it is watched, which is exactly when the reply is not
"unseen". Doing this needs the daemon to mark the turn (for example a status reason, or a
field on `EmberStatus`, which belongs to the wake-batching PR). The attention flame and
"Finished" still say there is something to read.

## G6: thinking-only runs

- `buildEmberRows` draws no work row for a finished run made only of a wake, thinking and
  turn ends: a progress wake Ember only acknowledged. A live run keeps its row, since Ember
  may still run a tool.
- A run without tools (thinking only) takes its "Worked for" from its turn's
  `durationMs`: the first turn end at or after the run's first item (`turnEndAfter`, a
  walk done only for tool-less runs; `runMs`).

## Mock

`mock/ember.ts` seeds a lead with a team:

- task t-4c5d6e7f "Validate notes API input" (doing) on s-ember-lead, idle "waiting on 2
  child threads";
- three workers it created:
  - s-ember-team-schema (finished, report done);
  - s-ember-team-post (busy);
  - s-ember-team-put (busy, progress report).

`World.addEmberWorkers` sets each fixture's `createdBy`. `MockEmber` derives the team the
way the daemon does (deps `children` and `createdBy`), and `watches` walks up the creator
chain, so a team member's status change republishes the board.

`mock/emberChat.ts` gains a fourth section:

- a progress wake from the lead and thinking only (no work row);
- a reply with `/Users/dev/src/code-foundry/README.md` (a chip), `README.md` and
  `main..cf/notes-validation` (plain code), and the lead's task link.

## Tests

- Go: `team_test.go`, with a table over a lead, a sub-lead, archived, stopped and starting
  members and the ten-row cap, plus a store test that publishes a worker's busy and then
  its question, with a done task's team left out.
- Unit:
  - `lib/ember.test.ts`: the team rows, the counts, the waiting rules, the row's words, the
    card meta, the flame, the quiet run and the turn duration;
  - `lib/pathChips.test.ts`: git ranges and `projectPlace`;
  - `stores/ember.test.ts`: the bell with waiting workers.
- e2e `ember.spec.ts`:
  - G3: the team under the lead, a member finishing updates the header and the row, and a
    team row opens its thread;
  - G2: Needs input on the row, the attention flame and the bell's count, the bell going to
    Ember, the chat not clearing it, the board's row and card, and an answer clearing it;
  - G1: one chip, the plain code, the range, and the chip opening the File tab;
  - G6: still three work rows;
  - updated counts: "4 threads", "3 in progress".

## Gotchas

- `workerWords` now takes any thread-like object (state, status, reason, and optionally
  archived and removed), so `emberStatusWords` no longer builds a fake
  `EmberTaskThreadView`.
- The other two parallel PRs touch `ember.proto` too (wake batching may add `EmberStatus`
  fields). The fields here are on `EmberTaskThread` (13–16) and a new message only. After
  a rebase, run `make gen`.
