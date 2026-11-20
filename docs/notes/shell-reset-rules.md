# Shell reset rules: from mounted views to the stores

An audit of the frontend's effects found rules about "something happened" written as "a value
changed while this view is mounted". They date from the one-pane window. The shell mounts
several of these views, or none, so such a rule ran once per view, or from the wrong one. Each
rule below now lives where its state lives and holds whichever views are mounted.

## Thread info overlay (`stores/threadInfoOverlay.ts` setCardRoom)

Rule (thread-info-overlay.md, "Dismiss"): another thread hides the overlay; room again hides it.

* **Bug, reproduced** (`components/threadinfo/useInfoRoom.test.ts`), two ways, both only with
  several thread panes:
  * a pane for thread B mounting beside A hid A's overlay: each body's mount effect hid any
    overlay not its own ("a pane for another thread mounting beside it keeps the shown thread's
    overlay");
  * B's pane going away hid A's overlay too: the body's cleanup resets the unnamed measure
    (`setCardRoom(true)`), and the unnamed measure's "room again" cleared any overlay ("the body
    going away hides its overlay; another pane's going away does not").
* **Fix.** useInfoRoom's mount effect is gone; setCardRoom carries both rules. The unnamed
  measure stands only for a thread no body measures, so it clears only such a thread's overlay.
  A body arriving for another thread clears only an overlay whose thread no body shows. A body
  moving to another thread, or going, still hides its own overlay (its cleanup, unchanged).
* **Same in one pane.** With one body the overlay's thread is that body's, so the cleanup
  already hid it before the next body's mount effect ran (React runs every effect cleanup of a
  commit before its new effects); the removed effect only ever acted on an overlay left for a
  thread with no body, and the arrival rule keeps that case.

## Full screen (`shell/fullscreen.ts`)

Rule (shell-19-rails-fullscreen.md): full screen ends when the window leaves its space or the
space has no pane to show, and coming back does not resume it.

* `full` was always derived (fullscreenPaneOf); PaneGrid's effect only cleared the stored flag.
  Now a layout-store subscription in shell/fullscreen.ts clears it, mounted grid or not. It
  watches the layout only: the flag is only ever set by enterFullscreen, which checks the pane.
* **Differs**: while no grid was mounted (the window waiting for the daemon's layout), leaving
  the space or the layout being reset left the flag set, and full screen came back with the
  space. Now it ends, as the rule says.
* The layout store publishes each change in one setState (`publish`), so the subscription never
  sees a half-applied layout.

## Sidebar keyboard cursor (`stores/sidebarCursor.ts`)

Rule: a selection made elsewhere moves the highlight and drops an old keyboard cursor.

* Was an effect in ThreadListbox, run by every mounted list (the expanded list, the rail, each
  open rail card), and also on each list's mount.
* Now one subscription on the ui, threads and layout stores. It remembers the highlighted row
  the cursor was set against (`seen`); when the highlight moves to a row the cursor is not on,
  the cursor goes. The highlighted row's derivation (focusedDraftOf, selectedRowKeyOf) moved
  there too, and listRows' useSelectedRowKey uses it, so the two cannot drift.
* It computes the highlight only while a cursor is set, so a streaming threads store costs a
  null check.
* **Differs**: a list mounting no longer drops the cursor. Before, opening a rail card or the
  rail giving way to the expanded list (or back) dropped a cursor that was off the highlighted
  row; now it stays where the keys put it, and a list without that row shows none (ThreadListbox
  `shownCursor`), as before.
* Not a read-time rule: the cursor reading null against a stale selection would come back when
  the selection returned to the row it was set against; the effect never brought one back.

## Left alone: the sidebar selection's order (ThreadListbox setSidebarOrder)

* `stores/shellList.ts` sidebarThreadOrder gives the same thread order the list draws: drafts are
  not thread rows, and the one option that differs (openThreadId: the list passes it only for a
  put-away thread, the getter for any) affects only the Snoozed and Archived footers, where any
  open thread is a put-away one.
* But the effect is more than a copy. It prunes the selection when a selected row leaves the
  list, it gives the shift-click anchor (the highlighted thread row), and the selection lives
  only while the expanded list is mounted (its cleanup drops it). It runs in that one list only
  (`multiSelect`), so it is not a several-views rule. Replacing it means either read-time
  pruning in every reader (the selection size, a row's selected state, the bulk menu's "two or
  more") or a store subscription rebuilding the sections on each threads-store change, where
  the list's memo rebuilds only when a list key changes. Neither is cheap, and the behaviour
  is right.

## Tests

* `components/threadinfo/useInfoRoom.test.ts`: two panes, a body moving, bodies going, an
  overlay left for a thread no body shows.
* `stores/sidebarCursor.test.ts`: the highlighted row, and a table of selection, thread and
  draft changes against a cursor, with no list mounted.
* `shell/fullscreen.test.ts`: leaving the space and the layout going end full screen with no grid
  mounted, and coming back does not resume it; a layout change that keeps a pane keeps it.
