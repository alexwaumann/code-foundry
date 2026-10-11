# Sidebar toolbar

Decided 2026-10-10 (Alex). Supersedes the "controls in the band" parts of
`sidebar-title-band.md`. Frontend plus one command (`view.dashboard`), so the daemon needs
a restart for the Dashboard button to enable.

## What moved where

* **The title band holds only the gutter and the name.** `SidebarBand`
  (components/sidebar/Sidebar.tsx) is the 80px traffic-light gutter, then "Code Foundry"
  (`sidebar-app-name`) 12px in. The name is now 16px (`text-base`), semibold,
  `tracking-tight`, still a `select-none` span (every page has its own h1). The band still
  drags the window and is still `TITLE_BAND_HEIGHT` (52px). `sidebar-band-controls` is gone.
* **A toolbar row sits under the band**, above the Pull Requests / Projects nav
  (components/sidebar/SidebarToolbar.tsx, `sidebar-toolbar`, `role="toolbar"`): 32px tall
  (`h-8`), 12px left padding, a bottom border (`border-sidebar-border`), `no-drag`. Four
  24px icon buttons, in this order (since thread-list.md: 1 and 2 on the left, a spacer,
  3 and 4 on the right with New thread rightmost, 12px from the edge):
  1. **Dashboard** (`sidebar-dashboard`): `CommandButton` for `view.dashboard`, lucide
     `LayoutDashboard` (reads as "overview" better than `House` next to a bell). While the
     dashboard shows it gets the nav rows' active style (`bg-sidebar-accent
     text-sidebar-accent-foreground`) and `aria-current="page"` (a new `current` prop on
     `CommandButton`). `whenUnavailable="disable"`, so an older daemon shows it disabled
     rather than shifting the row.
  2. **Notifications** (`sidebar-notifications`): replaces the band's attention badge.
     Always shown: `Bell`, or `BellRing` tinted amber with the count as a small pill over
     the icon's top-right corner (`attention-badge`, kept so the existing specs still read
     the count). A click runs `jumpToAttention()` (same as cmd+shift+a). With no count it is
     `aria-disabled` and dimmed, a no-op with the title "No threads need attention". It is
     not `disabled` because disabled buttons get no hover, so no tooltip.
  3. **Add project** (`sidebar-add-project`): `repo.add`, `FolderPlus`.
  4. **New thread** (`sidebar-new-session`): `session.new`, `SquarePen`,
     `whenUnavailable="disable"`.
* **The thread list's empty text is gone.** Once threads have loaded and there are none,
  the list is simply empty: the dashboard (the start page) already says what to do, and
  the toolbar has New thread and Add project one row up. The loading, stream-error and
  "unavailable on this daemon" lines stay.

## The dashboard view

* **`view.dashboard`** (internal/command/commands_view.go, "Show Dashboard", "Show the
  dashboard.") emits `UiIntent.ShowView{name: "dashboard"}` like `view.pullrequests` and
  `view.projects`. No default chord. The mock registry (mock/github.ts) has it too.
* **`{kind: "view", name: "dashboard"}`** is a selection like the other pages (`viewNames`
  in stores/ui.ts, `DASHBOARD`). App.tsx renders `<Dashboard />` for it; `none` still falls
  through to the same page. `isDashboard()` treats both as the dashboard.
* **The window always starts on the dashboard.** The selection was never persisted
  (`partialize` saves only the sidebar, font size and zoom), so the initial selection is
  now `DASHBOARD` instead of `none`.
* **Falling back to nothing selects the dashboard**, so the toolbar button lights up:
  Escape in an empty composer without a project to return to, and removing the selected
  thread. (The sidebar list's Escape only hands focus back to the terminal; it never
  cleared the selection.)

## Gotchas

* **The dashboard has no side panel**, like `none` before it: `keyOf` (stores/panel.ts)
  returns null for it. A plain `view:dashboard` key would have given the start page a
  panel it never had.
* **The selection context is unchanged.** `emptyContext.activeView` was already
  `"dashboard"`, and a view selection derives `{...emptyContext, activeView: name}`, so
  `session.new` and every `When` see exactly what they saw with `none`.
* **No measuring for the name.** At 16px "Code Foundry" is about 102px wide. At
  `SIDEBAR_MIN` (220) the header has 116px inside its paddings at 100% zoom, and 107px at
  90% (the lowest zoom: the gutter is 80 screen px, so 89 layout px). `AppName`'s
  ResizeObserver and `data-fits` are gone; the span keeps `overflow-hidden
  whitespace-nowrap` only as a clip for an unexpected font. layout.spec checks the fit at
  220 at 100% and 90%.
* **Playwright treats `aria-disabled` as not enabled**, so the no-op click in sidebar.spec
  is `force: true`.
