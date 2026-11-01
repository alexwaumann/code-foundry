# e2e flake fixes after the vitest-first series

The full run on main after #458-#465 took 8.1 minutes for 655 tests (down from 12.8 minutes
for 787 tests on #458's branch). It had 4 failures. Re-running each commit from before the
series through every merge showed that none of the failures came from the series. Three
failed again with the machine idle; all three were tests racing the app.

* plugin-env-restart, "an idle stale thread": Escape closes the title menu, and the menu then
  animates out with focus still inside it. A click on the title before it is gone does not open
  the menu again. The test now waits for the menu to go before it marks the environment stale.
* thread-project-set, "Add project": the same race on the thread info card's project row. Its
  third pick did not wait for the add-project list to close (the first two did). It now waits.
* dictation, "Escape in the prompt stops": clicking the sidebar row leaves the row's hover card
  open for a moment after the pointer moves away. While it is up, it takes the first Escape
  (Tip's Escape rule) and dictation keeps going. `openThread` now moves the pointer to the
  composer and waits for the hover card to close.
* SidebarRow.test "under a minute: seconds" read `NOW` when the file loaded and rendered against
  the real clock. Under load it read "5s". The status-time cases now hold the clock at `NOW`.

thread-info "split rows" failed once under load and passed alone. Left as is.

A second full run turned up two more.

* project-sets, "Save as workspace": a real bug. The dialog's name field took focus, then
  lost it to the body. The dialog's overlay appears under the pointer, so the pointer "leaves"
  the menu item while the menu is still fading out. Radix's onItemLeave then focuses the closing
  menu's content, which unmounts. The shared `DropdownMenuItem` and `ContextMenuItem` now call
  preventDefault on that pointerleave while their menu's `data-state` is closed
  (`components/ui/menuItemLeave.ts`, unit-tested). That covers every menu item that opens a
  dialog, and Snooze › Pick a date too.
* thread-prompts, "question keyboard": an Escape sent right after the reload, before the fresh
  question landed, went nowhere. The test now waits for "1 of 2" and for focus. Its
  `openThread` also uses the new `leaveSidebar` fixture (pointer off the row, hover card
  closed), which dictation now shares.

## Open question

The first two are real, if rare, behaviour: a click on a menu trigger within the previous
menu's close animation (about 150 ms) is lost. Nobody has reported it, so these are test-only
fixes. If it shows up in use, the place to look is how Radix's close focus handling
(`onCloseAutoFocus`, `focusPromptAfterMenu`) interacts with a menu reopened during exit.
