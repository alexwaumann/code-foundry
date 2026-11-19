# Turn gutter: the header says how long, a gutter carries the rest, the fold leaves the reply

A user saw content jump when the answer's copy button faded in on hover, and a folded turn
still showed every text written between tool calls. The agreed design (turn sketches 2,
section 1, and 4, section 5) moves the turn's details and its Copy into a fixed-height row
under the turn, and folds a turn down to its final reply. It also tells the model so.

This replaces parts of the earlier fold notes: thread-fold-3-header.md's header text and
"copy on the answer", and thread-fold-5-text-and-html.md's "the fold never hides text"
(pages, theme cards, notes and steers still never fold).

## What a finished turn shows

* **Header** (`rows.tsx HeaderRow`): only how long it took, "Worked for 1m 2s", behind the
  fold chevron. "Interrupted after 40s" and "Failed after 3s" keep their words and red.
  The live header ("Working · 3 steps · 1m 12s") is unchanged.
* **Gutter** (`GutterRow`, row type `gutter`, key `f:<turn key>`): the turn's last row. Copy
  (icon only, tooltip "Copy reply"; copies the reply's texts joined by blank lines, API
  error text left out, the same check and "Copied" as before), then "Fork from here"
  (fork-from-here-button.md), then in `text-caption`: steps, cost, model and the time the
  turn_end arrived (`sentTime`, the bubbles' clock format). Steps, cost and model follow the
  rules the header had (nothing shown when the daemon could not tell).
* **Folded**: the header, the reply, notes, steers, pages, theme cards and the gutter. The
  text before the reply is part of the work: it folds with the tool rows and comes back in
  order when the fold opens.

## Decisions

* **The reply** (`lib/threadTimeline.ts turnReply`): the turn's final texts (the trailing
  texts, as `final` always meant), else its last text (interrupted, failed, or a steer after
  the last text), else none. The same set is what the fold leaves and what Copy copies, so
  an interrupted turn whose last text is shown can copy it. No reply: no Copy, the info
  stays. A running turn has no reply set (`null`): none of its text folds, as before.
* **Steps are unchanged**: work rows only, text is no step. A turn with no work but text
  before its reply (text, steer, text) still has something to fold: the header carries a
  `foldable` flag (anything the fold hides) instead of deriving the toggle from `steps > 0`.
* **Gutter visibility**: shown at rest on the thread's latest turn (the last one with a
  header); while a newer turn runs, the finished one before it is no longer the latest and
  hides at rest. An older turn's shows while the pointer is over any of its rows (header to
  gutter) or one of its controls has the keyboard focus, and while its Copy shows its check.
* **Hover across rows** (`components/thread/turnActivity.ts`): a turn is several rows of
  the virtualized list, so no CSS `:hover` spans it. `rowTurns` maps each row to its turn;
  `TimelineList` puts it on the row's wrapper as `data-turn` and, given `turnOf`, listens on
  its column for `pointerover`, `pointerleave`, `focus` and `blur` (focus counts only when
  `:focus-visible`). A tiny store per list holds the hovered and focused turn; each gutter
  subscribes to "is my turn active", so a move re-renders at most two gutters.
* **No shift**: the row is always laid out at 26px (plus the turn's 16px end padding); only
  its contents change, with **opacity 0/1 and no transition**, not `visibility`. Hidden
  with `visibility`, Copy on an older turn would drop out of the tab order, and keyboard
  users could not reach it; with opacity it stays focusable and `.tgut:focus-within` shows
  it. Nothing else about it is interactive while hidden: the pointer is over the turn
  whenever it is over the button, which shows it.
* **A running turn has no gutter row.** It appears with the turn_end at the very end of
  the list, so nothing below it moves; a pinned list follows the bottom as it does for the
  fold that happens at the same moment. Reserving it during the run would only leave an
  empty 28px gap under streaming text.
* **Ember keeps its own copy button.** Ember's chat reuses `TextRow` with its own reply rows
  (lib/ember, `answer`), so the old `.copy-answer` button and its CSS stay for Ember only;
  a thread's text rows no longer get `answer`. Ember's prompt already tells it the user
  sees only its last text, and its UI was not part of this change.
* **Find and citations**: `foldingTurn` now names the turn for a finished turn's text
  before its reply, so the find bar opens that turn for a match there (and folds it back
  when the match moves on, as for questions), and a citation chip's Go to the quote opens it
  (`cite/reveal.ts` already called `unfold` when the row was not in the list). Pinned-only
  auto-fold, folded on return and the header's kept place are untouched: they key on the
  turn, not on what it hides.

## The model is told (daemon)

`internal/store/thread/workspace.go ReplyPrompt`, in every thread's
`--append-system-prompt` as the first part of its own append (`ownAppend`), before a
created thread's `CreatedThreadPrompt`: "The user sees only the last message of each turn;
everything before it is folded away with your work. Put everything they need in that last
message: results, decisions, caveats, and the answer to anything they asked or sent
mid-turn, restated even if you already said it earlier in the turn."

* Not inside `ThreadPrompt`: that paragraph's 1,641-byte budget is for skill routing and
  raising it needs a guide eval run (real money). `ReplyPrompt` has its own budget row
  (291 bytes, `internal/skills/budget_test.go`); every request still pays for it.
* A resident (Ember) does not get it: its rules (`internal/store/ember/files/rules.md`)
  already say this in their own words.
* The appended prompt is recorded on a conversation's first request, so it reaches new
  threads (and existing ones after a compaction), not running conversations.

## Tests

* `threadTimeline.test.ts`: the gutter as each finished turn's last row (folded and open),
  `latest` moving off a turn while a newer one runs, the interrupted turn's last text as its
  reply, no gutter for a setup's synthetic end, `foldable` with no steps, `rowTurns`,
  `foldingTurn` for text before the reply and never for a running turn's text. The `shape`
  helper leaves gutters out, so the older order checks did not all change.
* `rows.test.tsx`: the header's text in every form, the gutter's contents per kind (reply,
  no reply, interrupted, failed), latest vs older at rest, hover and focus through the
  activity store, Copy and Copied, the rows of a folded and an open turn.
* `turnActivity.test.tsx`: the DOM handlers (pointer over a turn's row, a row of none,
  leaving the list; keyboard focus vs a click's focus).
* `threadFindFolds.test.ts`: a match in text before the reply opens its turn and is put back.
* Go: `TestReplyPrompt`, `TestOwnAppend` (a resident gets none), the spawn prompt tests.
* e2e: `thread.spec.ts` "hovering an older turn shows its gutter and moves nothing" (every
  row's box before and after); the specs that read the old header text and the answer's
  copy now read the gutter; `citations.spec.ts` opens the folded turn for the quote, then
  goes back to the bottom with Jump to bottom (the opened turn leaves the list far above
  it, so the next reply was not mounted).

## Gotchas

* `thread-message-fold.spec.ts` "Go to source…" drags from a long message's first line:
  at 800 px the two new gutter rows pushed that line above the viewport and the drag
  selected nothing. It runs at 1280×1100 now, like the other tests that need a whole turn.
* The mock's streaming turn lasts minutes ("Worked for 9m 1s"): a header regex must allow
  minutes.

## Verified

`make drive` against the mock (s-r1 `idle`, `streaming`): the latest turn's gutter at
rest, the older one's hidden until hovered with every timeline row's box unchanged, the
first turn folded to its reply and opened with its in-between texts in order, and an
interrupted turn ("Interrupted after 9m 22s" in red, its last text, the gutter's info).
Screenshots are in the PR body.
