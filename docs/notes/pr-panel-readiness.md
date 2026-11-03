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

- Freshness (`detailFresh`): the daemon now marks the cached copy it serves after a failed
  fetch (`PullRequestDetail.fetch_failed`, never stored). `lastError` alone could not tell:
  a fresh fetch whose checks page failed sets it too, and a stale copy can carry a stored
  `checksTruncated`. A stale copy may predate `autoMergeAllowed`: for it the footer offers
  no Auto-merge and the Merge menu has no "Auto-merge is off" note. The stale banner, the
  ⋯ menu's "last fetch failed" and the check list's truncation reason read the flag too.
  Every other detail was fetched on this read (the daemon refetches rows read back from
  SQLite before serving them), so `false` there is the repository's setting.
- GitHub's merge state decides what blocks. CLEAN, UNSTABLE (a check that is not required
  fails) and HAS_HOOKS mean GitHub merges now (`mergeableNow`): every row stays with its
  tone but none blocks, and the headline is "Ready to merge" with the rows' short forms as
  its meta ("1 optional check failing · 1 running · 1 unresolved conversation"). Only
  BLOCKED, BEHIND, DIRTY, DRAFT or UNKNOWN let check, review and conversation rows count
  in "N left". A failing check row keeps its `task` when it does not block, so D2 can
  still offer "Fix in …" for optional checks.
- Not every check fetched (`checksTruncated`, over the page limit or a failed page): the
  counts are the larger of the rollup's and the list's per state, the title is
  "120+ checks" with the counts after it, and "All N checks passed" only when the rollup
  (which sees every check) says success.
- Approved with reviewers still requested (a code-owner team, say): the row adds "Still
  waiting on …"; under BLOCKED it turns pending and blocks, as that is GitHub's reason.
  An approval with commits after it says "· on an older commit", as the reviewers row does.
- Review ▾ shows for write access or when the viewer's own review is requested (GitHub
  takes reviews from read access too; the daemon does not refuse them). Approve and
  Request changes still follow `disabledVerdicts` (not on your own pull request).
- A team's review request never makes "Your review is requested": the detail has no team
  membership, so a viewer asked only through a team sees the team in "Waiting on …".
- BEHIND now blocks Merge (`mergeAvailability`): GitHub reports BEHIND only when branch
  protection requires up-to-date branches, and then refuses the merge. The old note
  ("Behind main: it merges as is") is gone, as is the "Auto-merge is on" note (the footer
  shows Cancel auto-merge instead of Merge then).
- Auto-merge is offered for an open, non-draft, non-conflicting pull request whose merge
  state is BLOCKED or BEHIND, to a viewer with write access, on a fresh detail of a
  repository that allows it. Otherwise Merge stays (disabled when GitHub would refuse).
- The split button's default method is the one last used in the repository (merge or
  auto-merge, from the menu or the main part), else squash when allowed, else the first
  allowed. It is remembered only once the command succeeds: a declined confirmation or a
  refusal leaves the default alone. Choosing a method in a menu runs it at once, as
  before; the daemon confirms.
- A blocked Merge is the neutral control, not green (it is not the next step), at the
  app's disabled opacity on both parts (Button's `disabled:opacity-50`), so beside Review ▾
  it reads as disabled. Its main part stays focusable with the reason as its tooltip and
  the first line of its menu; the chevron still opens.
- Review ▾ is the primary button while the viewer's review is requested (re-requested
  too: it then says Review, not "You approved").
- Your review requested blocks (counts in "N left") only when reviews are required.
- The headline's order: auto-merge on, waiting on your review, you can't merge (read
  access), then with nothing blocking: checking mergeability (mergeable and merge state
  both unknown, GitHub computing after a push; no "No conflicts" row, Merge as GitHub
  allows), else ready; waiting on checks (running checks are the only blocker); not
  ready · N left.
- The detail has no "closed by", so a closed pull request's row says "Closed 3d ago".
- A workflow waiting for approval is a check with conclusion action_required, status
  waiting, or a pending check whose description mentions approval. Approve on GitHub opens
  the check's URL, else the pull request's. GitHub's real shape for a first-time
  contributor's run was not checked against a live pull request.
- The Code tab's box is `compact`: no rows, the headline and the footer (Review ▾, Merge /
  Auto-merge / Cancel) on one line, the controls wrapping under the headline when the
  panel is too narrow (one line from about 520px; two at the default 420px, 66px tall).
  With the whole box above it the diff had no height left at 800px; compact, the diff
  starts about 335px down. Overview and Activity show it whole.
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

- The description fades by measuring its content's `offsetHeight` against 170px (+24px
  slack, so a description just over the fold is not cut by a line). The ResizeObserver
  watches the Markdown's own box, not the clipped wrapper: folded, the wrapper stays at
  170px whatever its content does, so a body edited down to 170-194px never unfolded.
  jsdom has no layout, so its tests stub `offsetHeight` (and ResizeObserver for the shrink).
- A conversation's file name is focusable when its tooltip holds the full path (hidden
  information), so the keyboard reaches it; a top-level file has no tooltip.
- Menu items that start a busy state close the menu themselves before running (the
  controlled `open && !busy` would otherwise reopen it when the work ends), as the old
  merge menu did; `SplitButton` hands its children a `close`.
- The mock's avatars (avatars.example.com) never load in the headless browser, so faces
  show as broken images in local renders; real GitHub avatars load.

## Verification

- vitest: `readiness.test.ts` (every state, table-driven, with UNSTABLE, CLEAN + running
  checks, CLEAN + unresolved conversations, HAS_HOOKS, truncated checks, checking
  mergeability; rows in detail; freshness; approval detection), `review.test.ts` (Review
  for a requested read-access viewer), `prPanel.test.ts` (the default method only after
  success), `merge.test.ts` (behind blocks; default method),
  `PullRequestSurface.test.tsx` (the box per fixture, Ready for review → `pr.ready`,
  Convert to draft → `pr.draft`, Auto-merge with a method and the head → confirm →
  `pr.auto-merge`, Cancel → `--off`, the repository note and the stale copy, Link to this
  thread → `thread.pr.link` and its conditions, the split merge, the description fade,
  primary Review, Approve on GitHub, the Code tab's compact box with its controls, a
  declined merge or auto-merge keeping the default, the blocked Merge's opacity, a read
  access reviewer's verdicts).
- Go: `internal/store/gh` (a failed refresh serves the copy with `FetchFailed`, a good one
  clears it, a restart's SQLite copy too), `internal/api` (the field mapped).
- e2e (`e2e/pr-panel.spec.ts`): every fixture at 360, 420 and 560px (nothing overflows the
  surface or the box, footer buttons never overlap, a row's button sits under its text),
  280px, the merge menu inside the panel, the Code tab's compact box on one line at 560px
  and two at 420/360 with the diff keeping the height; `pr-code` and `linkedprs` updated.
- Driven against the mock (`make drive`): every state at 360/420/560 in dark and light.
