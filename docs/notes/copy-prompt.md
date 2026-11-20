# Copy on a user message

A user asked for a way to copy a prompt they sent. The agreed design is option A of the
steer sketches' copy page ("mini gutter, hover"): a small icon-only Copy just left of the
time under the bubble, the same control as the turn gutter's Copy (turn-gutter.md).

## What it looks like

* **Where** (`UserBubble.tsx`, `thread.css .u-meta`): a line under the bubble holding Copy,
  then the time. The time keeps the right edge. A steer has it before its caption ("↓ sent
  mid-turn · 14:15"), a queued message before its time and Queued tag, all on one line.
* **The control** (`GutterCopy.tsx`): the gutter's button, now shared by both. A 24×22 `.ib`
  with the Copy icon, a tooltip through the shared `Tip` ("Copy prompt"), and for
  `COPIED_MS` a check in the success colour with "Copied" as its name and tooltip. The `.ib`
  rules in thread.css now apply to `:is(.tgut, .u-meta)`. Ember's own `.copy-answer` is
  left alone.
* **When**: hidden at rest; shown while the bubble or its line is hovered, while Copy has
  the keyboard focus (`:focus-visible`, not a click's focus), and while it shows its check.
  Opacity only, with no transition, so it appears instantly, stays in the tab order and
  takes its space at all times: showing it moves nothing.
* **Hover is CSS** (`.u:has(> .bubble:hover, > .u-meta:hover)`), not the turn gutter's
  activity store. A message is one row of the list, so plain `:hover` works. `.u:hover` alone
  would also count the empty width left of the bubble (`.u` spans the column), which the
  e2e test checks is not the message. The line reaches up over the message's 4px gap
  (`margin-top: -4px; padding-top: 4px`), so moving the pointer from the bubble down to
  Copy never crosses a spot that hides it.

## What it copies

`lib/userMessage.ts promptCopyText(pieces)`: the message as the user wrote it, as plain
text, built from the same pieces the bubble draws (`parseUserMessage`). It is computed from
the item, not read from the DOM, so a folded message (MessageFold) copies its whole text.

* **Not `text`** (what Claude got): that has the app's internal addresses
  (`@cf-file://<project>/…`, `[Image: x; ref=/staged/path]`, `[Thread "x" (id s-…)]`, a
  citation's long encoded `cf-cite://` link). Pasted into an editor or another tool they
  are noise, and the staged path is private to the daemon.
* **Not `composerText`** (the tokens): our composer turns pasted tokens back into tags, but
  an image token holds the sent message's attachment index, not a draft id, so it pastes as
  a broken chip. A citation's sent link is not a draft token, so it pastes as a long link.
  In an editor every tag reads as a Markdown link to a `cf-` URL.
* **So, per piece**: text runs as typed; a skill `/name`; a file `@path` (`#L24` for a line),
  the form Claude Code's @ mention reads, so a paste into any Claude composer still points
  at the file; another thread its name; a pull request `owner/repo#123` (unambiguous
  outside this thread, and what gh takes); an image or PDF `[Image: name]` / `[PDF: name]`
  where the chip was, so "see this screenshot" keeps its referent; a citation the quote as
  a Markdown blockquote on its own lines, then the user's comment. A skill or file gets a
  space before a word right against it (as the projection does), not before punctuation.
* **No text, no Copy**: a message of only attachments (and whitespace) gets `""` and no
  button; its time stands alone as before.

## Where it shows

Only in a timeline: the bubble gets Copy when it has a `foldKey`, which already marks "a
message in a timeline" (the thread's messages, steers and queued messages, and a subagent's
prompt in the subagent pane, which a user may well want to reuse). The search preview and
the theme gallery pass none and get none: the preview is a read-only picture of a hit, and
the gallery is `inert`. A message from another thread (FromRow) and a wake note do not use
UserBubble's line and are unchanged.

## Departures from the sketch

* The sketch named a folded prompt's button "Copy full prompt"; it is "Copy prompt" for
  every message, as asked when the design was agreed. A folded message copies whole anyway.
* The sketch showed Copy for any hover over `.u` (its full width); here only the bubble and
  its line count, as agreed ("bubble or its meta row").
* The sketch's meta row was a fixed 22px. Here the line only exists when there is a Copy,
  so a message without one keeps its old layout; with one, the line is the button's 22px,
  which puts the time 3px lower than before (once, not on hover).

## Tests

* `lib/userMessage.test.ts promptCopyText`: plain text, a CLI message, each tag kind, the
  word gap, image and PDF names, only attachments, a citation.
* `components/thread/UserBubbleCopy.test.tsx`: the button and its place before the time;
  the copied text, the check and "Copied", and back; a folded long prompt copies whole;
  tags as plain text; steer, queued steer and queued message; none for attachments only and
  none without a fold key.
* `rows.test.tsx` covers the gutter's Copy through the shared component, unchanged.
* e2e `thread-copy-prompt.spec.ts`: hover shows it with no transition and every row's box
  and the time's stay put; the empty width beside the bubble does not show it; the pointer
  going from bubble to Copy keeps it shown; keyboard focus shows it. SHOTS=<dir> saves the
  PR's screenshots.

## Gotchas

* WebKit's Tab skips buttons unless full keyboard access is on: the focus test uses Alt+Tab,
  and a programmatic `focus()` after a click is not `:focus-visible`.
* A steer ends the mock's streaming turn and the list moves; WebKit does not recompute
  `:hover` until the pointer moves, so the screenshot test hovers once the list has settled.
