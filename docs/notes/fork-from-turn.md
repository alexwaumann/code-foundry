# Fork from a turn (daemon, proto, CLI, mock)

Status: done on branch `feat/fork-from-turn`. `make check` green; exercised end to end with
an isolated dev daemon (`CODE_FOUNDRY_HOME` under /tmp), the CLI and haiku on a scratch
repo; the run is in the PR body. The GUI's "Fork from here" button is a later PR; this
one adds no GUI control.

## What it does

`thread fork --at <turn end>` (`ForkThreadRequest.at`, one verb with `thread.fork`)
starts a fork whose conversation is the parent's up to and including that finished turn.
`at` is the turn's `turn_end` item id, or its `#ordinal` as `thread items` prints it
(the same two forms `thread wait --after` takes). The fork's timeline is the parent's
items up to that turn end, then the note "Forked from <parent> at turn N of M. The files
are as they are now, not as they were after that turn."

Like a whole-thread fork: the fork runs in the parent's checkouts as they are (files are
never rewound), its project set is copied, its linked pull requests are not, and the
parent's background shells and agents stay with the parent.

## Claude Code (2.1.325)

`--resume-session-at <uuid>` is hidden from `claude --help` (the CLI side of the SDK's
`resumeSessionAt`). With `--resume <id> --fork-session --session-id <new>` it keeps the
loaded transcript up to and including the record with that uuid, over stream-json too.
Checked on scratch sessions:

* Any record with a uuid is a valid cut: a message, an attachment (`prompt_snapshot`), a
  system record (`local_command`, the compaction boundary itself).
* An unknown uuid prints `No message found with message.uuid of: <uuid>` and exits 1
  before a session starts. So does a record before the last compaction boundary unless it
  is in that compaction's kept tail (`compactMetadata.preservedMessages.allUuids`; also
  `preservedSegment` head..tail). A cut in the kept tail works and the fork has the
  summary plus that tail; a cut at the boundary has neither (the model knew nothing).
* The fork's transcript keeps the parent's record uuids, so a fork of a fork can be cut.
* **Interrupted turn**: an interrupt ends the turn with a user record
  `[Request interrupted by user for tool use]`. Cutting after it works; the fork knows
  the turn was stopped ("the 40-second sleep was interrupted while it was running"). So
  an interrupted turn can be forked from, and the cut keeps the marker.

## The cut (`internal/store/thread/forkcut.go`)

The daemon does not store a turn's last record (a turn end is `turn-<result uuid>`, and
a result is not a transcript record), so the cut is worked out at fork time from the
parent's items and its current transcript, all before anything is spawned. Never left to
Claude's "No message found".

* **The cut is the parent of the record that opens the next turn**, not the turn's own
  last item: between turns Claude writes records no item maps to (a `prompt_snapshot`
  attachment, the interrupt marker, a local command's system record).
* **The next turn's opening**, from the items after the turn end in timeline order
  (`PlacedAfter` respected: the log is sorted that way): a user message is its own record
  (the daemon sends it with its item id as the uuid); a message Claude read mid-turn is a
  `queued_command` attachment whose `source_uuid` is our id (so a steer is never mistaken
  for an opening: it sorts before the turn end). A turn Claude opened itself (a
  background task's notification) has no user message item: its first reply is found by
  message id (`msg_…/<block>` → `message.id`) and the opening is the record before it
  that opens a turn.
* **Which records open a turn**: Claude Code marks the first record of each model turn
  with `turnOrigin` (`sdk`, `task_notification`, `peer`). A subagent's hand-back is an
  `isMeta` record with `turnOrigin: peer`, so isMeta alone does not mean "not an opening".
  Local commands (`/compact`, `/cost`, `/clear`) have no turnOrigin; for them, and for
  transcripts older than the field, any top-level user record that is not a tool result,
  meta, a compaction summary or an interrupt marker counts.
* **Stepping back** from the opening skips its preamble: meta records that open nothing
  (a local command's `<local-command-caveat>`, a subagent's tools reminder before its
  hand-back) and a compaction's summary and boundary (a `/compact` opens the next turn),
  whose `logicalParentUuid` is the record before the compaction. That is why the turn
  before a `/compact` is forkable: its replies are the kept tail.
* **Nothing after the turn end in the items**: the transcript after the turn's own
  records is searched for an opening (a background agent's report Claude has not
  answered, items not arrived yet). With none, the turn ends the conversation and the
  fork takes all of it: no `--resume-session-at`, as a whole-thread fork. A busy parent
  with no opening found is refused instead (its next turn has started but is not written
  yet).
* Lines over 8 MiB are skipped, as everywhere the daemon reads a transcript; a cut on
  such a line would be refused as "not in the conversation", never sent to Claude.

## Refusals

All before a thread row, log or process exists. Everything a whole-thread fork refuses,
plus:

| Case | Error | Message |
|---|---|---|
| no such item | INVALID_ARGUMENT | the thread has no item X (give a turn end's item id, or its #ordinal from thread items) |
| not a top-level turn end | INVALID_ARGUMENT | #N (user message) is not a turn end: --at takes the turn end of a finished turn |
| an item of the running turn | FAILED_PRECONDITION | #N is in the turn that is still running: fork from its turn end once it finishes |
| before a /clear or reseed | FAILED_PRECONDITION | turn N is not in the thread's current Claude conversation (it came before a /clear or a reseed started a new one) |
| compacted away | FAILED_PRECONDITION | the conversation was compacted after turn N and Claude keeps only a summary of it; fork from a later turn, or fork the whole thread |
| next opening not in the transcript | FAILED_PRECONDITION | the start of the turn after turn N is not in Claude's transcript yet; try again in a moment |

The turn is named by its number among the thread's top-level turn ends, the copied ones
of a fork included (a fork's own turn 1 is "turn 2 of 3" when it holds one copied turn).

## How the GUI knows which turns can be forked from

Decision: **no per-turn field; the refusal is known at fork time and the GUI shows the
daemon's message.** The GUI offers "Fork from here" on every finished top-level turn end
(a running turn has no turn end yet, so it has nothing to offer).

Why: the honest answer needs the transcript. Whether a turn survived a compaction
depends on the kept tail, whether a /clear or reseed left it in an older session depends
on which file is current, whether the next turn's opening is written yet changes by the
second. A field per turn end would mean reading the transcript on the hot path of
WatchThread (or a cached index invalidated on every transcript append), for an action
that is rare. The fork is refused before anything is made, so trying is free: one
transcript scan, no spawn, no thread row. The refusals are rare (a compaction, a /clear
or a reseed after the turn) and each message says what to do. If the GUI later wants to
grey out turns, the items already say most of it (a compaction item after the next turn
end), and the daemon stays the judge.

## Fixtures and tests

`internal/store/thread/testdata/forkcut/` are real transcripts of Claude Code 2.1.325
(haiku, driven by this daemon over stream-json; the /clear one by `claude -p` over
stream-json, its items written by hand from the uuids sent), cut down to the fields the
cut reads (no prompts, account ids or paths), with the daemon's items of the same
threads. Cases: two turns, a tool call, a steer, an interrupted turn, compaction (before
the cut, inside the kept tail, the /compact turn itself), slash commands (a prompt
command and a local command opening the next turn), a background subagent reporting
after the latest turn, a turn opened by a background task's notification, and /clear.
`TestForkCut` runs every case twice, the second time with `turnOrigin` stripped (older
transcripts): only the subagent's hand-back differs (it reads as meta, so the fork keeps
the report). No drift guard against the live CLI, by the repo's rule for Claude formats.

Also: `TestForkAt` (ids, ordinals, refusals), `TestForkAtPlacedMessage` (a message
placed after the turn end is the next turn's), `TestForkItemsAtTurn` (later subagent
items and placed messages not copied), `TestForkFromTurn` / `TestForkFromTurnRefusals` /
`TestForkFromTurnKeptTail` (the store: argv, copied items, note, no thread made on a
refusal), the launch argv table, the command test, and the mock's `thread.fork --at` in
`world.test.ts`.

## Mock

`thread.fork` takes `at`: it copies the mock log up to that turn end with the daemon's
note, and refuses as the daemon does what the items can tell: no such item, not a turn
end, an item of the running turn, and a turn a later compaction dropped (the turn right
before a compaction counts as its kept tail).

## Gotchas

* Between two turns Claude often writes a `prompt_snapshot` attachment parented to the
  last reply; the next message hangs off it. Cutting there is fine (it is the system
  prompt snapshot the next request reuses).
* `thread items --json` gives thinking items as `msg_…/0`: the message id is the key to
  assistant records, not a record uuid.
* A background agent's items keep arriving after the turn that started it ends; they sort
  after that turn end and are not copied (the fork's Claude does not have the agent).
* `~/.claude.json` keeps a project entry for every directory Claude ran in, the scratch
  repo's included; it was left alone (other Claude processes write that file).
