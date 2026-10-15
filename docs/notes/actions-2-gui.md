# Actions, PR B: the GUI (2026-10-14)

The GUI half of Actions on top of PR A's daemon contract (`actions-1-daemon.md`): a Play
menu in the thread header and on Projects worktree rows, the add/edit dialog, action runs
as bottom-panel tabs with a command echo and a status line, and a toast for a failed
worktree-create run. Decided variants from the sketch (`docs/sketches/actions/`): **menu
a** (pencil on the highlighted row) and **exited status a** (a status line under the
output, shown from the start). Frontend and mock only: no Go, proto or generated change.

Status: `make check` green (Go packages ok; 130 vitest files / 2663 tests). `make
gui-e2e` (both browsers, nothing else running): 738 passed, 32 skipped, 4 failed: the two
`projects.spec.ts` tests that list the project overflow menu, on each browser, which now
has "New action…". Fixed in the spec; rerun with `actions.spec.ts` and
`bottom-panel.spec.ts`: 80 passed, 4 skipped (the SHOTS-only screenshots).
`make gui-build` green. Then a live pass against the real daemon and Wails window (see
Live pass), whose defects are fixed here; after the fixes `make check` is green (132
vitest files / 2693 tests) and `actions.spec.ts`, `bottom-panel.spec.ts` and
`projects.spec.ts` on both browsers: 82 passed, 4 skipped (SHOTS-only).

## Pieces

| File | Role |
|---|---|
| `api/actions.ts` | View models (`ActionView`, `ActionRunView`, `ActionRunFinishedView`), `toActionEventView`, `getActionRun` (GetRun, a read), `runFromResult` (action.run's result JSON) |
| `api/events.ts`, `stores/events.ts` | The `action` source: the store reducer, then `onActionRunFinished` for run_finished |
| `stores/actions.ts` | `byId`, `byRepo` (ids in position order), `runs`; `applyActionEvent`; `useRepoActionIds`, `useAction`, `useActionRun` |
| `stores/actionActions.ts` | `runAction` (action.run `--terminal` in the owner's context), `stopActionRun` (terminal.kill, confirmed), `rerunAction`, `saveAction` (action.add / action.edit with changed fields), `deleteAction` (action.remove), `onActionRunFinished` + `openFailedRun` |
| `stores/actionDialog.ts` | Which editor (new / edit, project, from where) or run output is open |
| `stores/actionStops.ts` | Action terminals the user pressed Stop on (GUI-only), for "Stopping…" and "Stopped" |
| `lib/actions.ts` | Pure: tab status (running / stopping / ok / stopped / failed), `formatRunClock` (0:12), `formatRunDuration` (4.2s, 3m 5s), the echo, drafts and the args Save sends |
| `lib/path.ts` | `splitPathTail`: a path's directory and last segment, for the run dialog's middle ellipsis |
| `lib/termlabel.ts` | `KIND_ACTION`, `ACTION_LABEL`, `ACTION_NAME_LABEL`, `ACTION_RUN_LABEL`, `isActionLabels`, `isPanelLabels` |
| `stores/bottomPanel.ts` | `ownerKeyOf` takes `kind in (shell, action)`; an action tab's title is `action.name` (numbered like shells: "Test", "Test 2") |
| `stores/bottomActions.ts` | `showOwnTerminal` (the "+" focus path, for a run's terminal) |
| `components/actions/ActionsMenu.tsx` | `ActionsMenu` (header or row trigger) and `ThreadActionsMenu` |
| `components/actions/ActionDialog.tsx` | The editor |
| `components/actions/ActionRunDialog.tsx` | A failed background run's output, with "Run in terminal" |
| `components/actions/ActionTabParts.tsx` | Tab icon and status mark, `ActionEcho`, `ActionStatusLine` |
| `components/bottom/BottomPanel.tsx` | Action tabs; echo above and status line under the one `TerminalHost` |
| `components/terminal/TerminalHost.tsx` | `exitOverlay={false}` for action tabs (the status line says it) |
| `terminal/attach.ts`, `terminal/xterm.ts` | An exited terminal hides its cursor (`hideCursor`, DECTCEM off) |
| `HeaderActions.tsx`, `ProjectsPage.tsx`, `App.tsx` | The header menu (left of the bottom toggle), the row menu and "New action…" in the project overflow, the two dialogs |
| `mock/actions.ts` (+ `world.ts`, `server.ts`) | ActionService, the action source, `action.*`, `kind=action` terminals with scripted output, the worktree-create hook, `/__mock/action/*` |

## Decisions

* **Every user action is a registry command.** Run is `action.run` (with the thread's or
  worktree's context), Save is `action.add` / `action.edit`, Delete `action.remove`, Stop
  `terminal.kill`, closing a tab `terminal.close`. The only raw service call is
  `ActionService.GetRun` (a read of a finished run's output), like `ensureMcpStatus`.
* **The GUI always runs in a terminal** (`action.run --terminal`). The dialog exposes only
  terminal actions (`in-terminal` is `true` on add and never sent on edit, so an action an
  agent made a background one stays so), and running one of those from the menu still
  opens a tab, where the user can see it.
* **Keyboard path to the pencil: ArrowRight** on the highlighted row opens the editor
  (`aria-keyshortcuts="ArrowRight"` on the item), as it would open a submenu; letters stay
  Radix's typeahead. The pencil is a mouse affordance (tabIndex -1) shown on the
  highlighted row (hover or arrow keys). The palette also has `action.edit`/`remove` with
  args. Cmd+Enter saves the editor from anywhere in the dialog (Enter is a newline in the
  command); the key is handled on the dialog's content, not the form (see Gotchas).
* **Header**: Play (`pane-actions-menu`) left of the bottom toggle, only for a thread with
  a project and only while the daemon lists `action.run` (like Snooze). The menu's label is
  the project's name; empty: "No actions for <project> yet" and "New action…".
* **Projects page**: a Play menu on every worktree row (a fourth slot, the broom a fifth;
  the slot column is `w-24`/`w-30`), runs owned by that worktree (the page's panel); the
  project overflow has "New action…" after "New worktree…".
* **Picked items run after the menu has closed** and handed focus back (as the Projects
  overflow menus do), so a run's tab or the dialog takes focus last.
* **Editor**: the sketch's form. The daemon's refusal shows above the footer (no toast);
  a message mentioning the name marks the Name field invalid. Any edit clears the refusal
  and the red field (it was about the draft as it was). Save is disabled without a name
  and a command. Delete swaps the footer for "Delete X for every thread in
  <project>?" Keep / Delete, the armed Delete on the right; the project's name does not
  break at its hyphens. The description says "the
  worktree's checkout" when opened from the Projects page. **The switch's subtitle
  differs from the sketch**: the daemon runs worktree-create actions in the background
  regardless of `in_terminal`, so "Opens in the new thread's bottom panel" would be wrong;
  it reads "In the background, for a new thread's worktree; failures notify you".
* **Action tabs**: keyed like shells; icon from the action as it is now (Play once
  deleted), title from `action.name` at start, status mark (sky spinner, emerald check,
  red x) from the terminal's state. An exited action tab is not struck through. The echo
  is drawn from the run's command (else the terminal's argv `[$SHELL, -lc, cmd]`), dimmed,
  one line with "+N lines" for a multi-line command. The status line is 28px, always
  there for an action tab, so the terminal does not refit on exit; times come from the
  run, else the terminal. Stop keeps the keyboard in the terminal. **Stop** reads "Stopping…" (muted
  spinner, Stop disabled) until the run exits, then "Stopped · 4.2s · Rerun", neutral (a
  muted stop mark on the tab), when the exit code is 129 or 137 after the user's Stop. A
  command that exits 137 (or anything else non-zero) on its own stays red "Exited with
  code N". The GUI remembers the Stop (`stores/actionStops.ts`); the daemon is unchanged.
  An exited action tab hides the terminal's cursor.
* **Rerun** runs the action again for the same owner first, then closes the old tab: if
  the run fails (the action was deleted), the old tab and its output stay. The new tab is
  appended and active.
* **Toast**: run_finished with trigger worktree-create and a non-zero exit only: "Setup
  action X failed (exit N)" with Open (id per run, so a reconnect cannot repeat it). It
  stays until dismissed (× or Open; `duration: Infinity`, like a failed git op's toast):
  the run is in the background with no tab, so the toast is the only sign it failed. Open
  reveals the run's tab when it had a terminal; the daemon runs setup in the background,
  so normally it selects the thread and opens the run's captured output (GetRun) in a
  dialog with "Run in terminal". The dialog's status is one line; its path ellipsizes in
  the middle, keeping the last folder (the worktree's branch folder).

## Gotchas

* **A button inside a Radix menu item** must stop `pointerdown` *and* `pointerup`: the item
  clicks itself on pointerup when the pointerdown was not its own, which ran the action
  instead of editing it.
* **A closing dropdown's `onCloseAutoFocus` comes after its exit animation**, so it can
  arrive after the menu was opened again; moving focus then dismissed the new menu. The
  menu skips the focus restore while open. (Reopening within the 150ms fade still loses
  the click to the fading menu's outside-pointer handler; the e2e waits for the old menu
  to go.)
* `action.run`'s result JSON is the protojson `ActionRun` (`terminalId`), not a
  `Terminal` (`id`), so `terminalIdFromResult` does not apply.
* The action store's errors start with their sentinel (`failed precondition: this project
  already has an action named "Test"`, from `%w`), and `rawMessage` keeps that text (it
  only drops Connect's own code prefix). The editor strips it (`lib/actions.ts`
  `refusalText`); the mock's action errors carry it like the daemon's.

* **WebKit does not focus a button on click.** After clicking an icon tile or the switch
  the focus is on the dialog's content (Radix's focus target), outside the form, so a
  form-level `onKeyDown` never saw Cmd+Enter. The form registers its handler through a
  ref and `DialogContent` calls it.
* **Stop takes ~3 s live.** terminal.kill sends SIGHUP; `$SHELL -lc cmd` passes it on, but
  a child that ignores it (a dev server, `make dev`) keeps running until the daemon's
  SIGKILL after the grace period, so the run ends 137, not 129. Hence "Stopping…" and both
  codes for "Stopped". The mock's Debug daemon (`make dev`) ignores SIGHUP the same way
  (137 after 1.5 s), so the e2e sees "Stopping…".
* **Hiding the cursor is a write** (`ESC[?25l`), queued behind the output, so it works for
  the DOM and the WebGL renderer alike and comes after a reattach's snapshot.

## Tests

* Unit: `lib/actions.test.ts` (status, clock and duration tables, echo, drafts and
  edit/add args), `stores/actions.test.ts` (reducer), `api/actions.test.ts` (mapping,
  `runFromResult`), `stores/actionActions.test.ts` (toast conditions and its sticky
  options, Open, owners, run, rerun, stop and its Stopping flag, save/delete and the
  inline refusal), `components/actions/ActionDialog.test.tsx` (Cmd+Enter from the
  content, an icon tile, the switch and Name, not during the delete confirm; a refusal
  cleared by editing Name), `lib/path.test.ts`, `terminal/attach.test.ts` and
  `terminal/xterm.test.ts` (the cursor hidden on exit), `stores/bottomPanel.test.ts` (action
  rows for `ownerKeyOf`, `bottomTabIds`, titles and numbering), `HeaderActions.test.tsx`
  (where the menu shows, the list and the empty state).
* e2e `e2e/actions.spec.ts`: the header menu (order, pencil on hover, a click runs
  `action.run --terminal` for s-1, the tab, echo, running then failed status line, no exit
  overlay, no toast); the empty state; add, a duplicate refused inline, edit by pencil
  (only changed args, Cmd+Enter) and by ArrowRight, delete with Keep and Delete; Stop
  (`terminal.kill`, confirmed, tab kept, "Stopped" at 129; "Stopping…" with Stop
  disabled, then "Stopped" at 137, for a run that ignores SIGHUP), Rerun (new run, old tab gone, new one
  active), an exit-0 run, × closing through `terminal.close`; an agent's run showing up;
  the Projects page (row run with the worktree's context in the page's panel, "New
  action…" for ghostty-playground); the setup toast, Open, the output dialog (one status line and the path's tail at 360px
  wide) and Run in terminal, a passing setup run staying quiet, and × on a failure toast.

## Live pass

Against the real daemon and Wails window (`make gui-build`, an isolated
`CODE_FOUNDRY_HOME`, a scratch repo). Checked: the header menu with and without actions,
New / Edit / Delete in the editor (a duplicate name refused inline, the worktree-create
switch), the Projects row menu and a row run in the page's panel, running, stopped and
exited action tabs, and a failing worktree-create action on a new-worktree thread: its
toast, Open and the output dialog. No `code-foundry` CLI was on PATH, so the agent ran
the CLI as `$CODE_FOUNDRY_BIN` (which `code-foundry daemon` and `gui` export to every
session). Defects it found, fixed in this PR: the setup toast vanished after 4 s; Stop gave
no feedback for ~3 s and then read red "Exited with code 137" (see Gotchas); Cmd+Enter did
nothing after clicking an icon or the switch; a refusal stayed after the user fixed the
name; the output dialog's status wrapped and cut the path's end; the delete confirm broke
the project's name at its hyphen; exited action tabs kept a block cursor. The refusal's
"failed precondition: " prefix was fixed earlier (`refusalText`).

## Screenshots

From the live pass (Wails window, real daemon), in `docs/notes/actions-2-gui/`, taken
before the fixes above (the Stop and output-dialog states changed since):

* `live-menu-dark.png`: the header menu, the pencil on the highlighted row.
* `live-menu-empty-light.png`: a project without actions.
* `live-dialog-delete-light.png`: Edit after Delete, the inline confirm.
* `live-panel-running-dark.png`: a running action tab, the echo and "Running · 0:02 · Stop".
* `live-panel-exited-light.png`: an exited action tab, the status line with Rerun.
* `live-toast-setup-failed-light.png`: a failed setup action's toast with Open.

The e2e's `SHOTS=<dir>` test still writes mock screenshots on demand (`SHOTS=<dir> pnpm exec
playwright test e2e/actions.spec.ts --project=webkit -g screenshots`); they are not kept.

## Daemon changes

None needed.

## Not done

* The fixes after the live pass are checked by unit and e2e tests against the mock, not
  by a second live pass; the screenshots predate them.
* No drag reorder of actions (the daemon has `--position`; the GUI does not use it).
* The header Play button and the Projects row menus are mouse-first, like their
  neighbours (tabIndex -1); the palette's `action.run` / `action.add` / `action.edit` /
  `action.remove` are the keyboard path to them.
* Daemon follow-up worth considering: worktree-create actions with `in_terminal` could run
  as a tab of the new thread (the sketch's subtitle); today they always run in the
  background, so the toast's Open shows captured output instead of a tab.
