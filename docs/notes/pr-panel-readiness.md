# PR panel redesign, PR D1: layout A and the readiness box

The Pull request surface rebuilt to layout "A": a header, a readiness box listing every
blocker with its own action and Review ▾ + Merge (or Auto-merge) in its footer, then the
tabs Overview / Activity / Code. Builds on the daemon actions of #498 (`pr.ready`,
`pr.draft`, `pr.auto-merge`, `thread.pr.link`). The thread-task buttons on the issue rows
are PR D2.

## What shipped

- `components/pr/readiness.ts`: a pure model from the detail, the viewer, freshness and
  the clock to `{ headline, rows[], footer }`. Table-tested in `readiness.test.ts`. Rows in
  order: draft, checks (or "N workflows waiting for approval" for runs a maintainer must
  approve), reviews (your review requested; changes requested; approved; review required;
  no reviews yet), unresolved conversations, conflicts / behind / no conflicts, and a
  "Blocked by branch protection" fallback. Merged and closed get their end-state row (and
  closed the checks as last seen) and no footer.
- Each issue row carries `task` (pr.task's kind: checks, review, conversations, conflicts,
  behind, review-request), rendered as `data-task` on the row and nothing else: D2 puts
  its "Fix/Address/Resolve/Update/Review in …" buttons there.
- `ReadinessBox.tsx` renders it; `PrHeader.tsx` is the new header; `PrOverview.tsx`
  (was `PrSummary.tsx`) is the Overview body; `PrChecks.tsx` the full check list the
  checks row unfolds to (per panel tab, `open.checks`).
- `SplitButton.tsx` is the footer's split button: `MergeButton` (main part merges with
  the default method, chevron menu with every method, the delete-branch box and the
  notes) and `AutoMergeButton` (zap; `pr.auto-merge --method … --head-sha`). Cancel
  auto-merge is a plain button (`--off`).
- Store (`stores/prPanel.ts`): `setPullRequestDraft`, `setAutoMerge` (busy in `changing`
  until the re-read lands, like a review), `linkPullRequestToThread`, and
  `mergeMethods`, the method last chosen per repository (in memory).
- ⋯ menu: Convert to draft (open, not a draft, write access or the author) and Link to
  this thread (the selection is a thread whose linked pull requests do not include this
  one, slug compared ignoring case; gone once the daemon publishes the link).
- Mock: fixtures #160 (changes requested + threads), #161 (conflicts), #162 (BEHIND),
  #163 (checks running, approved), #164 (auto-merge on); the same in `src/test/prWorld.ts`
  with handlers for the new commands. The mock's merge is refused while BEHIND.

## Decisions

- Freshness (`detailFresh`): a detail with `lastError` set and `checksTruncated` false is
  the cached copy served after a failed fetch, and may predate `autoMergeAllowed`. For it
  the footer offers no Auto-merge and the Merge menu has no "Auto-merge is off" note.
  Every other detail was fetched on this read (the daemon refetches rows read back from
  SQLite before serving them), so `false` there is the repository's setting.
- BEHIND now blocks Merge (`mergeAvailability`): GitHub reports BEHIND only when branch
  protection requires up-to-date branches, and then refuses the merge. The old note
  ("Behind main: it merges as is") is gone, as is the "Auto-merge is on" note (the footer
  shows Cancel auto-merge instead of Merge then).
- Auto-merge is offered for an open, non-draft, non-conflicting pull request whose merge
  state is BLOCKED or BEHIND, to a viewer with write access, on a fresh detail of a
  repository that allows it. Otherwise Merge stays (disabled when GitHub would refuse).
- The split button's default method is the one last chosen in the repository (merge or
  auto-merge, from the menu or the main part), else squash when allowed, else the first
  allowed. Choosing a method in a menu runs it at once, as before; the daemon confirms.
- A blocked Merge is greyed (the neutral control), not a dimmed green: it is not the next
  step. Its reason is the tooltip and the first line of its menu; the chevron still opens.
- Review ▾ is the primary button while the viewer's review is requested (re-requested
  too: it then says Review, not "You approved").
- Your review requested blocks (counts in "N left") only when reviews are required.
- The headline's order: auto-merge on, waiting on your review, you can't merge (read
  access), ready, checking mergeability (both unknown), waiting on checks (running checks
  are the only blocker), not ready · N left.
- The detail has no "closed by", so a closed pull request's row says "Closed 3d ago".
- A workflow waiting for approval is a check with conclusion action_required, status
  waiting, or a pending check whose description mentions approval. Approve on GitHub opens
  the check's URL, else the pull request's. GitHub's real shape for a first-time
  contributor's run was not checked against a live pull request.
- The Code tab keeps only the box's headline (`compact`): with the whole box above it the
  diff had no height left at 800px. Overview and Activity show it whole.
- The review composer opens under the box (below Review ▾), the Ask composer stays under
  the header (below ⋯). With the review composer under the header, opening it pushed the
  box down; the Review menu, still fading out, slid under a pointer that had not moved,
  WebKit's synthetic mouse move focused one of its items, and focus fell to the body when
  the menu unmounted (the 280px e2e test failed about half its runs). Nothing above a
  menu's button may move when its item opens something.
- Merged and closed pull requests' Overview has no Reviewers row (the renders), only
  labels when any.
- Inner tab ids are now `overview` / `activity` / `code` (store and test ids).
- `--cf-success-foreground` moved from THEMES.md's pages-only slots to the live ones: the
  Merge button's label reads it.

## Gotchas

- The description fades by measuring `scrollHeight` against 170px (+24px slack, so a
  description just over the fold is not cut by a line); jsdom has no layout, so its test
  stubs `scrollHeight`.
- Menu items that start a busy state close the menu themselves before running (the
  controlled `open && !busy` would otherwise reopen it when the work ends), as the old
  merge menu did; `SplitButton` hands its children a `close`.
- The mock's avatars (avatars.example.com) never load in the headless browser, so faces
  show as broken images in local renders; real GitHub avatars load.

## Verification

- vitest: `readiness.test.ts` (every state, table-driven; rows in detail; freshness;
  approval detection), `merge.test.ts` (behind blocks; default method),
  `PullRequestSurface.test.tsx` (the box per fixture, Ready for review → `pr.ready`,
  Convert to draft → `pr.draft`, Auto-merge with a method and the head → confirm →
  `pr.auto-merge`, Cancel → `--off`, the repository note and the stale copy, Link to this
  thread → `thread.pr.link` and its conditions, the split merge, the description fade,
  primary Review, Approve on GitHub, the Code tab's compact box).
- e2e (`e2e/pr-panel.spec.ts`): every fixture at 360, 420 and 560px (nothing overflows the
  surface or the box, footer buttons never overlap, a row's button sits under its text),
  280px, the merge menu inside the panel; `pr-code` and `linkedprs` updated.
- Driven against the mock (`make drive`): every state at 360/420/560 in dark and light.
