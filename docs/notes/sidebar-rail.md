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
  (each while its section would show), a separator, the palette, usage and settings buttons and
  the daemon's dot.
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
row's own Snooze (AlarmClock) and Archive (Check) actions. In this step they are inert, one small
component each in `rail/RailSections.tsx`, named in a tooltip with their count; the follow-up gives
each a hover card listing its rows, and adds the update tile.

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
  `popover` flag and `setNeedsPopover`. The space tabs' counts, the bell and the Needs you popup stay.

## Gotchas

- `ThreadListbox` focused itself on mount whenever `sidebarFocusSeq` was above 0, so a list mounted
  later (the rail giving way to the expanded list for a rename) took the keyboard from the rename
  field. Each focus request is now acted on once (`handledFocusSeq`), whichever list is mounted.
- Tailwind's `[&_svg]:size-4` on a `CommandButton` beats the glyph's own `size-3.5` (a descendant
  selector is more specific), which is how the menu pane's plus gets 16px without a new prop.
- Tests: the rail's vitest mocks TanStack Virtual as the sidebar's tests do; width, scrolling, the
  fades and the card's placement are `e2e/sidebar-rail.spec.ts`, which also takes the PR's
  screenshots (`SHOTS=<dir>`).
