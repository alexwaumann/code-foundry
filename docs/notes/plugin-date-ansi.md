# Plugin date input and ANSI logs

Two small plugin UI additions: a date input kind for form fields and SGR colours in the log
node. Capabilities `view.input.date` and `view.log.ansi`.

## Date input

- `InputKind` `date` (`ui.DateField`, `.WithDateRange(min, max)`, `ui.Date(t)`); `Input.Min` and
  `Input.Max` are ISO dates. The value is `time.DateOnly` or "".
- Validate refuses a value, min or max that is not a real day written as `YYYY-MM-DD`, min after
  max, a value outside the bounds, and a pattern, maxLength or mono on a date. Min and max on any
  other input are refused too. A plugin value that is out of range is refused, not clamped: the
  calendar could not offer it again.
- The daemon checks each submitted or changed date (control `date` in the action index): ""
  or an ISO date inside the bounds. A plugin reading a non-empty value can always parse it.
- A pick is a committed change, as with a select: a field with a change event sends it on each
  pick. `live` is allowed and routes the pick through `liveSender` (one act in flight, latest
  last). Without the flag the pick goes out at once anyway.
- `plugintest.Host.PickDate` sends the change act the host sends and refuses what the host refuses.

### Calendar: our own grid, not shadcn's Calendar

The repo has no shadcn Calendar. shadcn's Calendar is react-day-picker v9, which brings
date-fns: tens of KB for a 7x6 grid, plus a second styling system to fit to our tokens. The
app already draws a month calendar (the snooze dialog), so `DateControl` is a small grid in the
existing shadcn Popover with the snooze calendar's look: today outlined, the picked day filled,
neighbouring months' days muted (the sketch left them blank; the app's own calendar wins).
Added over the snooze calendar: the week starts from the locale (`Intl.Locale` getWeekInfo or
weekInfo; Monday if the engine cannot say), weekday and month names come from `Intl`, there are
min/max bounds, and keyboard navigation (arrows by day or week, Page Up/Down by month,
Home/End to the week's ends, Enter or Space picks, one tab stop). Quick picks: Today, Tomorrow,
next Monday (labelled with the locale's short weekday; a week on when today is a Monday), and
Clear (disabled when empty). Tooltips on Tomorrow and Monday show the day they land on, which
is not on screen. Follow-up, not done here: move the snooze dialog onto this grid. That would
change snooze's week start, which is a separate call.

Days are counted in UTC (`Date.UTC`) so DST never moves one. "Today" is the local day, read
with `useNowSelect` every minute.

## Log ANSI

- `Log.ANSI` (`ui.NewANSILog`). No ANSI/SGR parser existed in the frontend (only xterm's), so
  `ansi.ts` is new: one pass per line, and a line with no ESC or control character costs a
  single regex test. 2000 coloured lines parse well inside the test's 250 ms bound.
- Supported: 30-37, 90-97, 40-47, 100-107, 39/49, bold, dim, italic, underline (21, 4:n), the
  22/23/24 resets, and 0. 256-colour and truecolor map to the nearest of the 16 (measured
  against xterm's default RGB with a redmean distance), so every colour is a theme slot
  (`--terminal-ansi-N`) and follows light, dark and user themes. The decision was to map them
  rather than drop them: an orange stays warm. Inverse, blink, strike and the rest are dropped.
- Every other escape is dropped (CSI with a private prefix or intermediates, OSC/DCS/APC/PM/SOS
  ended by BEL or ST, nF and two-byte ESC, a cut sequence at the end), as are C0 controls other
  than tab. A trailing CR is a CRLF; a CR inside a line keeps what follows it (a redrawn progress
  line). The style carries across lines. An escape split between two appends works because
  `appendToLog` joins text before splitting.
- A span's colour beats the line's tone; the tone still colours unstyled text. Copy copies the
  text without escapes. Follow and scroll are unchanged (same rows, same box).
- `ui.StripANSI` (Go) drops the same sequences for an older host that shows them raw. It
  leaves other control characters alone.

## Panel width

- Date: in the body the trigger is the form's width. In a toolbar or footer it sits at its own
  width (`shrink-0`) with its label for screen readers only. The popover is 256 px, so it fits
  the 360 px column.
- ANSI log: same box as any log (wrap or scroll sideways); colours do not change the layout.

## Gotchas

- `hints_test.go` used `"date"` as its example of an unknown kind; it is now `"color"`.
- The demo's form and log fixtures (`internal/store/plugin/testdata/hello-demo`) were
  regenerated from the demo's own nodes; `registry.test.tsx` and `form.test.ts` count them.
- The SHOTS spec waits for the popover's fade-in (`getAnimations().finished`), or the shot is
  see-through.
