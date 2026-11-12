# Shell PR 17: the Needs-you inbox

Seventeenth PR of the shell stack (`docs/notes/shell-plan.md`, section 4). With the shell flag on
and the shell drawing the window, a Needs you row has a hover card with the whole ask, its title
opens a popup with a limited view of the thread and today's ask card, cmd+shift+a opens the popup
of the next thread that needs the user, a collapsed sidebar puts a Needs you control in the top
bar, and a thread pane too short for the full ask docks it as one line above the composer. With
the flag off nothing changes (cmd+shift+a and the menu item keep selecting the next thread).

## What is in it

| File | Holds |
| --- | --- |
| `components/needs/NeedsCard.tsx` | the hover card: `NeedsCardBody` (the ask by kind, the thread, the context line, the actions) and `NeedsHoverCard` (the card around an anchor) |
| `components/needs/NeedsPopup.tsx` | the popup: crumb, Go to thread, close, `InlineThread` (the thread's Watch and today's docked cards) |
| `components/needs/NeedsPopover.tsx` | the top bar's control and its popover of Needs you rows |
| `components/needs/AskStrip.tsx` | the one-line ask in a short pane's composer |
| `components/ui/hover-card.tsx`, `pagelib/ui.ts`, `internal/pagelib/dist`, the pages skill's `reference/components.md` | shadcn's hover card over `radix-ui` (zoom-aware offsets, as the popover's), so also in `@cf/ui` for pages |
| `stores/needs.ts` | the popup's thread, the card a popup shut, the keyboard cursor flag, the popover's open state, each ask's detail read once; `openNextNeedsPopup`, `goToNeedsThread`, `useAskView` |
| `lib/needsAsk.ts` | pure: the ask's target, the line of context, cmd+shift+a's next thread, `askAsStrip` (the strip's rule) |
| `shell/askStrip.ts` | `useAskStrip`: measures the body, the dock and the card with a ResizeObserver and applies the rule |
| `api/threadSearch.ts` | `readAskItems`: the ask's item and Claude's last texts, two small ListItems pages |
| `lib/shellSections.ts`, `stores/shellList.ts` | `needsList` / `useNeedsList` / `getNeedsIds`: the section's ids in the scope in force |
| `lib/threadRequest.ts` | `permissionTitle`, moved out of `PendingPrompt.tsx` so the card shares it |
| `ShellRows.tsx`, `ShellSidebarList.tsx` | the card on a Needs you row; the title opens the popup; Enter on a Needs you row opens the popup; the keyboard cursor shows the card |
| `TopBar.tsx`, `Shell.tsx` | the control after the sidebar toggle; the popup mounted once |
| `ThreadPane.tsx`, `ThreadComposer.tsx`, `thread.css` | the strip in place of the docked prompts; the card's uncapped command box |
| `keys/bindings.ts`, `keys/menu.ts` | `nextAttention`: the popup in the shell, the classic jump otherwise |
| `mock/thread.ts`, `mock/world.ts`, `mock/server.ts` | `seedAsk`, `World.addNeedsYou`, `POST /__mock/needs-you` (three threads with real asks: a long command, a question, a short command without a project) |
| `e2e/shell-needs.spec.ts` | the pointer path into the card, the long command, the strip, stream counts, SHOTS |

## Decisions

- **The card's data without a stream.** The EventService thread source already gives every
  thread's pending requests with a one-line summary; the card needs the whole input and the line
  before it. A thread whose Watch is open (a pane shows it) gives both from its log. Otherwise the
  card reads them when it opens: ListItems, the last 12 tool items (permissions and questions are
  tools) and the last two replies. A request read whole is kept by request id; a read that failed,
  or that did not find the ask (not among those items, or the item answers another request), is
  recorded as a miss and read again on the card's next open. A hover never opens a Watch, which
  would also mark the thread's turns seen.
- **Allow and Deny only with the whole request on screen** (review of #696). A permission's card
  has four states (`AskView.state`, `data-ask-state`): **known** (the request whole, from the log or
  the read: the title, the tool, the whole command, then Allow, Deny and Go to thread);
  **loading** (a quiet "Reading the request…" line, no command, Open… and Go to thread);
  **failed** and **notfound** (the one-line summary and why, "Open it to see it whole", Open… and
  Go to thread). The request is only ever the oldest open request's own (`request.requestId` equals
  the pending one's), so another request's command never sits under these buttons. The buttons send
  the id of the request on screen (`request.requestId`, `data-request-id`) and do nothing when that
  request is no longer open at the click (`requestOpen`: answered or being answered). When the
  oldest open request changes while the card is open, the card follows it: from the log at once,
  else through loading, with no buttons until the new one is known.
- **The card per kind.** A permission: today's title ("Allow Claude to run this command?"), the
  tool chip, the whole command highlighted (or the file relative to the checkout, a page's URL,
  else the input as JSON), the thread (place icon, project, name), Claude's last line in quotes,
  then Allow, Deny and Go to thread (once known, above). A question: "Claude has a question", each question with its
  header chip and its option labels as plain text, then Answer… (the popup) and Go to thread. No
  radio, checkbox or field: it is never answered in the card. An ask with no request (a woken
  snooze, a plugin's flag) shows its status word and detail, Open… and Go to thread. Several
  open requests: the oldest, and "+N more".
- **Quick actions.** Allow and Deny run `thread.respond` with `allow` / `deny`, the shown request's
  id and no reason (the reason is the popup's). The card shuts at once and the row goes when the daemon's status moves
  on. Allow for session is not in the card (the sketch has Allow and Deny only).
- **Size.** `w-max` between 320 and 560 px wide (less the window's 32 px), at most 560 px tall or
  the room Radix reports on its side (`--radix-hover-card-content-available-height`, so a card
  opening upward from a strip in a short window is never cut); it scrolls beyond. Today's 160 px
  cap on the command box is lifted inside the card (`.cf-needs-card`): the card scrolls, not the box.
- **Pointer and keyboard.** Radix's hover card: 200 ms open and close delays, so the pointer can
  cross the 8 px gap into the card. A press on the anchor shuts it (it acted). In the sidebar the
  rows are not focused (the list uses an active descendant), so the card follows the keyboard
  cursor: it shows while the cursor was moved by key on a Needs you row, and goes on a press in
  the list or when the list loses focus. The popover's rows and the strip are buttons, so Radix's
  own focus opening applies there.
- **Clicks.** The title opens the popup; the rest of the row (line 1) goes to the thread, as before.
  Enter on a Needs you row in the sidebar opens the popup (the card cannot take the keyboard, the
  popup can); other rows keep Enter. In the popover, Enter on a row opens its popup.
- **The popup dismisses the card until the anchor is hovered again.** Each card has an anchor key
  (`sidebar:<id>`, `popover:<id>`, `strip:<pane>`); opening the popup records it, and only a new
  pointer enter on that anchor (or a keyboard move in the list) clears it. While any popup is open
  no card opens.
- **The popup** is the shadcn dialog with the app's scrim, `size="sheet"` resized to at most
  980 × 900 px within the window: a header (place › name as the title, Go to thread, close) over
  `InlineThread`, the plugin node's thread view: the conversation scrolls, the composer docks
  today's `PendingPrompts` (the permission with Allow for session and its deny-reason field; the
  question with its options and Other). It is the full conversation, scrolled to its end, not a
  cut: the Timeline is virtualised and scrolls, which gives the context room. The keyboard starts
  on the ask once the Watch draws it, so digits answer as in a pane. Escape closes it, except in a
  text field or the composer, which keep their own (the deny reason's Escape cancels the denial).
  It closes by itself once the thread's open requests go from some to none (answered there or
  anywhere). Go to thread closes it and runs `select()`, which the selection bridge turns into
  `thread.open --focus`: the thread's space, its tab focused or opened in the focused pane.
- **Streams.** `InlineThread` holds the thread's Watch through `startThreadWatch`, shared with a pane
  showing the same thread, released when the dialog unmounts its content on close (e2e counts it).
- **cmd+shift+a** stays a global view action (it already wins over the shell key table, so it is
  not added to `shell/keys.ts`). In the shell it opens the popup of the Needs you list's next
  thread after the popup's (else the focused thread), wrapping, in the scope in force; with none
  it does nothing visible, and the native menu item shows no toast either. While a popup is open
  it moves to the next one.
- **The top bar control** sits after the sidebar toggle (sketch 08). It shows only while the
  sidebar is collapsed and some thread in any space waits on the user (as the section's header);
  its count is the section's, in the scope in force, hidden when that is 0 (another space's asks
  with "This space"; the popover then says "Nothing in this space needs you."). Its popover has
  the header with the same scope pill and the sidebar's Needs you lines, each with the same card
  (to its right) and popup. A space tab's count stays that space's own (`attentionIds`, PR 15).
  The popover is closed by the popup and by Go to thread; it takes the focus itself on open, so a
  click does not open the first row's card.
- **The strip's threshold** (`lib/needsAsk.ts`): the strip shows when, with the full card and the
  composer docked, the conversation would keep less than **120 px** of the thread's body
  (`ASK_MIN_ROOM`). Drawn as the strip, the full card comes back once it would leave 120 + 24 px
  (`ASK_HYSTERESIS`), judged with the card's last measured height, so it does not flap. Each new
  ask is drawn as the card first and measured; the ResizeObserver's callback runs after layout and
  before paint, so a short pane does not flash it. With the mock's one-line command (a 152 px
  card) that is a thread body under about 426 px; a long command's card switches earlier. Never
  both: the strip takes the docked prompts' place in the composer card. Only shell panes; the
  classic window and the popup always draw the card.
- **The strip**: the ask's icon and kind in the warning tone, the start of the command (its first
  line, mono) or of the first question, "+N" for more. Hover or focus shows the same card (above
  it); a click opens the popup.
- **Only the user's own threads**, as the section lists them (`needsList` uses the section's own
  filter: not hidden, archived or snoozed, the `prompt` group).

## Visible differences from the sketches (03a, 03b, 03c2, 03d, 08)

- The scope control is PR 16's one pill naming the scope in force, in the popover too, not the
  sketches' two-segment control.
- The card has no Allow for session (the sketch has none either) and no key hints on its buttons
  (the card does not take keys).
- A question's card lists the option labels in one muted line under the question; the sketches
  have no question card.
- The popup's header is the place › the full thread name (the sketch shortens it), the close is an
  icon button with a tooltip; the popup is centred in the window.
- The popup's ask card is today's, so it shows the mode hint and the Allow for session note above
  the buttons, as in a pane; 03c2's reason field and Deny ↵ / Cancel esc are the same.
- The top bar control is the shield and the count in the warning tone without a border; sketch 08
  has the same shape.
- No sketch for the strip or the card over it.

## Verification

- vitest: `components/needs/NeedsCard.test.tsx` (a permission's tool, whole command, thread and
  context, its three buttons; a file's relative path; the log of an open Watch and no read; each
  state of a permission: loading (no command, no Allow or Deny), failed (the summary, Open… and Go
  to thread, read again on the next open, then known with Allow and Deny), not found (also when the
  item answers another request), known (Allow and Deny send that request's id); the oldest request
  changing while open (A answered elsewhere: loading without buttons, then B's command and Allow
  sends B's id; a new request ahead from the log: Deny sends the one shown); `requestOpen`; a question's text and options with no radio, checkbox or field,
  Answer… and Go to thread; "+1 more"; Allow and Deny run `thread.respond` with the request id and
  shut the card; Go to thread selects and answers nothing; Answer… opens the popup; the card opens
  on hover, the popup shuts it until a new hover; the keyboard opens it, a disabled card stays
  shut), `NeedsPopover.test.tsx` (only with the sidebar collapsed; the count in every space and in
  this space; no count with only another space's asks and the empty popover; none without asks;
  the rows' order, title → popup, line 1 → the thread; Enter → popup), `NeedsPopup.test.tsx` (the
  thread shown, a missing thread opens nothing, Go to thread, closing once answered, staying open
  for an ask without a request, Escape in a field and outside), `ThreadComposerAskStrip.test.tsx`
  (the card with room, the strip and never the card when short, the strip's popup and anchor),
  `lib/needsAsk.test.ts` (targets, the line of context, the next thread, the strip's rule with its
  hysteresis), `lib/shellSections.test.ts` (`needsList`: order, scope, own threads only),
  `keys/bindings.test.ts` (cmd+shift+a in the shell opens the popups in order and wraps, selects
  nothing; nothing visible with none), `ShellSidebarList.test.tsx` (the title opens the popup,
  line 1 still opens the thread; the keyboard cursor shows the card, Enter opens the popup, a
  press in the list hides the card).
- e2e `shell-needs.spec.ts` (WebKit, mock): the pointer from a row's title and from line 1's right
  end (where other rows' hover controls sit) into the card, reaching Go to thread and Deny, then
  Allow there (the window stays on its tab); a long command at a 340 px window: the card 560 px
  wide, within the window, scrolling under the wheel while the command box is whole; the strip at
  a 520 px window, its card, its popup, the card back at 900 px; WatchThread 1 → 2 with another
  thread's popup → 1 after close, and 1 with the pane's own thread's popup. 20 of 20 over five
  repeats on four workers.
- End to end with `make drive DAEMON=dev` and `?shell=1` on a scratch home under /tmp and a scratch
  repository under the home folder (both removed after), threads on Sonnet 5.5 at medium, supervised:
  in a second space, "Touch hello" (asking to `touch hello.txt`, living in Main) was allowed from its
  hover card: the window stayed in the second space, hello.txt appeared, the thread finished.
  cmd+shift+a opened the popup of "Remove readme" with the keyboard on the ask; 3 then a reason and
  Enter denied it (`thread read`: "denied (deny): Keep the readme; add a line to it saying hello
  instead.", and Claude asked for that instead); the popup closed. "Pick a colour"'s question was
  answered in its popup (3, Enter: "= Blue", Claude's reply "You chose Blue for the heading.").
  With the sidebar collapsed the control counted 1; its popover's row went to the thread in Main.

## Gotchas

- Radix's dialog content mounts a pass after its parent (the portal): a ref object is still null
  in the parent's effect. The popup keeps its content element in state (`ref={setRoot}`).
- `react/set-state-in-effect` (oxlint) refuses a measure-then-set in a layout effect; the strip's
  hook sets its state from a ResizeObserver callback instead, which also runs before paint.
- A `vi.mock` of `@/api/threadSearch` is needed in any test that renders a Needs you row with its
  card open (the card reads on open); `ShellSidebarList.test.tsx` returns a promise that never
  settles.
- `top bar` tests build threads without a `statusReason`: the control computes the list only while
  the sidebar is collapsed (`NeedsControl`), which also spares the work when it is not shown.
- A radix primitive may only be imported in `components/ui` (`lib/tooltips.test.ts`), and every
  file there is re-exported to pages as `@cf/ui` (`pagelib/ui.test.ts`), with its exports listed in
  the pages skill (`internal/skills` tests against `dist/ui-exports.json`). So the hover card is a
  page library addition too: `make pagelib` and the skill's component list, in its own commit.
- `playwright cli mousemove` takes two arguments; zsh does not split `$A`, use `${=A}`.

## For later PRs

- **Cutover (PR 20)**: cmd+shift+a's shell branch (`nextAttention`) becomes the only one once the
  classic window goes; the native menu's toast goes with it.
- **PR 21**: nothing here imports the panel stores.
- The popup shows the whole conversation, virtualised; a cap ("the last N turns") could come if a
  long thread opens slowly there.
- An optimistic leave of the row after Allow or Deny (the `answering` map) would remove the short
  wait for the daemon's status.
