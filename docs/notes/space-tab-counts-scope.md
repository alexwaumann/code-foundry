# Which space tabs show their Needs you count

Every space tab used to show the count of its threads that need the user whenever it was above
zero. With the sidebar's Needs you section set to every space, that repeated what the sidebar
already listed; with it set to this space only, the current tab's count was the section's own.

## Rule

- Needs you in every space (`sidebar.needs_scope` "all", also the default when unset): no tab
  shows a count. The sidebar lists every space's threads that need the user.
- Needs you in this space only ("space"): every tab except the current one shows its count when it
  is above zero. The tab's count is what the sidebar does not show; the current space's is the
  section's.
- The sidebar collapsed to its rail does not change the rule: the rail's amber section icons
  already say something needs the user.

So a count on a tab always means "this space has asks you cannot see in the sidebar".

## Decisions

- The rule lives in `SpaceTabs` (`useNeedsScope` beside `useNeedsBySpace`): `SpaceTab` draws
  whatever count it gets, 0 draws none. `needsBySpace` is unchanged.
- The current tab never shows a count now, so the restyle of the count on the accent fill
  (`bg-cf-accent-foreground/20`, from `space-tab-solid.md`) is gone; the count is always the warning
  tint with "n thread(s) need(s) you" as its label.
- The spaces e2e spec's screenshots set the scope to this space (`settings/external`) so the top
  bar still shows a count on another tab.

## Tests

`components/shell/TopBar.test.tsx`: scope all on the current and another tab (none), unset (none),
scope space on the current tab (none) and another (its count and label), the counts following a
space switch, and the same rule with the sidebar collapsed.
