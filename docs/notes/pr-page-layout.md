# Pull request page: header with the state, cards in Overview

The pull request surface's layout redone to the agreed sketch (v11, after ten rounds): the
readiness box is gone. The header carries the state and its buttons on every inner tab, and
Overview carries the details and one card per requirement that is not passing. Frontend only;
the merge, review and diff components are unchanged and only render somewhere else.

## What shipped

- **Header** (`PrHeader.tsx`): the title with the ⋯ menu; one quiet line, `owner/repo #n · base
  ← head` (the branches truncate, tooltip only when cut); then the status section under a
  divider: the state's icon and words in its tone, quiet text after them, and the buttons at
  the right (Review ▾, then the state's main action). The whole header has a wash of the state's
  tone (success, warning, the merged tone, error; none for a draft). The bottom border stays the
  divider colour. No state pill, no Open on GitHub button, no author, ages or diffstat.
- **Words** (`readiness.ts` headline): Ready to merge, Waiting on checks, Not ready to merge
  (no "N left"), Auto-merge on (no method after it), Draft, Merged with "a3f9c21 into main 1d
  ago", Closed with its age. `statusTone` maps the headline's tone to the wash.
- **Main action** (`ReadinessFooter.main`, was `merge`): merge, auto-merge or cancel-auto-merge
  as before; `ready` for a draft (the author or write access), `revert` for a merged pull
  request with write access. Rows no longer carry Ready for review or Revert; Revert left the ⋯
  menu.
- **Stale strip**: under the header on every tab when the copy's fetch failed: "Showing the
  copy from 5m ago. GitHub could not be reached." The reason is the text's tooltip (it takes
  focus for the keyboard), and Retry runs the same refresh as the menu.
- **⋯ menu**: Start a thread (Ask a question, Explain this PR, Fix findings), This pull request
  (Convert to draft, Link to this thread; the heading only when one of them shows), Open on
  GitHub and Copy link, then Refresh with its freshness. No hint lines, except "Converting to
  draft…" while it runs.
- **Overview** (`PrOverview.tsx`): the details (Author, Reviewers, Opened, Updated or
  Merged/Closed as `detailAges`, Labels when any, Commits) are a 216px side column from 680px
  and a wrapping strip above narrower. Then `readinessCards`: a card per issue row (failure,
  pending, info, draft) with its TaskButton or Approve on GitHub, and one quiet card for the
  passed rows. A failing or running checks card lists those checks, with All N checks to unfold
  every check (Failing only / Running only back); the passed card's checks line has Show / Hide.
  Merged and closed pull requests have no cards. The description folds at twice the app's fold
  (340px).

## Decisions

- Neutral rows are not cards: "No reviews yet", "Review requested" (reviews not required) and
  "No checks" say nothing the details do not. A checks row of only skipped checks goes on the
  passed card.
- The passed card shows titles only. The approvers are in the details' reviewers.
- Statuses the brief did not name keep their words and their quiet text: "Waiting on your
  review" (warning), "You can't merge this · read access" and "Checking mergeability" (no wash:
  neither says the pull request is or is not ready). "Waiting on checks · 3 running" and
  "Ready to merge · 1 optional check failing" keep the existing meta; the brief dropped only
  "N left" and the auto-merge method.
- Closed says only its age: the detail has no "closed by".
- The draft's card is "Still a draft" (the header already says Draft).
- Reviewers show on merged and closed pull requests when there are any (who reviewed it is
  history), without the picker.
- One face per reviewer per width: the strip's avatar has the tooltip (the name is hidden
  there); the side column's avatar and name carry none. The container query swaps the two, so a
  hidden one is never hovered, and the `pr-reviewer` element stays one per reviewer.
- The ⋯ button no longer spins for a revert: the header's Revert does, and the menu has no
  Revert.
- Short panes: the surface scrolls inside the panel's box, so a height container query on it
  has nothing to measure (size containment would also turn its overflow into ink overflow and
  stop the box scrolling). `useShortPane` watches the scroll box with a ResizeObserver and sets
  `data-short` under 480px; the header's padding reads it through `group-data-short/pr`.
- While the detail is on its way the header shows the seeded words (merged, closed) or a bar,
  bars for the buttons, and Overview the seeded cards; the details wait for the detail.

## Gotchas

- The status line's wrap: the words are `flex: 0 1 auto`, the buttons' box `flex: 1 1 auto`
  with `justify-content: end`. A flex item breaks to a new line by its content width, so the
  buttons move under the words only when they do not fit beside them, and on a line of their
  own too narrow for both (280px) they wrap among themselves.
- A card's button under its text below 480px is `basis: calc(100% - 24px)` with its 24px
  margin; `basis-full` plus the margin overflowed the card by 24px.
- Playwright's `toContainText` reads `textContent`, which includes `display: none` text; the
  reviewer name checks use `useInnerText`.
- `pr-stale-first.spec.ts` scrolled to 240px: with the shorter header that is inside the
  timeline, and the new comment at its top moved it by scroll anchoring. It scrolls to 80px,
  inside the header.
