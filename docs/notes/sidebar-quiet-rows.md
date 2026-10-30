# Sidebar: divider, quiet archived/snoozed rows, snooze countdown icon

Frontend only (gui/frontend/src/components/sidebar). Decided with a user from screenshots.

## Decisions

- **Divider between the page nav and the thread list.** A 1px rule right after the Pages
  nav (Pull Requests, Projects), `data-testid="sidebar-divider"`. It runs from the
  window's left edge to the sidebar's right edge: the body has the shell gutter on the
  left (`pl-shell`), so the rule pulls back through it with `-ml-shell`; there is no right
  padding to undo.
- **Colour is `bg-cf-border`, not `cf-sidebar-border`.** The theme engine derives
  `--cf-sidebar-border` from `--cf-sidebar` (src/themes/slots.ts: "sidebar (no visible
  edge)"), so a rule in that colour is invisible by design. The pane border token is the
  one line colour every theme makes visible against the sidebar.
- **Equal gaps, measured.** The user asked that the gap between the Projects row's box and
  the rule equal the gap between the rule and the first thread row's box. The nav buttons
  end flush (their `mt-0.5` is above each), and the main list keeps its 4px
  `paddingStart`. So the rule has `mt-2` (8px under Projects) and `mb-1` (4px, plus the
  list's 4px = 8px above the first row). Measured in WebKit against the mock daemon:
  8px and 8px in both schemes; density does not change it (it only changes row height).
- **Archived and snoozed rows are quiet, not smaller.** The name keeps `text-body` (15px,
  the live rows' size) but drops `font-semibold` and takes
  `text-cf-sidebar-muted-foreground`, and so does the right-hand age or countdown (still
  `text-caption-sm`). Chosen over 13px or 12px names: weight and colour make the footers
  recede while the text stays the live rows' size. `nameClass` gained a `quiet` flag; live rows (`ThreadLabel`)
  are unchanged. Provisional (muted italic) and unnamed (muted id) styling still apply.
  Selection and hover backgrounds are unchanged; the quiet name stays muted when selected.
- **The snooze countdown says it is one.** `SnoozeLeft` renders a lucide `AlarmClock`
  (size-3, same muted colour, `gap-1`) before the bare remaining time: `[alarm] 2h`.
  Chosen over words ("wakes in 2h", "2h left"), which cost width on a 280px sidebar for
  what an icon says. The archived age stays a bare "1h": no icon, the section header says
  what it is.
- **The tooltip's "Snoozed until …" line is gone.** The row now says how long until it
  wakes, so the hover card no longer repeats it; `TipStatus` and `TipWaiting` render for
  snoozed threads like any other (a snoozed thread's finished turn has no tip status, as
  before). `snoozeTimeFull` had no other caller and was removed with its test; the thread
  page's "Snoozed until …" uses `snoozeTimeShort`, which stays.

## Gotchas

- e2e on non-default ports: the runner starts one mock per worker on
  `E2E_MOCK_PORT`+0..3, so a base that only checks its own port can still collide with
  another worktree's run on base+1. Leave four ports of room.

## Tests

- SidebarRow.test.tsx: quiet name classes on archived and snoozed rows (text-body, muted,
  no font-semibold, no text-inherit), provisional italic on a quiet row, muted age without
  an icon, alarm clock first in the countdown.
- snooze.test.ts: the `snoozeTimeFull` case removed with the helper.
- e2e/sidebar.spec.ts: the rule spans the sidebar, is 1px, uses `--cf-border`, and sits
  8px from Projects and 8px from the first row.
- e2e/snooze.spec.ts: countdown icon, regular weight at the live rows' font size, no
  "Snoozed until" in the tooltip. e2e/archive.spec.ts: archived name at weight 400 next to
  a live row's 600, no icon on the age.
