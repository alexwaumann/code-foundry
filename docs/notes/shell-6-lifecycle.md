# Shell PR 6: thread and terminal lifecycle reach the layout

Sixth PR of the shell stack (`docs/notes/shell-plan.md`, section 4). Creating, archiving,
snoozing, removing and moving threads, and terminals starting, being reset and going away, now
keep the daemon's layout true. A new shell gets a tab; the quick terminal and the ring of a
thread's terminal tabs are commands. The classic window does not read the layout and works as
before.

## What is in it

| Where | Holds |
| --- | --- |
| `internal/daemon/layout.go` | the glue: thread, terminal and layout events to layout ops and terminal ends; the thread store's `ShellsGoing` hook |
| `internal/layout/terminals.go` | pure ops `set_quick`, `replace_terminal`, `drop_terminal`; `Holds`, `HeldTerminals`, `NextInRing` |
| `internal/store/layout` | `Event.Op` and `Event.Result` (Go only, never sent to a client); `Viewports`: the newest pane area of a visible window |
| `internal/store/thread/shells.go` | `Options.ShellsGoing`, called before a thread's shells are removed, with why (`ShellsArchived`, `ShellsSnoozed`, `ShellsRemoved`) |
| `internal/api` | the three ops' proto cases and converters; `Clients.Visible` |
| `internal/command/commands_terminal_quick.go` | `terminal.quick`, `terminal.cycle`, the tab `terminal.new` and `terminal.new-free` open |
| `internal/command/commands_thread_compose.go` | `thread.new --compose <tab>` |
| `internal/command/commands_layout_threads.go` | `layout show` lists each thread's stored space, quick terminal and remembered tabs |
| `gui/frontend/mock/layout.test.ts` | the mock's run of the JSON cases skips the three terminal ops (no GUI sends them yet) |

## The rules, and where each lives

- **A new thread joins a space** (glue, on the first `thread.Updated` of an id it has not seen):
  its creator's space when a thread made it, else the current space. A plugin's thread (an
  `Owner`) stays in the default space. A thread the layout already knows is left alone: that is
  the one sent from a composer.
- **Sending from a composer** is `thread.new --compose <tab>`: the command checks the tab is a
  composer before it makes the thread, then applies `open_thread` with `compose`, so the
  thread's tab takes the composer's (or the draft's) place and the thread lives in that space.
  The glue and the command may run in either order and end the same: if the glue moves the new
  thread to the current space first, `open_thread` puts it in the composer's space after.
- **An unarchived thread** joins the current space (PR 2's note): an archived one lives in no
  space.
- **Archive and remove** (hook, `ShellsArchived` / `ShellsRemoved`): `archive_thread`, closing the
  thread's tabs everywhere and dropping its record. The glue then ends the terminals it closed
  or that its set kept running. `thread.Removed` applies `archive_thread` again, for a removal
  path that skips the hook (a discarded setup goes through it too).
- **Snooze** (hook, `ShellsSnoozed`): the glue reads, for each of the thread's terminals (open
  tabs and remembered ones still running), the foreground job, else the last command, and
  applies `snooze_thread` with them. The terminal tabs stay in the set marked fresh, with that
  command. **The ordering risk** the plan names is handled by where the hook is called: in
  `removeShells` itself, before the shells are killed, so the commands can still be read and
  the tabs are already remembered as fresh when the removals arrive. A removal never forgets a
  fresh record (`drop_terminal` skips them, and the glue only drops what `Holds` says the layout
  holds). `TestShellsGoingBeforeTheShellsGo` pins the order for archive, snooze, save for later
  and remove; `TestLayoutGlueSnoozeKeepsTheSetWithFreshShells` runs the whole sequence.
- **Unsnooze and send** change nothing: the thread stays closed.
- **Opening a snoozed thread** (`open_thread`, from any client): its commit's `Result.Fresh` lists
  the restored terminal tabs; the glue starts a shell for each in the thread's checkout (thread
  labels) and points the tab at it with `replace_terminal`. The tab keeps its id, place, name and
  its `ran` param, for the GUI's "Run again" line. A thread with no checkout gets no shell, and
  the tab closes.
- **A terminal tab closed by itself ends its terminal** (glue, on any commit): every terminal tab
  in `Result.Closed` (close_tab, close_pane, remove_space, ...) and every terminal in
  `Result.Ended` is killed and removed, linked or free, unless the layout still holds it. Tabs
  closed with their thread are in `Result.Kept` and keep running. Only shells and action runs
  are ended (what `terminal.close` ends); a plugin's terminal and an unlabelled one are their
  owner's.
- **A terminal removed closes its tab** (`drop_terminal`), and a remembered running record of it is
  forgotten, so a thread never brings back a dead terminal. A shell is removed as soon as it
  exits (the reaper), so "exits" is covered for shells.
- **A reset terminal keeps its tab**: a shell labelled `replaces=<old>` points the old one's tab at
  itself (`replace_terminal`). The terminal store merges updates and removals from two
  subscriptions, so the old one's removal can arrive first; the glue then looks for a terminal
  replacing it before it drops the tab.
- **The quick terminal** is `ThreadState.quick` (plan 2.7): `set_quick` opens or closes it and
  keeps its height. When a thread's quick shell is removed and the thread has no other running
  (a reset starts the new one first), the glue draws it closed, so "open" always means a shell
  exists. A snooze removes it, so a snoozed thread comes back with it closed.
- **The sweep** (at start and every minute) drops what the layout holds of terminals that no
  longer exist and closes quick terminals with no shell: after a restart none survives, and the
  bus may drop events.
- **Viewport**: the store keeps each window's last report and lays out in the newest report of a
  window the presence registry says is visible, else the newest of any, else 1180 x 820.

## The commands

| Verb | Does | Classified |
| --- | --- | --- |
| `terminal.new` (changed) | a thread's shell gets a linked tab placed by the rules; a worktree's shell an unlinked tab in the focused pane; `--quick` none. From the user the tab takes the focus, from a thread never | unchanged |
| `terminal.new-free` (changed) | an unlinked tab in the focused pane | unchanged |
| `terminal.quick [<thread>] [--open \| --close] [--focus]` | toggle the quick terminal; opening starts the shell when none runs and, from the user, opens and focuses the thread; closing leaves the shell running. Default: the thread of the focused tab (a linked surface's thread); from inside a thread the id is required | no palette, no chord, no index |
| `terminal.cycle [--tab] [--focus]` | the ring: the thread, its terminal tabs in layout order (its space only), the thread; from a view, the first terminal; from the last terminal of a closed thread, the thread opens. Only moves focus: refused from a thread without `--focus` | no palette, no chord, no index |
| `thread.new --compose <tab>` | the new thread's tab takes that composer's place | unchanged |

`terminal.quick` and `terminal.cycle` stay out of the palette until the shell window draws the
quick terminal and terminal tabs (PR 13), and out of the agents' index (they are the user's
keys; adding them put the guide 54 bytes over its budget).

## Decisions

- **The commit carries its op and result on the bus** (`Event.Op`, `Event.Result`), not the store
  calling the glue. Every client's op (GUI, CLI, a model, the glue's own) reaches the same
  handler, and the store still never looks at threads or terminals.
- **A hook in the thread store, not event order.** The thread store removes the shells before it
  publishes the snooze, and the removals arrive first; no reordering of events could keep the
  set. `Options.ShellsGoing` follows `Options.Archived` and `Removed`.
- **The new shell's tab is opened by the command, not the glue**: only the command knows whether
  the user asked (focus) or a thread did (never the focus), and the glue must not give a tab to
  the fresh shells it starts itself.
- **`remove_space` ends every terminal of the tabs it closes**, linked ones too: the threads move
  with no remembered set, so nothing could bring those tabs back. The spec names only the
  unlinked ones; this PR's scope said linked or free. *Superseded*
  (`shell-review-fixes-daemon.md`): a moved thread keeps its set, its linked tabs join it, and
  only unlinked terminals end.
- **An action run that exits keeps its tab** so its output can be read, as in the classic window;
  closing the tab removes it. Shells are removed on exit, so their tabs close.
- **Unarchive joins the current space**, not the space the thread had (its record went with the
  archive).
- `drop_terminal` and `replace_terminal` are in the proto like every op (the converter test asks
  for all); clients have no reason to send them.

## Verification

- `make check` green. One unrelated timing failure in the first full run, named:
  `TestSendAfterACancelStartsOver` (thread store setup) under full-suite load; it passed 20 times
  in a row alone and was not touched.
- Pure: 12 JSON cases (`set_quick-*`, `replace_terminal-*`, `drop_terminal-*`), written as state
  and op, `want` filled by `-update` and each read against its `doc`; the property run draws the
  three ops; `TestNextInRing` (every step of the ring, a view, a terminal in another space, a
  free shell refused), `TestHeldTerminals`.
- Store: `TestViewports`. API: `TestClientsVisible`; the converter test covers the new cases.
- Thread store: `TestShellsGoingBeforeTheShellsGo` (the order, four ways).
- Glue (`internal/daemon/layout_test.go`, real ops over `layouttest`, `terminaltest` events on
  the same bus, thread events published by hand): new threads to the creator's or the current
  space, a plugin's and a composer's left alone, unarchive; snooze in the thread store's order,
  the set kept with commands, reopened with fresh shells; archive and remove (open, remembered
  and other-space terminals end); a removed thread; closed tabs end their terminals by close_tab,
  close_pane and remove_space, never a plugin's; a closed thread keeps its terminals and forgets
  one that exits; a gone terminal closes its tab; reset in both event orders; the quick terminal
  and the start sweep; a fresh shell with no checkout. Ran with `-race -count=5`.
- Commands: `TestTerminalNewOpensATab` (thread, from a thread, worktree, free, quick),
  `TestTerminalQuick`, `TestTerminalCycle`, `TestThreadNewFromAComposer`,
  `TestLayoutShowThreads`; the classification lists.

### End to end with the built binary

`make build`, a daemon on `CODE_FOUNDRY_HOME=$(mktemp -d /tmp/cf6.XXXX)` (stopped and removed
afterwards). The diff tab went through `LayoutService` with curl: `view.open.diff` is PR 7.

```
$ code-foundry thread new --no-project --name "Shell six" --created-by=
created thread Shell six (s-565dcf79c1fd) in /Users/alex (no project)
$ code-foundry thread open s-565dcf79c1fd
opened thread s-565dcf79c1fd as tab t-ua5tuziq in pane p-nd7dd7o4 of space sp-pjkzein4
$ curl --unix-socket $CODE_FOUNDRY_HOME/daemon.sock .../LayoutService/Apply -d <open the thread's diff>
{"rev":"2","spaceId":"sp-pjkzein4","paneId":"p-l5hskq5j","tabId":"t-bdbk5ihg","rule":"5"}
$ code-foundry terminal new --context-thread s-565dcf79c1fd
created terminal t-0200ef3f9a88; tab t-7cmuzdr2 in pane p-l5hskq5j
$ code-foundry terminal new --context-thread s-565dcf79c1fd
created terminal t-55dcf9deb03a; tab t-j2bguz37 in pane p-l5hskq5j
$ code-foundry terminal rerun t-0200ef3f9a88 --command "sleep 600"
$ code-foundry terminal rerun t-55dcf9deb03a --command "sleep 1"
$ code-foundry terminal list          # 6 s later
ID              STATE    CWD          RUNNING    LABELS
t-0200ef3f9a88  running  /Users/alex  sleep 600  kind=shell project= thread=s-565dcf79c1fd worktree=/Users/alex
t-55dcf9deb03a  running  /Users/alex  -          kind=shell project= thread=s-565dcf79c1fd worktree=/Users/alex
$ code-foundry layout show
rev 4, laid out in 1180x820
space sp-pjkzein4 "Main" (current) (default: threads with no space live here)
  row s-wjhni356 [0.55 0.45]
    pane p-nd7dd7o4 (focused)
      * t-ua5tuziq thread s-565dcf79c1fd "Shell six"
    pane p-l5hskq5j
        t-bdbk5ihg diff of s-565dcf79c1fd "Shell six"
        t-7cmuzdr2 terminal of s-565dcf79c1fd "Shell six" terminal t-0200ef3f9a88
      * t-j2bguz37 terminal of s-565dcf79c1fd "Shell six" terminal t-55dcf9deb03a
$ code-foundry thread snooze s-565dcf79c1fd --until 1h
snoozed thread Shell six (s-565dcf79c1fd) until Thu Nov 12 10:09 AM
$ code-foundry layout show                     # tabs gone, set kept
rev 5, laid out in 1180x820
space sp-pjkzein4 "Main" (current) (default: threads with no space live here)
  (no panes)
threads
  thread s-565dcf79c1fd "Shell six" in space sp-pjkzein4
    remembered t-bdbk5ihg diff of s-565dcf79c1fd in pane p-l5hskq5j
    remembered t-7cmuzdr2 terminal of s-565dcf79c1fd terminal t-0200ef3f9a88 in pane p-l5hskq5j (comes back as a fresh shell; ran "sleep 600")
    remembered t-j2bguz37 terminal of s-565dcf79c1fd terminal t-55dcf9deb03a in pane p-l5hskq5j (comes back as a fresh shell; ran "sleep 1")
$ code-foundry terminal list
ID  STATE  CWD  RUNNING  LABELS
$ code-foundry thread snooze s-565dcf79c1fd --clear
unsnoozed thread Shell six (s-565dcf79c1fd)
$ code-foundry layout show                     # unchanged: rev 5, the thread still closed
$ code-foundry thread open s-565dcf79c1fd
opened thread s-565dcf79c1fd as tab t-o56tgzib in pane p-nd7dd7o4 of space sp-pjkzein4; 3 linked tabs came back
$ code-foundry layout show                     # the set is back in its pane, with fresh shells
rev 8, laid out in 1180x820
space sp-pjkzein4 "Main" (current) (default: threads with no space live here)
  row s-igwlrdex [0.55 0.45]
    pane p-nd7dd7o4 (focused)
      * t-o56tgzib thread s-565dcf79c1fd "Shell six"
    pane p-l5hskq5j
        t-bdbk5ihg diff of s-565dcf79c1fd "Shell six"
        t-7cmuzdr2 terminal of s-565dcf79c1fd "Shell six" terminal t-c917300ac295
      * t-j2bguz37 terminal of s-565dcf79c1fd "Shell six" terminal t-5311b68252fa
$ code-foundry terminal list
ID              STATE    CWD          RUNNING  LABELS
t-5311b68252fa  running  /Users/alex  -        kind=shell project= thread=s-565dcf79c1fd worktree=/Users/alex
t-c917300ac295  running  /Users/alex  -        kind=shell project= thread=s-565dcf79c1fd worktree=/Users/alex
$ code-foundry layout show --json              # the terminal tabs' params
t-7cmuzdr2 {'ran': 'sleep 600', 'terminal': 't-c917300ac295'}
t-j2bguz37 {'ran': 'sleep 1', 'terminal': 't-5311b68252fa'}
$ code-foundry tab close t-j2bguz37            # a terminal tab closed by itself
closed tab t-j2bguz37
$ code-foundry terminal list                   # its terminal is gone
ID              STATE    CWD          RUNNING  LABELS
t-c917300ac295  running  /Users/alex  -        kind=shell project= thread=s-565dcf79c1fd worktree=/Users/alex
$ code-foundry thread close s-565dcf79c1fd
closed thread s-565dcf79c1fd's tab; 2 linked tabs remembered
$ code-foundry layout show
rev 10, laid out in 1180x820
space sp-pjkzein4 "Main" (current) (default: threads with no space live here)
  (no panes)
threads
  thread s-565dcf79c1fd "Shell six" in space sp-pjkzein4
    remembered t-bdbk5ihg diff of s-565dcf79c1fd in pane p-l5hskq5j
    remembered t-7cmuzdr2 terminal of s-565dcf79c1fd terminal t-c917300ac295 in pane p-l5hskq5j
$ code-foundry terminal list                   # closing the thread kept its terminal running
ID              STATE    CWD          RUNNING  LABELS
t-c917300ac295  running  /Users/alex  -        kind=shell project= thread=s-565dcf79c1fd worktree=/Users/alex
```

Then the quick terminal, the ring, a reset, a free shell, a new thread joining the current
space, an archive and a restart:

```
$ code-foundry thread open s-565dcf79c1fd
opened thread s-565dcf79c1fd as tab t-tffe4mqa in pane p-nd7dd7o4 of space sp-pjkzein4; 2 linked tabs came back
$ code-foundry terminal quick s-565dcf79c1fd
opened thread s-565dcf79c1fd's quick terminal t-c85158d94274 (started)
$ code-foundry terminal new --context-thread s-565dcf79c1fd
created terminal t-27f325d88516; tab t-alply4my in pane p-l5hskq5j
$ code-foundry terminal cycle                  # from the thread's tab: t-7cmuzdr2, t-alply4my, the thread, again
focused tab t-7cmuzdr2
focused tab t-alply4my
focused tab t-tffe4mqa
focused tab t-7cmuzdr2
$ code-foundry terminal reset t-27f325d88516
reset terminal t-27f325d88516: t-ba113646f58c starts in /Users/alex
$ code-foundry tab list                        # the tab followed the new shell
t-alply4my  sp-pjkzein4  p-l5hskq5j  terminal of s-565dcf79c1fd terminal t-ba113646f58c
$ code-foundry terminal new-free
created terminal t-723aae7a5e56 in /Users/alex; tab t-i2sea5k4 in pane p-l5hskq5j
$ code-foundry space new --name Review --focus
$ code-foundry thread new --no-project --name "Shell six two" --created-by=
created thread Shell six two (s-2ab95ae54abc) in /Users/alex (no project)
$ code-foundry thread archive s-565dcf79c1fd
$ code-foundry layout show                     # only the free shell's tab is left
space sp-pjkzein4 "Main" (default: threads with no space live here)
  pane p-l5hskq5j (focused)
    * t-i2sea5k4 terminal terminal t-723aae7a5e56
space sp-5omctov5 "Review" (current)
  (no panes)
$ code-foundry terminal list                   # the thread's three shells and its quick terminal ended
ID              STATE    CWD          RUNNING  LABELS
t-723aae7a5e56  running  /Users/alex  -        kind=shell
# daemon restarted
$ code-foundry layout show                     # the sweep dropped the tab of the shell the old daemon took with it
rev 23, laid out in 1180x820
space sp-pjkzein4 "Main" (default: threads with no space live here)
  (no panes)
space sp-5omctov5 "Review" (current)
  (no panes)
threads
  thread s-2ab95ae54abc "Shell six two" in space sp-5omctov5
$ code-foundry terminal new-free
created terminal t-13aa2c738b53 in /Users/alex; tab t-pcyet4e3 in pane p-alx3uh5a
$ code-foundry tab close t-pcyet4e3
$ code-foundry terminal list                   # a free shell ends with its tab
ID  STATE  CWD  RUNNING  LABELS
```

No warning or error in the daemon logs.

## Version window

The classic window ignores the layout. Its bottom panel still derives its tabs from terminal
labels, so a shell started there also gets a layout tab nobody sees, and closing it there
(`terminal.close`) drops that tab. A snooze, archive or removal from the classic window updates
the layout the same way. New proto cases only: an older GUI never sends them.

## Gotchas

- `terminal.Store.Watch` merges two bus subscriptions (updates and removals), so their relative
  order is not kept: never rely on a shell's start arriving before another's removal.
- A plugin terminal's tab closing must not end it (the plugin owns it); the glue ends only what
  `terminal.close` would.
- `layout show` from a new CLI against an older daemon prints the older daemon's outline: the
  text is made in the daemon.

## For later PRs

- **PR 7** (`view.open.*`): the diff above went through curl; the verbs place linked tabs the same
  way `terminal.new` now does (`openTerminalTab` is the pattern: focus from the user, never from
  a thread).
- **PR 10/11** (GUI): the window reports `SetViewport` with its client id; the visible one wins.
  `thread.new` from the shell's composer passes `--compose <tab>`. `Event.Result` stays on the
  daemon side: the GUI sees the commit's delta only.
- **PR 13** (terminal tabs, quick terminal): drop `NoPalette` from `terminal.quick` and
  `terminal.cycle`; map cmd+j (`terminal.quick`; the presenter passes `--open` when the quick
  terminal is open but not focused, so "focus when open" never closes it) and cmd+shift+j
  (`terminal.cycle`). A restored tab carries `ran` until the user runs it again
  (`terminal.rerun --command <ran>`) or the GUI clears it with `set_tab_params`; the quick
  terminal's height drag is `set_quick` with `height`: port `set_quick` to the mock
  (`mock/layout.ts`) then, and take it out of `TERMINAL_GLUE_OPS` in `mock/layout.test.ts`.
- **PR 18 / 20** (import, cutover): until the cutover, shells started in the classic window get
  layout tabs placed by the rules, so a long-running classic session builds a layout nobody has
  seen. The first-load import should start from the spec's empty space (or reconcile those
  tabs) rather than show them.
- **Restart**: no terminal survives a daemon restart, so the sweep closes their tabs. Bringing
  them back as fresh shells, as after a snooze, is a possible follow-up; the spec does not ask.
- **A free shell with no tab** (one started before this PR, or through `TerminalService.Create`)
  is never ended by the layout; only its exit removes it.
- **PR 23** (architecture doc): `internal/daemon/layout.go` and `Options.ShellsGoing` join the
  store and glue sections.
