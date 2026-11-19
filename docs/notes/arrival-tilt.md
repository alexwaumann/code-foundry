# Arrival tilt

An icon tilts once, briefly, when something that needs the user arrives. Agreed from a
prototype a user tried (variant "5 Lively"): eight swings dying away, 20° at most, 1400ms,
ease-in-out, one iteration. One definition: `@keyframes cf-arrival-tilt` and
`--animate-arrival-tilt` in `src/index.css`, used as the `animate-arrival-tilt` utility.

## Where it plays

- The top bar's bell: when a notification event names an arrival that is shown
  (`lib/arrivals.ts bellArrived`). Only the glyph tilts; the count beside it stays still.
- A thread's icon on the collapsed sidebar rail (`RailRows.tsx` Glyph).
- The same thread's status icon in the expanded sidebar: a Needs you row's ask icon
  (`ShellRows.tsx` AskKind) or an Active row's status icon (`SidebarRow.tsx` RowStatus, which
  is where a woken snooze shows). Never the word ("Permission", "Woke") or the row.

A bell (the top bar's Bell, a woken snooze's BellRing) swings from its top
(`origin-[50%_12%]`); every other icon rocks about its centre (`lib/arrivals.ts tiltClass`).

## "Just arrived" is state, not "plays on mount"

- Threads: `stepArrivals` compares the threads that call on the user (status line kind
  permission/input, question, plan or snooze ended; in the sidebar; not archived) with the
  previous step's, as `stores/dockAlerts.ts` does for the dock. The first step and the first
  after the threads epoch changes (startup, a reconnect's List or snapshot) are a baseline. A
  thread that stops calling and calls again later is a new arrival; one that changes its ask
  while still calling (permission, then question, then woken) is not.
- The bell: a connect's snapshot names no arrivals, so a connect or a reconnect never tilts it.
- `stores/arrivals.ts` keeps each arrival's time for TILT_MS, then forgets it. An icon reads its
  arrival's time and sets a negative `animation-delay` (now minus the arrival) from its ref
  callback as it mounts. So a row that re-mounts mid-tilt (virtualized scroll, rail and
  expanded list swapping, a space or scope switch) carries on from where the tilt is rather
  than starting again, and one after TILT_MS shows nothing. A re-render does not call the ref
  again, since its callback is the same for one arrival.
- Several notifications within one tilt are one tilt: a second arrival moves the stored time
  but the running animation keeps its start (a changed delay on a running CSS animation does
  not restart it).

## Decisions

- **Plays under Reduce motion.** The user's explicit decision: the tilt says something arrived,
  it is information, not a decorative transition. It is not gated on `prefers-reduced-motion`.
  The app has no global reduced-motion rule (the working circle and spinners opt out one by one
  with `motion-reduce:`), so nothing needed exempting; the keyframes' comment says so.
- **An exception to "frequent user actions are instant".** That rule is about the user's own
  actions; an arrival is not one, and this is the agreed exception.
- Colours unchanged; no dependency.

## Gotchas

- The React compiler's lint rejects `Date.now()` during render (`react(purity)`) and reading a
  property of an object that also carries a ref callback named `ref` (`react(refs)`). The hook
  returns `{ className, place }` and the callers destructure it; the time is read in the ref
  callback, not in render.
- A Needs you row with several open requests shows "N items" and no icon, so nothing tilts on
  it in the expanded list (its rail icon still tilts).
- The mock refuses `thread/status` on a disconnected thread; in `make drive` only s-1, s-2 and
  s-5 change status.

## Tests

- `src/lib/arrivals.test.ts`: who calls, every baseline and plays-once case, the bell's rule,
  the pivot.
- `src/stores/arrivals.test.tsx`: the store from the threads store's events (load, reconnect,
  re-entry, forgetting) and the hook across re-render, re-mount and forgetting.
- `src/components/sidebar/arrivalTilt.test.tsx`, `src/components/notifications/NotificationBellTilt.test.tsx`:
  which element tilts in each place.
- `e2e/arrival-tilt.spec.ts`: the stylesheet animation runs once on the icon in WebKit with
  Reduce motion emulated, and not after a reload. SHOTS=<dir> for the PR's screenshots.
