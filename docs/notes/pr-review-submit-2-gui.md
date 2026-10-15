# Pull request reviews and comments, 2: GUI

Status: Review ▾ in the PR panel header, the inline review composer, the "You approved"
chip, the mock daemon's review and comment writes, unit and e2e tests. `make check` is
green; `pr-panel.spec.ts` passes in WebKit and Chromium (31 each). Stacked on
`t3code/pr-review-1-daemon` (PR #120). Not run against real GitHub (no review was
posted).

Screenshots (dark | light, the mock's #139): `pr-review-submit-2-gui/review-menu.png`,
`review-approve.png`, `review-approved.png`.

## Pieces

| File | What |
|---|---|
| `components/pr/review.ts` | pure: `VERDICT_SPECS` (title, hint, label, tone, body required, empty hint, placeholder, own-PR reason), `canSubmit`, `composerHint`, `disabledVerdicts`, `reviewVisible`, `yourReview`, `reviewArgs` |
| `components/pr/reviewIcons.ts` | lucide icons per verdict and per "your review" (own file: react-refresh wants components-only modules) |
| `components/pr/ReviewButton.tsx` | the header's Review ▾ / chip and its shadcn DropdownMenu |
| `components/pr/PrReviewComposer.tsx` | the composer, modeled on `PrAskComposer` |
| `components/pr/keys.ts` | `composerKeyAction(e, "cmd-enter")` |
| `stores/prPanel.ts` | `submitReview` (pr.review), busy flag `reviewing` per pull request |
| `stores/gh.ts`, `api/gh.ts` | `viewerResource` / `useViewerLogin` over `GhService.GetViewer` |
| `PullRequestSurface.tsx` | one composer slot: `"ask" \| Verdict \| null` |
| `mock/prDetail.ts`, `mock/server.ts` | the two RPCs and the two commands; #139 fixture |

## Decisions

* **Viewer login.** The gh store had no viewer of its own (only the dashboard's
  `viewer`, which would mean reading the whole dashboard in every panel). Added
  `viewerResource` over `GetViewer`, a snapshot read with no GitHub call, re-read on the
  `viewer` event. `useViewerLogin()` returns only the login. Unknown viewer ("") means
  nothing is disabled: GitHub refuses and the toast says so.
* **Who sees Review.** Open pull requests (drafts too) with `viewerCanUpdate`, as the
  brief asked, mirroring the reviewer picker. Merged and closed get nothing (and so no
  chip). Note: on GitHub a read-access user can review a public repository's PR; hiding
  it on #140 follows the reviewer picker, not GitHub.
* **Own pull request.** `pullRequest.author` vs the viewer, case-insensitive. Approve and
  Request changes are Radix-`disabled` items with the normal hint and the reason as a
  `Tip` on a wrapping `span.grid` (disabled items have no pointer events, as the Code tab
  does). The tooltip carries the reason because the item does not show it.
* **Chip.** `yourReview` takes the viewer's (non-team) entry in `reviewers`, whose state
  is the latest review: APPROVED, CHANGES_REQUESTED, COMMENTED make the chip; none,
  PENDING (an unsubmitted draft on GitHub) and DISMISSED show Review. The chip is the
  same `DropdownMenuTrigger` (re-reviewing is allowed), tinted with `toneBadge`, no
  chevron (as the sketch), icon only below 340px. Its accessible name is its text.
* **Composer slot.** The surface keeps one `composer` state; Ask and the review composer
  replace each other. The review composer has a fixed React key, so switching verdicts
  re-renders it with the text kept; Ask ↔ Review remounts (fresh text). Choosing a
  verdict bumps the shared focus counter and the menu's `onCloseAutoFocus` is prevented
  for that select, so focus lands in the textarea (Ask's approach).
* **Keys.** `composerKeyAction` gained a `submit` mode. `"cmd-enter"`: only cmd+Enter
  (no shift/alt/ctrl) sends, Enter is a newline; Escape cancels; IME rules unchanged.
  Ask keeps `"enter"`.
* **Body.** Approve: optional, placeholder "Say why, or leave it empty…". Request changes
  and Comment: the submit button is disabled and the hint reads "Say what should change"
  / "Write a comment" until there is non-blank text; then "⌘⏎ submit · esc cancel".
  `reviewArgs` trims and omits an empty body. The daemon checks again (INVALID_ARGUMENT,
  65536 characters).
* **Submitting** goes through the registry: `runCommand("pr.review", …)` (not quiet, so
  the daemon's "Approved #139" is the success toast, like the reviewer picker's
  request). `submitReview` invalidates the detail and waits (`settled`) until it is read
  again, so the chip and the review in Comments are there when the composer closes.
  While it runs: the textarea is read-only, the hint says "Submitting…", Cancel and
  Escape do nothing, the submit button spins (`aria-busy`), and the header button is
  `aria-disabled` with a spinner and will not open (the review menu's `open && !busy`,
  as Merge). A second submit while one runs sends nothing. Failure: the generic
  "Review Pull Request failed" toast with the daemon's message; the text stays.
* **Approve tint.** Only the approve composer has a background (`bg-success/5`), per the
  sketch; its label and button are green. Request changes is red text and button,
  Comment the primary button.
* **`pr.comment`** stays CLI/palette only. The Comment item submits a COMMENT review, as
  GitHub's Review → Comment does.
* **Mock.** `submitReview`/`postComment` on `PrDetailWorld`, served as RPCs and as
  `pr.review`/`pr.comment` (results are protojson of the responses). A review appends a
  REVIEW comment by the viewer, moves the viewer's reviewer entry (request answered) to
  the front of the reviewed, bumps `updated_at` in place (the dashboard row shares it)
  and announces the detail. Own-PR approve / request changes: FAILED_PRECONDITION
  "failed precondition: Review Can not approve your own pull request" (and the
  request-changes variant). Bodies are checked like the daemon: trimmed, required except
  for approve, at most 65536 code points. It also mirrors the daemon's 2-minute write
  memo: the same write returns the first result, and after
  `POST /__mock/gh/pr-fail?command=pr.review` (unconfirmed, UNAVAILABLE) the same text
  gets that error until the window ends. `pr-delay` delays `pr.review`. Calls count as
  `SubmitPullRequestReview` / `AddPullRequestComment` in `/__mock/gh/calls`.
* **#139** now has a writable detail (`viewerCanUpdate`, permission write) with the
  viewer as a requested reviewer; before, its detail was built from the summary and
  read-only.

## Gotchas

* **The mock's command result must be protojson.** `JSON.stringify` of a response holding
  a protobuf `Timestamp` throws on its BigInt seconds; the write had already happened,
  so the e2e saw the chip but the command "failed" and the composer stayed open.
* **`title=` guard.** `src/lib/tooltips.test.ts` rejects `title=` on anything not in its
  `OWN_TITLE` list. `ReviewButton` reuses PrMenu's `Item`, whose `title` is the item's
  visible label, so the list gained `ReviewButton.tsx`/`Item`.
* **Retrying the same text after "may have been posted" gets the same error for 2
  minutes** (the daemon's memo, review fix 1 of part 1). The composer keeps the text; the
  user has to check GitHub or change the text. The e2e covers it.
* **Sonner toasts do not dismiss on click**; the e2e counts them instead.
* The dashboards still list #139 under "awaiting your review" after the review in the
  mock: the daemon polls soon after a review, the mock does not.

## Tests

* `review.test.ts`: verdict → title, label, tone, body required; `canSubmit`/
  `composerHint` table; `disabledVerdicts` (case-insensitive, unknown viewer);
  `reviewVisible`; `yourReview` (each state, pending, dismissed, team, other logins);
  `reviewArgs`; `composerKeyAction(…, "cmd-enter")` table.
* `prPanel.test.ts` `submitReview`: trimmed args, busy until the detail re-read lands, a
  second submit sends nothing, the success toast; an empty approval sends no body; a
  refusal toasts and re-reads.
* `pr-panel.spec.ts` (new): the #139 menu (left of Merge, hints, inside the panel),
  Approve composer, Enter newline, cmd+Enter submits, the recorded `pr.review` args and
  `SubmitPullRequestReview` count, toast, focus to the panel, the chip, reviewer entry
  and the review in Comments, the chip reopening the menu; Request changes blank cannot
  submit, verdict switch keeps the text, Escape, Ask ↔ Review; an unconfirmed review
  (read-only, spinner, toast, text kept, the same text refused again, other text posts);
  #145 disabled items with their tooltips and Comment posting, GitHub's refusal from
  the command; #140 and #138 without Review; 280px (button icon-only, menu and composer
  fit, chip icon-only). The existing 280px test also opens the review menu on #145.

Runs (2026-10-15): `make check` green (Go vet/staticcheck/race tests, tsc, eslint,
vitest 148 files / 2971 tests). `playwright test e2e/pr-panel.spec.ts --project=webkit`
31 passed; `--project=chromium` 31 passed.
