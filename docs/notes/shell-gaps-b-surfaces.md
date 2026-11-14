# Shell gaps 11 to 19: surfaces in panes

`docs/notes/shell-21-remove-classic.md`, "Shell gaps found", lists 24 gaps the classic window hid.
These are 11 to 19, "Surfaces in panes": what the side panel's box gave a surface and a shell pane
did not, plus three that only showed once the shell was the only window. Each is fixed at its cause,
its tests run again, and a unit test proves it where one can. No test was deleted: none of the nine
is right by `shell-model.md`.

## 11. A pane's body is not a scroll area

**Cause.** The side panel drew every surface inside its group body, a box with `overflow: auto` and
`[data-scroll-root]` (the box `components/pr/VirtualStack` virtualizes long lists against and
plugin nodes count as on screen in). A pane's body is a plain flex column, and the panel surfaces
(a pull request, a file, a diff, MCP, the gallery, Ember's board, plugin surfaces) do not scroll
themselves: a long pull request was cut at the pane's foot.

**Fix.** `shell/surfaces/panel.ts panelSurface` draws a panel surface's body inside that same box
(`shell-surface-scroll`). One place, for every panel kind; the thread, composer, page and terminal
surfaces scroll themselves as before.

## 12. Popups overhang their pane; Escape from a composer drops the keyboard

**Cause.** Popups find their collision boundary with `usePanelBoundary`, which looked for the
trigger's `[data-region="panel"]` ancestor (the side panel's `aside`). No pane has one, so a menu was
kept inside the window, not its pane. `PanelComposer`'s close handed the keyboard to the same
ancestor, so after Escape (or a send) the keyboard fell to the document body.

**Fix.** One mark on every open pane: `data-pane-box` on the pane's `section`
(`shell/paneBox.ts`). `usePanelBoundary` uses it as the boundary, and `PanelComposer` hands the
keyboard back with `focusPaneOf`, which focuses the pane body's focus root (the same path a focus
request takes, `focusPaneBody`, shared with `PaneView`). The popups' own `data-region="panel"`
went: it named the classic focus region, which no longer exists.

The gap's note also said that at 280 px a verdict chosen in the Review menu left the keyboard in
the closing menu. With the boundary in place the test's composer has the keyboard; that part was not
diagnosed further.

## 13. A surface's own keys are dispatched by nothing

**Cause.** `SurfaceSpec.onKey` (a pull request's cmd+shift+c) was called by the side panel's
`onKeyDown`. A pane had no key handler, and a press on a pull request's text left the keyboard on
the document body: the side panel's `aside` was focusable, a pane's body is not (on purpose: a
press on a composer's heading must not take the keyboard out of its prompt).

**Fix.** `ShellSurface.onKey`, mapped from the panel surface's `onKey`; the pane's `section`
dispatches it for its active tab (`PaneView` `surfaceKey`) after the window's keymap, outside text
fields, as the side panel did. The panel surface's scroll box (gap 11) is focusable
(`tabIndex=-1`) and the body's focus root, as the `aside` was, so a press inside a pull request
takes the keyboard into its pane. Only panel surfaces get it, so a composer's heading still leaves
the prompt alone.

## 14. An unlinked pull request tab loses its inner tab

**Cause.** `stores/prPanel.ts` kept inner state by `prTabKey(panelKey, tabId)`, the surface built
`panelKey` from the window's selection (`useCurrentTarget`: `view:pullrequests` for a page), and
`pruneClosedTabs` kept only keys of the seam's places, which are `thread:<id>` and `pane:<id>`. An
unlinked tab's key matched no place, so any layout change dropped it; a linked tab's key changed with
the selection.

**Fix.** Keyed by the tab's layout id alone, linked or not: it is unique and it is what every place
holds. `prTabKey` went.

## 15. A plugin surface linked to a thread follows the window's selection

**Cause.** `PluginSurface` read the window's selection for its watch's context, its show state and
its command buttons. With another tab focused (an unlinked terminal, a page) it said "Not available
here" and its node streams ended.

**Fix.** A tab linked to a thread (its panel key `thread:<id>`, `PanelKeyContext`) draws for that
thread; an unlinked one still for the window's selection. The show state then reads "unknown" while
the commands are listed for another context, so the surface keeps watching instead of saying it does
not apply.

## 16. An action run from the thread card opens no tab

**Cause.** `action.run --terminal` started the run's terminal and placed no tab, in the daemon and in
the mock; the GUI's `runAction` waited for a tab nothing opened. The classic window showed the run in
the thread's bottom panel.

**Fix.** In the daemon: `action.run` gives a terminal run's terminal a tab with `openTerminalTab`
(the same as `terminal.new`): linked to the run's thread and placed by the rules, or for a
worktree's run unlinked in the focused pane; from the user it takes the focus, from inside a thread
it never does. `ActionDeps` gained `Layout`; `openTerminalTab` takes the layout store instead of
`TerminalDeps`. An exited run keeps its tab (the layout drops a terminal's tab only when the
terminal is removed, `internal/daemon/layout.go gone`), so its output can be read, as the spec says.
The mock's `action.run` does the same through `ActionHost.openTerminalTab`.

## 17. Run in terminal: the timeline leaves its end

**Cause.** Not the resize: the press. The timeline counts a pointer press in the list as the user's
scroll input (the scrollbar) until 400 ms after its release. Run in terminal is a button in a row;
its terminal's pane opens within that window and narrows the thread's, the virtualizer re-measures
the rows above the view and moves `scrollTop` to keep them in place, and that scroll was read as the
user's: the list unpinned. It failed about half the time, depending on how fast the pane opened.

**Fix.** A press counts as the user's scroll only if the list moved while it was held (a dragged
scrollbar, a selection scrolling it); a click that did not move it leaves the layout's scrolls to
the layout (`components/thread/Timeline.tsx`).

## 18. A gutter takes no keyboard

**Cause.** The gutter was a separator with no `tabIndex`, no key handler and no double-click.

**Fix.** Focusable; the arrows move it 16 px (Shift: 64), Home and End go to the bounds
(`shell/resize.ts gutterKeyDelta`, kept at each pane's minimum by `dragSizes`), and a double click
shares the two panes beside it evenly (`evenSizes`). Each step commits with `pane.resize`, previewed
from what is drawn so quick presses add up. The handle shows while the gutter has the keyboard.

## 19. No "Moving to …"

**Cause.** Only the classic crumb (`ThreadCrumb`) read the move in flight. The shell's header has a
place chip that knew nothing of it.

**Fix.** `components/thread/useMovingTo.ts` (moved out of `ThreadParts.tsx`, which keeps using it for
a subagent run's crumb); the header's place chip says "Moving to <name>…" with a spinner from the
send until the move is done, in place of the branch or "No project".

## The Diff tab and the pull request's Code tab across a width change

The Diff tab drifted the way the File tab did (`shell-20b-gaps.md`, 3): measured at 2400 × 1100 on a
1200-line wrapped diff scrolled to 14000, its top row went 702, 703, 698, 702 at 90, 200 and 100%.
`useKeepTopLine` now takes how a box's rows are known: a file's by line number, a diff's by row index
(`data-line-index`'s unified part), since a diff's line numbers repeat (an old and a new line 10).
`DiffFile` uses it; the top row stays 702 at every zoom.

The pull request's Code tab is not changed. It draws the library's `CodeView`, many files in one
virtualized list with a container per file, which anchors its own scroll on a re-layout
(`getScrollAnchor` / `resolveAnchoredScrollTop` in its render); the hook assumes one file in one
shadow root and would fight that. The mock's pull request diff (three short files) is too short to
scroll, so that was read in the library's code, not measured.

## Tests

- e2e, run again: pr-panel ("long conversations and timelines are virtualized …", "an unlinked pull
  request tab keeps its Code tab …", "shift+cmd+c copies the link …", "at 280px the surface's popups
  …", "at 280px the merge split button …"), pr-stale-first, plugin-picker, plugin-streams,
  thread-info ("an action run from the card …"), code-block-actions, shell-tabs (with a double
  click now), move-no-project. New: file-zoom-scroll "the Diff tab keeps its top row …".
- vitest, run again: `PullRequestSurface` ("inner tabs stay per tab on the Pull Requests page too",
  "Escape from the Ask composer hands focus back to the tab's pane …"). New: `PullRequestSurface`
  "the pane dispatches the surface's own key …", `prPanel` "is kept for an unlinked tab …",
  `PluginSurface.watch` "a tab linked to a thread watches with its thread's context …",
  `timelineList` (a click that did not move the list; a press that did), `resize` (the keys, Home
  and End, the double click), `MovePicker` "the shell's thread header says Moving to …".
- Go: `TestActionRunOpensItsTerminalsTab` (a thread's run from the app and from the thread, a
  worktree's run, a background run).

## Gotchas

- The flaky gap (17) only failed when the pane opened within 400 ms of the click's release; logging
  the scroller's scroll and resize events in the test showed the virtualizer's +61 px correction.
- The Ask and Review composer tests mount the composer inside a pane box with a body
  (`data-pane-box`, `role="tabpanel"`), as a pane draws it.
- The pane boundary (12) makes Radix measure more while a popup is open: over the pull request
  surface's tests jsdom's `getComputedStyle` calls rose from 3807 to 5026 and
  `getBoundingClientRect` from 1049 to 2794 (counted, with the boundary off they are back at
  3864 and 1049). It is what the side panel's boundary cost before PR 21 removed it; in time it
  is under the noise of a loaded machine (the quietest pair: 7.6 s without it, 8.5 s with it,
  for 71 tests). No timer, observer or listener is left over: both branches end those files with
  the same counts.
