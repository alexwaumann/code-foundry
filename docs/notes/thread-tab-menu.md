# The thread's menu on its tab, and Fork and Remove in every thread menu

A thread had three menus that should be one: the sidebar row's context menu, the header's
"…", and nothing on its tab. Fork and Remove were only in the sidebar row's.

- A right click on a thread's tab (in the strip, and its icon in a rail) opens the header's
  menu: Keep open (a preview), Open ▸, Move to space ▸, the thread's items, Close.
- Fork and Remove moved into the shared list (`ThreadMenuItems`), after Archive, so all three
  menus end with them. The header's and the tab's Close sits after Archive, before that group,
  so the destructive item stays last.

## Decisions

- One body, `components/thread/ThreadMenu.tsx` `ThreadMenuBody`, drawn with a menu kit
  (`menuKit.ts`): the header gives it the dropdown's parts, the tab the context menu's. The kit
  gained `Shortcut` and a destructive `Item`; `ui/context-menu.tsx` gained `ContextMenuShortcut`,
  the dropdown's copy.
- The sidebar row keeps its own Open ▸ and Move to space ▸ (their test ids and the row's
  thread as the verbs' context) and has no Close or Keep open: those act on a tab, and the row
  may have none.
- The tab's kit is `tabMenuKit`: a context menu's parts with `rowInView` false, as no sidebar
  row is known to be on screen, so Pin, Archive and Remove toast as they do from the header.
- `TabContextMenu` (PaneTabStrip) wraps the strip's tab and the rail's icon, so a terminal's
  menu now opens from a rail too. Its `wrap` puts the rail's tooltip around the menu's trigger:
  a tooltip goes outside a menu's trigger (`ui/tooltip.tsx`), and `radix-ui`'s Slot is not
  imported outside `components/ui`.
- `ShellSurface.tabMenuKeepsFocus` is asked as the menu closes: an Open ▸ item, Rename, New
  thread on this branch and Move to project… put the keyboard somewhere, and the menu must not
  take it back to the tab.
- An item of the tab's menu acts for the tab's thread, not the window's selection: the tab
  right-clicked need not be the active one (`shell-linked.spec.ts`).
