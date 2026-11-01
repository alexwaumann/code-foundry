# e2e → vitest: pull request surfaces

Part of the e2e → vitest series (docs/notes/e2e-unit-duplicates.md, e2e-vitest-surfaces.md,
e2e-vitest-projects.md). Area: the Pull request surface in the side panel (pr-panel.spec.ts,
the suite's most expensive file), the Pull Requests page (prs.spec.ts), the Code tab
(pr-code.spec.ts), linked PR tags (linkedprs.spec.ts), `#` tags in the composer
(composer-prs.spec.ts) and buttons.spec.ts. 38 audited e2e tests, ~131 s measured on the
dev server before #467.

## What moved

The PR surface had no component tests (only pure helpers and stores). New:

* `src/components/pr/PullRequestSurface.test.tsx` (23): the surface in the real `SidePanel`,
  with the confirm dialog and a sonner Toaster. Summary (#145's header, reviewers, markdown
  description, checks failed first with tones, comments newest first with threads, the order
  toggle, links through view.open.url); #140, #131 and an unknown number; Timeline (entries,
  kinds, order, commit link, counts, inner tabs per panel tab, a closed tab starting fresh);
  the reviewer picker (requests and recents, search from 2 characters, Matches/Requested,
  pr.review.request in both directions, ×, recents across reopening, "jane doe", the refused
  request's toast); the ⋯ menu (items, hints, Refresh and a failed one, Copy link, Open on
  GitHub); Revert (confirm, both invokes, the new tab, the toast) and declining it; Explain,
  Fix findings, Ask from a thread and from the page, a failed ask, the shared busy state across
  a thread's panel and the page; the merge button (methods, delete-branch note, confirm text,
  args with the head, draft/read-only/merged, unchecking, declining, the spinner, a refusal, a
  fork's branch); Review ▾ (menu, verdict hints, cmd+Enter, the chip, the reviewer entry, the
  review in Comments, Request changes waiting for text, switching verdicts keeping the text,
  Escape into the panel, Ask and Review sharing the slot, an unconfirmed review, the viewer's
  own PR with the reasons' tooltips, the composer closing when the PR is merged meanwhile).
* `src/components/prs/PullRequestsPage.test.tsx` (4): the page's sections, order, pills,
  verdicts and charts; the sidebar's count (before the page opens) and its tooltip, inbox
  zero with Ember's line, one dashboard read per change shared by the page and the sidebar;
  keyboard order, Enter/click into the panel, cmd+Enter/cmd+click to GitHub; gh events
  (dashboard re-read, a failed poll's red header without a re-read, a quiet poll).
* `src/components/pr/PrCode.test.tsx` (2): the Code tab's file list and its fold, the diff read
  again once when the detail's head moves and on refresh, the too-large notice and its link.
  `@pierre/diffs/react`'s CodeView is stubbed (it needs a real browser).
* `src/components/compose/usePrSource.test.tsx` (3): `#` with two projects lists both
  repositories with the repository as the hint; the card draws the hint.
* `src/components/sidebar/SidebarStatus.test.tsx` (2): Settings toggles and shows pressed,
  Help opens its overlay, the palette button opens the palette without invoking anything.
* Added to existing tests: `SidebarRow.test.tsx` (a later detail read drops a closed PR from
  the tag's count; details read later fill in the open card), `UserBubble.test.tsx` (the PR
  chip's state and tooltip), `ThreadParts.test.tsx` (the crumb's place is not a button).

Fixtures (shared, additive):

* `src/test/prWorld.ts`: the mock's pull requests as view models (the details of #145, #138,
  #131, #140, #142, #146, #139, the reviewer candidates with the daemon's search rank, the
  dashboard with its stats) and the pr.* commands changing them as the mock does (refresh,
  review requests, revert, merge, review with the write memo, ask/explain/fix). `failNext`
  is the mock's pr-fail; `hold(command)` replaces pr-delay with a gate the test releases, so no
  test waits on a clock. `prGhFakes` serves GetPullRequestDetail (NOT_FOUND marked like
  api/gh.ts), ListReviewerCandidates, GetDashboard (counted) and GetViewer. It does not import
  `mock/`.
* `src/test/prPanelHarness.tsx`: resets the PR stores, renders SidePanel + ConfirmDialog +
  Toaster with the Pull Requests page selected, and small helpers (openPr, prTabs, press,
  pick, toastTexts).

Product code: unchanged, nothing exported.

## e2e removed (26) and shortened (12)

Removed (each with a comment at its old spot): pr-panel's Summary, both reviewer picker
tests, Revert, declining it, #140/#131/unknown, Fix findings, Ask from the page, a failed ask,
running threads on every surface, the merge button's variants, #146, the Review composer, the
unconfirmed review, the viewer's own PR, the composer closing on merge (16); prs' page and
sidebar count, gh events (3); both pr-code tests (2); buttons' status row (1); composer-prs'
second project (1); linkedprs' "one PR" (merged into "several"), the tag's states and the card
(3).

Shortened to their browser part: Timeline (counts box before the order toggle at 420px, the
rail), the menu (shift+cmd+c through the keymap), closing a tab (cmd+w hides the panel),
Explain and Ask (the daemon's FocusThread selecting the new thread, the PR tab across routes),
#142 merges (the menu inside the panel, the dashboard moving the row), Review (left of Merge,
the menu inside the panel), prs' Enter (the list keeps focus), buttons' new-thread (picker to
the real editor to the new thread) and header (rename focus into the sidebar, fork through
cmd+k), composer-prs' bubble (picked and sent from the thread's real editor), linkedprs' tag
(the surface in the newly selected thread's panel, the prompt not focused).

SHOTS: every screenshot the removed tests took is still taken, by SHOTS-only tests
("summary", "reviewer picker", "merged pull request menu" in pr-panel; "page and inbox zero"
in prs) or inside the shortened tests behind `if (shots)`. Checked with SHOTS set: pr-panel's
16 shots, prs, linkedprs, composer-prs and pr-code's all written.

Time: the removed rows measured 88.6 s; the 12 shortened rows measured 42.6 s and now take
17.6 s on the bundled build (WebKit, one worker; not strictly comparable with the audit's
dev-server times). The new vitest files run in about 6 s together.

## Gotchas

* A Radix Tooltip on a trigger focused after a key (the popover's Escape returning focus)
  stays open as a dismissable layer, so the next Escape closes it instead of the popover.
  The picker test opens the popover with pointerdown then click, as a pointer does (Tip's
  press guard keeps the tooltip shut).
* The reviewer search's 250 ms pause runs on `vi.useFakeTimers({ shouldAdvanceTime: true })`
  and `advanceTimersByTimeAsync(260)`; `settle()`'s zero timeouts still run.
* In the "every surface" test the s-1 ask's release must land (wait for its toast) before the
  page's menu opens, or the composer's re-enabled state moves focus and shuts the menu.
* A tooltip on a span (the disabled review verdicts' reasons, the sidebar count) opens on
  pointermove after the provider's delay; `tooltipText` (focus) works only on focusable
  triggers.
* The mock controls gh/pr-delay, gh/pr-fail, gh/stale, gh/poll, gh/update and gh/pr-push have
  no e2e callers left. They stay for now.

## Rules that belong in Go, not here

Not moved (the GUI part, "shows the message", was): GitHub not adding a reviewer without
access (internal/store/gh/pr_detail_test.go), the merge refusing a moved head and keeping a
fork's branch (internal/store/gh/pr_merge_test.go, internal/api/gh_merge_test.go), the review
write memo answering the same text for 2 minutes (internal/store/gh/pr_review_test.go), the
merge confirmation's text (the fake reproduces the mock's wording only so the dialog shows it).
