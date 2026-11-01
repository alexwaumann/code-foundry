# e2e → vitest: workbench

Part of the e2e → vitest series (docs/notes/e2e-unit-duplicates.md, e2e-vitest-surfaces.md,
e2e-vitest-projects.md). Area: project actions, the bottom and side panels, file tabs, the
Projects pages, Add Project paths, no-git projects. 54 audited e2e tests in 15 spec files.

Result: 31 e2e tests removed (99.7 s of measured test time), 22 cut down to their browser-only
part (rows worth 70.9 s; part of that is saved), 1 kept unchanged (3.5 s). Three spec files went
(create, nogit, project-rename).

## What moved

### Actions and the bottom panel

New test files:

* `components/bottom/BottomPanel.test.tsx` (14): BottomPanel over the real stores and the real
  TerminalHost (a renderer that draws nothing, Attach streams the test scripts). Action tabs: the
  name, the `$ command` echo (from the run, or argv for an agent's run), Running with its clock
  (fake Date and setInterval instead of waiting for the mock's processes), the failure with its
  duration and Rerun, no exit overlay, Stop → terminal.kill confirmed → Stopped, Rerun → a second
  action.run and the old tab's terminal.close, a passing run's check, × → terminal.close,
  Stopping… with Stop disabled until a 137 exit, a worktree's run in `view:projects`. Shells: the
  exit overlay and struck-through tab until the reaper removes it; the Projects page's worktree
  shells, their titles and tooltip, "+" in the active tab's worktree, a row's New terminal here; a
  project page's Terminal; a sidebar row's New terminal here (the real RowMenu); a new shell
  opening its owner's panel, selected or not, with no focus request. cmd+j
  (toggleBottomFromHere): blank while terminal.new runs, the exit hiding the panel, a fresh shell
  next time; the Projects page's empty-state hint; a persisted open panel closed by
  closeEmptyPanels; terminal.new failing: the empty state, its retry, cmd+w on it.
* `components/actions/ActionsMenu.test.tsx` (5): ProjectsPage + ActionDialog + BottomPanel: the row
  menu's project label, items, New action, the pencil's label; an item's run (context, the page's
  panel, echo); a project without actions (no row menu, Details, Add an action, Name focused); the
  project menu's New action; add → the daemon's refusal in place (no toast) → pencil edit with
  Cmd+Enter → ArrowRight edit → the delete confirm (text, the project name's no-wrap class,
  Keep/Delete focus) → action.remove, with the args of each command.
* `components/actions/ActionRunDialog.test.tsx` (3): run_finished through stores/events.ts in a real
  Toaster: the setup failure's toast, Open selecting the thread, the dialog's heading, meta, path
  spans and output, Run in terminal; a passing setup staying quiet; the failure toast's ×; a user's
  failed run not toasting.
* `components/threadinfo/PlaceGroup.actions.test.tsx` (1): the card's action menu lists the
  project's actions; an item runs `action.run --terminal` for the thread.
* `components/palette/CommandPalette.commands.test.tsx` (3): the palette over a context-aware fake
  List: what is offered with and without a thread or a shell, no NoPalette verb, a row's chord;
  worktree.create's arg prompt and its context; an enum's values with the default highlighted; the
  notify and openPalette intents.

Extended: `ActionDialog.test.tsx` (the icon tiles start on Play, wrap at both ends, End, a click).

New shared fakes (new files): `src/test/terminalHost.ts` (a fake XtermRenderer and a scripted
Attach, so the real TerminalHost runs in jsdom) and `src/test/actionsWorld.ts` (the mock's six
actions, action terminals and runs, terminal events, fakes for action.run, terminal.kill and
terminal.close).

### File tabs and the side panel

* `components/files/FileTab.test.tsx` (+7): markdown Rendered by default, Source at a line with the
  wrap toggle and the persisted choice, the next markdown file opening as source; a TypeScript file
  at a line (meta "80 lines · 2 KB · TypeScript", the marked line); an image's meta once it decodes;
  binary, folder and truncated notices; a missing file, Retry, a re-read on the worktree's detail
  changing, and Refresh. The code view is a stand-in that shows the marked line.
* `components/files/HtmlPreview.test.tsx`: the frame's referrer policy and the footer's text.
* `components/changes/ChangesView.test.tsx`: a committed rename opens its Diff tab on the branch
  with its old path; a project without git lists nothing until git init.
* `components/panel/SidePanel.test.tsx` (+3, "closing tabs"): cmd+w activating the neighbour, × and
  middle click, the last close hiding the panel and handing focus to content; the roving tab stop
  and arrows not activating; the + picking without adding a tab or invoking anything, picking an
  open surface, cmd+w while picking going back.
* `components/panel/SidePanel.split.test.tsx` (+1): each group's own + and picker, a tab from
  elsewhere landing in the focused group, cmd+w collapsing an empty group, Escape.
* `stores/intents.test.ts` (+2): ShowView `panel.new-tab` shows a hidden panel picking, and with the
  palette open moves its return target to the panel.

### Projects, workspaces, Add Project

* `ProjectsIndex.test.tsx`: Initialize git from the index row with a fake `project.git.init` that
  makes the daemon's change: the row turns git, Publish to GitHub shows.
* `ProjectPage.test.tsx`: a checkout row opening its Changes tab in the page's own panel
  (`view:projects:project:repo-cf`); End then Enter on the list; a removed worktree leaving the
  table and Details' count; kind variants after git init; the header menu's Initialize git; Show
  diff in Worktrees without threads and in the remove dialog; removed leftovers leaving.
* `WorkspacePage.test.tsx`: View opening CLAUDE.md in the workspace page's panel; Show changes in X;
  the chevron's tooltip; an unregistered member opening nothing on click, double click or Enter,
  a registered one opening its Changes tab.
* `AddProjectDialog.test.tsx`: on a highlighted folder `/` and Tab descend, Enter adds it.
* `ProjectPicker.test.tsx`: the pinned Add a project… row opening the dialog on Local folder.
* `SidebarRow.test.tsx`: the no-git row's badge and project name.
* New `components/palette/CommandPalette.projects.test.tsx`: project.github.publish from sketches'
  composer opening the publish dialog for repo-sk, project.create opening the New tab, the dev.path
  prompt (folders without a chevron, "Use ~/", a clicked folder invoking dev.path).
* New `components/compose/Composer.nogit.test.tsx`: the composer in a project without git (only
  Project folder in Work in, the No git badge, no base or branch, thread.new without
  new-worktree).

`src/test/projectsWorld.ts` gained `panelActive(key)`, `resetPanels()` and `fakeGitInit()` (new
exports at the end, one import added).

## e2e removed (31)

* actions (8): the card's action menu runs one; a project without actions; the icon tiles; add,
  edit, delete; an action tab's Stop, Rerun and ×; Stop on a run that ignores SIGHUP; an agent's
  run; a project page's checkout row run and New action.
* bottom-panel (4): the Projects page's panel and its +; a new shell opening its owner's panel; the
  Projects page's last shell and the empty hint; a persisted open panel coming back closed.
* terminal-routing (2): a thread row's New terminal here; a project page's Terminal.
* app (2): a shell's exit overlay; the OpenPalette and Notify intents.
* file-tabs (2): committed changes on the branch (rename, deletion, binary); a missing file and
  Retry, re-reads.
* projects (4): the index; a project's page; kind variants; Remove….
* workspace-page (3): the Threads table; Write instructions; an unregistered member.
* paths (2): a highlighted folder's `/`, Tab and Enter; the palette's path prompt.
* nogit (2), create (1), project-rename (1): the files went.

## e2e shortened (22)

Each keeps only what needs the browser; several were renamed to say so.

* actions: the pencil's hover opacity and one Escape closing its tooltip then the menu; the run
  dialog at a 360px window (one-line meta, the path truncating in the middle).
* bottom-panel: cmd+j's keyboard moves into xterm, back to content, into the fresh shell (the
  mock's 600 ms terminal.new delay is gone); cmd+w on the focused empty panel and the retry's
  shell taking the keyboard.
* app: cmd+shift+p reaching the app from a focused shell; worktree.create's FocusProject reveal and
  scroll.
* gitops: cmd+shift+k running git.push in the thread's worktree (the 1200 ms mock delay is gone).
* file-tabs (4): @pierre/diffs drawing addition lines; a rendered markdown image decoding and
  Source marking its line in the library's view; the line scrolled into view, the interactive
  HTML sandbox, an image decoding; pdf.js drawing pages, the page column scrolling, a 1.5 MB
  image decoding.
* panel (4): the computed `--wails-draggable` values; native Enter, Space and Tab on the tabs;
  a real cmd+w while picking; the palette handing focus to the panel.
* panel-split (1): cmd+\ and cmd+alt+\ through the keymap and focus moving between groups.
* projects (2): the project page's list focused on open and End+Enter; Show diff narrowing the
  page and Resume over the stream.
* workspace-page (2): View drawing CLAUDE.md in the page's panel; Start here's hover opacity.
* addproject (2): cmd+k and the New thread picker handing off to the dialog with focus in its
  input; the Local folder chevron's computed opacity.

## Kept (1)

* bottom-panel "a daemon restart that pruned the shells leaves the panel closed": the reconnect
  wiring (events.ts runs closeEmptyPanels after the List), real focus, and a reload.

## Not moved: daemon rules

* A new shell's labels (kind=shell, thread=…) asserted in terminal-routing: the mock's copy of the
  daemon's label contract (internal/termlabel). The spec's `shellLabels` helper went with it.
* The duplicate action name's wording is the daemon's (internal/store/action); the unit fake
  answers with it and checks that it shows in place without its prefix.
* The SIGHUP → SIGKILL escalation is the daemon's (Go terminal tests); the unit test only scripts
  the 137 exit.

Product code: unchanged, no exports added.

## Gotchas

* `refreshCommands` runs after every command and replaces the commands store from the fake's
  `daemon.commands`: set both, or the empty state's chord and CommandButtons vanish mid-test.
* `focusContent()` only bumps `contentFocusSeq`; `ui.focus` follows real DOM focus, so unit tests
  check the sequence.
* Radix's roving focus (the icon tiles) moves on a timer: wait a `setTimeout(0)` after each key.
* projectsWorld's threads have no `flags`; the sidebar RowMenu reads `flags.length`.
* The real TerminalHost runs in jsdom once `@/terminal/xterm` and `@/api/terminal` are faked; the
  exit overlay then comes from the scripted Attach's exit frame, as in the app.
* In SidePanel.test.tsx a describe after "reordering tabs" has its clicks swallowed (dnd-kit's
  click swallower stays on the document 50 ms after a drag test): new describes go before it.
* FileTab with a project watches the worktree detail resource: fake `@/api/worktreeDetail`. An
  image's "W × H" comes from its load event, which jsdom never fires: the test sets
  naturalWidth/Height and fires `load`.
* The panel store is persisted module state: tests that open tabs call `resetPanels()`.
* A jsdom double click does not fire the clicks before it, as Playwright's dblclick does.
* The actions SHOTS test opens `trigger(page, "repo-gp")` while on code-foundry's page; it looked
  wrong before this change and was left alone (SHOTS runs only).

## Verification

The 12 touched spec files under two workers: 73 passed, 11 skipped (SHOTS), first run. The whole
vitest suite: 7423 passed. `bun run typecheck` and `bun run lint` clean.
