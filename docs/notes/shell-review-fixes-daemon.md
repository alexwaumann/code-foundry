# Shell review fixes: the daemon

A review of the whole `shell` branch found nine things on the daemon's side. Each was confirmed
with a test that failed on the code before this change (run against a checkout of `shell` at
`55f0b3c90`) and fixed at its cause. The GUI's findings are another pull request; this one
touches the window only at the sidebar drop's call site (item 9), the mock and generated code.

## 1. Removing a space killed its threads' terminals

**Cause.** `RemoveSpace` (`internal/layout/ops_space.go`) set each moved thread's `Remembered`
to nil and put every tab of the space in `Result.Closed`, linked terminal tabs included. The glue
ends every closed terminal tab the layout no longer holds, so an open linked terminal was killed,
and a closed thread's remembered running terminal lost its record and ran on with no tab. That
was a decision of `shell-6-lifecycle.md` ("the threads move with no remembered set"), now
superseded.

**Rule now.** A moved thread is closed as `close_thread` closes it: its tab closes, its linked tabs
in the space join its remembered set (`Result.Kept`), its earlier set is kept, and its terminals
keep running. Opening it in its new space brings them back, placed fresh (their panes are gone).
A linked tab of a thread that lives in another space (dragged here by itself) joins that thread's
set the same way, so its terminal keeps running too. Only the space's other tabs are in
`Result.Closed`, so only unlinked terminals end. With "archive them all", `space.remove` archives
the threads first, and the archive rule applies: their terminals end and their records go.
`RemoveSpace` now takes the pane area (`W`, `H`), as `close_thread` does, to record where each
tab sat. `shell-model.md` states the rule.

## 2. Opening an archived thread switched to the default space

**Cause.** `ArchiveThread` deletes the thread's record, and a thread with no record lives in the
default space, so `OpenThread` opened its tab there and `show(..., focus)` made that space current.
The layout cannot tell an archived thread from a default-space thread: neither has a record.

**Rule now.** `OpenThread.Archived` says the thread lives in no space: its tab opens in the current
space (the pane's, when one is given), which it then lives in. `thread.open` and `thread.focus` set
it from the thread store. The glue no longer moves such a thread when it is unarchived: an
unarchived thread joins the current space unless its tab is open, since it then lives where it
opened.

## 3. A snooze lost the thread's terminal tabs in other spaces

**Cause.** `SnoozeThread` closed the thread's terminal tabs in other spaces into `Result.Closed`
and did not remember them, so they ended and never came back.

**Rule now.** They join the remembered set, marked fresh like the rest, each with the space it was
in (`RememberedTab.Space`, `RememberedTab.space_id` in the proto). Opening the thread puts such a
tab back in that space, in its old pane at its old index (or its old pane rebuilt beside its
neighbours), with a fresh shell; when that space or pane is gone it is placed beside the thread as
any other record. `layout show` names the space.

## 4. A thread or a page could end the user's drafts

**Cause.** `composer.draft.discard` and `composer.draft.clear` are `PageState` and had no caller
check, so a thread's model or a page could end a draft and lose its text.

**Rule now.** A draft is the user's text. From a thread's context (the CLI in a thread, not the
user in person) the two verbs are refused with a message that says the user can do it from the
draft's row. From a page they ask the user first, naming the draft by its label (`pageAsks`), and
an allowed call runs. The window, the user's own CLI and a plugin run them as before. Reading
draft ids stays open: `layout show --json` lists every space's drafts to anyone.

Why "ask" for a page rather than a refusal: the page verb classes put verbs that destroy app state
in `PageState` (they run nothing), and the gate's tool for "this one is different" is a question.
A page that offers a "discard draft" button stays possible, behind the user's yes. A thread has no
one to ask, so it is refused.

## 5. A page could re-run a custom command line through a reset

**Cause.** `terminal.reset` is `PageState`, so a page's call ran unasked, and it starts the old
terminal's argv again, which may have come from `terminal.new --argv`, a verb that asks a page.

**Rule now.** A reset of a terminal whose argv is not the plain login shell (`$SHELL -l`) asks a
page exactly as starting it does: "Run this?", the call, and the argv, every word quoted; a call too
long to show is refused. A plain shell's reset runs unasked. Other callers are unchanged.

## 6. The glue could miss events

**Confirmed.** `bus.Publish` never blocks: when a subscriber's buffer (256) is full it drops the
event for that subscriber and counts it. The glue acts on each layout commit's result and each
thread event; a burst larger than its buffer while it is busy (a big archive, a glue op waiting on
a terminal start) would lose those: terminals of closed tabs never ended, fresh shells never
started, new threads never placed. The minute sweep only repairs terminals that are gone.
`TestLayoutGlueCatchesUpAfterDroppedEvents` holds the glue in a fresh shell's start with a buffer of
two, closes four terminal tabs and creates four threads, then lets it go: before this change two
shells kept running.

**Rule now.** After each event and on each sweep tick the glue compares each subscription's
`Dropped()` with what it has caught up on. For layout events it compares the state after the last
commit it acted on (the bus event now carries `State`, Go only) with the snapshot now: a terminal
held then and not now ends (unless a reset replaced it), and a tab restored as a fresh shell in
between gets its shell; commits at or below the snapshot's rev are then skipped. For thread events
it runs every thread of the thread store's snapshot through the same rules (new ones join a space,
unarchived ones the current space, gone ones are forgotten). Terminal events are still repaired by
the sweep. The buffer is an option (`layoutGlueOptions.Buffer`, default 256) for the test.

## 7. Going back to an older build wiped the layout

**Cause.** The store's load (`internal/store/layout/db.go`) treated a document of a newer version
as corrupt: it dropped it to an empty one, and Sanitize dropped tabs of unknown kinds, then the
store rewrote every row. So a downgrade after a layout version bump, or a new tab kind, erased
spaces, panes and remembered sets.

**Rule now.** What only a newer build writes is left on disk as it is: a space or thread document of
a newer version, a tab (open or remembered) of a kind this build does not know, a node of a type it
does not know (`core.FromNewerBuild`). When the load finds any, the store logs it once and saves
nothing: the window shows and changes the layout as far as this build understands it, in memory
only, and the newer build finds its layout as it left it. `Snapshot.Newer` lists what was found,
and `layout show` says so on its second line. Documents that are corrupt (not JSON, out of normal
form) are repaired and rewritten as before. Because an unknown kind now means "newer", a kind must
never be removed from the identity table (a comment there says so).

The window does not show a notice yet; that is the GUI's, and out of this change.

## 8. "Archive them all" missed orphaned children

**Cause.** `space.remove --archive` listed threads with `created_by: user`, but the sidebar also
lists a thread's child once its creator no longer exists (`thread.Thread.InSidebar`). Such a child
was moved instead of archived, and not counted in the question.

**Rule now.** The command lists threads with archived ones included (so an archived creator still
counts as existing) and archives every unarchived thread of the space the sidebar shows: no
creator, or a creator that is gone. A child whose creator exists is archived with its creator by the
thread store, as before. The command test's thread fake now honours `created_by: user`, which it
ignored, so the old behaviour shows in a test. The mock's world does the same
(`sidebarThreads`).

## 9. A sidebar row dropped on the grid was two commands

**Cause.** The window sent `thread.open` into a pane, then `tab.move` of the tab it opened; a
refusal or a failure between the two left the thread open in the wrong place.

**Rule now.** `open_thread` takes the place: `Index` with `Pane` (a place in that strip), `Edge`
with `Pane` (a new pane on that edge of it, half its size), `Edge` alone (a new pane on that edge
of the whole pane area at a thread's default size; a space showing only its empty composer still
has it replaced). `Result.Rule` is "edge" for a new pane. `thread.open` takes `--index`,
`--split` with `--edge`, and `--outer`, as `tab.move` does; `OpenThreadOp` has `index` and `edge`.
The window's one call site (`components/shell/ShellDnd.tsx dropThread`, with
`shell/drag/threadDrop.ts threadDropArgs`) sends one `thread.open`. The linked tabs a thread brings
back are now placed around where it landed, not where it opened first. The mock does the same.

## Verification

- Go, each failing on the old code first: the op cases `remove_space-keeps-linked-terminals`,
  `remove_space-default` and `snooze_thread-open` (both changed: they pinned the old behaviour),
  `open_thread-archived-current-space`, `-archived-pane`, `-index`, `-edge`, `-outer`,
  `-after-snooze-other-space`, plus `-not-archived-default-space`, `-outer-replaces-composer`,
  `-after-snooze-other-space-gone`, `-index-without-pane`, `-bad-edge`; the glue's
  `TestLayoutGlueRemoveSpaceKeepsThreadTerminals` (move and archive),
  `TestLayoutGlueUnarchivedOpenThreadStays`, `TestLayoutGlueCatchesUpAfterDroppedEvents`; the
  store's `TestANewerBuildsLayoutIsNotWrittenOver` (five ways); the commands'
  `TestThreadOpenArchivedOpensInTheCurrentSpace`, `TestThreadOpenAtADropPlace`,
  `TestDraftsAreTheUsers`, `TestTerminalResetFromAPage`, `TestSpaceRemoveArchivesTheSidebarsThreads`;
  the API's `TestLayoutOpenThreadAtAPlace`. The property test is green. The glue tests ran with
  `-race -count=3`.
- The mock: `remove_space` keeps what moved threads remember; the two cases that now report `kept`
  are skipped as "a remembered set", the rest still run. `thread.open` takes the place and an
  archived thread (`layoutVerbs.test.ts`).

### End to end with the built binary

`make build`, a daemon on `CODE_FOUNDRY_HOME=$(mktemp -d /tmp/cfrev.XXXX)`, stopped by its pid and
the home removed afterwards.

Removing a space with a closed thread's remembered running terminal and an open thread's linked
terminal, moving them:

```
$ code-foundry space new --name Work --focus
$ code-foundry thread new --no-project --name One --created-by=     # s-f3851fafd5b0
$ code-foundry thread new --no-project --name Two --created-by=     # s-aee4dd0b230c
$ code-foundry thread open s-f3851fafd5b0
$ code-foundry terminal new --context-thread s-f3851fafd5b0
created terminal t-e2641798205e; tab t-vrol75s4 in pane p-e646euoe
$ code-foundry thread open s-aee4dd0b230c
$ code-foundry terminal new --context-thread s-aee4dd0b230c
created terminal t-1effb6a50f53; tab t-lewcdn2n in pane p-e646euoe
$ code-foundry terminal new-free
created terminal t-473429bea373 in /Users/alex; tab t-xgj477le in pane p-kzpa2qnt
$ code-foundry terminal rerun t-e2641798205e --command "sleep 600"
$ code-foundry terminal rerun t-1effb6a50f53 --command "sleep 601"
$ code-foundry thread close s-f3851fafd5b0
closed thread s-f3851fafd5b0's tab; 1 linked tab remembered
$ pgrep -fl "sleep 60[01]"
58825 sleep 600
58827 sleep 601
$ code-foundry space remove Work --to Main --yes
removed space sp-ibxjrpdh "Work"; 2 threads moved to "Main"
$ code-foundry terminal list
ID              STATE    CWD          RUNNING    LABELS
t-e2641798205e  running  /Users/alex  sleep 600  kind=shell project= thread=s-f3851fafd5b0 worktree=/Users/alex
t-1effb6a50f53  running  /Users/alex  sleep 601  kind=shell project= thread=s-aee4dd0b230c worktree=/Users/alex
$ pgrep -fl "sleep 60[01]"                      # the same processes; the free shell ended
58825 sleep 600
58827 sleep 601
$ code-foundry layout show
rev 10, laid out in 1180x820
space sp-xhoaawoi "Main" (current) (default: threads with no space live here)
  (no panes)
threads
  thread s-aee4dd0b230c "Two" in space sp-xhoaawoi
    remembered t-lewcdn2n terminal of s-aee4dd0b230c terminal t-1effb6a50f53 in pane p-e646euoe
  thread s-f3851fafd5b0 "One" in space sp-xhoaawoi
    remembered t-vrol75s4 terminal of s-f3851fafd5b0 terminal t-e2641798205e in pane p-e646euoe
$ code-foundry thread open s-f3851fafd5b0
opened thread s-f3851fafd5b0 as tab t-i7bq3pvk in pane p-kzpa2qnt of space sp-xhoaawoi; 1 linked tab came back
$ code-foundry thread open s-aee4dd0b230c
opened thread s-aee4dd0b230c as tab t-weuyrxcx in pane p-kzpa2qnt of space sp-xhoaawoi; 1 linked tab came back
$ code-foundry layout show
rev 12, laid out in 1180x820
space sp-xhoaawoi "Main" (current) (default: threads with no space live here)
  row s-hxc6mafv [0.49 0.21 0.30]
    pane p-kzpa2qnt (focused)
        t-i7bq3pvk thread s-f3851fafd5b0 "One"
      * t-weuyrxcx thread s-aee4dd0b230c "Two"
    pane p-e646euoe
      * t-lewcdn2n terminal of s-aee4dd0b230c "Two" terminal t-1effb6a50f53
    pane p-seayjvpm
      * t-vrol75s4 terminal of s-f3851fafd5b0 "One" terminal t-e2641798205e
$ pgrep -fl "sleep 60[01]"
58825 sleep 600
58827 sleep 601
```

An archived thread opened from a second space, then unarchived from Main:

```
$ code-foundry thread archive s-f3851fafd5b0 --yes
$ code-foundry space new --name Second --focus
$ code-foundry thread open s-f3851fafd5b0
opened thread s-f3851fafd5b0 as tab t-gcdgdht7 in pane p-b4v5jcyu of space sp-xmryqcp5
$ code-foundry space list
  1. sp-xhoaawoi  Main  2 panes, 2 tabs
* 2. sp-xmryqcp5  Second  1 pane, 1 tab
$ code-foundry space switch Main
$ code-foundry thread archive s-f3851fafd5b0 --archived=false
$ code-foundry layout show | grep s-f3851fafd5b0
    * t-gcdgdht7 thread s-f3851fafd5b0 "One"
  thread s-f3851fafd5b0 "One" in space sp-xmryqcp5
```

A snooze of a thread whose terminal tab is in another space, then reopening it:

```
$ code-foundry tab move t-lewcdn2n --space Second
$ code-foundry thread snooze s-aee4dd0b230c --until 1h
$ code-foundry layout show
space sp-xhoaawoi "Main" (current) (default: threads with no space live here)
  (no panes)
space sp-xmryqcp5 "Second"
  pane p-b4v5jcyu (focused)
    * t-gcdgdht7 thread s-f3851fafd5b0 "One"
threads
  thread s-aee4dd0b230c "Two" in space sp-xhoaawoi
    remembered t-lewcdn2n terminal of s-aee4dd0b230c terminal t-1effb6a50f53 in pane p-b4v5jcyu (comes back as a fresh shell; ran "sleep 601")
  thread s-f3851fafd5b0 "One" in space sp-xmryqcp5
$ code-foundry terminal list
ID  STATE  CWD  RUNNING  LABELS
$ code-foundry thread snooze s-aee4dd0b230c --clear
$ code-foundry thread open s-aee4dd0b230c
opened thread s-aee4dd0b230c as tab t-ueovtnkq in pane p-7o7if36f of space sp-xhoaawoi; 1 linked tab came back
$ code-foundry layout show
space sp-xhoaawoi "Main" (current) (default: threads with no space live here)
  pane p-7o7if36f (focused)
    * t-ueovtnkq thread s-aee4dd0b230c "Two"
space sp-xmryqcp5 "Second"
  pane p-b4v5jcyu (focused)
    * t-gcdgdht7 thread s-f3851fafd5b0 "One"
      t-lewcdn2n terminal of s-aee4dd0b230c "Two" terminal t-e6fd7d02b345
$ code-foundry terminal list
ID              STATE    CWD          RUNNING  LABELS
t-e6fd7d02b345  running  /Users/alex  -        kind=shell project= thread=s-aee4dd0b230c worktree=/Users/alex
```

(That run's binary printed a record from another space without its space; `layout show` now adds
"of space <id>".)

## Gotchas

- The restored tab in another space does not become its pane's active tab when that pane is the
  space's focused pane: what lands in the pane the user was in waits behind the user's tab, as
  everywhere in restore.
- An open thread can now have a remembered set (a dormant linked tab of it in a removed space). It
  comes back the next time the thread is closed and opened again; nothing reads a set while the
  thread is open.
- `layoutstore.Event.State` is shared with the snapshot: never mutate it.
