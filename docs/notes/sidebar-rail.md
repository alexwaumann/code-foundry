# Sidebar rail

cmd+B and the top bar's sidebar toggle used to hide the sidebar completely, with a Needs you
control in the top bar while it was hidden. A user found that hid too much: nothing said what
needed them, what had finished or how much was working. The hidden state is gone. Collapsed, the
sidebar is a 40px rail of icons that keeps its whole feature set. Designed over several sketch
rounds (real-app renders with injected DOM); this records what was built and why.

## What it is

- `stores/ui.ts` `sidebarExpanded` (renamed from `sidebarVisible`): true is the full list, false the
  rail. The persisted store still reads an old `sidebarVisible`, so a sidebar that was hidden loads
  as the rail; nothing else migrates.
- `components/sidebar/Sidebar.tsx` draws `SidebarExpanded` or `rail/SidebarRail`.
- The rail, top to bottom: the menu pane (New thread, search), Ember's flame (when its row would
  show) and a separator, Needs you (at most four icons tall), a separator when Needs you has rows,
  Active (the height left), then pinned to the bottom a separator, Working / Snoozed / Archived
  (each while its section would show), a separator, a pending update's tile, the palette, usage
  and settings buttons and the daemon's dot.
- Sizes (`rail/railLook.ts`): the 12px shell gutter plus a 28px column. Icons are 26px tall, 28px
  wide, 2px apart, a 16px glyph. Separators are a 16px hairline in the divider colour. Layout px,
  so the page zoom scales the rail as it scales everything else.

## Reuse over a parallel list

- `shell/listRows.ts` (`useShellListRows`, `useSelectedRowKey`) and `shell/ThreadListbox.tsx` came
  out of `ShellSidebarList`: the rows, the listbox with its keyboard cursor (arrows, Home/End to
  Ember, Enter, F2, Escape), a row's click (`activate`), and the right-click menu
  (`ShellRowMenu`, `DraftRowMenu`) with the rows' hover cards shut while it is open. The expanded
  list and the rail are two presentations over the same listbox.
- `rail/RailRows.tsx` draws a row as an icon and wraps it in the row's own hover card
  (`NeedsHoverCard` for Needs you with the same `sidebar:<id>` anchor, `ThreadTooltip` otherwise)
  and its drag (`useThreadDrag`). Only one of the two presentations is ever mounted, so they share
  the anchor and the cursor key.
- The footer buttons are the expanded footer's (`SidebarStatus.tsx` `PaletteButton`,
  `UsageButton`, `SettingsButton`), so tooltip changes there reach the rail. `DaemonStatus` has a
  `dotOnly` mode: its version and words move into the tooltip.
- Ember's menu (`EmberRowMenu`) and line (`EmberLine`) are exported from `EmberRow.tsx`; the rail's
  flame has the row's click and menu, and its tooltip shows the name and the line the row shows.

## Icons

`railThreadLook` (pure, tested): a Needs you row shows its ask's icon (permission, question, plan)
in the warning colour; an Active row its status icon in its colour; a row that would only show a
time gets the thread surface's MessageSquare, muted. A draft gets the draft mark on the draft
row's amber tint. A pinned thread has a small pin on the icon's top right corner. The selected
thread takes the rows' selected fill.

Working uses the working status's icon in the info colour; Snoozed and Archived the icons of the
row's own Snooze (AlarmClock) and Archive (Check) actions, one small component each in
`rail/RailSections.tsx`, named (for a screen reader) with their count; the rail draws no counts.

## Selected section tile

A user found the rail lost the open thread whenever it was working, waiting, snoozed or archived
(an Archived or Snoozed row opens as the preview tab): its row is inside a section's card, so no
icon was selected. A Working, Snoozed or Archived tile now takes a thread icon's selected fill
(`railTileClass(true, …)`) while the selected thread is one of that section's rows, and follows the
selection live (the thread starts or stops working, is archived, snoozed or woken, focus moves).

- The selected row is the expanded list's: `RailSectionCard` reads `useSelectedRowKey` (what
  `ThreadListbox` hands both lists as `selectedKey`: the focused pane's thread, its nearest shown
  ancestor for a hidden child, or the composer's draft) and checks it against the section's rows.
  No rule of its own, so at most one thing on the rail is selected: the rows are split between
  the icons and the cards.
- Selected wins over the open card's hover fill, as it does over a thread icon's hover; the focus
  ring stays. Inside the card the row shows as selected as before.
- The tile is a button with `aria-haspopup="listbox"`, not an option, so it carries
  `aria-current="true"` (and `data-selected` for tests), never `aria-selected`.

## Working, Snoozed and Archived cards

`rail/RailSectionCard.tsx`. Hovering or focusing a section's icon opens a card to the right of the
rail (the shadcn HoverCard, 200ms open and close delays): the section's name and count on top,
then its rows as the expanded sidebar draws them, "a menu inside a hover card". It replaced the
placeholder tooltip.

- Reuse: the rows are the expanded footer's `PanelRows` (exported from `ShellSidebarList.tsx`,
  with a `fade` prop for the rail's scrolling look) inside a `ThreadListbox`, so a row's click
  (`activate`: an Archived or Snoozed row opens as the preview tab), right-click menu, drag, hover
  actions (Snooze, Archive), own hover card and the keyboard cursor are the expanded row's.
  `ThreadListbox` gained `label`, `claimsFocus` (false: the window's focus request stays the rail
  list's) and `onMenuOpenChange`.
- `useShellListRows({ expandAll: true })` (was `expandMain`) lists every section's rows whatever
  its collapsed state in the expanded sidebar; the card never changes `workingCollapsed`,
  `snoozedCollapsed` or `archivedCollapsed`.
- The list is capped at 300px (`RAIL_CARD_MAX`), virtualized, no scrollbar, the edge with more
  fades (`useEdges`, moved to `shell/useEdges.ts` and shared with `RailGroup`).
- Open state is the pointer (Radix's hover, over the icon or the card) or a row's menu being up
  or the keyboard in the card. A row's click closes it. Placement: side right, aligned to the
  icon's top less 4px so the header sits level with it; Radix shifts it up when it would not fit.
- Keyboard: the icon is a button; focus opens the card, ArrowRight, ArrowDown, Enter or Space
  hand the keyboard to its list (the listbox's keys then apply), Escape closes it.
- A drag out of the card: the row is the drag's source, so the card stays mounted but invisible
  until the drop, then closes.

## Update tile

`UpdateTile` in `components/update/UpdateIndicator.tsx`, beside the expanded footer's chip and
built from the same `updateBadge` and tone table (`useUpdateBadge`): a 28 by 26px rounded-md tile
above the palette button with the chip's icon (14px, the footer buttons' glyph size) in the chip's
tone, no text. Its tooltip is the chip's words, the label then the call to action, muted; a click
opens the update dialog as the chip does. No tile while there is no update.

## Decisions

- The rail lists Needs you's and Active's rows even when their headers are collapsed in the
  expanded list (`useShellListRows({ expandMain: true })`): the rail has no headers to open them
  with, and a collapsed section would simply vanish.
- Scrolling: each group is its own virtualized scroller, never a scrollbar, and a mask fades only
  the edge that has more to scroll to (`edgeMask`), kept up to date on scroll, resize and content
  changes. Active has a floor of three icons.
- Rename from the rail (F2, the menu's Rename) opens the expanded list, where the rename field is
  (`renameInSidebar`, also used by `beginRename` and cmd+R). A double click on an icon does not
  rename: the click before it opens the thread and gives its prompt the keyboard, which then takes
  focus from the field the expanded list just mounted, and the rename is committed unchanged.
- Readers of the old flag: `PaneHeader` no longer pads for a missing sidebar (the top bar holds the
  traffic lights and the sidebar is never gone); rename paths still expand first; cmd+B still
  hands the keyboard to the thread's prompt when collapsing and to the list when expanding.
- The search icon runs the normal thread find; while an agent search has something to say (the
  expanded menu's search row), a dot marks the icon, the tooltip says what the row says and a
  click opens that search.
- Footer buttons keep their own 14px glyph (the expanded footer's, as the final sketch has them),
  inside the rail's 26px target.
- Removed: the top bar's Needs you control (`NeedsPopover`), `useNeedsList`, and the needs store's
  `popover` flag and `setNeedsPopover`. The space tabs' counts, the bell and the Needs you popup stay
  (which tabs show a count follows the Needs you scope, collapsed or not: `space-tab-counts-scope.md`).

## Gotchas

- React's pointer enter and leave follow the component tree through portals, so the pointer
  moving from a section card into a row's context menu or its thread card does not leave the
  section card. Moving out of all of them does, and Radix starts its close: the row menu holds
  the card through `onMenuOpenChange`.
- A right click focuses the card's list, and a menu that unmounts with the focus in it fires no
  blur, so "focus in the card" stuck the card open. Only keyboard focus (`:focus-visible`) holds
  it, and closing the menu re-reads both the pointer and the focus.
- Radix's hover-card trigger opens on focus, so refocusing the icon after Escape would reopen
  the card; Escape leaves the focus to the list's own Escape (the open thread's prompt).
- The mock's `update/latest` takes `stepMs` to pace the download; a long one holds Downloading
  for the tile's screenshot.

- `ThreadListbox` focused itself on mount whenever `sidebarFocusSeq` was above 0, so a list mounted
  later (the rail giving way to the expanded list for a rename) took the keyboard from the rename
  field. Each focus request is now acted on once (`handledFocusSeq`), whichever list is mounted.
- Tailwind's `[&_svg]:size-4` on a `CommandButton` beats the glyph's own `size-3.5` (a descendant
  selector is more specific), which is how the menu pane's plus gets 16px without a new prop.
- Tests: the rail's vitest mocks TanStack Virtual as the sidebar's tests do, and opens a section
  card by focusing its icon past the open delay; the update tile is
  `components/update/UpdateTile.test.tsx`. Width, scrolling, the fades, the cards' placement, the
  card staying open across the gap and the 300px cap are `e2e/sidebar-rail.spec.ts`, which also
  takes the PR's screenshots (`SHOTS=<dir>`).
