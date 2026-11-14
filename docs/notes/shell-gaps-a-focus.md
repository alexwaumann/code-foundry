# Shell gaps A: focus, the keyboard and the command context

Gaps 1 to 10 of `docs/notes/shell-21-remove-classic.md` ("Shell gaps found": "Focus and the keyboard"
and "The command context"). Each test marked for them is un-skipped and green; none was deleted. Gaps 11
to 24 are other PRs'.

## The cause of each, and the fix

1. **A surface the user opens lands behind the active tab.** The host seam's `openTab`
   (`shell/hostShell.ts shellOpenTab`) always sent `open_surface` with `focus: false`, and the daemon
   places such a tab behind the focused pane's active tab. Every caller but one is the user's (a Pull
   Requests row, a workspace's View, the diff's Open file, a revert's new pull request, a path chip, the
   finder, a menu's Show changes), so `openTab` now takes the focus by default: a new tab opens with
   `focus: true` and, once its commit lands, its pane is asked for the keyboard; an open tab that is not
   already shown is focused and its pane asked too; one already shown and focused only takes its params
   (the Diff tab's own picks stay where they are).
7. **A thread's model moved the user's view.** The one caller that is not the user's,
   `stores/threadPanelIntent.ts` (the window's half of a `view.open.*` ShowView), went through the same
   path, and for a tab the daemon had already opened it sent `focus_tab`. It now passes
   `focus: false` (`openFileInPanel`, `openDiffInPanel`, `openPullRequestInPanel`, `openMcpSurface` and
   the gallery's `openTab` take it): only the tab's params change.
2. **The file finder's Enter left the keyboard in the prompt.** `openFoundFile` opened the file without
   the focus and then closed the palette, whose close asks the thread's prompt for the keyboard
   (`contentFocusSeq`). It now closes the palette as a dismissal (back to what had the keyboard) and then
   opens the file with the focus, so the keyboard ends in the File tab.
3. **Escape from the palette only served a thread's prompt.** `closePalette` bumped `contentFocusSeq`,
   which only `ThreadComposer` serves. The palette now notes the element that had the keyboard as it
   opens (`stores/ui.ts noteReturn`), and a dismissal (Escape, the backdrop: Radix's `onOpenChange`)
   hands it back there (`closePalette(true)`, `takePaletteRestore`, taken in `CommandPalette`'s effect
   once the dialog's focus trap is off). A command that ran still asks the content, as before: it may
   have moved the target. Two gotchas: the restore yields when something else took the keyboard first
   (a tab the pick opened), and an element that no longer takes focus asks its pane instead (a pane's
   body is focusable only while it has the keyboard, `PaneView focusInto`).
4. **`ui.focus.terminal` showed the tab but not the keyboard.** The window ignored the FocusTerminal
   intent, and `focusTerminalTab` asked the pane for the keyboard as soon as the terminal had a tab, which
   for a hidden open tab was before the commit that shows it: the keyboard went to the tab still showing.
   The intent now moves the keyboard (`followFocusTerminal`: a quick terminal's host, else the tab's
   pane), and `whenTerminalTab` waits until the tab is the active one of its pane.
5. **A quick terminal closed by its shell's exit took the keyboard with it.** Nothing handed it back: only
   cmd+j and the × asked the thread's pane. `QuickTerminal` now runs `handBackFromQuick` in a layout
   effect's cleanup (the node is still in the document then): when it had the keyboard and the layout has
   its quick terminal closed, the thread's pane is asked for it. Leaving the tab (the quick terminal still
   open) moves nothing.
6. **A terminal started under the usage sheet opened behind it.** Sheets close when the selection changes
   (`startViewSync`), and a terminal tab linked to the same thread changes no selection. A terminal this
   window starts or shows now asks for the keyboard with `requestPaneFocusOverSheets`, which closes the
   settings, usage and themes sheets: under a modal the keyboard cannot reach it. Not every pane request:
   a first version closed the sheet on any, and a clicked row's request, sent once its tab draws, closed
   the Settings sheet cmd+, had opened meanwhile (e2e plugins "Settings → Plugins: …").
8. **The row menu's Move to project… lost its picker about half the time.** Traced in WebKit: the
   thread's header mounts and unmounts as the tab opens (React's effect replay in the dev build, or a
   remount), and `MovePicker`'s cleanup did two things wrong. It closed the picker at once, so an opening
   asked for meanwhile was lost; and with the keyboard nowhere (the menu item that had it just went) it
   asked the thread's prompt for the keyboard. That request stays pending until the new composer mounts,
   which then takes the keyboard from the picker's filter, and the popover closes on the focus leaving
   it. Now the close waits a frame and is skipped when a picker for the thread mounted again
   (`holdMovePicker`), and the prompt is asked only when the picker itself had the keyboard. Each half
   alone left failures in 20 repeats; with both, none in 40.
9. **A focused terminal tab was not the context's terminal.** `getUiContext` lost its terminal with the
   bottom panel. It now adds `activeTerminalId`: the focused tab's terminal when the focused tab is a
   terminal's, else the quick terminal holding the keyboard (while the palette is open, the element that
   had it when it opened: `keyboardElement`). An explicit selection's context still has none. The
   command sync re-lists on layout changes and on `focusin`.
10. **cmd+t from a worktree shell's tab started a shell in home.** With the terminal in the context, a
    shell of a worktree and no thread also gives the context its project and worktree (its labels), as
    the classic Projects-page shell did, so `newTerminalTab` runs `terminal.new` there.

## Tests

- Un-skipped vitest: `PullRequestsPage` "a click on a row shows its pull request", `PullRequestSurface`
  "the revert's new pull request is shown at once", `CommandPalette.commands` "with the keyboard in a
  thread's shell…" (its setup now seeds a focused terminal tab, the assertions are unchanged).
- Un-fixme'd e2e: prs, workspace-page, file-tabs, file-finder, shell-tabs (palette), terminal-tabs
  (three), app (three), server-rollup, usage-sheet, thread-panel-items, move-no-project (the row menu's),
  terminal-find. workspace-page asserted `data-active=""`, which the strip never writes: it reads
  `"true"`. file-tabs' stand-in test ("…reached by its tab, while the gap above stands") is gone with the
  gap.
- New unit tests: the seam's focus rule as a table (`shell/hostShell.test.ts`), the context's terminal
  (`stores/context.test.ts`), the palette's return (`CommandPalette.test.tsx`), the FocusTerminal intent
  and the hidden-tab race (`stores/intents.test.ts`), the quick terminal's hand-back
  (`shell/terminalActions.test.ts`), the sheet closing for a terminal and not for a late request (`stores/views.test.ts`), the picker across a
  remount (`MovePicker.test.tsx`).
- Changed: `filePanel.test.ts` "openCheckoutDiff" now expects the tab shown with the focus (it said
  "without taking focus", the gap); `threadPanelIntent.test.ts`'s editor setup opens its tab with
  `focus: false`, as it did before the default changed.

## Decisions

- The default of `openTab` is the user's open (focus), not the thread's: every caller but the thread's
  ShowView is the user's, so the exception is the one that says so.
- After #700 (gaps C) `behind` is the id of the tab the user is typing in (`open_surface`'s
  `behind`). It wins over the default: an open with `behind`, the user's or a thread's, never takes
  the focus or the keyboard, and a new tab still waits behind that editor in its pane
  (`hostShell.test.ts`, the focus table's `behind` rows).
- The keyboard follows the focus into a tab the user opened (gap 2 asks for it; a pane focused without
  the keyboard is the bug gap 4 describes).
- Only a terminal's focus request closes a sheet (above): other requests can arrive late, after the
  user opened the sheet on purpose.
