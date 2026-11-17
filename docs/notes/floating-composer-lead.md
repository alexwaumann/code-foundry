# The floating composer writes to the lead unless the child is open

Full screen, a linked surface carries a floating composer (`shell-19-rails-fullscreen.md`). For a
surface a child thread opened (a diff, a file, a terminal), it wrote to the child, while the row
under the strip already named the lead (`linked-names-lead.md`). A user talks to the lead and the
lead talks to its children, so a message typed over a child's diff went past the thread the user
was working with.

## The rule

The target is the nearest thread up the creator chain, starting with the surface's own thread,
that has a thread tab in the current space: in any pane, shown or behind another tab, a preview
tab included. When none has, it is the lead at the top of the chain. A surface of a thread that is
not a child is unchanged (its chain is itself).

- The chain is `lib/inSidebar.ts creatorChain`: the thread, its creator, and so on up to the first
  thread in the sidebar (no creator, or a removed one), the same stop as `sidebarAnchor`. A thread
  not in the list yet or a creator cycle gives just the thread itself, so the composer writes to
  the surface's thread as before rather than guessing.
- `shell/fullscreen.ts floatingTargetIn` picks from the chain over the layout; `floatingTargetOf`
  composes the two (the table test); `useFloatingTarget` is the live hook PaneView uses. Its two
  selectors return strings (the chain joined, then the target), so the pane re-renders only when
  either changes, and the threads store is read only while a linked tab is full screen.
- An intermediate child that is open wins over the root lead (lead > child > grandchild, the
  grandchild's surface, the child open: the child).
- Only a thread tab counts as open. Another surface of the child (its file tab) does not.
- Open in another space does not count: the space shown is the one the user is in.

## What follows the target

Everything keyed by thread in `FloatingComposer`: the chip's name and status dot, the draft
(`thread:<id>`), the WatchThread held while expanded, docked asks, send and steer. PaneView keys
the component by the target, so opening or closing the child's tab while full screen is on remounts
it for the new target and no state leaks between the two. The expanded or collapsed state and the
drag are the window's (`shellView.floating`) and stay.

Window-only: the daemon is unchanged, and so is the look.
