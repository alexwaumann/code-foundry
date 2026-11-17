# Thread tab status dots

A thread's tab icon (in a pane's strip and on a folded pane's rail) carries a dot in the colour
of its sidebar row's status icon. Before, one amber "Needs you" dot marked every thread whose
daemon status was `attention`, so a finished turn and a Claude error looked like a permission
ask, and a working thread had no dot at all.

## Decisions

- **One source.** The dot reads the same `lib/statusLine` kind and `lib/statusRegistry` tone as
  the sidebar row (`RowStatus`), so the two cannot drift: a new kind gets its dot colour from
  its registry entry. `rowToneDotClasses` is the fill per tone, beside `rowToneClasses` (text).
- **Which kinds.** Every kind the sidebar shows an icon for: blue working and setting up, amber
  permission/question/plan/woke, green done, red error/interrupted/crashed/setup failed/transcript
  deleted, grey waiting and cancelled (the sidebar's muted icon colour). Idle (`place`) has no
  dot, as before. Grey for waiting was agreed with the user on the sketch.
- **Archived** threads still show no dot, as the attention dot did: archiving says the user is
  done with it.
- **Surface hook.** `ShellSurface.useAttention: boolean` became `useStatus: StatusLineKind | null`.
  Only the thread surface sets it; the strip and rail render `StatusDot`, whose label is the
  status word ("Working", "Done", "Permission") for screen readers. Test id `shell-tab-status`
  with `data-kind`.

## Gotchas

- Component-test thread fixtures need `statusReason` (a string): `statusLine` calls
  `startsWith` on it. The old dot only read `status`.
- Screenshots: `SHOTS=<dir> bunx playwright test e2e/tab-status-dots.spec.ts` (WebKit, dark and
  light, two panes with one tab per status, plus a close-up of the strips).
