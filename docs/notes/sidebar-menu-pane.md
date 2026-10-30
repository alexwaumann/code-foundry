# Sidebar: the menu pane

> The sidebar was the title band, a toolbar (Dashboard and the Notifications bell), the
> nav rows, a 1px rule, then the thread list. It is now the title band, a **menu pane**
> holding New thread, Pull Requests and Projects, then the thread list. A user picked
> this look (option A) from sketches rendered over the real app. GUI only; no daemon,
> proto or command change. Supersedes the toolbar in `sidebar-toolbar.md`.

## What changed

* **`SidebarToolbar` is gone** (Dashboard button `sidebar-dashboard`, the bell
  `sidebar-notifications` with `attention-badge`). `view.dashboard` and the dashboard page
  stay for now: the start page and the palette reach it; a later PR removes them.
  Jump-to-attention keeps cmd+shift+a and the macOS menu item; nothing replaces the bell.
  The window title still counts threads that need the user. `useEmberAttention` (the
  bell's only reader) is removed; `emberAttentionId` stays for cmd+shift+a.
* **The rule between the nav rows and the threads (`sidebar-divider`) is gone.**
* **`SidebarMenu`** (components/sidebar/SidebarMenu.tsx, `sidebar-menu`) wraps
  `SidebarNewThread` and `<nav aria-label="Pages">` (PullRequestsNav, ProjectsNav):
  `bg-cf-surface`, `border border-cf-divider`, `rounded-pane` (12), `p-1` (4). It is the
  sidebar body's first child, right under the band (top = 56), from the body's `pl-shell`
  gutter (x = 12) to the sidebar's right edge, so it is a shell gap from the window and
  from the content pane, like the rows. It does not drag.
* **Rows unchanged**: 28px, `text-body-sm`, muted 16px icons, row hover and selected
  colours, 2px apart (`mt-0.5`), the Pull Requests count pill. New thread dropped its
  `mt-1.5` (the pane's padding is its top gap).
* **New thread is now the current row on the composer page** (`selection.kind ===
  "compose"`): the selected-row colour and `aria-current="page"`, like Pull Requests and
  Projects on their pages.
* **Below the pane**: `mb-2` (8px), then the thread list with its 4px `paddingStart`, so
  the first row's box starts 12px under the pane.
* **Ember's pinned row moved under the pane**, between it and the thread list (it was
  above New thread). The pane is the app's pages; Ember is a thread-like row whose arrows
  come from the list, so it sits with the threads. Its `mt-1.5` is gone: the pane's 8px is
  the gap above it.

## Decisions

* **Rows keep `rounded-md` (6).** The inner-corner rule wants 12 - 4 = 8, and the radius
  scale has no 8 (sm 4, md 6, lg 10, pane 12); the guard (`src/design/guards.test.ts`)
  forbids an arbitrary radius. 6 is the nearest step below; the rows already used it.
* **Dark hover under the pane.** `--cf-surface` is close to the row-hover colour, so a
  hovered first thread row could read as a second pane. Judged in the mock and the live
  app at the 8px gap: the pane's 1px divider border and the row's lack of one keep them
  apart, so no extra gap was added and no token changed.
* **e2e reads the attention count from the window title** (`expectAttention` in
  e2e/fixtures.ts: "Code Foundry (N)"), which counts what the bell did except Ember (as
  the Dock badge). The Ember spec checks its row's status and flame and drives
  cmd+shift+a instead of the bell; lineage reads the number out of the title.

## Gotchas

* Playwright's `[role="option"]` first match under `sidebar-main` is the first thread row;
  the Ember row is outside `sidebar-main`, so the 12px check does not depend on Ember.
* The isolated live copy shares the installed app's WebKit localStorage, so its side panel
  showed the real app's tabs on the Projects page; nothing there was changed.

## Verification

* `make check`.
* Playwright WebKit against the mock: sidebar, layout, ember, snooze, archive, threads,
  lineage, plugin-flags, thread-prompts, theme-editor-fuzz and buttons specs (111 passed,
  2 skipped; one theme-editor-fuzz test flaked once in the parallel run and passed alone).
  New checks: the pane's geometry, fill, border, radius and padding, the 12px to the first
  row, the current row per page (Projects, Pull Requests, New thread on the composer),
  no toolbar and no divider.
* Live: `make build && make gui-build`, the real app on a scratch `CODE_FOUNDRY_HOME`,
  dark, start page and Projects (the pane right under the band, Projects selected).
  Dark and light shots of seeded threads came from the mock harness.
