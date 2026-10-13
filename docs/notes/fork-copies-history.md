# A fork shows the conversation it continues

Status: done on branch `t3code/fork-copies-history`. `make check` green; exercised end to
end with the built app (isolated `CODE_FOUNDRY_HOME`, haiku, a scratch repo) and the
CLI. Screenshots in `fork-copies-history/`.

Before: `Manager.Fork` started the fork with no items (Claude has the history through
`--resume --fork-session`), and the thread pane said "Forked from <parent>. Claude has the
conversation so far…", looking the parent up live (a raw id once it was removed).

## What changed

* **Daemon** (`internal/store/session/fork.go`). Fork copies the parent's items into the
  fork's log, then appends a `note` item "Forked from <parent name at fork time>" (the
  parent's id when it has no name, like the GUI's title fallback). A parent that is itself
  a fork already holds its own parent's copy and note, so a fork of a fork has both notes
  with no special case (`TestForkOfAFork`, the first parent removed in between).
  * `forkItems` is pure (table test `TestForkItems`): items in order, ordinals renumbered
    from 1, ids, `parent_tool_use_id` and times kept (a copied turn happened when it
    happened). Copies are never live: streaming items are dropped (not in Claude's
    transcript yet), running tool calls end as errors ("Interrupted: the thread was forked
    before it finished."), pending permission requests and questions are cancelled with
    that reason. The parent's own items are untouched (its request still waits).
  * The note's id is `note-fork-<parent id>`.
* **Order of operations.** `thread_items.session_id` references `sessions(id)` (foreign
  keys are on) and the fork's session row is first written by `spawn`'s commit. So Fork
  builds the fork's in-memory log first (`forkLog`: `m.threads[newID]`), then spawns
  (`spawnStream`'s `m.thread` finds the hydrated log instead of loading an empty one, and
  the projector starts on it), then writes the copied rows in one transaction
  (`saveItems`, `persistForkLog`). The runner's own items get ordinals after the copy and
  never collide. A spawn failure drops the log as before. Any Watch of the fork, which
  can only start once the session is published by spawn, gets the copy in its first
  snapshot (`TestForkCopiesItems` watches right after Fork, then restarts and compares).
* **Proto**: `ThreadItem.note = 20`, `NoteItem { text }` (the payload is a oneof, so the
  new "kind" is a oneof case, not an enum value). `internal/api` maps it; `thread items`
  prints `#9 note: Forked from …`.
* **GUI**: `src/api/thread.ts` maps it to `{ kind: "note", text }`. In the timeline
  (`lib/threadTimeline.ts`) a note is a turn of its own: it closes the turn before it (a
  parent forked mid-turn ends its copied turn there) and becomes a `system` row that never
  folds. The row (`SystemNoteRow` in `rows.tsx`, `.sysnote` in `thread.css`) is the
  sketch's divider (docs/sketches/rendered-thread `.divider`): 12px muted text centered
  between two hairlines, `role="separator"`, no icon. The ThreadPane's fork empty state
  is gone; "No messages yet." stays for a thread with no items.
* **Mock**: `session.fork` copies the parent's mock log the same way and appends the
  note (`MockThreads.fork`); the e2e "a fork shows its parent's conversation, ended by a
  Forked from note" replaces "a fork starts empty, naming its parent".

## Decisions

* **The note is generic: text only, no tone.** Nothing uses a tone yet; adding
  `NoteItem.tone` later is an append-only proto change, and the GUI row is already
  kind-agnostic (it renders whatever text the daemon wrote). No icon for the same reason:
  the text says what happened.
* **Copied turns fold.** The note is the latest "turn", so every copied finished turn
  folds by default (its user message, final answer and footer stay); the fork's own turns
  start open below the note.
* **Copied from the parent's memory, not its rows**: the log is the newest state (the
  same as the rows except for streaming items, which are dropped anyway). Loading the
  parent's log for this is the usual lazy load (`m.thread`).

## Usage and cost: no double count

* **Thread usage and the Usage page** come only from the transcript fold (`usage.go`,
  `usage_runs.go`): per-source buckets in `session_usage` / `session_source_usage`,
  priced at read time. Nothing in the daemon or the GUI sums `turn_end` items (the GUI
  reads `turnCostUsd` only for one footer). The fork's copied records in Claude's
  transcript are skipped by `notBefore` as before (`TestForkSkipsParentUsage` unchanged
  and green). Live: parent 4 requests, fork 1 request (its own) after the fork's turn.
  So copied turn ends need no marker (no `copied_from` column).
* **The one reader of items for cost** is `newProjector`, which seeds the previous
  process's running totals from the log's last `turn_end` (a check that a process whose
  transcript restored nothing did not continue someone's totals). With the copy, a fork's
  projector is seeded from the parent's last turn end. That is the same relation a
  Reconnect has (the fork's process resumes the parent's conversation), so it was left as
  is: in the common case (the parent's `cost-state` restored, or a fresh total smaller
  than the parent's) the fork's first turn cost is unchanged; it only makes a fork whose
  totals unexpectedly continue the parent's report "unknown" instead of a wrong number.
  Live: the fork's first turn said $0.0003 (its own; "$0.0003 so far").

## Pending requests

The GUI's docked prompts (`useOpenRequests`) and the EventService pending badges come
from the daemon's `pending` list, which `pendingOf` derives from item state, and the
timeline's amber "waiting for you" from the request item's state. So item state does
drive them: copies are cancelled in `forkItems` (asserted: no pending in the fork, the
parent's still pending).

## Gotchas

* `spawnStream` runs `closeUnfinished` on the log and saves what it changes; on a fresh
  fork that would write before the session row exists. The copy is closed before the log
  is installed, so there is nothing for it to change.
* The fork's `Fake` (`sessiontest`) does not copy items; nothing reading the fake needs
  it.
* Screenshots: the isolated app shares WebKit localStorage with the installed one; the
  theme is a daemon setting (`appearance.theme`) of the isolated home and was put back to
  `system` before quitting. Launching a path with a space from the agent sandbox needed a
  small wrapper script.

## Live check

`make gui-build`; `CODE_FOUNDRY_HOME=/tmp/fch-home` app; `repo.add ~/cf-fork-scratch`;
`session.new --model haiku --effort medium` "Read README.md …" (Read tool + answer), then
`thread.send` "list the files with ls" (Bash + answer); `session.fork`; `thread items` on
the fork showed the eight copied items and `#9 note: Forked from readme-check`; a
follow-up in the fork ("What was the first file you read?") answered from the copied
history. `live-dark.png` / `live-light.png` are that fork; `mock-dark.png` is the mock's
fork of the scripted thread. Scratch repo and home deleted afterwards.

## Daemon restart

Needed: the copy, the note kind and the proto field are daemon changes. An older daemon
with this GUI still works (its forks start empty and say "No messages yet."). A newer daemon with an older GUI drops the note (unknown payload) and shows
the copied history.
