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
`make gui-build` green. Not exercised against the live daemon (see Not done).

## Pieces

| File | Role |
|---|---|
| `api/actions.ts` | View models (`ActionView`, `ActionRunView`, `ActionRunFinishedView`), `toActionEventView`, `getActionRun` (GetRun, a read), `runFromResult` (action.run's result JSON) |
| `api/events.ts`, `stores/events.ts` | The `action` source: the store reducer, then `onActionRunFinished` for run_finished |
| `stores/actions.ts` | `byId`, `byRepo` (ids in position order), `runs`; `applyActionEvent`; `useRepoActionIds`, `useAction`, `useActionRun` |
| `stores/actionActions.ts` | `runAction` (action.run `--terminal` in the owner's context), `stopActionRun` (terminal.kill, confirmed), `rerunAction`, `saveAction` (action.add / action.edit with changed fields), `deleteAction` (action.remove), `onActionRunFinished` + `openFailedRun` |
| `stores/actionDialog.ts` | Which editor (new / edit, project, from where) or run output is open |
| `lib/actions.ts` | Pure: tab status, `formatRunClock` (0:12), `formatRunDuration` (4.2s, 3m 5s), the echo, drafts and the args Save sends |
| `lib/termlabel.ts` | `KIND_ACTION`, `ACTION_LABEL`, `ACTION_NAME_LABEL`, `ACTION_RUN_LABEL`, `isActionLabels`, `isPanelLabels` |
| `stores/bottomPanel.ts` | `ownerKeyOf` takes `kind in (shell, action)`; an action tab's title is `action.name` (numbered like shells: "Test", "Test 2") |
| `stores/bottomActions.ts` | `showOwnTerminal` (the "+" focus path, for a run's terminal) |
| `components/actions/ActionsMenu.tsx` | `ActionsMenu` (header or row trigger) and `ThreadActionsMenu` |
| `components/actions/ActionDialog.tsx` | The editor |
| `components/actions/ActionRunDialog.tsx` | A failed background run's output, with "Run in terminal" |
| `components/actions/ActionTabParts.tsx` | Tab icon and status mark, `ActionEcho`, `ActionStatusLine` |
| `components/bottom/BottomPanel.tsx` | Action tabs; echo above and status line under the one `TerminalHost` |
| `components/terminal/TerminalHost.tsx` | `exitOverlay={false}` for action tabs (the status line says it) |
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
  args. Cmd+Enter saves the editor (Enter is a newline in the command).
* **Header**: Play (`pane-actions-menu`) left of the bottom toggle, only for a thread with
  a project and only while the daemon lists `action.run` (like Snooze). The menu's label is
  the project's name; empty: "No actions for <project> yet" and "New action…".
* **Projects page**: a Play menu on every worktree row (a fourth slot, the broom a fifth;
  the slot column is `w-24`/`w-30`), runs owned by that worktree (the page's panel); the
  project overflow has "New action…" after "New worktree…".
* **Picked items run after the menu has closed** and handed focus back (as the Projects
  overflow menus do), so a run's tab or the dialog takes focus last.
* **Editor**: the sketch's form. The daemon's refusal shows above the footer (no toast);
  a message mentioning the name marks the Name field invalid. Save is disabled without a
  name and a command. Delete swaps the footer for "Delete X for every thread in
  <project>?" Keep / Delete, the armed Delete on the right. The description says "the
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
  run, else the terminal. Stop keeps the keyboard in the terminal. A stopped run reads
  "Exited with code 129" in red (no separate "Stopped" state).
* **Rerun** runs the action again for the same owner first, then closes the old tab: if
  the run fails (the action was deleted), the old tab and its output stay. The new tab is
  appended and active.
* **Toast**: run_finished with trigger worktree-create and a non-zero exit only: "Setup
  action X failed (exit N)" with Open (id per run, so a reconnect cannot repeat it). Open
  reveals the run's tab when it had a terminal; the daemon runs setup in the background,
  so normally it selects the thread and opens the run's captured output (GetRun) in a
  dialog with "Run in terminal".

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
* The mock's error messages have no code prefix; the GUI shows `rawMessage`, which drops
  it for the real daemon too.

## Tests

* Unit: `lib/actions.test.ts` (status, clock and duration tables, echo, drafts and
  edit/add args), `stores/actions.test.ts` (reducer), `api/actions.test.ts` (mapping,
  `runFromResult`), `stores/actionActions.test.ts` (toast conditions, Open, owners, run,
  rerun, stop, save/delete and the inline refusal), `stores/bottomPanel.test.ts` (action
  rows for `ownerKeyOf`, `bottomTabIds`, titles and numbering), `HeaderActions.test.tsx`
  (where the menu shows, the list and the empty state).
* e2e `e2e/actions.spec.ts`: the header menu (order, pencil on hover, a click runs
  `action.run --terminal` for s-1, the tab, echo, running then failed status line, no exit
  overlay, no toast); the empty state; add, a duplicate refused inline, edit by pencil
  (only changed args, Cmd+Enter) and by ArrowRight, delete with Keep and Delete; Stop
  (`terminal.kill`, confirmed, tab kept at 129), Rerun (new run, old tab gone, new one
  active), an exit-0 run, × closing through `terminal.close`; an agent's run showing up;
  the Projects page (row run with the worktree's context in the page's panel, "New
  action…" for ghostty-playground); the setup toast, Open, the output dialog and Run in
  terminal, and a passing setup run staying quiet.

## Screenshots

WebKit against the mock daemon, 1280x800 at 2x, dark and light, in
`docs/notes/actions-2-gui/` (`SHOTS=<dir> pnpm exec playwright test e2e/actions.spec.ts
--project=webkit -g screenshots`):

* `menu-{dark,light}.png`: s-1's header menu, the pencil on the hovered Test row.
* `menu-empty-{dark,light}.png`: s-2 (ghostty-playground), no actions.
* `dialog-new-{dark,light}.png`: New action filled in like the sketch (Install deps,
  two-line command, Configure, the switch on).
* `dialog-delete-{dark,light}.png`: Edit Test after Delete, the inline confirm.
* `panel-running-{dark,light}.png`: Check running, the echo and "Running · 0:02 · Stop".
* `panel-exited-{dark,light}.png`: Test exited 1 beside Check's green check, the red
  status line with Rerun.

## Daemon changes

None needed.

## Not done

* **Not run against the real daemon and Wails window.** Everything here is against the
  mock; a live pass (isolated `CODE_FOUNDRY_HOME`, a scratch repo, the header menu, a
  failing setup action on a new-worktree thread) and live screenshots are still to do.
* No "Stopped" wording for a run the user stopped (it reads "Exited with code 129").
* No drag reorder of actions (the daemon has `--position`; the GUI does not use it).
* The header Play button and the Projects row menus are mouse-first, like their
  neighbours (tabIndex -1); the palette's `action.run` / `action.add` / `action.edit` /
  `action.remove` are the keyboard path to them.
* Daemon follow-up worth considering: worktree-create actions with `in_terminal` could run
  as a tab of the new thread (the sketch's subtitle); today they always run in the
  background, so the toast's Open shows captured output instead of a tab.
