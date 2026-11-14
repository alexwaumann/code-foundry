# Shell PR 20: the shell is the default window; first-load import

Twentieth PR of the shell stack (`docs/notes/shell-plan.md`, section 4, "PR 20"; section 2.11).
The window shell draws the window by default, and before it first draws it brings the classic
window's side panels and bottom terminals over once (the GUI half of PR 18's import). The spec's
key table is the real keymap. `?shell=0`, `localStorage["code-foundry.shell"] = "0"` or the
palette's "Toggle new shell (preview)" still give the classic window, for this one PR: PR 21
removes it.

## What is in it

| Where | Holds |
| --- | --- |
| `internal/command` | the spec's key table as the commands' default `Keybindings`; the retired chords gone; `ReservedChords` (cmd+w and cmd+alt+\ leave, ctrl+cmd+1…9 join); `tab.auto-name` (cmd+shift+r); `tab.rename` renames a thread's tab's thread; `terminal.quick`, `terminal.cycle`, `terminal.new-free`, `view.thread-diff` and `tab.rename` listed in the palette; `layout show` says "placed fresh beside the thread" for a record with no pane |
| `internal/command/keybindings_test.go` | `TestShellKeyTable` reads the spec's table and pins every chord to its verb or to a reserved view action; `TestRetiredChords`; `TestPanelKeybindings` and the thread-step chords' test gone |
| `internal/daemon/settings_keybindings_test.go` | a `[keybindings]` table written for the classic window: each stale override is an issue, none is fatal |
| `internal/layout/legacy_test.go` | `TestImportLegacyCarriesOnlyLiveTerminals` (see "Terminals at import") |
| `src/shell/keyPresenters.ts` | what each verb of the table does in the shell window (the interim `shell/keys.ts` is deleted) |
| `src/keys/bindings.ts` | the presenters in `presentCommand`; ctrl+cmd+1…9 as view actions (`space.switch --index`); the classic window keeps cmd+r (rename the selected thread) and cmd+j (its bottom panel) |
| `src/shell/flag.ts`, `palette/shellPreview.ts` | on unless "0"; the URL wins over the stored value; the toggle stores "0" or forgets it |
| `src/shell/legacyImport.ts`, `components/shell/Shell.tsx`, `ShellNotice.tsx` | the gate: the first draw waits for the layout and the import; a failed import's notice with Try again and Open without them; a daemon that sends no layout gets a "waiting" line after 5 s (no classic fallback) |
| `src/api/layout.ts`, `stores/layout.ts` | `legacyImported` on the layout and its deltas; `importLegacy`; `applyImportedLayout` |
| `src/lib/update.ts`, `stores/update.ts` | `SHELL_SINCE`, `predatesShell`, `isOldDaemon` |
| `mock/layout.ts`, `mock/server.ts` | `ImportLegacy` (records the call, sets the mark, the layout unchanged); `POST /__mock/layout/import?imported=&fail=&error=&delay=` |
| `e2e/cutoverSkips.ts`, `playwright.config.ts` | the tests skipped by name until PR 21 (`grepInvert`; `CUTOVER_SKIPS=0` runs them) |
| `e2e/shell-cutover.spec.ts` | the import in the browser, its failure, a reload, the palette over a slow first draw; SHOTS |

## Keys

Every row of the spec's table is a command's default chord or a GUI view action
(`TestShellKeyTable` in Go, `keys/shellKeys.test.ts` in the window, `mock/keymap.test.ts` for the
mock), and the keyboard help lists each. A chord reaches its verb from the content, a thread's
prompt and a terminal (they yield cmd chords bound to commands). In a text field (a rename field,
the space name) only the field's yielded commands run: the interim table ran over fields too.
In the File tab's code editor cmd+[ and ] stay the editor's indent, as they were for view.back.

`tab.close` and `pane.close` from the user ask a surface with unsaved work first
(`shell/closeTab.ts`, the side panel's `beforeClose`): see the fixes below.

The classic window, for this PR only: the table's layout verbs do nothing there (it has no
panes); cmd+r renames the selected thread inline and cmd+j toggles its bottom panel. cmd+shift+e,
cmd+\ and the thread-step chords are gone there too: the classic window is the way back, not a
second keymap.

## The first-load import (GUI half)

Before the shell first draws: when the daemon's layout says `legacy_imported` is false, the
window sends `localStorage["code-foundry.panel"]` and `["code-foundry.bottom"]` (as they are,
"" when absent) to `LayoutService.ImportLegacy` once, and draws from the layout it answers (applied
as a snapshot unless the stream is already past it). Both keys stay. A second window, a reload or
a retry after a lost answer finds the mark set and calls nothing.

- **What is sent.** The classic panel store still loads in this PR, and its persist middleware
  migrates the stored value to its current version on load, before the import reads it. The
  daemon reads any version (PR 18's port is pinned to the same migrations), so the tabs are the
  same; the bytes are the migrated ones. PR 21 removes the store; from then on the value goes as
  the user's last classic window left it.
- **A failure** (the daemon restarting, a refusal) does not leave the window blank: the pane area
  says the old panels could not be brought over, that nothing is lost, and why, with **Try again**
  and **Open without them**. Opened without them, the next launch tries again (the mark is unset).
  The sidebar and the top bar work meanwhile; the sidebar is the shell's from the start (it drew
  the classic list until the first draw before this PR: fixed here).
- **A daemon without a layout** (from before PR 18) never sends one. `SHELL_SINCE` opens the update
  dialog with Restart Now, as a pre-tunnel daemon does, only while the shell is on; after 5 s the
  pane area says it is waiting. There is no classic fallback any more (plan 2.12).
- **`SHELL_SINCE` is `v0.22.0-tip.3`**: the shell reaches `main` as one merge, the first minor
  after v0.21. Re-derived at the merge (PR 25) from the version that merge produces: `main` was two
  first-parent commits past v0.21.7 (tips v0.21.8-tip.1 and tip.2), so the merge is the third and
  `scripts/next-version.sh --tip` gives `v0.22.0-tip.3`. No `v0.22.0-tip.1` or `tip.2` was released.

## Terminals at import

No terminal survives a daemon restart (the classic bottom panel prunes then, and PR 6 closes every
terminal tab whose terminal is gone). An update restarts the daemon, so by the time a new window
imports, the bottom terminals of the old daemon have ended. The import carries only terminals alive
at import time; a terminal that no longer exists is in no remembered set, nothing marks it to come
back as a fresh shell, and opening its thread starts no shell for it
(`TestImportLegacyCarriesOnlyLiveTerminals`). Terminals started on the new daemon while an old
window was still open are carried as PR 18 built: the oldest shell becomes the quick terminal, the
others linked tabs, the same processes.

So the spec's "Running terminals keep running" holds only for terminals alive at import time. The
lead will correct the spec's wording after the owner has seen it; this PR does not change the spec.

## Fixes the suite found once it ran on the shell

Running the whole e2e suite with the shell as the default found these shell bugs, fixed here
(each with a unit test; the e2e specs that found them pass):

- **A File tab lost its bridge, its edit session and its requests.** The shell drew the side
  panel's surfaces without their panel key and gave a File tab its layout id. A thread's HTML page
  opened as a tab had no bridge (its calls errored), an edit session was dropped the moment it
  started (`prune` saw no tab of its id), a thread's "edit this file" request never cleared on
  save, and cmd+w or a tab's × closed a tab with unsaved edits **without asking**. A linked tab's
  body now acts for its thread's panel (`thread:<id>`), a File tab keeps the side panel's path id
  (`kinds.ts seamTab`, `hostShell.ts findShellTab`), the strip shows the unsaved dot, and every
  close by the user asks the surface first.
- **The keyboard landed on the pane body** after a press on a blank spot of a tab (the composer's
  heading took the keyboard out of its prompt): the body is focusable only for a focus request.
- **A thread opened from the sidebar did not take the keyboard into its prompt** when its tab was
  new (pre-existing on `shell`: the request reached the tab still showing; the e2e test passed by
  timing). The prompt is focused once the opened tab is drawn.
- **A click or a palette opened before the first draw** (the import's round trip) was lost or lost
  its keyboard: a thread selected then opens when the shell draws; a composer mounting under an
  open dialog leaves the keyboard there.
- **The prompt history closed on the first key typed in a new composer** (the draft's id changed
  its key); the composer's skills loaded twice for the same reason.
- **A thread's request to edit a file came back after the save.** A save sends two updates of the
  tab's params at once (the request stamped as saved, then ended). In the shell each was computed
  from the layout's last confirmed params and sent as its own call, so the daemon could apply them
  in either order (the side panel's store was synchronous). A tab's params updates, retitles
  included, now go in order, each computed from the one before it (`hostShell.ts queueParams`).
- **Home in the sidebar** left the Needs you header scrolled out.
- **The keyboard help** ran its columns sideways once the key table had chords: View and Worktree
  were out of reach.

## e2e: what runs, what is skipped

`make gui-e2e`: 365 passed, 161 skipped (SHOTS and live specs, as before), with the tests below
left out by name. Specs whose premise was the classic window's height (the top bar and the tab
strip take about 60px more) or its selection model now account for the shell: `thread.spec`
(fold click), `thread-setup` (fold anchoring), `bridge` (card growth; a second window shows the
daemon's shared layout), `composer-files`, `zoom-popovers`, `compose` (the shell sends
`compose: <tab>` and runs layout verbs after a send), `archive`.

**Classic-only, skipped by name until PR 21** (`e2e/cutoverSkips.ts` lists each test with its
reason; `CUTOVER_SKIPS=0` runs them). None is a shell bug: each drives the classic window's side
panel, bottom panel, page rows, thread header or sidebar layout, or selects a thread waiting on
the user by its row or cmd+shift+a, which in the shell opens its Needs-you popup by the spec.

| Spec | Tests | Why |
| --- | --- | --- |
| `app.spec.ts` | 6 | Needs-you click / cmd+shift+a, Pull Requests / Projects sidebar rows, classic bottom panel |
| `bottom-panel.spec.ts` | 14 | replaced by the shell specs |
| `buttons.spec.ts` | 2 | Needs-you click, classic thread header |
| `code-block-actions.spec.ts` | 1 | classic bottom panel |
| `compose.spec.ts` | 1 | the classic draft rule (one draft per project, Escape to Projects) |
| `diff-viewer.spec.ts` | 8 | classic side panel widths |
| `file-edit.spec.ts` | 4 | classic side panel strip and groups |
| `file-finder.spec.ts` | 1 | classic side panel |
| `file-request.spec.ts` | 1 | classic side panel strip |
| `file-tabs.spec.ts` | 4 | classic side panel |
| `font.spec.ts` | 1 | classic bottom panel |
| `gallery.spec.ts` | 1 | classic side panel widths |
| `home.spec.ts` | 1 | Needs-you click |
| `inline-html.spec.ts` | 2 | classic side panel; Needs-you click |
| `layout.spec.ts` | 8 | replaced by the shell specs |
| `lineage.spec.ts` | 2 | cmd+shift+a, classic thread header |
| `linkedprs.spec.ts` | 1 | Needs-you row (no tag there) |
| `mcp-panel.spec.ts` | 3 | classic side panel |
| `move-no-project.spec.ts` | 3 | classic thread header |
| `no-project.spec.ts` | 1 | classic thread header |
| `page-verbs-panel.spec.ts` | 1 | classic side panel |
| `panel-split-drag.spec.ts` | 6 | replaced by the shell specs |
| `panel-split.spec.ts` | 5 | replaced by the shell specs |
| `panel.spec.ts` | 19 | replaced by the shell specs |
| `plugin-menu.spec.ts`, `plugin-picker.spec.ts`, `plugin-stats-bars.spec.ts`, `plugin-table.spec.ts` | 4 | classic side panel widths |
| `plugin-owned.spec.ts`, `plugin-streams.spec.ts` | 3 | classic bottom panel |
| `plugin-table-meter.spec.ts` | 2 | classic side panel widths |
| `plugins-layout-fuzz.spec.ts` | 4 | classic side panel resize |
| `plugins.spec.ts` | 5 | classic side panel |
| `pr-code`, `pr-open-instant`, `pr-stale-first`, `pr-tasks` specs | 4 | the Pull Requests sidebar row |
| `pr-panel.spec.ts` | 15 | the Pull Requests sidebar row, classic side panel |
| `project-sets.spec.ts` | 2 | classic thread header |
| `projects.spec.ts` | 8 | the Projects sidebar row |
| `prs.spec.ts` | 7 | the Pull Requests sidebar row |
| `server-rollup.spec.ts` | 1 | classic bottom panel |
| `sidebar.spec.ts` | 6 | cmd+shift+a, classic sidebar rows and hover card |
| `snooze.spec.ts` | 2 | cmd+shift+a, classic content pane |
| `terminal-find.spec.ts` | 13 | classic bottom panel |
| `terminal-routing.spec.ts` | 2 | replaced by the shell specs |
| `theme-editor-fuzz.spec.ts`, `usage-sheet.spec.ts` | 2 | the classic header's panel toggle |
| `thread-dock-height`, `thread-panel-items`, `thread-reconnect`, `waiting-strip` specs | 4 | Needs-you click |
| `thread-header.spec.ts` | 1 | classic thread header |
| `thread-info.spec.ts` | 2 | classic side panel; Open in › Terminal opens a terminal tab now (the card's geometry checks after it need re-basing) |
| `thread-prompts.spec.ts` | 4 | Needs-you click |
| `thread.spec.ts` | 5 | Needs-you click, the Projects sidebar row |
| `threads.spec.ts` | 3 | Needs-you click and its badge, the Projects sidebar row |
| `welcome-page.spec.ts` | 1 | classic side panel strip |
| `workspace-page.spec.ts` | 3 | the Projects sidebar row |

199 tests in 59 files. The SHOTS-only screenshot tests of these specs (e.g. `lineage.spec.ts`'s)
are not listed: they run only with SHOTS and drive the same classic parts.

**Reported, not classic** (skipped by name too, listed apart in `cutoverSkips.ts` as `REPORTED`):

1. `ember.spec.ts` "a worker waiting on the user: cmd+shift+a goes to Ember first": cmd+shift+a
   opens the Needs-you popup of a thread, and Ember is not in Needs you, so it no longer reaches
   Ember. For PR 24 (Ember's chat) or an owner decision.
2. `plugin-gaps.spec.ts` "a row that shows a plugin's flag opens the thread and the plugin's
   surface for it": a thread a plugin flags for attention is listed under Needs you, whose click
   opens the popup; nothing opens the plugin's surface from the row now. Owner decision.
3. `file-zoom-scroll.spec.ts` "in edit mode at 125% … keeps the line on top": the File tab keeps
   its top line within 2 lines, not 1, across zoom changes at the shell pane's width. The File
   tab's own anchoring; for PR 24's zoom pass.

`file-request.spec.ts` "--focus puts the caret at the end of the line" failed one run in about six:
a shell race, fixed here (below), not a flake. 56 repeated runs of the spec pass after the fix.

## The migration rehearsal

A scratch home on `/tmp/cfr20.XXXX`, two scratch git repositories (`alpha`, `beta`) under
`~/cf20-rh.XXXX`, both removed afterwards; a daemon and window built from `origin/main`
(a6c218c96) in a second worktree, then this branch's daemon and window. The window was each
build's Vite dev server on the same port, so the browser kept one origin and one localStorage,
driven with `playwright cli` (WebKit). Threads ran Sonnet 5.5 at medium effort with one-word
prompts. The real `~/.code-foundry` was never touched.

**Phase A: `main`.**

```
$ code-foundry project add ~/cf20-rh.XXXX/alpha; … beta
$ code-foundry thread new --project alpha --new-worktree=false … --name "Alpha diff and file"   # A1 s-c9c7…
  … "Alpha pull request" (A2 s-4007…), "Alpha to archive" (A3 s-68ca…), beta: "Beta terminals" (B1 s-1e3a…), "Beta to snooze" (B2 s-a4be…)
$ code-foundry view.panel.diff --thread A1; view.panel.file --thread A1 --path …/notes.md; … README.md; view.panel.split --thread A1
$ code-foundry view.panel.diff --thread B2; view.panel.file --thread A3 --path …/README.md
  A2's pull request tab: added through main's window's panel store (openSurface, #7):
  view.panel.pr refuses, a scratch project has no GitHub repository
  window: B1 selected, cmd+j (main's view.bottom.toggle: a shell); A1 the same
$ code-foundry terminal new --context-thread B1 --run "sleep 3600"
$ code-foundry thread snooze --id B2 --until tomorrow; thread archive A3
$ code-foundry terminal list
t-0ca03c25a441  running  …/beta   kind=shell thread=B1
t-d6956ac45c4b  running  …/beta   kind=shell thread=B1       (sleep 3600)
t-f265f99db1c3  running  …/alpha  kind=shell thread=A1
  shells 44462 44748 44892 under daemon 38751
```

localStorage then: A1 a split panel (the diff; notes.md and README.md), A2 the pull request, A3
README.md, B2's entry emptied (main's window empties a thread's panel when it is snoozed); the
bottom store with B1 and A1 open. Before shot: `before-classic.png` (and light).

**Phase B: the update's restart.** `main`'s daemon stopped, this branch's started on the same home.

```
44462 ended, 44748 ended, 44892 ended          # every terminal ends with the daemon
$ code-foundry terminal list                    # (new daemon)
ID  STATE  CWD  RUNNING  LABELS
```

`main`'s window, pointed at the new daemon (its port changed), kept working with its stored panels
(old window, new daemon). A first attempt opened B1's bottom panel with cmd+j there: on the new
daemon cmd+j is `terminal.quick`, so the old window ran it, the daemon made the shell B1's quick
terminal and opened B1's own tab in the layout. A space holding a thread tab is "arranged", and
PR 18's import leaves it as it is, so that path would not draw one empty space (see the findings).
To rehearse the designed path, the daemon was stopped, its three `layout_*` tables emptied (no
import had run: `legacy_import` was unset) and started again. B1's bottom panel was then opened with
the classic header's toggle (`view.bottom.toggle`, a classic `terminal.new`), and a long-running
command added:

```
$ code-foundry terminal new --context-thread B1 --run "sleep 3600"
$ code-foundry terminal list
t-5d1bc93c4ac7  running  …/beta  -           kind=shell thread=B1
t-49564ce8471b  running  …/beta  sleep 3600  kind=shell thread=B1
$ code-foundry layout show
  pane p-3rwbdrs3: t-oi4vsm5a terminal of B1 (t-5d1b…), t-otwknjki terminal of B1 (t-4956…)
processes: 49497 /bin/zsh -l (t-5d1b…), 49619 /bin/zsh -l (t-4956…), 49720 sleep 3600 (child of 49619)
```

**Phase C: this branch's window**, same origin, reloaded (no flag: the default).

```
daemon.log: layout: imported the classic panels threads=3 quick=1 folded=2 removed=0
            dropped=["thread A3 is archived or gone: its side panel is dropped"]
$ code-foundry layout show
space "Main" (current): (no panes)
  thread B1 "Beta terminals", quick terminal open
    remembered t-otwknjki terminal of B1 terminal t-49564ce8471b, placed fresh beside the thread
  thread A2 "Alpha pull request"
    remembered t-6hbgkfi2 pullrequest of A2 "#7", placed fresh beside the thread
  thread A1 "Alpha diff and file"
    remembered diff "main vs HEAD", file notes.md, file README.md, placed fresh beside the thread
$ code-foundry terminal list
t-5d1bc93c4ac7  running  …  kind=shell slot=quick thread=B1
t-49564ce8471b  running  …  sleep 3600  kind=shell thread=B1
49497, 49619, 49720: running
layout_meta legacy_import = done:<ms>
```

- **One empty space with the composer; no thread opened** (`after-first-load.png`).
- **A1 opened** (sidebar click): its diff and both files in one pane to the right of the thread, at
  the diff (the split's two groups become one pane: records with no pane are placed fresh and join
  the first); no shell for the terminal that ended with `main`'s daemon, and no quick terminal
  (`after-thread-restored.png`, light too).
- **B1 opened**: its quick terminal is `t-5d1bc93c4ac7` (pid 49497) under the conversation, its
  `sleep 3600` terminal `t-49564ce8471b` (pids 49619, 49720) a tab beside it, both attached live:
  the same processes (`after-b1.png`, light too). `layout show` and `terminal list` named exactly
  the tabs and terminals the window showed.
- **A2** remembers its pull request tab; **A3** (archived) kept nothing and its panel was dropped;
  **B2** (snoozed) kept nothing, because the classic window had emptied its panel at the snooze.
  Both stay under Snoozed and Archived.
- **A second launch** (a reload) called nothing: one `ImportLegacy` request in the daemon log in
  all (its OPTIONS preflight and one POST), the window back on the same layout (rev unchanged).

### Findings

1. **Bottom terminals end at the update's restart**, before any new window imports (above). Only
   terminals started on the new daemon under an old window come over.
2. **An old window on a new daemon takes the new chords.** Its keymap is the daemon's command
   list, so after this PR its cmd+j runs `terminal.quick` (a quick shell, the thread's tab opened in
   a layout it does not draw), cmd+shift+d `view.thread-diff`, cmd+w `tab.close` outside its panel,
   and cmd+shift+e no longer toggles its side panel. The window only exists until Restart Now
   relaunches it, but a cmd+j there makes the space "arranged", and the import then leaves it as it
   is (the thread's tab stays open, its legacy tabs only remembered): the first load is not one
   empty space. Not fixed here: say so in the update notes, or have the import treat a thread tab
   opened by `terminal.quick` under an old window as automatic; owner's call.
3. **A thread snoozed in the classic window comes back with no tabs**: the classic window empties a
   snoozed thread's panel itself; the shell's own snooze keeps the set (spec).
4. **The space tab counted 1** while Needs you was empty: a finished turn ("Alpha pull request")
   counts in the tab's badge but is not listed in Needs you. Pre-existing (PR 15/17); for PR 24.
5. **The scripted rehearsal's pull request tab** went in through `main`'s panel store, as no GitHub
   repository backs a scratch project; the owner's rehearsal on a copy of a real home will have
   real ones.

## Differences from the spec

- "Running terminals keep running" on first load: only terminals alive at import time (above). The
  spec's wording is the lead's to correct.
- cmd+[ / cmd+] in the File tab's code editor are its indent, not back and forward (as they were
  for view.back before); the spec's table does not say.
- A classic window snoozed thread brings no tabs (finding 3).
- The classic window's split panel comes back as one pane of tabs (placement puts fresh records
  together), not two.

## For later PRs

- **PR 21**: rewrite the tests in `e2e/cutoverSkips.ts` against the shell and delete the list, the
  config's `grepInvert` and `CUTOVER_SKIPS`; delete `classicPresenters` in `keys/bindings.ts`,
  `palette/shellPreview.ts` and its row, and the classic Sidebar tests' flag pinning; move
  `components/panel/panelKeyContext.ts` (the shell uses it for linked tabs) out of `panel/`; the
  first-load import then sends the stored value as the last classic window left it.
- **PR 22**: `view.bottom.toggle`, `view.panel.toggle`, `view.panel.split` and the thread steps keep
  their commands here without chords; they go with the panel verbs.
- **PR 23**: the guide's and the skills' keys (GETTING-STARTED's two lines are corrected here);
  `tab.auto-name` and `tab.rename`'s thread case in the architecture's command section.
- **PR 24**: the reported gaps (Ember and cmd+shift+a, a plugin flag's surface, the File tab's zoom
  anchoring), the tab badge counting finished turns, finding 2, the rehearsal on copies of real
  homes.
- **PR 25**: re-derive `SHELL_SINCE` from the version the merge will produce.
