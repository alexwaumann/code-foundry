# Inline HTML pages never fold (2026-10-23)

The rule from a user: "HTML pages should never fold under the turn's fold." Until now a
page the model showed (`view.inline`) kept its "Showed <file>" row in a folded turn, but
its card closed with the fold (inline-html.md), except that a card seen open survived the
turn's own fold at its end (the `html-seen:<id>` mark and the node's `foldChosen`).
Frontend only.

## Decision

The turn's fold never affects an html page. Its row and its card stay exactly as they
are whether the turn is folded or unfolded, folds by default at its end, or the reader
folds it. Only the reader clicking the row closes or opens the card. Leaving the thread
forgets expand choices (as before), so on return every card is open again, folded turn or
not. The page is still no step in the header's count and still breaks a live strip's run.

## What changed

- `lib/threadTimeline.ts`: the `html` WorkNode is `{ type, key, id }`; `folded` and
  `foldChosen` are gone, and `buildRows` pushes the node as it is in a folded turn
  (`foldsAway` already kept it).
- `components/thread/InlineHtml.tsx`: one expand key per page, `html:<id>`, open by
  default; the per-fold-state key (`html:<id>:folded|open`), the `html-seen:<id>` mark and
  its effect are gone, and so is the "folded" meta word (the title shows instead, when
  there is one).
- The theme card is unchanged: it never had a fold-dependent state (no expand key, no
  flag), so it was already shown the same in a folded turn.

## Tests

- `threadTimeline.test.ts`: a folded turn yields `html:h` (no "(folded)" suffix), and the
  node is the same object shape whether the turn folds by default, the reader folds it, or
  unfolds it.
- `rows.test.tsx`: a finished turn with a page, in each of the three fold states, renders
  the row with `aria-expanded="true"`, the card, and no "folded" word; the row closes the
  card and the choice holds when the turn's fold changes. The card's grant is mocked to
  stay loading (no frame in jsdom).
- `e2e/inline-html.spec.ts`: "the turn's fold never touches a page" replaces "the item
  folds with its turn": the turn ends and folds with both cards open; unfolding and
  folding keeps them open; the row closes one and the fold does not reopen it; after
  leaving and returning, the folded turn's cards are open. With `SHOTS=<dir>` it saves
  `folded-open-{dark,light}.png` at the end.

## Gotchas

- Expand state is per thread in the thread store and is cleared when the thread is left,
  which is what makes "open again on return" hold; no new state was needed.
- The mock's `thread/finish` completes the "html" state's streaming answer with text that
  reads oddly; the screenshots are cropped to the header and the two cards.
- The worktree sandbox refuses heredocs and shell loops; `sips --cropOffset` ignored the
  offset, so the shots were cropped with `magick -crop`.

## Daemon restart

Not needed: GUI only.
