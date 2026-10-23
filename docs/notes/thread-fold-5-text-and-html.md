# Thread fold 5: the fold hides work only, never text or pages (2026-10-23)

Two rules from a user: "HTML pages should never fold under the turn's fold", and Claude's
text must never be hidden by the fold either. Until now a folded turn showed its message,
header, final answer (the trailing text), notes, steers and the inline pages' rows, but
an intermediate text (written between tool calls) folded away, and a page's card closed
with the fold (inline-html.md; a card seen open survived only the turn's own fold at its
end, through an `html-seen:<id>` mark and the node's `foldChosen`). Frontend only.

## Decisions

- **What the fold hides.** Only work: tool rows, explore groups, Agent rows, thinking,
  questions and permission requests. A folded turn shows its user message(s), its header,
  then in order every text row (not only the answer), notes, steers, inline pages and
  theme cards (`foldsAway` in `lib/threadTimeline.ts`).
- **Text is no step.** The header's count is the work the fold hides, so intermediate
  text, which used to count, no longer does, in the finished header and the live one
  ("Working · N steps") alike. The mock's 12-step turn reads 9 steps now. A turn with
  text only and no work has a plain header (nothing to fold), as before.
- **The answer is unchanged.** `final` still marks the trailing text (it gets more air),
  the copy action still sits on the first final row and copies the final texts, and the
  header's `finals` (not rendered, used by tests) still lists them. The header stays at
  the top of the turn; the texts follow it in their order.
- **Pages ignore the fold.** An html page's row and card stay exactly as they are whether
  the turn is folded or not, folds by default at its end, or the reader folds it. Only the
  reader clicking its row closes or opens the card. Leaving the thread forgets expand
  choices (as before), so on return every card is open again. A page is still no step and
  still breaks a live strip's run.
- **The theme card** had no fold-dependent state (no expand key, no flag): unchanged.

## What changed

- `lib/threadTimeline.ts`: `foldsAway` keeps every text; the `html` WorkNode is `{ type,
  key, id }` (`folded`, `foldChosen` and the `buildRows` special case are gone); comments.
- `components/thread/InlineHtml.tsx`: one expand key per page, `html:<id>`, open by
  default; the per-fold-state key, the `html-seen:<id>` mark and its effect, and the
  "folded" meta word are gone (the title shows instead, when there is one).
- `components/thread/cite/reveal.ts`: going to a citation's quote no longer unfolds its
  turn: the text is always in the list. The unfold branch (buildTurns over the thread's
  items, setTurnFolded) is gone; the turn stays folded.

## Tests

- `threadTimeline.test.ts`: folded turns keep `text:mid` in place and count one step
  less; a folded turn with text → tool → text → tool → final text yields the header and
  the three texts (2 steps), the same when the reader folds it, the work between them when
  unfolded; an html node is the same in all three fold states; the live strip cases count
  no text.
- `rows.test.tsx`: a finished turn with a page, folded by default, by the reader, or
  unfolded: the row is `aria-expanded="true"`, the card is there, no "folded" word; the
  row closes the card and the choice holds across the turn's fold. The grant hook is
  mocked to stay loading (no frame in jsdom).
- e2e: `inline-html.spec.ts` "the turn's fold never touches a page" replaces "the item
  folds with its turn". `citations.spec.ts`: the chip's quote is in a folded turn's
  intermediate text, which goes into view with the turn still folded. `thread.spec.ts`:
  9 steps, not 12; the two "header and answer in view after the fold" checks run at
  1280x1100 (the folded turn is taller now); the "leaving a thread" test wheels up to the
  header before clicking it.

## Gotchas

- The folded turn is taller now. At the e2e's 800 px a folded turn whose texts are long no
  longer fits with its header, so a pinned list at the bottom has the header above the
  viewport. Expected, not a bug: the header is at the top of the turn.
- A programmatic scroll on a pinned list is undone (the list follows the bottom back):
  tests that need a row in the middle use the wheel (`wheelUpTo` in thread.spec, a wheel
  loop in citations.spec). Before, unfolding the turn unpinned the list as a side effect.
- `ember.spec.ts` "the board's sections…" fails when run between midnight and 2 AM: the
  mock's cancelled task is `ago(120)` minutes, which is then yesterday. Not touched.
- `make check` hit `TestMisbehavingPlugins/flood` (heap during a flood) once; it passed on
  rerun. No Go changed here.
- Screenshots are in the PR body (from the `cf/html-never-folds-shots` branch), taken with
  `SHOTS=<dir>` on `inline-html.spec.ts` against the mock.

## Daemon restart

Not needed: GUI only.
