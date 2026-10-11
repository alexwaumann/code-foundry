# Thread list rows, tooltip and toolbar sides

Decided 2026-10-10 (Alex). Design record: the static sketch `/tmp/thread-list/index.html`,
`?v=14` for the rows and `?v=23` for the tooltip (PNGs in
`~/.t3/userdata/attachments/thread-list/v14.png`, `v23.png`). Frontend only; it builds on the
daemon step in `thread-status-persistence.md` (persisted status, `status_reason`,
`status_changed_at`, ERROR "interrupted"). Supersedes the section and row parts of
`workspaces-4-sidebar.md` and the toolbar order in `sidebar-toolbar.md`.

## Rows

* **No status icon column, no model.** A thread row is the name with its trailing group
  (Linked PRs badge, workspace badge, pin glyph) on line 1, and a status line on line 2.
  Same two-line geometry as before (`rowHeight + 15`), 8px left padding, 2px between the
  lines. The name is never coloured by status (the amber name is gone); an unnamed thread
  still shows its id muted.
* **Line 2** comes from `statusLine(session)` (`src/lib/statusLine.ts`, table-tested), which
  classifies on `sessionBadge` then `statusKind`; `statusText(line, now)` words it:

  | Status | Line 2 | Colour |
  |---|---|---|
  | busy | `Working · project · branch` | "Working" sky |
  | attention / permission | `Needs input · <tool or dialog question>` (just "Needs input" without one) | amber |
  | attention / question (incl. "waiting for input") | `Asked a question` | amber |
  | attention / plan | `Plan ready for review` | amber |
  | attention / trust, notification, other | `Needs input · <detail, else the reason>` | amber |
  | attention / finished | `Finished <formatAgo>` | emerald |
  | attention / error | `Error · <code>` | red |
  | error / interrupted | `Interrupted while working · <formatAgo>` | red |
  | idle, unknown, plain disconnected | `project · branch` (NoGit badge for a non-git project) | muted |
  | starting / closing | `Starting · project · branch` / `Closing · …` | muted |

  The "detail, else the reason" rule is `statusNote` (lib/session.ts): the text after
  `<kind>: `, else the whole reason unless it is a bare kind word ("bell", "finished",
  "waiting for input", "interrupted"), so a bell reads "Needs input", not "Needs input ·
  bell". A queued "moving to …" line still replaces line 2 entirely.
* **Colours**: Tailwind `sky/amber/emerald/red-400` in dark mode (the sketch's
  `#38bdf8 #fbbf24 #34d399 #f87171`), the 600s in light mode for contrast.
* **Offline** (`state === "disconnected"`) rows dim the row's content to 50% opacity
  (`data-offline` on `session-body`); the text is otherwise the same, so a question that
  outlived a restart still reads "Asked a question" in amber, dimmed. The selection and
  hover background is not dimmed.
* **Relative times** ("Finished 3 min ago", "Interrupted while working · 1 h ago") use
  `formatAgo` and the shared `useNow(30_000)` clock (`src/lib/clock.ts`: one interval per
  period, running only while subscribed). Only the status text of a row that shows a time
  subscribes (`TimedStatusText`), so the list has one timer, and only when some row has a
  time.
* **Terminals** were restyled to line up with the iconless thread rows (the sketch shows
  them without icons): name, program, and a trailing chip instead of the old status icon
  and terminal glyph: `fullscreen` while running on the alternate screen, `exited` (muted)
  or `exit N` (red) once exited; the name is still muted when exited. Line 2 unchanged.

## Order, headers, keys

* **Headers**: only Terminals. Pinned, Needs attention and Threads are gone.
* **Order** (`buildRows`): pinned threads (any status), then unpinned threads waiting on the
  user with prompts above finished turns, then everything else; newest first (creation
  time) inside each group. Error / interrupted and offline threads sort with everything
  else; an offline thread whose persisted status is attention stays in the attention group
  (it still counts, see `isAttention`).
* **"Prompt" vs "done"** is `attentionTier` (lib/session.ts): any attention status that is not
  `finished` is a prompt, including a Claude API error at the prompt (`error: <code>`): it
  needs the user to do something, so it sits with the dialogs rather than with finished
  turns. `ListSession.attention` is now that tier (`"prompt" | "done" | ""`), and the list's
  structure key per thread is id + attached terminal + pin + tier: busy/idle, a different
  dialog, a new detail or a ticking time re-render only that row; a tier change (question
  answered and finished) rebuilds the row list, and `rowCache` keeps every other row object
  identical, so the memoized `SidebarRow` re-renders only the moved row.
* `data-section` on a thread row still says its group (`pinned`, `attention`, `threads`)
  for tests; it is no longer visible.
* cmd+1..9, cmd+shift+a (and the toolbar bell), ↑/↓/Home/End all derive from `buildRows`,
  so they follow the new order unchanged. The attention count is unchanged (attention
  statuses in any state).

## Tooltip

* shadcn-style `src/components/ui/tooltip.tsx` over Radix Tooltip (from the `radix-ui`
  meta package already in use). Unlike upstream shadcn, `Tooltip` does not wrap its own
  provider; `SidebarList` has one `TooltipProvider` (`delayDuration` 500), so moving from
  one row to the next opens the next tooltip without a second delay (Radix's skip delay).
* Per thread row, `side="right"`, `align="start"`, `sideOffset` 12, 220px wide,
  `disableHoverableContent` (it closes as soon as the pointer leaves the row). Contents,
  mounted only while open: the name (13px semibold); project with `FolderGit2` (or `Folder`
  and a muted "no git" chip); branch with `GitBranch` in mono and a muted "worktree" chip
  when the cwd's worktree has `isMain === false` (omitted without git); the model with
  `ClaudeMark` in `#d97757`, `modelLabel` ("opus" -> "Opus", "" -> "Default") and the
  effort muted in parentheses when set. No permission-mode row.
* `ThreadRowModel.worktree` is the new pure field (cwd worktree known and not the main
  checkout; false for unknown or non-git); `RepoLookup` worktrees gained optional `isMain`.
* `src/components/icons/ClaudeMark.tsx`: the sketch's `I.mark`, twelve rays, stroke 2.6,
  round caps, `currentColor`.
* **Keyboard and menus.** Rows are not focusable (the list uses `aria-activedescendant`), so
  keyboard navigation never opens a tooltip. Radix closes it on pointer down, so a click or
  right-click closes it. While the row context menu is open, `RowTooltipsEnabled` (a context
  in `rowTooltips.ts`) is false and rows refuse to open, so hovering other rows does not
  cover the menu. Not shown while the row is being renamed.

## Toolbar

Dashboard and Notifications on the left, a flex spacer, then Add project and New thread on
the right (New thread rightmost, 12px from the edge, the toolbar's own padding). DOM order is
unchanged, so `layout.spec`'s button order assertion holds; a spacer rather than `ml-auto`
on Add project because `repo.add` hides when unavailable.

## Deviations from the sketch

* **Starting / Closing** get a muted word before the place. The sketch has no such row, and
  without the icon column a starting thread would look idle for its first seconds.
* **"Asked a question · before restart"** (the sketch's offline question) is just "Asked a
  question", dimmed, as the brief specifies; the dimming says it is offline.
* **Relative time format** is `formatAgo` ("3 min ago", "1 h ago", "just now"), not the
  sketch's "3m ago".
* **Tooltip background** is the app's `bg-popover` with its border and `shadow-lg` (as the
  popovers use), not the sketch's exact `oklch(.17 0 0)`.
* **Terminal rows** keep their exit state as chips (the sketch has only "fullscreen").
* The `data-session-badge` attribute moved from the removed icon to the row's line-2 span,
  so specs that read a row's badge still work.

## Gotchas

* **Two tooltips in the DOM.** When the pointer moves to the next row, the previous tooltip
  is still fading out (`data-state="closed"`) while the new one opens; specs select
  `[data-testid="thread-tooltip"]:not([data-state="closed"])`.
* **`react-hooks/refs`** rejects a `useRef` row cache updated inside `useMemo`; the cache is
  a closure (`rowCache()`) held in `useState`, which also makes it unit-testable.
* **`react-refresh/only-export-components`**: the context lives in its own file
  (`rowTooltips.ts`), not in `SidebarRow.tsx`.
* The workspace and Linked PRs badges keep their native `title`, so hovering a badge can
  show the native title as well as the row tooltip.
