# Shell PR 15: the top bar and spaces

Fifteenth PR of the shell stack (`docs/notes/shell-plan.md`, section 4). With the shell flag on, a top
bar spans the window: the app name, the sidebar toggle, back and forward, the space tabs and "+".
Spaces switch, rename, reorder and are removed from it; a tab or a pane dropped on a space tab moves
there; Move to space ▸ lists the real spaces; cmd+[ and cmd+] go back and forward through what was
focused, across panes and spaces; ctrl+cmd+1…9 switch space. With the flag off nothing changes.

## What is in it

| File | Holds |
| --- | --- |
| `components/shell/TopBar.tsx` | the bar: traffic-light gutter, app name, sidebar toggle, back and forward (`view.back`/`view.forward` buttons dimmed by the focus history), the space tabs, "+" |
| `components/shell/SpaceTabs.tsx` | the space tabs: glyph, name, needs-you count; click, double click or F2 to rename, context menu (Rename…, Remove space…), drag to reorder (dnd-kit sortable), marked while a grid drag is over it |
| `components/shell/SpaceIcon.tsx` | a space's glyph from its own tree |
| `components/shell/RemoveSpaceDialog.tsx`, `stores/removeSpaceDialog.ts` | the remove dialog: what closes, how many threads, move them to (a space) or archive them all |
| `shell/spaces.ts` | pure: `spaceGlyph`, `spaceAttentionCounts`, `spaceDropCommands`, `removeSpaceArgs`, `defaultRemoveTarget`, `threadsOfSpace`, `spaceAtIndex`, `reorderIndex` |
| `shell/spaceActions.ts` | what the controls run: `space.switch`, `space.new`, `space.rename`, `space.move`, `space.remove`, the drop's verbs, Move to space ▸ New space |
| `stores/focusHistory.ts` | the focus history: recorder, push rule, live entries, back and forward, `useCanStepFocus` |
| `palette/shellPreview.ts` | "Toggle new shell (preview)" in the palette |
| `components/shell/ShellDnd.tsx`, `shell/drag/state.ts` | space tabs as drop targets; the top bar ends the grid's outer band |
| `shell/keys.ts` | cmd+[ / cmd+], ctrl+cmd+1…9 |
| `shell/linked.ts`, `LinkedRow.tsx` | the row of a thread living in another space takes the window there |
| `ThreadSurfaceItems.tsx` | Move to space ▸ with glyphs and New space |
| `App.tsx`, `Sidebar.tsx`, `Shell.tsx`, `PaneView.tsx`, `PaneTabStrip.tsx`, `stores/views.ts` | small: the bar above the sidebar and the grid, the sidebar band hidden in the shell, the grid right under the bar, no traffic-light inset on the top-left strip, `view.back`/`view.forward` step the focus history in the shell |
| `mock/layout.ts`, `mock/layoutVerbs.ts`, `mock/world.ts` | `move_thread` (simplified), `space.rename`, `space.move`, `space.remove` (with `--archive`), `thread.space.move` |
| `e2e/shell-spaces.spec.ts` | drops on a space tab, focus history across spaces, the drag band and its controls; SHOTS |

## Decisions

- **The bar is the title band's height** (56 px: the shell gap, then a 44 px row centred where the
  host puts the traffic lights) and starts with the traffic-light gutter. It is `bg-cf-chrome`, as the
  sidebar's band was. The grid starts right under it (`m-shell mt-0`), so the bar is the gap above
  the panes. It spans the window above the sidebar and is not aligned to it: the sidebar's own band
  (app name, back and forward) is not drawn while the shell draws (`useShellChrome`, also true while
  the window waits for the layout, so the band does not flash). With the sidebar hidden the top-left
  pane no longer pads its strip past the traffic lights: the bar holds them.
- **The window's drag band** is the bar (`--wails-draggable: drag`); its buttons, history and tabs
  are `no-drag`. The strip's free space stays the pane's grip (PR 14).
- **A space tab**: a quiet row; the current one a bordered pill (`border-cf-border`, `bg-cf-surface`).
  The glyph is `plainRects` of the space's tree laid out at 8× the 16 × 12 box and scaled down, so the
  12 px gutter is a 1.5 px gap; each pane an outlined rectangle; a space with no pane is one
  rectangle. The count is `attentionIds` (the user's own threads, not archived, snoozed or started by
  a thread) by the space each lives in; it is the warning tint, with "n threads need you" as its
  label. A name cut short has its `whenTruncated` tooltip.
- **Rename**: double click, F2 or the menu's Rename… put a field over the name; Enter or leaving it
  renames (`space.rename`), Escape keeps it. "+" runs `space.new --focus` and opens the field on the
  new space's default name, selected, so typing names it.
- **Reorder**: dnd-kit sortable inside the bar (its own `DndContext`, outside the grid's), 4 px to
  start; the drop runs `space.move --index` and the new order shows until its commit arrives. The
  sortable's attributes are not spread: their `aria-disabled` while renaming marked the name field
  inside the tab disabled (WebKit's spec caught it).
- **Remove**: the menu's Remove space… (disabled as "The last space stays" for the last one) opens
  the dialog: "Its n tabs and panes close. It holds n threads.", then, when it holds threads, Move
  them to [space] (default: the space on its left, else on its right, the daemon's own default) or
  Archive them all. The count is the user's own threads that are not archived, as the daemon's
  `removal` counts them. Remove runs one `space.remove --to` or `--archive`; the dialog was the
  question, so the daemon's own confirmation is answered yes (`invokeConfirmed` with `ask`). The
  palette's Remove Space keeps the daemon's plain confirmation.
- **Drops on a space tab** (`spaceDropCommands`): a thread's tab runs `thread.space.move` (it takes
  its linked tabs in its space); any other tab `tab.move --space` (a linked one waits there, dormant);
  a pane `pane.move --space`. The daemon refuses a pane holding a thread's own tab, so each thread in
  it moves first and the pane follows with what is left (nothing left: no `pane.move`). The verbs run
  one after the other and stop at a refusal (an identity already open there is refused by the
  daemon, and toasted). The current space's tab is not a target. The window stays in its space.
- **Hit-testing**: the bar and its space tabs are measured (viewport px) when a drag starts. Over a
  space tab that would take the source, the drag state's `space` is set and `target` is null; anywhere
  else in the bar there is no target, so the grid's 24 px outer band above the panes stops at the bar.
  `targets.ts` and `drop.ts` did not change (another PR is in `drop.ts`). The tab under the drag is
  marked with the focus colour; there is no preview rectangle. Announcements: "Tab Diff is over the
  space Review." and "… was moved to the space Review."
- **Focus history** (`stores/focusHistory.ts`): entries are (space, pane, tab). The recorder follows
  the layout slice: the current space and its focused pane's active tab, once per task (a close and
  its refocus, an optimistic focus and its confirmation count once). Every way the focus moves goes
  through the layout (a press, the keys, a space switch, the linked row, cmd+shift+d, the terminal
  ring, a sidebar click), so none of them calls it; hovering never moves the layout's focus. Browser
  semantics: a new focus drops the entries after the current one; 100 kept. Back and forward go to
  the nearest entry that is live and is not what is focused now; an entry's tab is found where it is
  now (it may have moved pane or space); a space recorded with no tab is switched to. A step moves
  the index first, then focuses with `tab.focus` (which switches space), so its own focus is not
  pushed; the keyboard follows into the pane. Per window, not persisted.
- **cmd+[ and cmd+]** are in the interim key table (they step at once). `view.back`/`view.forward`
  (the registry's chords, the palette, the top bar's buttons, the CLI's intent) step the same history
  while the shell draws (`historyCommand`); with a sheet open, back still closes it first.
- **ctrl+cmd+1…9**: `space.switch` to the nth space; a number past the last does nothing.
- **The linked row** of a thread living in another space now runs `thread.open --focus`: its tab
  opens or is focused in its own space and the window switches there (it said where it was before).
- **Move to space ▸**: every space with its glyph, the thread's own marked "here"; then New space,
  which runs `space.new --focus=false` and `thread.space.move` to it (the window stays).
- **Reopening in the same space** needed nothing in the GUI: the daemon stores `current_space`, and
  a reload lands in it (checked end to end).
- **"Toggle new shell (preview)"** is a palette row the palette adds itself (not a daemon command):
  it sets or removes `localStorage["code-foundry.shell"]` and reloads, so the owner can try the shell
  in the real app window on this branch. The cutover PR (PR 20) removes it.
- **Mock**: `move_thread` is simplified (not run against Go's cases, like `open_thread`): the thread's
  tab after the target's focused pane's active tab, its linked tabs in its space placed by the mock's
  placement, one whose identity is open there closed. `space.remove --archive` archives the user's
  threads in the space through the world.

## Visible differences from the sketch (01, 04b)

- The bar does not line up with the sidebar (the spec's rule): the app name sits after the traffic
  lights, and the sidebar's menu card starts under the bar. The sketch has them in one column.
- The count's tint is the app's warning surface with its text colour; the sketch's is a filled amber
  circle.
- A space tab under a dragged tab or pane is outlined in the focus colour (not in any sketch).
- Move to space ▸ shows the glyphs as drawn from each space's tree, so a space with no pane is one
  rectangle, as "Reviews" is in the sketch.
- The sidebar's contents are unchanged (PR 16), so its rows are today's and it still lists every
  space's threads.

## Verification

- `make check` green (numbers in the PR).
- vitest: `shell/spaces.test.ts` (glyphs for no pane, one, two, a column in a row; counts by space;
  every drop source's verbs, a pane with threads, nothing left, its own space, a gone source; remove
  args and the default target; the nth space; reorder index), `stores/focusHistory.test.ts` (push,
  forward dropped, the cap; recording focus changes and space switches once each, a space with no
  pane; back and forward across spaces with the keyboard request and no push of its own; dead entries
  skipped, a moved tab found; the focused entry skipped; a space without a tab switched to),
  `components/shell/TopBar.test.tsx` (the bar's parts, the counts, the glyphs, the drag band's
  classes, click switches, "+", rename by double click with Enter and Escape, the menu and the last
  space, the drop mark, back and forward dimming; the dialog's move and archive outcomes and a space
  without threads), `linkedTabs.test.tsx` (Move to space ▸ with two spaces, glyphs, the verb),
  `linked.test.ts` (the row of a thread in another space), `keys.test.ts` (two rows),
  `palette/shellPreview.test.ts`.
- e2e `shell-spaces.spec.ts` (WebKit, mock): a linked tab, a pane and a thread's tab dropped on space
  tabs by the pointer (marked while over, no grid preview over the bar, the stored layout after each,
  the verbs `tab.move`, `pane.move`, `thread.space.move`), the own space not a target; focus by press
  and ctrl+cmd+2, then cmd+[ three times back across the two spaces, cmd+] and the bar's forward
  button; the bar's `--wails-draggable` (drag on the bar and the app name, no-drag on its controls)
  and clicks on a space tab, the sidebar toggle and "+" with its name field.
- End to end with `make drive DAEMON=dev` and `?shell=1` on a scratch home under /tmp (removed
  after): two no-project threads; Alpha opened, cmd+t twice put two linked terminal tabs in a pane to
  its right. "+" in the bar made a space and typing named it "Review". ctrl+cmd+1 back to Main, then
  Alpha's menu › Move to space › Review: `layout show` had Main with no pane and Review with Alpha's
  pane and both terminal tabs. In Review, one terminal tab dragged onto "Main" (marked while over)
  went there alone. In Main its row read "Terminal of Alpha · in Review"; its link switched to
  Review with Alpha's pane focused; cmd+[ went back to Main's pane, cmd+] forward to Review; a reload
  reopened in Review with the same pane focused. Then `space new --name Temp` and Beta moved there
  from the CLI; removing Temp in the bar's dialog moved Beta to Review (the default, on its left);
  removing Review with "Archive them all" archived Alpha and Beta, dropped its panes, closed the
  dormant tab in Main and ended both terminals (`terminal list` empty).
- Flag off: `make gui-e2e`, the existing suite (numbers in the PR).

## Gotchas

- dnd-kit's sortable attributes include `aria-disabled`; Playwright treats everything inside an
  `aria-disabled` element as disabled, so an input inside it cannot be filled.
- The mock's `thread/status` refuses a disconnected thread (`s-4`): use a connected one in a spec.
- `useFocusHistoryStore` and the layout slice are two stores: `useCanStepFocus` reads the whole
  history (small) and selects from the layout with it.

## For later PRs

- **PR 16 (sidebar)**: list only the current space's threads (`spaceOfThread`); a thread row could
  be a drag source onto a space tab too (`thread.space.move`): `spaceDropCommands` would take a
  `thread` source.
- **PR 17 (Needs you)**: the control for a collapsed sidebar goes in the top bar, after the space
  tabs' "+" or at the bar's right end; `spaceAttentionCounts` already splits the count per space.
- **PR 19 (rails, full screen)**: the bar stays in full screen (the spec); nothing to change here.
- **PR 20 (cutover)**: remove `palette/shellPreview.ts` and its palette row; cmd+[ / cmd+] and
  ctrl+cmd+1…9 move into the commands' keybindings (`space.switch` takes `--index`); the sidebar's
  `SidebarBand` and `HistoryButtons` go with the classic window (PR 21).
