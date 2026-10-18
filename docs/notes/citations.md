# Citations: cite text from Claude's answers into the composer

Status: branch `cf/citations`. GUI only: no daemon, proto or command change. Approved by
Alex 2026-10-18 from the HTML sketch (`/tmp/cf-cite-sketch/index.html`, `light.html`),
with one change: a multi-line comment field with Cancel and Save at the bottom right.

## What landed

| Path | What |
|---|---|
| `gui/frontend/src/lib/citation.ts` | pure: `Citation`/`CitationBody`, draft token, `citeLink` (projection), `parseCiteLink`, `splitCiteLinks`, `citeLabel`, `quoteAt`, `locateQuote` (re-anchoring), `citableItem`, `placeCite` (placement rules) |
| `gui/frontend/src/lib/prompt.ts`, `lib/userMessage.ts` | the `cite` tag kind; projection and `sentComposerText` take a citation lookup; the bubble reads citation links from either text |
| `gui/frontend/src/stores/compose.ts`, `stores/threadActions.ts` | `Draft.citations`, `putCitation`, `findCitation`, `useCitation`; both sends project citations |
| `gui/frontend/src/stores/cite.ts` | the flow's shared state: the chip being edited, Go to source requests, the composer's cite target, the timeline's handle |
| `gui/frontend/src/components/thread/cite/` | `CiteLayer` (Cite button and comment popover), `CiteChip` (the sent chip and its popover), `citeDom` (plain text, offsets, ranges, paint), `reveal` (unfold, scroll, find), `cite.css` (`::highlight`) |
| `components/compose/{TagView,QuoteGlyph,tagContext,tagStyle,PromptEditor}.tsx` | the composer chip (amber, quote glyph, tooltip, click to edit, ring), `insertCite`, `focusCollapsed` |
| `components/thread/{rows,Timeline,ThreadPane,ThreadComposer,UserBubble}.tsx` | `data-cite-item` on the thread's own answers, the timeline handle, the layer, the target, the bubble chip |
| `gui/frontend/e2e/citations.spec.ts` | mock e2e |

## Decisions

* **No command.** Citing is pointer-driven and selection-only, like Copy on a code block
  (`code-block-actions.md`: Copy has no command, Run in terminal does because the daemon
  types). There is no keybinding to register, so nothing goes in `internal/command`.
* **Citable**: the thread's own assistant text items (`TextRow` with an empty
  `parentToolUseId`, in the thread timeline, not the subagent view). Both ends of the
  selection must be inside the same answer (`citableItem`); a selection that runs into a
  tool row, a bubble, another answer or the header shows no button. Intermediate text
  between tool calls counts as an answer too (it is Claude's prose). A subagent's text
  does not.
* **Plain text**: an answer's text nodes in order with one newline between blocks
  (`plainText`): no button text (Copy, Run), no whitespace-only nodes between blocks.
  The quote is that text between the selection's ends, trimmed; offsets, prefix and
  suffix (32 characters each) are into it. The quote is therefore exactly what was
  rendered: inline code without backticks, paragraphs on their own lines.
* **Re-anchoring** (`locateQuote`): the offsets when the text there is still the quote
  and the prefix and suffix agree; else every occurrence of the quote, scored by how much
  of the prefix and suffix agree, ties to the one nearest the old offsets; whitespace is
  ignored throughout. Null when the quote is gone.
* **Highlighting**: the CSS Custom Highlight API (`::highlight(cf-cite-held)` for the
  selection kept while the comment field has the keyboard, `::highlight(cf-cite-mark)`
  for a cited quote, amber with an underline). It never touches React's DOM. WebKit and
  Chromium both have it; where it is missing a fixed overlay of the range's line boxes
  outside React's tree stands in (repainted every frame while shown).
* **Placement** (`placeCite`, the sketch's rules): 6px under the quote's last line box,
  centred on the pointer's x (the new citation) or the quote's end (an edit), clamped
  12px inside the thread body; above the first line when the room under it, above the
  composer, is too short, but only when there is room above (else it stays below). The
  comment popover keeps the side it opened on while its field grows (down to the body's
  bottom, or up to its top, then it scrolls), so it does not jump while typing. Hidden
  while its line is out of view (above the body or under the composer). Recomputed every
  frame while shown, from the offsets, so it follows the scroll and a row that remounts.
* **Radix**: both surfaces are the shadcn Popover with a virtual anchor (focus, Escape,
  outside clicks, the zoom wrapper). The cite layer computes the top-left itself
  (`avoidCollisions` off, `updatePositionStrategy="always"`); the sent chip's popover
  anchors at (chip left, bubble bottom) and lets Radix shift it inside the window.
* **The chip** (`cite` tag kind): token `[Assistant quote](cf-cite://<citationId>)` in
  the prompt; the body (quote, comment, source thread and item, offsets, prefix, suffix)
  in `Draft.citations`, kept in memory like attachments, never pruned while the draft
  lives (undo brings a deleted chip back with its body), gone with the draft. Label: the
  first 4 words of the quote, at most 24 characters: cut at the last word boundary within
  them when that keeps at least 12, else mid-word; an ellipsis when anything was cut
  (`The fingerprint then…`; review: the first cut was mid-word, `The fingerprint then mat…`). Tooltip: the quote, then the comment muted. Not
  project-scoped (member changes keep it). A token whose body no draft has (copied from a
  composer that has sent it) is dashed and left out of the message; a token copied to
  another composer while its draft lives finds its body there (`findCitation`).
* **Insertion**: at the prompt's caret (its end when it was never focused), a space
  before unless whitespace is there, one after; the prompt takes the keyboard after it.
* **Editing**: a click on a composer chip scrolls to its quote (unfolding its turn when
  the answer is folded away), paints it amber, rings the chip and opens the popover there
  with the comment and Save; Save changes only the comment. Closing returns the keyboard
  to the prompt with the caret after the chip. When the quote is not in this thread (a
  token pasted from another thread, a compacted answer) the popover opens above the chip.
* **Buttons**: Cancel (outline) and Save (primary, with the ⏎ glyph) for a new citation
  too, as Alex asked ("Cancel and Save"), rather than the sketch's "Cite ⏎". Enter saves,
  Shift+Enter is a new line, Escape and a click outside cancel. The comment is optional.
* **Projection** (T3's format): `[Assistant quote](cf-cite://v1/<threadId>/<itemId>?text=…&start=…&end=…&prefix=…&suffix=…&comment=…)`,
  every value percent-encoded including `!'()*`, `comment` left out when empty. Real item
  ids contain `/` (`msg_…/1`): ids are encoded too (`%2F`). It is both the message text
  and the stored composer text.
* **The bubble** reads citation links from the composer text and, when there is none,
  from the message text (the one exception to "nothing is parsed from the projected
  text"). A message of text and citations only has composer text equal to the projection,
  so `sendThreadDraft` sends none; the link is self-contained, so the chip still draws.
  A link that does not decode stays text. Its popover: the quote muted behind a 2px rule
  (4 lines, then it scrolls), the comment, "Claude · 05:47 AM" (the answer's time), and
  Go to source (scroll there, flash the quote for 1.6 s). Disabled with "No longer in this
  thread" when the item is not in this thread's items.

## Gotchas

* The cite layer is a sibling of the Timeline, which is keyed by the thread id: keying
  the layer by the same id gave React two children with one key and the layer never
  mounted. It is keyed `cite:<id>`.
* A popover that opens hidden (its first placement frame has not run) cannot focus its
  field: the chip edit left the keyboard in the prompt with the chip node-selected, and
  the next key replaced the chip. The field focuses once the surface is shown. Found in
  the live check; the e2e asserts the focus now.
* Radix `PopoverTrigger` together with a virtual `PopoverAnchor` positioned the sent
  chip's popover at (0, 0): the chip is a plain button that toggles the popover, and an
  outside interaction on it is ignored so it does not close and reopen.
* `UserBubble.test.tsx` mocks `@/api/threads` partially: importing the quote glyph from
  `TagView` pulled the compose store into the bubble. The glyph has its own file.
* Chromium starts a text drag when a drag begins inside a selection, and autoscrolls the
  list when a drag runs near its edge: the e2e clears the selection first and centres the
  row before selecting.
* `Range.toString()` includes the whitespace nodes between blocks that the plain text
  skips; nothing reads it for offsets.
* WebKit can draw macOS Writing Tools' badge at the left of a fresh selection in the
  Wails window; it is the system's, not ours.
* Running a second Playwright run while the full suite ran cleaned its shared
  `test-results` directory (a trace ENOENT in two unrelated specs), as noted in
  `composer-tags-4-files.md`.

## Live check (scratch daemon, 2026-10-18)

`make build gui-build`; `CODE_FOUNDRY_HOME=/tmp/cf-cite-home bin/code-foundry daemon
--dev`; a plain folder `~/cf-cite-scratch` added as a project; one thread on Haiku 5.5
(`claude-haiku-5-5[1m]`), medium, asked for two paragraphs and a two-item list about a
count-based PR fingerprint. The GUI as an isolated copy on that home, driven with CGEvent
clicks and drags.

* Dragging over "The fingerprint then matches the old value" showed Cite 6px under the
  line, centred where the pointer let go. Cite turned into the popover in place, the
  selection painted while the field had the keyboard; a two-line comment, Enter: the chip
  `The fingerprint then mat…` at the caret (now `The fingerprint then…`). A second citation of the bold lead-in
  "Fingerprint the full state:" with no comment.
* A click on the first chip: the quote amber and underlined, the chip ringed, the comment
  prefilled and focused; Escape returned to the prompt.
* Sent. The stored message text (and what Claude got):
  `[Assistant quote](cf-cite://v1/s-9a4536786a78/msg_011Cg9a1N2WWmHChjpMvTZjG%2F1?text=The%20fingerprint%20then%20matches%20the%20old%20value&start=211&end=253&prefix=…&suffix=…&comment=Is%20the%2030%20s%20idle%20tick%20configurable%3F%0AIf%20not%2C%20make%20it%20a%20setting.) is that right? Start with [Assistant quote](cf-cite://v1/…?text=Fingerprint%20the%20full%20state%3A&…) and keep the setting small.`
  Haiku answered about each quote by name ("The second quote is right. Fingerprinting the
  head SHA …"; "The first quote describes a general failure mode …").
* The bubble drew both chips; the first's popover showed the quote, the comment and
  "Claude · 05:47 AM"; Go to source scrolled the answer into view and flashed the quote.
* The same in the light theme. Screenshots: `docs/notes/citations/dark.png`,
  `light.png` (2x2 each: selection and Cite, the comment popover, chips with one being
  edited, the sent bubble's popover); full-size originals on `cf/citations-shots`.

## Verified

* `make check` green: gofmt, vet, staticcheck, `go test -race ./...`, typecheck, lint,
  vitest. Vitest: `lib/citation.test.ts` (token, label table, link round trip with
  special characters, malformed links stay text, `quoteAt`, `locateQuote` table:
  offsets right, text inserted before, several occurrences, other surroundings,
  whitespace changes, gone, nearest on a tie; `citableItem` table; `placeCite` table),
  `lib/prompt.test.ts` (cite tokens, a sent link is not a draft token, projection with
  and without a body, not project-scoped), `lib/userMessage.test.ts` (sent composer
  text, project-then-parse round trip from either text, next to a tag and across lines),
  `components/thread/cite/citeDom.test.ts` (plain text, offsets, ranges, re-anchoring
  after a re-render), `CommentForm.test.tsx` (keys table: Enter, Shift/Alt/Cmd+Enter,
  IME; focus and caret; Cancel and Save).
* `e2e/citations.spec.ts` (WebKit and Chromium, twice each): select → Cite (position) →
  comment (held paint, Shift+Enter) → chip and token → tooltip → edit from the chip
  (focus, amber paint, ring, Save, back to the prompt) → send (the link's exact shape,
  prefix and suffix) → bubble chip → popover (position, quote, comment, time) → Go to
  source (flash); no button in a bubble, across into a bubble, a click elsewhere hides
  it; Escape, a click outside, an empty comment, Backspace and undo; a folded turn
  unfolds for its chip; a link to an item the thread lacks: "No longer in this thread".
* `make gui-e2e` (full suite, run while the GUI build and the live check loaded the
  machine): 921 passed, 46 skipped, 9 failed, none of them in the composer or the
  timeline (`projects.spec.ts:349`, `settings.spec.ts:293` and `:507`,
  `threads.spec.ts:242`, `usage-page.spec.ts:36`, `worktree-panel.spec.ts:112`; two of
  them the `test-results` clobber above). Re-run alone in both browsers: 12/12 passed.
