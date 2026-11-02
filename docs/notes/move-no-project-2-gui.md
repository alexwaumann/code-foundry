# Move a No project thread, step 2: the GUI

PR 2 of 2 (the daemon, proto and CLI are PR 1, `move-no-project-1-daemon.md`). A user who
started a No project thread to look into something moves it into a project or a workspace
from the thread's header, without starting over.

## What landed

| Path | What |
|---|---|
| `internal/command/commands_thread_move_open.go` | `thread.move.open`: palette-visible, ShowView `thread.move` with `{id}`; When: a thread with no project and no workspace |
| `gui/frontend/src/components/compose/placement.ts` | the composer's Work in, Branch from and Run in logic as hooks (`usePlacement`, `usePlacementPickers`, `usePrimaryPicker`, `placementCheckouts`) |
| `components/compose/Composer.tsx` | uses them (same groups, values, texts, icons, defaults, collision checkouts) |
| `components/thread/MovePicker.tsx` | the popover: step 1 (filter, Workspaces, Projects, footer), step 2 (header, pills, line, Move) |
| `components/thread/ThreadParts.tsx` | the crumb's No project place is the picker's trigger; "Moving to <name>…" while moving |
| `components/thread/ThreadMenuItems.tsx`, `menuKit.ts` | "Move to project…" in the title menu and the sidebar row's menu |
| `lib/move.ts` | `canMove`, `moveArgs`, `moveLine`, `movingTo`, `movingLabel` (pure) |
| `stores/movePicker.ts` | which thread's picker is open, moves in flight; `openMovePicker`, `moveThread` |
| `keys/bindings.ts`, `stores/views.ts` | the palette presenter of `thread.move.open`; ShowView `thread.move` from the CLI |
| `api/threads.ts` | `ThreadView.pendingMove` (`ThreadMoveView`) |
| `mock/world.ts`, `mock/server.ts` | `thread.move`, `thread.move.open`, `ThreadService.Move`; `POST /__mock/thread/move-fail`, `move-delay` |

## Decisions

* **The GUI goes through `thread.move`**, not `ThreadService.Move` directly: every user
  action is a command. The args are thread.new's (`project`, `workspace`, `worktree`,
  `new-worktree`, `base`, `branch`). The picker always sends the choice explicitly
  (`new-worktree=true|false`), the default it showed, rather than leaving the daemon to read
  `threads.default_worktree` again. The project folder is `new-worktree=false`, not the
  main checkout's path. A non-git project is `new-worktree=false` too.
* **One set of pickers.** The composer's Work in / Branch from / Run in computations moved
  out of `ComposerCard` into `components/compose/placement.ts`. The move picker renders
  `ComposerPicker` with what those hooks return. The composer's tests are unchanged and
  green. A like draft ("New thread on this branch") still computes its own read-only pill;
  its Run in goes through `usePrimaryPicker` with its thread's set.
* **Defaults** come from `threads.default_worktree` exactly as in the composer
  (`defaultWorktree`, `setWorkIn`). A workspace's primary is the workspace's default primary
  (`resolveSet`). Collision hints are the composer's (`useCollisions` over
  `placementCheckouts`): the amber Work in pill and its tooltip.
* **No Work in for a project without git**: the No git badge alone, as the composer has
  beside its single-option picker. The line says "Works in the project's folder."
* **The line under the pills** (`moveLine`): "New branch, named from the conversation when it
  moves." / "Works on the existing branch <b>; a worktree is made for it if none exists." /
  "Works in the project's folder, on its current branch." (a set: "each project's folder, on
  the branch it has checked out").
* **Keys.** Step 1: cmdk (↑↓, Enter, type to filter); Esc closes (Radix). Step 2 focuses its
  own container: Enter moves, Backspace or ← goes back; on a pill, Enter and the arrows are
  the pill's. Keys from an inner picker's list bubble through React from its portal, so the
  handler acts only on keys whose target is the container itself. After an inner pick the
  container takes the keyboard back (`focusAfter`), so Enter then moves.
* **Moving.** `moveThread` closes the picker and records the destination's name in
  `sending` until the call answers, so the crumb reads "Moving to <name>…" at once. The
  daemon's `pending_move` then names it (a workspace's name wins over its primary member's).
  While moving, the place is plain text, not a trigger. The success message is not toasted
  (`quiet`): the crumb, the new name and the daemon's timeline note say it. The daemon's
  hints are toasted as warnings, as after thread.new. A refusal is `runCommandForResult`'s
  failure toast ("Move Thread to Project… failed" with the daemon's words). The thread is
  untouched, so the crumb is No project again.
* **When it is offered** (`canMove`, shared by the crumb, the menus and the palette): no
  project (`isNoProject`), not archived, not resident, not moving already. The daemon's
  `thread.move.open` When sees only the context (no project, no workspace). `inPalette`
  hides it for the rest, as for thread.run-in.
* **Opening from elsewhere.** `openMovePicker` selects the thread when the window shows
  something else (without `focusPrompt`), then opens the picker two animation frames later,
  so a closing menu or palette has handed focus back first. A focus that lands outside
  would dismiss the popover. The title menu's `onCloseAutoFocus` leaves focus alone after
  Move to project… (`markMovePicking`, like `markInPlace`). Leaving the thread unmounts the
  crumb and closes the picker, so coming back does not reopen it.
* **Menu order**: Rename, Regenerate name, Move to project…, separator, Pin, Snooze …, as
  sketched. Text only.
* **The guide** leaves `thread.move.open` out (a window's popover; agents call
  `thread.move`), so its byte cap is untouched.

## Gotchas

* The ThreadMenuItems test fixture had no `pendingMove`, so `canMove` read `undefined !==
  null` as moving and the item stayed hidden while the test still passed. The fixture has
  `pendingMove: null` now.
* `stores/views.ts` imports the move store. Importing `threadActions` from there pulled
  `stores/compose` into every module that imports views, and `Code.test.tsx`'s narrow
  `vi.mock("@/api/threads")` broke on `ATTACHMENT_MIME_TYPES`. The store builds the thread
  context with `getUiContext` directly.
* Found in the built app: typing "webapp" in step 1 picked the workspace that has webapp,
  listed above the projects, because its row's search keywords were its members' names (as
  in cmd+N's picker, whose row shows them). The move list shows "N projects", not the
  members, so a workspace row matches on its name only.
* The mock's `thread/<action>` control regex lists every action. New ones (`move-fail`,
  `move-delay`) must be added there too, or the server answers "unknown control endpoint".

## Tests

* Go: `TestThreadMoveOpen` (availability, why, the ShowView and its id); the command,
  keybinding and guide lists.
* vitest: `lib/move.test.ts` (args per choice, the line, the moving name, canMove);
  `components/thread/MovePicker.test.tsx` (trigger only for No project; step 1 groups and
  rows; step 2 per target and setting; no Work in without git; back keys; Enter on a pill;
  Enter moves with the args and the crumb's Moving text through pending_move to the
  project; a workspace's args; the refusal toast; openMovePicker selects then opens);
  `ThreadMenuItems.test.tsx` (the item, its place, absent for project, workspace, archived
  and moving threads, opens the thread and the picker); `keys/bindings.test.ts`
  (`thread.move.open` in the palette).
* e2e `move-no-project.spec.ts` (WebKit): the popover under the crumb (geometry), the
  filter focused after the sidebar row's menu, the title menu and the palette close, Esc,
  and a whole move over the mock's streams (Moving…, the crumb, the name, the row, the note).

## Verified in the built app

`make build`, `make gui-build`; `CODE_FOUNDRY_HOME=/tmp/cf-move-gui bin/code-foundry daemon`
and the GUI from `gui/bin`. Scratch repos `~/cf-move-gui-scratch/webapp` and `authlib`
(each with a local bare origin and two branches), a plain folder `notes`, and workspace
`platform` (webapp, authlib). `threads.default_worktree = new`, `threads.naming_model =
claude-sonnet-5-5[1m]`. Threads: `thread new --no-project --model 'claude-sonnet-5-5[1m]'
--effort medium`.

1. Dark, a running thread: `thread move.open --id …` from the CLI opened the picker under
   the crumb, with the filter focused (ShowView `thread.move`). Step 1 listed platform
   (2 projects), authlib, notes (No git), webapp. Typing "webapp" + Enter picked the
   workspace (the keyword gotcha above, fixed after). Step 2 for platform: Fresh copies,
   From defaults, Run in webapp, the members on the right. Backspace went back; ↓↓↓
   Enter picked webapp; Work in listed Fresh copy, Project folder and the repo's
   branches. Esc, then Enter moved it. The crumb read "Moving to webapp…" (the title
   muted while renamed) for about 2 s. Then "webapp ›  Fix login redirect destination",
   the sidebar row on `fix/login-redirect-destination`, the card on webapp (Fresh copy),
   and the note "Moved this thread to webapp (new worktree on
   fix/login-redirect-destination)." The daemon took its needs_trust restart path.
2. Light, a stopped thread (archived and unarchived): the same through the rebuilt GUI.
   "webapp" + Enter now lands on the project. It moved through "started thread to move
   it", in about 3 s.

Found, not fixed here (the daemon's, PR 1): with real Claude, both moves left an empty
turn end right after the move note (`turnEnd {subtype: success, durationMs: 22–34,
turnCostUsd: 0}`, drawn as a bare "Worked" row). The empty result after an accepted
set_cwd is meant to be dropped (`runner.cdResultOwed`); with fakeclaude's
`CF_FAKE_CLAUDE_SET_CWD_RESULT` it is, both directly and after a trust restart (checked
here). Real Claude probably sends something before that result that marks the turn busy
(`streamStatus.turnStarted`), so `cdResult` treats the result as a turn's. It needs a
capture of real Claude's stream around set_cwd.
