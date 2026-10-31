# Sidebar inbox rows 2/3: status registry, elapsed format, band ordering

PR 2 of the three-line ("inbox") thread row. This one only adds library code; PR 3 rewrites
components/sidebar/SidebarRow.tsx on top of it, and PR 1 adds Thread.busy_tool.

## What landed

- `src/lib/statusRegistry.ts`: one entry per StatusLineKind (icon, word, tone, timeMode),
  typed as a Record so a new kind fails to compile until it has one. `statusBadge(line)`
  resolves the word (the plugin's name for the flag kinds) and the tone's class;
  `statusDetail(line, thread)` is line 3's text; `statusTimeAt(line, thread)` is the time
  line 1's elapsed counts from (status change for working/waiting, last activity for idle,
  null for the attention, error and done kinds, which show no time on the row).
- `src/lib/elapsed.ts`: `formatElapsed` ("4s", "4m", "1h 4m" / "1h", "3d", rounded down) and
  `elapsedTickMs` (1000 while under a minute, else 60000) for PR 3's re-render tick.
- `src/lib/tree.ts` buildSections: the bands and the three footers are unchanged; inside
  them, prompts and then errors, and finished turns sort by statusChangedAtMs, idle by
  lastActivityAtMs, most recent first; pinned and Working keep newest created first.
- `src/components/sidebar/rowSizes.ts`: THREE_LINE_ROW (60px) for every thread row but
  snoozed and archived ones (one line, by density, as before).

## Decisions

- Flags: statusLine() now carries the flag's `pluginName` and `reason` apart (`flag` on the
  StatusLine) instead of the registry splitting the joined detail on ": ", which a plugin
  name or reason could contain. `detail` keeps the joined text for statusText.
- crashed already had its own kind (status "error", reason "crashed"); no change.
- The registry's `statusDetail` shares its name with lib/thread.ts statusDetail (the
  reason's part after "<kind>: "), as asked; the doc comment says which is which.
- busyTool is typed `{ busyTool?: string }` on the input, not a Pick of ThreadView, so this
  compiles with or without PR 1's field.
- Waiting's detail is "2 child threads" / "1 child thread", and "a queued wake" when the
  daemon says only "waiting" (a queued wake, no counted children).
- A missing time sorts after the known ones in its band, newest created first, rather than
  comparing as equal: a comparator that treats unknown as equal to everything is not a
  consistent order, and the result would depend on the sort algorithm.
- The sidebar's list keys (stores/context.ts) carry only the sort time that matters for the
  thread's band (`bandSortTimes`): a working thread's activity updates do not rebuild the
  list; a new prompt on an attention thread or new activity on an idle one does, since it
  moves.

## Gotchas

- Until PR 3 lands, SidebarRow still renders two lines inside the 60px slot, so rows look
  spaced out (10px more per row in comfortable density, 14px in compact). Expected for this PR only.
- SECOND_LINE stays exported for the existing test and goes with PR 3.
