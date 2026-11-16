# Needs you line items and the popup stepper

PR 5 of the notifications build. A thread under Needs you with two or more open requests
(permissions, questions, a plan) lists one line per request under its title, and the Needs-you
popup steps between them. Notifications, the bell and plugins are untouched. Builds on
`docs/notes/shell-17-needs-you.md`.

## Where the data comes from

Frontend and mock only. The EventService thread source already carries every thread's pending
requests, oldest first, each with a one-line summary (`internal/store/thread/items.go`
`pendingOf` / `requestSummary`: a question's first question, else "<tool> <description or
title>"), and `stores/thread.ts` keeps them per thread (`useOpenRequests`, without the ones being
answered). Nothing was missing in the daemon, so no proto change.

## Decisions

- **The line** (`lib/needsAsk.ts` `requestLine`): the kind's word and the summary on one line.
  The kind is question, plan (`ExitPlanMode`) or permission; the icon is the status registry's for
  that kind, in the warning tone. A Bash summary starts with "Bash ", which the line drops (the
  command says what it is); other tools keep their name ("Permission: Write notes.md"). A plan's
  summary is only the tool's name, so its line says "Plan: ready for review". The text is cut to
  one line with no tooltip: the line's card has it whole.
- **The cap**: at most four lines (`MAX_REQUEST_LINES`). Up to four requests, a line each; five or
  more, the first three and "+N more", which opens the popup on the first request not listed. Four
  lines keep a row under about 120 px.
- **Status**: with two or more open requests the row's right-hand word becomes "N items", muted
  (the lines carry the attention tone). With one, the row is as before.
- **Only Needs you**: the lines live in `NeedsLines`, which only Needs you rows and the top bar's
  popover rows draw. Active, Working, Snoozed and Archived rows never show them. An ask without a
  request (a woken snooze, a plugin's flag) has no open requests, so no lines.
- **Row height**: the brief assumed fixed heights; the shell list already measures every thread
  and draft row (`PanelRows`, `measureElement` with a ResizeObserver; only headers and the one-line
  Snoozed and Archived rows are fixed). The lines just make the row taller, and a request arriving
  or leaving re-measures it. The estimate before the first measure is unchanged (62 px); a row
  with lines corrects itself on its first draw.
- **The top bar's popover** reuses `NeedsLines`, so it shows the same lines, each with its card.
- **A line's card** is the existing `NeedsHoverCard` with a `requestId`: `useAskView` shows that
  request instead of the oldest, with the same states (Allow and Deny only once that request is
  known whole, and they send its id), no "+N more", and Answer…/Open… opens the popup on it. Its
  anchor is `sidebar:<thread>#<request>` (`popover:` in the popover).
- **Nested cards**: the line's card sits inside the row's card trigger. The row's card stays shut
  while the pointer is on a line or in a line's card (`data-needs-line-zone`; React's pointer
  events reach the row through the line card's portal), and comes back after the 200 ms card delay
  once the pointer is on the title again, so two cards never show at once (only the line card's
  fade-out overlaps, as between two rows today). The line card stops its clicks, presses, double
  clicks, context menu and keys from reaching the row (open thread, drag, rename, menu).
- **Clicks**: a line opens the popup on its request; the title on the oldest (`popupRequest`
  null); line 1 still goes to the thread. Lines are not focusable: the sidebar's keyboard model is
  an active descendant, and Enter on the row opens the popup, where the stepper takes the keys.
- **The stepper** (`NeedsPopup.tsx`): a band under the popup's header, only with two or more open
  requests: previous, one dot per open request (the current one wide in the warning tone; each a
  button whose tooltip names its hidden request), next, "2 of 3", and the "← → switch" hint. The
  arrows do not wrap. `InlineThread` takes `ask` and docks only that request in the composer; the
  conversation above does not move. The keyboard goes to the new ask on each switch unless it is
  in a field or the composer has text.
- **Its state** (`lib/needsAsk.ts` `reconcileStep`): the request it opened on, else the oldest.
  When the open requests change: the current one while it is open (arrivals add dots only);
  answered, here or anywhere, the next one after it that is still open, else the first still open;
  none left, the popup closes as before (`useCloseWhenAnswered`). Held in the popup's own state
  (a "derive from the previous list" pattern), seeded from `useNeedsStore.popupRequest`.
- **Keys** (`stepKey`): plain ArrowLeft and ArrowRight on the dialog, never with a modifier, not
  in an input, textarea or select, and not in the composer once it has text (an empty composer
  hands keys to the ask, as digits do). The ask cards bind no arrows (digits, Enter, Escape only),
  so nothing there loses them. Handled on the dialog, not the global keymap: they only mean
  something while the popup is open.
- **No animation** on the stepper: a switch is instant.
- **cmd+shift+a** opens the next thread's popup on its oldest request (`openNeedsPopup` resets
  `popupRequest`).

## Differences from the sketch (`popup-stepper.png`)

- Dots are one per open request. The sketch also kept an answered one as a green dot; an answered
  request leaves the thread source, and the brief asks for one dot per open request.
- No "⏎ allow" or "esc close" hints: Enter does not allow a permission (digits do), and Escape in
  a question's card skips it, so the hint would be wrong there. Only "← → switch".
- No "Answering moves to the next one…" footer: the popup is the large sheet with the whole
  conversation and today's docked card, and the behaviour shows itself.
- The stepper sits under the popup's header as in the sketch, but the ask stays docked in the
  composer at the bottom (today's popup), not under the stepper.

## Mock

`POST /__mock/needs-you` adds a fourth thread, `s-ny-multi` ("Push the badge fix and label the
PR"), with two commands and a question open at once (`seedAsk`'s `more`). It is the oldest ask,
so it sorts last and the other threads keep their places for the older tests.

## Verification

- vitest: `lib/needsAsk.test.ts` (each line's text and kind, none for one request, the cap and
  "+N more", every `reconcileStep` case, `stepBy`, `stepKey`), `NeedsPopup.test.tsx` (no stepper
  for one request, the oldest from the title, a line's request, arrows/dots/keys, keys in a field
  and in a composer with text, focus on switch, answer moves on, the last answered goes back to
  the first, answered elsewhere, an arrival, the dots' labels), `NeedsCard.test.tsx` (a line's
  card shows and answers its own request, Answer… opens the popup there, the row card's "+2 more",
  the row card shut over a line and back after the delay, the line card's presses kept from the
  row), `ShellSidebarList.test.tsx` (lines in order with "3 items", unmeasured height, one request
  as before, none on Active, a line's click, the cap, an answered line leaving),
  `keys/bindings.test.ts` (cmd+shift+a from a line's popup to the next thread's oldest).
- e2e `shell-needs.spec.ts`: the taller row's geometry in the virtual list, the pointer from a
  line into its card and Allow there, back to the title for the row card; the popup's arrows
  through real focus, the deny reason keeping them, an answer by digit moving on. 32 of 32 over
  four repeats on four workers. SHOTS for the PR's before and after.
- By hand with `make drive` (mock): hover each line, click the question line (3 of 3), ArrowLeft
  twice, 1, 1, then 1 and Enter on the question: three `thread.respond` calls with the right ids,
  the stepper gone at one request, the popup closed after the last; the collapsed sidebar's
  popover shows the same lines and line cards.

## Gotchas

- `isContentEditable` is not implemented in jsdom: the popup checks the `contenteditable`
  attribute (`closest`), which also holds in WebKit.
- New describes in `ShellSidebarList.test.tsx` go above "dragging Snoozed and Archived rows":
  dnd-kit's click swallower from a drag eats the next test's first click
  (`docs/notes/testing-gotchas.md`).
- In e2e, wait for the deny reason to have the keyboard before typing into it: under load the
  keys otherwise reach the ask, and an arrow steps.
