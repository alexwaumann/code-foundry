# A pull request tab's icon follows its state

A pull request's tab drew the plain pull request icon in the tab's text colour whatever the
pull request's state. It now draws the state's icon in the state's colour (open green, draft
muted, merged violet, closed red), as the sidebar's tag and the Pull Requests page do, at full
strength on active and inactive tabs alike (the user's choice over a dimmed inactive icon).
The rail's icon of a folded or collapsed pane is the same component, and so is a pull
request's item in a thread's Open ▸ menu, which was always green.

## Decisions

- `SurfaceSpec.TabIcon` is the seam: a panel surface may give an icon that follows the tab,
  and `shell/surfaces/panel.ts` passes it to the shell's `TabIcon` (a terminal's already had
  one). No switch on the kind.
- `PrRefIcon` reads nothing. It takes the freshest of what is already held (the detail, the
  viewer's dashboard, a branch's list on screen: the sidebar tag's `useLinkedPrViews`), so a
  tab off screen still holds no stream. A pull request nothing has read yet shows the plain
  icon, muted, until its tab is shown once.
