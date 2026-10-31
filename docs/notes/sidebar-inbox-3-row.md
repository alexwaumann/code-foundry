# Sidebar inbox rows 3/3: the three-line row

PR 3 of the three-line ("inbox") thread row. It rewrites the thread row in
components/sidebar/SidebarRow.tsx on top of PR 1 (Thread.busy_tool) and PR 2
(lib/statusRegistry.ts, lib/elapsed.ts, the band order, THREE_LINE_ROW).

## Layout

- Line 1 (text-caption-sm, h-4): the project, muted; a Layers glyph before it when the
  thread spans several projects (`set !== null`, the same rule as the card's workspace
  row); "No project" as plain text; the pin glyph after it. On the right `statusBadge`:
  icon (size-3) and word in the tone, font-medium; for timeMode "status" a plain space
  and the elapsed time in the same tone; "activity" the elapsed time alone, muted; "none"
  nothing after the word.
- Line 2 (h-[22px]): the name, text-body font-medium (was semibold), with the
  made-by-thread glyph. Snoozed and archived rows (SingleLineLabel) are unchanged.
- Line 3 (text-caption-sm, h-4): `statusDetail` when non-empty, muted and truncated;
  else the GitBranch glyph and the branch in mono; the No git badge for a project
  without git; empty for no project (the line keeps its height). A queued Run in move
  ("moving to X…") wins over both. On the right: background agents (Bot, info tone),
  background shells (SquareTerminal, muted), then the linked PR tag.
- The row box is THREE_LINE_ROW (60px), no gap between lines; the 4px row gap is the
  virtualizer's, as before. Working footer rows are the same row. The Working, Snoozed
  and Archived footers are unchanged and must stay at the bottom of the list.

## Decisions

- Branch on line 3 is the place model's branch (useThreadPlace: the checkout's HEAD,
  falling back to Thread.branch for a set without a checkout), the same value the old
  line 2 showed, rather than Thread.branch alone.
- A thread in its workspace's folder has no project, so line 1 shows the workspace's
  name (with Layers), as the old line 2 did. Every other workspace thread shows its
  run-in project and leaves the workspace's name to the card.
- Background agents only (Thread.background_agents_running), not every running subagent:
  a foreground subagent is the busy tool ("Agent <description>") on line 3 already.
- The elapsed time uses `useNowSelect(1000, now => formatElapsed(at, now))`: one shared
  1 s clock (lib/clock) for every row, and a row re-renders only when its text changes,
  so every second under a minute and once a minute after (elapsedTickMs's cadence). A
  60 s clock is not used: a subscriber joining a running clock reads a `now` up to a
  period old, which would flip a row back under a minute and between the two clocks.
- Hover actions sit absolutely over the status, which turns invisible on group-hover;
  the right side gets a 50px min width on hover so the buttons never cover the project.
  They stay shown while one has focus or the snooze menu is open. Tab stops only on the
  cursor row's buttons (tabIndex 0 there, -1 elsewhere): the list is an
  aria-activedescendant listbox, and every row's buttons in the tab order would turn Tab
  into a walk through the list. The context menu and the palette keep the same commands.
- PR tag click: one counted PR opens `showThreadView("panel.pr", id, {slug, number})`,
  the slug taken from the thread's own link (pullRequestKey lowercases it); several
  open the info card as before. The click stops there and selects the thread itself
  (and moves the cursor) only when it is not selected already, so the row's own click
  (prompt focus, a flag's plugin surface) does not run.
- Hover card: attention and error kinds (Claude's prompts, errors, interrupted, crashed,
  woke) read "<status> · for 6m"; a finished turn gets a green "Finished 6m ago" row;
  flags and a deleted transcript have no time (statusChangedAtMs is not theirs).
- The PR tag keeps its tinted chip (the reference render drew it bare).

## Gotchas

- statusLine built `flag: { pluginName, reason }` fresh on every call, so any
  `useShallow((s) => statusLine(...))` selector (the row, useTagInfo) never settled on a
  flagged thread: "Maximum update depth exceeded". It now hands back the thread's own
  flag object.
- Screenshots: Playwright against the mock-fed dev frontend at a 220px sidebar, not the
  built app; the mock's status-kinds scenario seeds every status at once, which a real
  daemon cannot without real turns.
