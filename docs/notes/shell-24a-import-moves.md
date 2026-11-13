# Shell 24a: import and move hardening

Hardening of the window shell before it merges to `main`: the first-load import, restoring a
thread's set, moving a pane with threads, plugin surfaces opened for a thread, the way back to a
build from before the shell, and who reads a terminal's command lines. Seven items, each fixed at
its cause with tests. The specification (`shell-model.md`) did not change.

## 1. The import drops tabs the window could only show as gone

**Cause.** The import (`internal/layout/legacy.go`) checked each tab against its kind (a diff
without a checkout, a pull request with a bad number) but not against what the daemon has. A diff
of a project no longer registered opened as "Project not found"; a tab of a plugin surface no
installed plugin offers opened as "This surface is gone".

**Fix.** `LegacyInput` gains `Projects` (registered project ids) and `Surfaces` (every surface an
installed plugin offers, as a tab kind `plugin.<plugin>.<surface>`). The import's `add` drops a
diff whose `project` is not registered and a plugin tab whose kind is not offered, and lists each
in `Dropped`, which the log line and the response's `dropped` already carry. It applies to side
panel tabs and to tabs folded from the layout alike. A disabled plugin's surfaces count as offered:
its tab says why it shows nothing, and enabling the plugin brings it back. Nil lists check nothing
(the pure function's callers in tests); the daemon (`internal/daemon/layout_import.go`) always
passes both, from the project store's snapshot and the plugin store's. The plugin store scans its
directory in `Start`, before the API serves, so the list is complete when a window imports.

## 2. A restored set shows the tab that was active

**Cause.** `restore` (`internal/layout/thread.go`) placed records with no pane, or whose thread
came back in another pane, one at a time through `place`, and each placement made its tab active
in its pane (when not the focused pane). In a pane that already existed the last tab placed won.
In a new pane the first did only because the first placement made that pane the space's focus.
The import marked each classic group's active tab as `Active`, so a split panel gave two.

**Fix.** `restore` remembers, per pane that the fresh records land in, the first record that was
active when the set was remembered, else the first record that landed there, and makes it the
pane's active tab after all are placed. The pane the user was in (the space's focus when the
restore began) is left as it is: what lands there waits behind the user's tab, as placement does
elsewhere. Records put back in their old pane (`putBack`) already honoured `Active`.

The import marks one tab: the active tab of the classic panel's focused group (`focused`), the
one the classic window showed. A focused group that was picking (no active tab) marks none, and
the first tab shows.

When two records were active (two old panes) and both land in one pane, the first of them in the
set's order shows. `open_thread-restores-fresh.json` changed for that (it showed the last).

## 3. An old window's chord before the import

**Cause.** A window from before the shell, still open against a daemon that has the shell, takes
its chords from the daemon's command list. Its cmd+j runs `terminal.quick`, which opens the
thread's own tab in a layout that window does not draw. The import treats a space holding a thread
tab as arranged by someone with the new verbs and leaves it, so the first load was not one empty
space (finding 2 of `shell-20-cutover.md`).

**How the two are told apart.** Until the import runs, no window draws the layout: the shell
window imports before its first draw. So a thread tab that a window's own controls open before
the import was opened by a window that does not show it.

- `Registry.Invoke` marks the context of a call from a window's own controls
  (`Context.FromWindow`: the app's origin with a view; not a page, a plugin, the CLI or a thread's
  CLI) with `layoutstore.FromWindow`.
- The layout store, until the import, keeps the thread tabs such a call opens
  (`core.TrackWindowTabs`) in `layout_meta` under `legacy_window_tabs`, so a daemon restart in
  between keeps them. A tab leaves the list when it closes, and when any other caller acts on it
  (the op names it, as `tab.focus` or `thread.open` on it do) or moves it to another pane or space:
  someone then arranged it on purpose. The list goes with the import.
- The import (`closeWindowTabs`) closes the listed thread tabs in each space where every thread tab
  is one of them, then folds the space's automatic tabs as before. A space that also holds a thread
  tab someone opened on purpose (the CLI's `thread open`, a model's `terminal quick --focus`) is
  left exactly as it is. Nothing ends: the thread's quick terminal keeps running and its open state
  stays. The closed tabs are reported with the removed ones (`removed_tab_ids`).

**What remains.**

- A call a new shell window makes in the moment between its start and its import's answer (a
  palette command typed before the first draw) counts as a window's call. If it opened a thread
  tab, the import closes it. The window draws the empty space right after; nothing is lost but
  that tab.
- A space where an old window opened a thread tab and the CLI or a model opened another thread's
  tab stays as it is, the old window's tab included: closing it would change what was arranged.
- An old window's other chords keep their effect: a tab it closed (cmd+w, `tab.close`) stays
  closed, and a linked tab it opened (cmd+shift+d) is folded into its thread's set as the
  classic window's automatic tabs always were.

## 4. A pane with thread tabs moves to another space in one op

**Cause.** `move_pane --space` refused a pane holding a thread's own tab. The window
(`shell/spaces.ts spaceDropCommands`) sent `thread.space.move` for each thread in it, then
`pane.move` with what was left: several commands, and a refusal halfway (an identity open in the
target) left the pane half moved.

**Fix.** `MovePane.toSpace` (`internal/layout/ops_tree.go`) moves the pane whole, in one op: the
pane goes to the right of the target's focused pane with all its tabs, each thread whose tab it
holds now lives in the target, and each such thread's other linked tabs in the old space go along,
placed by the rules beside it, as `move_thread` places them. A linked tab whose identity is open in
the target already is closed in favour of that one (`Result.Closed`). A tab in the pane itself
whose identity is open in the target still refuses the whole op, before anything changes. The
window sends one `pane.move` for every pane drop. The mock does the same (its placement is its own
simplified one, as for `move_thread`, so `move_pane-thread-to-space` is skipped by the mock's case
runner for that reason).

The result differs from the old sequence: the thread tabs stay in their pane instead of each
landing in the target's focused pane. That is what a pane drop means (the pane goes as it is).

## 5. A plugin surface opened for a thread is a linked tab placed by the rules

**What existed.** `plugin.<plugin>.show.<surface>` sent a `ShowView panel.plugin.<kind>?thread=<id>`
intent. A window then selected the thread (taking the user's focus there) and opened the tab in
the current target. With no window open it did nothing, and it always moved the focus, from a
thread's model or a plugin too. The pane "+" menu and the palette in the window already opened a
plugin surface as a linked tab through `open_surface` (`hostShell.ts`), placed by the rules; that
path is unchanged.

**The identity.** The identity key of a plugin tab was `plugin:<plugin>/<surface>/<scope param>`,
and the window never sets a scope param, so two threads' tabs of one surface in a space had the
same key: the second thread's open focused the first thread's tab. The plugin store's own instance
of a thread-scoped surface is one per thread (`thread:<id>`). The key is now: the tab's `scope`
param when it has one, else `thread:<id>` for a linked tab, else empty. So a plugin surface is one
per surface and thread, and a surface whose scope says otherwise (a project, a worktree, global)
keys by that scope when its tab names it. Changed in `identity.go`, the window's port
(`shell/identity.ts`) and `testdata/identity.json` together; a stored layout re-keys on load.

**Fix.** The plugin store takes a `TabOpener` (`Options.Tabs`; the daemon's is `pluginTabs` over the
layout store). The show command of a thread or pull request surface opens a tab of the surface
linked to the thread through `open_surface`, placed by the rules, and sends no intent. It takes the
user's focus when the user asked in person (`Context.FromUser`) or with the new `--focus`; a thread's
model, a plugin and a page never move it otherwise. A page's call is asked first, as every plugin
verb is (`PageRuns`). A second call finds the open tab. A pull request surface's tab is linked to the
thread too and keyed by it: the window cannot know the pull request when it opens one from "+", so
two threads on one pull request get a tab each, both showing the same instance. Global, project
and worktree surfaces still go to the windows as an intent (no thread to place them beside). The
mock's show commands do the same.

## 6. The way back to a build from before the shell

The migration is one way: a build from before the shell refuses a home the shell has migrated
("migration 61 unknown to this build, which knows up to 60"). Old builds are not changed.

**The procedure.** With the daemon stopped, run `internal/db/wayback/0061_layout.sql` on the home's
database:

```
sqlite3 ~/.code-foundry/db.sqlite < 0061_layout.sql
```

It drops `layout_spaces`, `layout_threads` and `layout_meta` and deletes migration 61's row from
`schema_migrations`, in one transaction, and touches nothing else. The older build then starts on
the home with every thread, project and setting. Lost: the layout only (spaces, panes, tabs, each
thread's remembered tabs, the import mark). The classic window's side and bottom panels come back as
they were, since the shell never removed them from the window's storage. Updating again runs
migration 61 to empty tables, and the first-load import runs once more from those panels.

What else the shell writes, an older build tolerates: settings it does not know are kept and
ignored, and key bindings that name verbs it does not have are reported as issues, not refused.

`db.LayoutWayBack` embeds the file, so the test runs the same text. `TestLayoutWayBack`: a migrated
database with layout rows is refused by the migrations before 61, opens with them after the way back
(threads and projects kept, layout tables gone), the way back runs twice harmlessly, and the full
migrations bring empty layout tables back.

**Where it is written.** Release notes are generated by GitHub from the pull requests' titles
(`scripts/release.sh`, `--generate-notes`), and the update dialog's "Release notes" opens that
page. The repository has no file for release or upgrade notes. So the procedure is here and in this
pull request's body; the shell's merge to `main` (PR 25) should carry it in its body, which the
generated notes link, or the release text should.

## 7. Who reads a terminal's command lines

Terminal events and `terminal list` carry each terminal's foreground command line and its last
command (`Terminal.foreground`, `last_command`), and a snoozed terminal's tab keeps its line for
"Run again" (`ran`, a remembered tab's `Fresh.Ran`). These are what was typed, with its arguments.

| Reader | Before this PR | Now |
| --- | --- | --- |
| The app (its own stream and verbs) | yes | yes |
| The CLI, outside or inside a thread (a thread's model) | yes | yes |
| A plugin (its process, and verbs with the plugin origin) | yes | yes |
| A page: read-only verbs that run without asking (`terminal.list`, `plugin.terminals`, `layout.show`, `tab.list`) | yes | no |
| A page: the bridge's `terminal` event source | yes | no |
| A call that names no origin and no view | yes | no |

The app, the CLI, a thread's model and a plugin run as the user and can read the process table
themselves, so these fields give them nothing new. A page cannot, and its read-only verbs and event
sources need no question, so the fields gave a page something it could not read before. The daemon
now leaves the lines out for an untrusted caller (`Context.Untrusted`: a page, or a call that does
not say who it is) in the four verbs above (`internal/command/command_lines.go`), and the window's
bridge leaves them out of the `terminal` source (`stores/bridgeSources.ts`). The rest of each
terminal (its directory now, its labels, its title) is as before. A page still sees when a
terminal's entry changes, not what changed in those fields.

Not changed, and readable by a page before the shell too: a terminal's title (set by the program),
its argv (an action run's argv is the action's command line, which the action list also shows), and
the thread's own items through `thread.items`.

## Verification

- `make check` green (numbers in the pull request).
- Go: `TestImportLegacyDropsGoneProjectsAndPlugins` (table, panel JSON and a layout JSON with folded
  tabs), `TestImportLegacyActiveTab`, `TestRestoreShowsTheRememberedActiveTab` (new and existing
  panes, none or several active), `TestRestoreKeepsTheUsersPane`, `TestTrackWindowTabs`,
  `TestImportLegacyClosesAnOldWindowsThreadTabs`, the store's `TestWindowTabsBeforeTheImport` and
  `TestWindowTabsTheCLIArranges`, `TestImportAfterAnOldWindowsChord` (the registry, `terminal.quick`
  from a window, the CLI, a thread with `--focus`, and the CLI acting on the window's tab),
  `move_pane-thread-to-space.json`, `TestShowCommandOpensALinkedTab` (a thread's model, a plugin, a
  page asked first, `--focus`, the app, a pull request surface, a global surface still an intent),
  the identity rows, `TestLegacyImportDropsGoneProjectsAndPlugins` and `TestKnownProjectsAndSurfaces`
  in the daemon, `TestLayoutWayBack`, `TestCommandLinesByCaller` (six callers by four verbs).
  Turning off each fix fails its test: the restore table (6 of 7 rows), the window case of the chord
  test, and 8 rows of the command lines table.
- vitest: `spaces.test.ts` (one `pane.move` for every pane), `bridgeSources.test.ts`,
  `identity.test.ts` against the regenerated `identity.json`, the mock's op cases.
- e2e: `shell-spaces.spec.ts` "a pane holding two threads dropped on a space tab moves whole in one
  command" (the pointer drop, the stored layout, one `pane.move` invocation).

### End to end with the built binary

`make build`; a daemon on `CODE_FOUNDRY_HOME=/tmp/cf24a.XXXX` (`daemon --dev`), two scratch git
repositories `alpha` and `gone` under `~/cf24a-rh.XXXX`, the example plugin `minimal` linked with
`plugin dev` (a thread surface, `status`). Two threads in `alpha` with no prompt (no turn ran).
`cfrpc` is a ten-line script that posts Connect JSON to the daemon as the window does. Everything
was stopped and removed afterwards.

```
$ code-foundry thread new --project alpha --new-worktree=false --name "Alpha one" --focus=false   # A1 s-f3e5…, A2 s-2ea7… the same
$ code-foundry plugin dev …/plugins/examples/minimal --yes --follow=false
enabled minimal 0.1.0 (starting)

# 3. A window from before the shell presses cmd+j on A1 (its call: a view, no origin).
$ cfrpc CommandService/Invoke terminal.quick, context {activeView: thread, activeThreadId: A1}
{"resultJson":"{\"rev\":2,\"thread_id\":\"s-f3e5c4e1bb62\",\"open\":true,\"terminal_id\":\"t-0a2b419da812\"}"}
$ code-foundry layout show
space sp-e4o3cf43 "Main" (current)
  pane p-kh27tbkq (focused)
    * t-wgs6m3wm thread s-f3e5c4e1bb62 "Alpha one"
$ sqlite3 db.sqlite "select value from layout_meta where key = 'legacy_window_tabs'"
["t-wgs6m3wm"]

# 1. The project gone is unregistered; the classic panels name it and an uninstalled plugin.
$ code-foundry project unregister --project gone --yes
unregistered 9a0144a6fe68
  A1's panel: group 0 [notes.md, diff of alpha] active the diff; group 1 [diff of gone,
  plugin.weather.radar, plugin.minimal.status] active minimal; group 1 focused. Bottom: A1 open, 260.
  A2's panel: one group [a.md, b.md, MCP] active b.md.
$ cfrpc LayoutService/ImportLegacy {panelJson, bottomJson, clientId: w-e2e}
daemon.log: layout: imported the classic panels threads=2 quick=0 folded=0 removed=1
  dropped=["thread s-f3e5c4e1bb62: side panel tab diff?project=9a0144a6fe68&worktree=…gone: project 9a0144a6fe68 is not registered",
           "thread s-f3e5c4e1bb62: side panel tab plugin.weather.radar: no installed plugin offers plugin.weather.radar"]
$ code-foundry layout show
space sp-e4o3cf43 "Main" (current)
  (no panes)
threads
  thread s-2ea7a0e1c51a "Alpha two"
    remembered file "a.md", file "b.md", mcp "MCP", placed fresh beside the thread
  thread s-f3e5c4e1bb62 "Alpha one", quick terminal open
    remembered file "notes.md", diff "Diff", plugin.minimal.status "Minimal", placed fresh beside the thread
$ sqlite3 db.sqlite "select key, value from layout_meta order by key"
current_space|sp-e4o3cf43  default_space|sp-e4o3cf43  legacy_import|done:1794545051826  rev|3
$ code-foundry terminal list
t-0a2b419da812  running  …/alpha  -  kind=shell … slot=quick thread=s-f3e5c4e1bb62     # the same shell, still running

# 2. The restored sets' active tabs.
$ code-foundry thread open s-2ea7a0e1c51a                # A2: a new pane
  pane p-bc6iwnc3:  a.md, * b.md, MCP                     # b.md, the classic window's tab (before: a.md, the first)
$ code-foundry thread open s-f3e5c4e1bb62                # A1: into that pane, which exists
  pane p-r733wgt3 (focused): thread A2, * thread A1
  pane p-bc6iwnc3:  a.md, b.md, MCP, notes.md, Diff, * Minimal   # A1's remembered tab
  (here the remembered tab was also the last placed; the unit table covers a middle one)

# 4. The pane holding both thread tabs, to a new space, one command.
$ code-foundry space new --name Review --focus=false
new space sp-2nhqcmic "Review"
$ code-foundry pane move p-r733wgt3 --space sp-2nhqcmic
moved pane p-r733wgt3 (now pane p-r733wgt3 in space sp-2nhqcmic)
$ code-foundry layout show
space sp-e4o3cf43 "Main" (current)
  (no panes)
space sp-2nhqcmic "Review"
  row s-d4yx5jpq [0.65 0.35]
    pane p-r733wgt3 (focused): thread A2, * thread A1
    pane p-hbp6zxlb: a.md, b.md, MCP, notes.md, Diff, * Minimal
threads
  thread s-2ea7a0e1c51a "Alpha two" in space sp-2nhqcmic
  thread s-f3e5c4e1bb62 "Alpha one" in space sp-2nhqcmic, quick terminal open

# 5. A plugin surface from a thread's environment ($CODE_FOUNDRY_THREAD, as its Claude has it).
$ CODE_FOUNDRY_THREAD=s-2ea7a0e1c51a code-foundry plugin.minimal.show.status
opened Minimal for thread s-2ea7a0e1c51a as tab t-b5w4trbm in pane p-hbp6zxlb (the user's focus did not move)
$ CODE_FOUNDRY_THREAD=s-2ea7a0e1c51a code-foundry plugin.minimal.show.status
found Minimal for thread s-2ea7a0e1c51a as tab t-b5w4trbm in pane p-hbp6zxlb (the user's focus did not move)
$ CODE_FOUNDRY_THREAD=s-f3e5c4e1bb62 code-foundry plugin.minimal.show.status
found Minimal for thread s-f3e5c4e1bb62 as tab t-pgdizrdp in pane p-hbp6zxlb (the user's focus did not move)
  pane p-hbp6zxlb: …, Minimal (A2, beside A2's tabs), notes.md, Diff, * Minimal (A1)
  Review's focus stayed on p-r733wgt3, thread A1.

# 7. A terminal of A1 running a command with an argument, read by each kind of caller.
$ code-foundry terminal new --context-thread s-f3e5c4e1bb62 --run "<a command with a TOKEN=… argument>"
$ code-foundry terminal list
t-dfec312b8097  running  …/alpha  <that command line>  kind=shell … thread=s-f3e5c4e1bb62
  terminal.list as a page:   foreground and last command empty for both terminals, nothing in the text
  terminal.list as the CLI in A1 (its model): the command line
  terminal.list as a plugin: the command line

# 6. The way back, with the build of origin/main (a6c218c96, before the shell), daemon stopped.
$ code-foundry daemon --dev        # the old build
code-foundry: db: database was last opened by a newer Code Foundry (migration 61 unknown to this build, which knows up to 60); reinstall the newer build
$ sqlite3 db.sqlite < internal/db/wayback/0061_layout.sql
$ sqlite3 db.sqlite "select max(version) from schema_migrations; select count(*) from threads; select count(*) from projects"
60  2  1                           # no layout_* table left
$ code-foundry daemon --dev        # the old build: starts
$ code-foundry thread list         # the old CLI
s-2ea7a0e1c51a  idle  Alpha two  alpha@main
s-f3e5c4e1bb62  idle  Alpha one  alpha@main
$ code-foundry daemon --dev        # this branch again
$ code-foundry layout show
space sp-2euniasl "Main" (current)
  (no panes)
$ sqlite3 db.sqlite "select key, value from layout_meta order by key"
current_space|sp-2euniasl  default_space|sp-2euniasl  rev|0     # no legacy_import: the import runs again
```

## Gotchas

- `sh -c '<one command>'` execs it, so the foreground line is the command's, not the `sh -c` line.
- `project unregister` takes `--project`, not a positional name.
- `move_pane`'s new placement of followers uses the op's `w`/`h` (the window's measured area), like
  `move_thread`; the CLI's call gets the last reported viewport.

## For later

- PR 25: carry section 6's procedure in the merge's body or the release text.
- The skills' and guide's text on `plugin.<n>.show.<s>` (it opens a tab beside the thread and takes
  `--focus`) and on `pane.move --space`, and the bridge source list's words on `terminal`, are for
  the agent editing docs and skills.
