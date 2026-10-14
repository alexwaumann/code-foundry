# Snoozed threads, PR 2 of 2: the GUI

Decided 2026-10-14 (Alex). Frontend only (plus the Playwright mock daemon); stacked on PR 1
(`snooze-threads-1-daemon.md`: `SessionView.snoozedUntilMs`, `session.snooze`,
`snoozeSession(id, untilMs | null)`, the daemon's wake into NEEDS_ATTENTION "snooze
ended"). Mirrors archive's sidebar PR (`archive-threads-2-sidebar.md`). Design record: the
static mocks Alex approved (`/tmp/cf-snooze/index.html?v=a|menu|custom|woke`, not
committed); their cards in the pane were illustrative only.

## Decisions (with Alex, not up for debate)

* **Sidebar footer "Snoozed"** between Working and Archived (main list → Working →
  Snoozed → Archived): header "Snoozed" + count, collapsible, **collapsed by default**,
  persisted (`snoozedCollapsed` next to `archivedCollapsed`), not rendered with no snoozed
  thread, up to ~25% of the sidebar body (Working 40%, Archived 30% unchanged). A snoozed
  thread appears nowhere else (even pinned or working, defensively). Soonest wake first.
* **Snoozed rows are one line**: the name, then right-aligned the time left (`45m`, `2h`,
  `18h`, `4d`; rounded down), 11px muted tabular-nums. The row tooltip adds the full wake
  time ("Snoozed until Thu, Oct 15, 9:00 AM"); no other new tooltips.
* **Snoozed threads are not attention** while snoozed (bell, window title, dock badge,
  cmd+shift+a, start page): `attentionIds` skips them like archived ones.
* **The wake**: the thread returns to the main list in the attention group, line 2
  "Snooze ended · 2 min ago" in amber (the `formatAgo` style of "Interrupted while working
  · 1 h ago"), and counts toward bell / badge / bounce through attention.
* **Actions**: a "Snooze" submenu in the row menu after Pin, before Archive (lucide
  `AlarmClock`) with presets showing their resolved time muted on the right — `1 hour`,
  `3 hours`, `Tomorrow` (9:00 AM), `Next week` (next Monday 9:00 AM; on a Monday the
  following one), separator, `Pick a date and time…` — and, for a snoozed thread,
  "Unsnooze" (`AlarmClockOff`). The thread header's icon-only snooze button (tooltip
  "Snooze Thread") opens the same presets as a dropdown; while snoozed it is "Unsnooze
  Thread" and unsnoozes. Presets are computed in the GUI (pure, `now` injected) and sent
  as absolute times; the confirmation comes from the daemon via runCommand (mid-turn only).
* **Pick a date and time…**: a small dialog, title `Snooze “<name>”`, a month calendar
  (prev / next month, today outlined, selected filled, past days disabled), a time field
  (9:00 AM), the chosen day spelled out, Cancel + Snooze (disabled for a past time).
* **Disconnected page**: no new card. The existing Reconnect card's text says
  "Snoozed until Thu 9:00 AM" (with Unsnooze next to Reconnect) while snoozed, and
  "Snooze ended · 2 min ago" in amber after the wake ("Snooze again" is the header button).
* **Panels**: snoozing drops the thread's side-panel tabs and closes its bottom panel,
  exactly like archive (the archive cleanup, generalised).
* Keyboard order spans all four sections; collapsed rows excluded; cmd+N across them.

## What was built

* `lib/tree.ts`: `ListSession.snoozedUntilMs`, section and footer `"snoozed"`, `FOOTERS`
  (the footer order), `ListOptions.snoozedCollapsed`, `Sections.snoozed`. `live` (the main
  list and Working) excludes archived and snoozed threads; Snoozed takes unarchived
  snoozed threads sorted by wake (ties newest-created first); a thread both archived and
  snoozed (cannot happen: the daemon keeps them exclusive) shows under Archived.
  `buildRows` concatenates main and `FOOTERS`.
* `lib/snooze.ts` (new): `snoozePresets(now)`, `shortRemaining`, `snoozeTimeShort`
  ("2:12 PM" today, "Thu 9:00 AM" within six days, else "Oct 19, 9:00 AM", the year when
  not this year), `snoozeTimeFull` (tooltip), `formatClock`, `formatDay`, and the
  calendar's `monthGrid` / `shiftMonth` / `addDays` / `wallTime` / `parseTimeValue`. Day
  arithmetic is on the local calendar (`new Date(y, m, d + n, 12)`), so DST days of 23
  or 25 hours keep 9:00 AM a wall time; the hour presets are absolute (now + 1 h / 3 h).
* `lib/session.ts`, `lib/statusLine.ts`: status kind `snoozeEnded` for the reason
  "snooze ended" (attention tier "prompt", so it sorts with prompts in the attention
  group), status line kind `snoozeEnded` (amber, timed, "Snooze ended · <ago>"); the
  tooltip's status row shows it too (amber like other waits).
* `stores/context.ts`: the list key carries the snooze time; `getListOptions` the
  collapsed state. `stores/ui.ts`: `snoozedCollapsed` (default `true`),
  `toggleSnoozedCollapsed`, saved / loaded like `archivedCollapsed`. No version bump.
* `stores/sessions.ts`: `attentionIds` skips snoozed threads.
* `stores/archiveCleanup.ts`: `newlySet(prev, next, field)` behind `newlyArchived` and
  the new `newlySnoozed`; `startArchiveCleanup` resets panels for both transitions (a
  re-snooze to another time, a wake and an unsnooze are not transitions).
* `components/sidebar/Sidebar.tsx`: a fourth `PanelRows` footer from `FOOTERS`,
  `FOOTER_CAPS.snoozed = 0.25`; snoozed rows are `rowHeight` like archived ones.
  `SidebarRow.tsx`: `SingleLineLabel` (archived and snoozed), `SnoozeLeft` on the shared
  30 s clock, `TipSnooze` in the tooltip (instead of the status row while snoozed), the
  Snoozed header toggle.
* `components/snooze/SnoozeMenu.tsx` (new): `SnoozePresetItems` (rendered by both the
  context submenu and the dropdown: the item component is a prop), `SnoozeRowItems`
  (submenu + Unsnooze) used by `RowMenu`, `SnoozeButton` in `thread/HeaderActions.tsx`
  between `session.close` and the archive button.
* `components/snooze/SnoozeDialog.tsx` + `stores/snoozeDialog.ts` (new), mounted in
  `App.tsx` next to the publish dialog.
* `thread/ThreadComposer.tsx` `Reconnect`: the snoozed / snooze-ended text and the
  Unsnooze button.
* `keys/bindings.ts`: a `session.snooze` presenter (see below).
* Mock: `MockSession.snoozedUntil`, `session.snooze` (`until` RFC 3339 or `90s` / `2m` /
  `1h`, `clear`; confirmIf as archive; snoozing closes like archive, removes shells,
  unpins, unarchives; archive, reconnect and pin(true) clear it), the wake
  (`wakeSession`: on the tick once due, or `POST /__mock/session/wake?id=`), `POST
  /__mock/session/snooze?id=&until=|clear=true`, and two snoozed threads in the default
  world: s-8 "Refactor the gh poller" (a finished turn, wakes in 2.5 h) and s-9 "Bump
  wails to v3.1" (wakes in 4 d 1 h). `DEFAULT_ORDER` gains `h:snoozed`.

## Choices made here (beyond the brief)

* **"<1m"** for under a minute left (also once due, until the daemon's next 30 s check
  wakes it), rather than "0m", which reads as "already woke".
* **Hints a week out drop the weekday**: "Next week" on a Monday reads "Oct 26, 9:00 AM",
  not "Mon 9:00 AM", which could mean today (before 9 AM). Same rule for "Snoozed until".
  An hour preset that crosses midnight says its day ("Thu 12:30 AM").
* **"Snooze ended" sorts with prompts** (attention tier "prompt"), above errors and
  finished turns, so a woken thread is at the top of the main list as in the mock.
* **The palette's "Snooze or Unsnooze Thread" has a presenter**: `until` is optional, so
  the palette would invoke it with no args and get the daemon's "give until or clear".
  Picked in the palette (or a future chord) it opens the custom dialog for the selected
  thread, or unsnoozes a snoozed one. CLI unchanged.
* **The custom dialog starts on tomorrow at 9:00 AM**; picking a trailing / leading day of
  another month switches the view to that month; the summary says "In the past" in red
  when the result is not in the future. The time field is a native `<input type="time">`
  (WebKit renders it "09:00 AM", segmented). No calendar dependency.
* **The header Unsnooze is a direct action** (no dropdown), like Unarchive; re-snoozing a
  snoozed thread to another time is the row menu's Snooze submenu.
* **A snoozed thread's tooltip** shows its wake time in place of the status row (its
  persisted status is the closed turn's; the wake is what matters while it is put away).
* **Not dimmed**: snoozed rows are disconnected but not dimmed (as Archived). A woken
  thread is dimmed like any disconnected thread in the main list.
* `archiveCleanup.ts` kept its name and `startArchiveCleanup` (now archive + snooze) to
  keep the diff small; renaming it is cosmetic.

## Gotchas

* `vi.stubEnv("TZ", "America/Chicago")` must run when the test module loads: `it.each`
  tables are built at import, before `beforeAll`. Node re-reads `TZ` on change, so the DST
  tables pass in any machine zone (checked with `TZ=UTC` and `TZ=Asia/Tokyo`).
* In the live app Claude refused `sleep 100` in the foreground (its harness blocks a
  standalone sleep) and backgrounds it otherwise, so a "working" thread for screenshots
  needs a long generation instead ("Write 400 numbered lines…").

## Verification

* `make check` green (see the PR for the counts). New or changed unit tests:
  `lib/snooze.test.ts` (presets table incl. Monday → following Monday, Sunday → tomorrow,
  late evening past midnight, after midnight, year end, spring-forward and fall-back
  nights, 23 / 25 h days; all presets in the future; short / full formats;
  `shortRemaining` table; month grids; `parseTimeValue`), `lib/tree.test.ts` (Snoozed
  footer: placement, sort, pinned / waiting / archived defensively, collapsed, order
  across four sections; rowCache), `lib/statusLine.test.ts`, `lib/session.test.ts`,
  `stores/context.test.ts`, `stores/ui.test.ts`, `stores/sessions.test.ts`,
  `stores/dockAlerts.test.ts` (snoozed not counted; the wake badges and bounces),
  `stores/archiveCleanup.test.ts` (`newlySnoozed` table; panels reset on snooze, not on
  re-snooze or wake), `stores/snoozeDialog.test.ts` (presenter), `SidebarRow.test.tsx`
  (single line with time left, snooze ended line, Snoozed header toggle),
  `HeaderActions.test.tsx` (order, presets, pick, unsnooze, hidden without the command),
  `SnoozeDialog.test.tsx` (defaults, submit time, past disabled, months, cancel).
* New `e2e/snooze.spec.ts` (both browsers): the section (collapsed default, order,
  single-line rows "2h" / "4d", tooltip, persistence, CLI unsnooze, bell excludes the
  snoozed waiting thread); row menu presets and their times, 1 hour without a
  confirmation, Unsnooze; header snooze of busy s-1 with the daemon's confirmation, panels
  reset, the card's "Snoozed until … 9:00 AM" and Unsnooze, CLI snooze resetting panels;
  the custom dialog (defaults, past refused, next month, exact local time sent, Cancel);
  the wake (attention row "Snooze ended · just now" in amber, bell 2, card text, snooze
  again from the header, reconnect unsnoozes); keyboard order and cmd+N across four
  sections, cmd+shift+a skipping snoozed; the palette presenter. Specs whose orders
  changed: `app`, `archive`, `sidebar`, `sessions`.
* `make gui-e2e`: see the PR body.
* `make build && make gui-build` green.
* **Live** (2026-10-14; isolated `CODE_FOUNDRY_HOME=/tmp/cf-snooze-ui` for the GUI's
  daemon and every CLI call, through a wrapper script; scratch repo
  `~/cf-scratch-snooze-ui`, `claude-haiku-5-5[1m]` at low): ten threads; one archived,
  three snoozed from the CLI (`--until 2026-10-18`, `tomorrow`, `2h30m`) showing "3d",
  "22h", "2h", soonest first; two long generations under Working. Bell 3 → the snoozed
  finished turns not counted. The row menu's Snooze submenu opened by hovering (CGEvent
  helper): times "11:53 AM", "1:53 PM", "Thu 9:00 AM", "Mon 9:00 AM". "Pick a date and
  time…" opened the dialog; picking Fri 16 and Snooze stored `2026-10-16T14:00:00Z`
  (9:00 AM CDT). A `--until 1m` snooze showed "Snoozed until 10:54 AM" with Unsnooze on
  its page, woke at 10:55:18 (the 30 s check) into the top of the main list with
  "Snooze ended · 2 min ago" in amber on the row and the card, bell 5. Daemon log: no
  warnings or errors. Snoozed collapsed again and the theme put back to `system` before
  quitting; everything removed afterwards (threads, `/tmp/cf-snooze-ui`, the scratch repo
  and its `~/.claude/projects` directory).
* Screenshots (not in the repo; branch `pr-assets/snooze`): sidebar dark / light, the row
  menu's Snooze submenu, the custom dialog, a snoozed page, a woken thread.
* Not verified live: the header dropdown and its confirmation mid-turn, the panel reset,
  the palette presenter, keyboard order (all mock e2e only); the dock badge / bounce on a
  wake (unit-tested; the bell counted it live).

## Daemon restart

Yes, for PR 1 (new RPC, command, migration 0018). This PR is frontend only.
