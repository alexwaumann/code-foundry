# A linked tab names the lead, not the child that opened it

A thread another thread created is never in the sidebar while its creator exists
(`no-sidebar-override-1-gui.md`). When a child opened a diff, a pull request or a terminal, the
window named the child: the row under the strip ("Pull request of ● child") and the tab's hover.
A user could not find that thread anywhere in the sidebar.

## The rule

Wherever the window names the thread a tab or a pull request is linked to, it names the lead:
`sidebarAnchor` of the linked thread, all the way up to the root (`lib/inSidebar.ts leadOf`). An
archived lead is still the lead (it is in the thread list). A thread whose creator was removed is
its own lead, as it is in the sidebar; under a removed lead the highest thread left is named. An
unknown thread or a creator cycle names the thread itself.

This is display only. `tab.thread`, where a linked tab is placed, which thread a terminal belongs
to and the daemon's link ownership are unchanged.

## What changed

- **The row under the strip** (`components/shell/LinkedRow.tsx`, `shell/linked.ts linkedRowOf`):
  the name, the status dot, live or dormant, "in <space>" and the click target are the lead's.
  `linkedRowOf` takes the lead as a third argument (the tab's thread when not given); live means
  the lead's tab is open in the tab's space; the click focuses or opens the lead's tab
  (`rowAction`, unchanged).
- **The tab's hover** (`LinkedTip` in `PaneTabStrip.tsx`, used by the strip and the rail): "… of
  <lead>".
- **The lead's menus list its children's tabs** (`threadSurfaces(…, kin)`,
  `ThreadSurfaceItems.tsx useKin`): the pane "+" menu's "This thread ▸", the thread header's Open
  ▸ and the sidebar row's context menu. `kin` is the threads in the space's tabs that the thread
  created, directly or further down (`createdUnder`). Their diffs follow the thread's own, their
  pull requests follow its links (a pull request already among its links is listed once: the
  daemon copies a child's links up, `linked-prs-children.md`), their terminals join its
  terminals. They are always open (they are tabs), so a pick focuses them. A child's tab is drawn
  as its strip draws it (icon and title), without the child's name: in the window the tab is the
  lead's, as its row says.

## Selectors

`useLeadThread(id)` selects the resolved id (`leadOf` walks a few `createdBy` hops), so the row
and the hover re-render only when the lead changes, not on every thread update. `useKin` selects
the ids of the space's tab threads that pass `createdUnder` with `useShallow`.

## Every place swept

| Place | Verdict |
| --- | --- |
| Row under a linked tab's strip | changed |
| Linked tab hover, strip and rail (`LinkedTip`) | changed |
| "+" menu "This thread ▸", header Open ▸, sidebar row menu | lists children's tabs |
| "+" menu's thread item (`ThreadSub`) | right as it is: only for a thread's own tab |
| Sidebar selection for a focused linked tab (`selectionBridge.selectionOfTab`) | right as it is: the selection is `tab.thread`, and the sidebar already highlights its anchor (`ShellSidebarList`) |
| Floating composer over a full-screened linked tab (`fullscreen.ts floatingThreadOf`) | left: its chip names the thread a message goes to, and that is `tab.thread`. Naming the lead there would mislabel the target; sending to the lead would change routing. Reported to the lead |
| PR tab and PR panel (`components/pr`) | name no linking thread. Their "… in this thread" task buttons and Link to this thread follow the selection (the child for a child's tab); routing, left alone (`taskRouting.ts`) |
| PR task toast "Sent to <owner> for <sender>" (`stores/prTasks.ts`) | right as it is: it names where the daemon actually sent the task |
| PRs page rows | name no thread |
| Sidebar PR tag | right as it is: the lead's links already include its children's (daemon) |
| Palette | lists no linked tabs by thread; the file finder reads a thread's checkouts, not a name |
| Notifications' thread link | names the thread a plugin named, not a linked surface; out of scope |
| Drag announcements | name a thread being dragged (its own tab), not a link |

## Not changed, for the lead to decide

Placement and put-away still follow `tab.thread`: `thread.space.move` on the lead takes only its
own linked tabs, so a child's tabs stay in the old space (their row then reads dormant, "in
<space>"); closing the lead does not put away its children's tabs (`hostShell` keeps tabs whose
`thread` is the closed one).

## Tests

- `lib/inSidebar.test.ts`: `leadOf` (child of a live lead, grandchild, archived lead, removed lead,
  removed middle thread, cycle, unknown) and `createdUnder`.
- `shell/linked.test.ts`: `linkedRowOf` with a lead (live, its tab the link, its space);
  `threadSurfaces` with kin (diff, pull request listed once, terminal, focus action).
- `components/shell/linkedTabs.test.tsx`: the row of a child's diff and a grandchild's terminal
  names the lead (name, dot, live, focus target); archived lead; removed lead (the child is named
  and opened); the hover; the lead's Open ▸ items.
- `e2e/shell-linked.spec.ts`: a SHOTS-gated screenshot test of a child's pull request tab beside
  its lead (row, hover, the lead's "+" submenu). No other e2e: nothing here needs a browser.
