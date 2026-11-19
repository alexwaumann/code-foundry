# Mark a thread as unread

A user asked for a way to remind themselves to come back to a thread, like marking a
message unread in Slack. Agreed design: no new concept. "Mark as unread" puts an idle thread
back into the status a turn that ended unseen leaves, NeedsAttention "finished" (the
sidebar's Done), and from then on it is a Done thread.

## The verb

- `thread.unread` (internal/command/commands_thread_unread.go), "Mark as Unread", category
  Thread, chord cmd+shift+u, in the palette, NoIndex (the user's own attention, like
  `thread.snooze.clear`). It calls the new `ThreadService.MarkUnread`, which runs the store's
  `MarkUnread` (internal/store/thread/unread.go).
- The daemon refuses anything but a thread idle at its prompt with FAILED_PRECONDITION and
  says why: working, starting, setting up (a setup running, failed or cancelled), waiting on
  an answer, already unread, needing attention for another reason, in error, archived,
  snoozed, saved for later, being removed, or not at its prompt (the waiting overlay).
  A stopped (disconnected) idle thread is fine.
- `When` is `hasThread`, as for `thread.pin` and `thread.interrupt`, not a status rule like
  `thread.snooze.clear`'s. The window's command list is fetched when the context changes, not
  when the thread's status does, so a status `When` would leave the chord bound or unbound
  by a stale reading (a thread that finished while selected could not be marked by key until
  the selection moved). The GUI offers the item by its own fresh copy of the rule
  (gui/frontend/src/lib/markUnread.ts): the row, header and tab menus (one list,
  ThreadMenuItems.tsx, after Snooze/Unsnooze) and the palette (keys/bindings.ts `inPalette`).
  The chord fires wherever a thread is in front; on any other thread the daemon's refusal is
  the toast.
- Not in a subagent's view (keys/bindings.ts `notInSubagent`), like Pin and Snooze.

## Running and stopped

- Running: a runner command (`threadCmd.unread`). The runner checks its own stream status
  (`AtPrompt`, Idle "at prompt", not closing or putting away) and the row (archived,
  snoozed, setup, waiting overlay) under one `m.mu` section, sets `streamStatus.markUnread`
  (unseen, no turn error, `held`), and publishes at once rather than after the debounce, so
  the answer carries the new status. Saved like every published status.
- Stopped: the record's status is set and committed, persisted, with `record.unreadHold`.
- Both commit through `commitMarkedLocked`: the waiting overlay, then `absorbLocked`, then
  the commit.

## The hold

The thread may be showing when it is marked: it has a viewer and presence is attended. Done
clears when a viewer sees it, so without more the open view would clear the mark at once (the
runner's acknowledge on the next result or presence rise, `seenStoppedLocked` on a stopped
thread's detach or presence rise). The mark is held against the viewers there when it was made:

- `streamStatus.held` on a runner: `acknowledgeIfViewed` (results, the wake limit) and
  `onAttended` (presence rising) skip a held status. `Acknowledge` itself still clears it, so
  answering a request does.
- `record.unreadHold` on a stopped thread: `seenStoppedLocked` skips it.
- `detach` carries a held mark from the runner onto the record (`holdUnreadLocked`) when the
  status it leaves is still "finished", so an idle stop or a close with the view open keeps it.
- The runner reads the viewer count at the mark, so a viewer that opened just before it
  (its signal not yet handled) is one the hold is against, not a new one.

It ends, and the thread is then seen as any Done thread would be, on:

- a new viewer (`addViewer` clears the record's hold; the runner's `onViewers` clears `held`
  on a rise, attended or not, so a view opened while away is seen when the user comes back);
- the thread gaining the focus (`Manager.FocusGained`);
- a message or a turn starting (`streamStatus.sent`, `turnStarted`), or a spawn (the
  runner's status starts afresh; `attach` clears the record's hold).

## Focus: from the layout, not the GUI

The daemon already knows the focus: the layout store (internal/store/layout) owns each
space's focused pane, each pane's active tab and the current space, and a focus change is a
layout commit (`focus_tab`, `focus_pane`, `switch_space`, `open_thread` from a row click).
So no frontend signal was added. `core.FocusedThread` (internal/layout/focused.go) is the
thread whose own tab is the active tab of the current space's focused pane, and the daemon's
glue `startThreadFocus` (internal/daemon/thread_focus.go) calls `FocusGained` after a commit
when that changed to a thread. A commit that leaves the focus where it was tells nothing, so a
thread marked while focused stays marked until the focus leaves and comes back (selecting its
sidebar row while it is already focused is no commit, so it does not clear it). Ops a model
runs with `KeepFocus` put the focus back, so they do not count. A dropped bus event is caught
up from the snapshot. `FocusGained` with no viewer, or while away, ends the hold only; the
thread is seen when a view and attention meet, as Done is.

## Presence rising holds the mark

Decision: coming back to the app with the marked thread still showing does not clear it,
unlike a real Done. The user marked it while looking at it; leaving the app and coming back
is not looking at it again. A real Done clears on the rise because the user had not seen
that turn; here they have.

## Wakes, alerts, badge

- No wake: Idle "at prompt" to NeedsAttention "finished" makes `CondAttention` true, a
  transition `observeLocked` would fire on. `absorbLocked` sets each subscription to the
  thread to what the new status meets before the commit, so nothing fires; settled and idle
  were true before and stay so; the thread's next real attention (after a turn) fires as
  ever. Held lead wakes: settled before and after, nothing released.
- No notification: nothing posts to the bell.
- The Dock badge: the brief assumed Done is not counted there. It is: the GUI's badge and
  window title count `attentionIds`, every NeedsAttention thread, "finished" included
  (stores/threads.ts). The mark is exactly Done, so a marked thread counts there like any
  Done thread, and this change touches neither. Excluding it would need a field telling a
  mark from a turn, which the design rules out.
- The Dock bounce fires (stores/dockAlerts.ts) when a thread enters the attention set while
  the app is not attended. Marks from the window are made while attended, so they never
  bounce. A mark from the CLI while the app is in the background would bounce as a turn
  ending there does.

## Gotchas

- The hold is in memory. After a daemon restart the GUI's thread views reconnect, which is a
  new viewer, so a thread marked while showing is seen once the restarted daemon has a
  view on it while attended. Not shown, it stays Done across restarts (the status is saved).
- The mock daemon marks and refuses like the daemon, but sees a thread only when a view opens
  (mock/thread.ts `seen`), so it holds while showing for free and has no focus rule.
- cmd+shift+u was git.pull's chord until the git verbs lost theirs, and free since. A user
  override that binds it to another command now meets this default, and the default wins
  (the settings issue says the chord is already bound), as with any new default chord.
  `TestStaleKeybindingOverrides` used it as its example of a free retired chord; it uses
  cmd+shift+k now.
- The success toast follows the toast rule: silent from the row's menu, toasted from the
  header's, the tab's, the palette and the chord, where the row may be out of view.

## Verified

- Go: `TestMarkUnread` (running and stopped, held while viewed through a presence rise, a
  second view, reopen, focus, a message, the stop and a restart, a view opened while away),
  `TestMarkUnreadRefusals`, `TestMarkUnreadFiresNoWake` (five conditions, running and
  stopped, and the next real attention still firing), `TestStreamStatusMarkUnread`,
  `TestFocusedThread`, `TestThreadFocus`, `TestThreadUnread`. Removing the hold from
  `onAttended`, from `seenStoppedLocked`, the detach carry, the absorb or the `onViewers`
  clear each fails one of them.
- Vitest: lib/markUnread.test.ts, ThreadMenuItems.test.tsx (position in all three menus,
  the command and its inView, hidden for each refused kind), bindings.test.ts (`inPalette`),
  mock/world.test.ts. Playwright: e2e/thread-mark-unread.spec.ts presses the chord through
  the keymap; its SHOTS tests make the PR's screenshots.
- End to end with `make drive DAEMON=dev` on a scratch home and a scratch
  `CLAUDE_CONFIG_DIR`, the fake claude (text-table) behind `advanced.claude_path`: a thread
  marked from its row's menu while another showed read Done and cleared when opened; one
  marked by cmd+shift+u while showing held, through another tab taking its place, and cleared
  when its tab was activated again; one marked while showing held while a tab moved into a
  pane beside took the focus, and cleared when its pane was clicked.
