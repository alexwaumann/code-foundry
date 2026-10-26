# PRs page as an inbox, PR 1: daemon + proto

The Pull Requests page becomes the viewer's review inbox across GitHub. The gh store
already fetches its lists viewer-wide (authored, review requested, reviewed by, merged in
7 days; `internal/store/gh/poll_query.go`). This PR is the daemon side. PR 2 rebuilds the
page on it.

## What changed

* `GetDashboard` no longer filters authored / review_requested / reviewed /
  recently_merged to tracked repositories. Every list is returned in full.
  `include_untracked` (field 1) is kept for wire compatibility, ignored, and marked
  deprecated in its comment ("Deprecated:" makes staticcheck flag Go uses of it as
  SA1019; the one deliberate use, in `gh_activity_test.go`, carries a `lint:ignore`).
  `tracked_slugs` (field 9) is still filled in: the projects' repositories, which the
  lists are no longer limited to. `GetRepoActivity` (per repository) is unchanged.
* `PullRequestReview.commit_sha` (field 4): the head commit a latest review was
  submitted on. GraphQL: `commit { oid }` added to `latestReviews` in the
  `PullRequestDetail` fragment, so the poll's detail fetch and `GetPullRequest` both
  get it. Store: `gh.Review.CommitSHA` (`commitSha` in the cached JSON). TS:
  `ReviewEntryView.commitSha: string` in `gui/frontend/src/api/gh.ts`.
* Merged and closed PRs are fetched with the summary only, so they have no latest
  reviews and nothing changes for them. `partial` is unaffected.
* The dashboard searches no longer wait for a tracked repository. With
  `github.dashboards_enabled` on, they run at the normal interval even with no project
  (`planPoll` in `poll.go`). The poll is "idle" (the viewer alone, every
  `IdleInterval`, 10 min) only when dashboards are off and nothing is tracked or
  watched. That is `isIdle`, shared by `planPoll` and `PresenceChanged`. The monthly
  stats still need a tracked repository (`statsDue`), unchanged: the page's charts stay
  empty for a user with no project. `gh-viewer-polling.md` and `gh-poll-tiers.md` say
  so now.
* Wording: the pages skill's `gh` source (`reference/sources.md`) now says the lists
  are the user's PRs in any repository; the PLAN.md known issue about filtering at
  read time is updated.

## Old caches

The cache is JSON, so there is no migration and no cache version bump (a bump would
drop the stats and the whole dashboard too). A row written before this change decodes
with `commitSha` empty (`TestCacheReviewCommits`). An empty commit cannot mean "unknown"
for long, though: PR 2's stale rule would count every such review as stale. So the
store records `PullRequest.ReviewCommits` ("these latest reviews were fetched with
their commits"), and `needsDetail` refetches an open PR that has latest reviews but not
the marker. That is one detail fetch per such PR on the first poll after the upgrade,
and none after it.

A marker rather than "any review with an empty commit" because GitHub really does
return `commit: null` for some reviews. In the live check (below) 10 of 51 latest
reviews had no commit: old reviews on PRs whose reviewed commit has been force-pushed
away, e.g. ghostty-org/ghostty#12881. Refetching on an empty commit would refetch those
PRs on every poll.

## The stale rule PR 2 uses

A PR in the viewer's inbox needs their review when any of these holds:

1. a review request for the viewer is pending (it is in `review_requested`), or
2. the viewer's latest review has `commit_sha != head_sha` (the head moved since they
   reviewed), or
3. the viewer's latest review is `DISMISSED`.

A comment-only review (`COMMENTED`) on the current head counts as reviewed.

An empty `commit_sha` counts as "not on the head", so it is stale. After the heal
above, empty means GitHub has no commit for the review, which in practice means the
reviewed commit was force-pushed away, so it is no longer the head. The detail panel's
own rule (`pr_detail_decode.go`, `Reviewer.Stale`) treats a null commit as not stale.
The two differ only on these reviews. That was left alone here: PR 2 can pick one rule
for both if it wants them to match.

## Re-fetch when a review changes: confirmed, nothing to do

A detail fetch happens when the fingerprint's `updatedAt`, state, or head moves
(`needsDetail` in `poll.go`; rules in `docs/notes/gh-viewer-polling.md`). Submitting a
review bumps the PR's `updatedAt` (that note already relies on this for
`reviewDecision`). A push moves the head, which refetches the detail. The reviews keep
their old commit, so they show as stale against the new head. Dismissals were not
exercised live; a dismissal is a timeline event and bumps `updatedAt` like a review.

## Gotchas for PR 2

* A signed-in user with no projects now polls GitHub every interval (4 searches plus
  details), where before it polled only the viewer every 10 minutes. Turning dashboards
  off restores the old cadence.
* Until PR 2 lands, the current page's "tracked only" view gets the full lists, since
  the daemon no longer filters. Accepted: the GUI and daemon always ship together.
* The e2e mock daemon (`gui/frontend/mock/github.ts` `getDashboard`) still filters on
  `includeUntracked`. Making it mirror the daemon breaks `e2e/prs.spec.ts` ("three
  sections filtered to registered projects"), which belongs to the page PR 2 rewrites.
  So the mock change goes in PR 2 together with that spec.
* `searchFirst` / 50 per list is unchanged: a busy viewer's review_requested list can
  be capped at 50 (mitchellh's was exactly 50).

## Verified

* `make check` green.
* Unit tests: `TestDecodeDetailsReviewCommits` decodes a real capture
  (`testdata/pull_request_details_reviews.json`, 2026-10-26, ghostty-org/ghostty #14815
  stale CHANGES_REQUESTED + APPROVED, #14693 review on the head, #14318 two stale, plus
  a merged #14588), plus a `commit: null` node. `TestNeedsDetail` gains the
  reviews-without-commits cases (open refetches, merged does not, marked does not).
  `TestCacheReviewCommits` covers the old-row decode and the round trip.
  `TestGhDashboardListsEveryRepository` replaces the tracked-filter test and checks
  `commit_sha` on the wire. The fake GitHub renders review commits.
  `TestPollDashboardsWithNothingTracked` checks both cases with no repository tracked:
  dashboards on gives filled lists at the poll interval, off gives the viewer alone at
  the idle interval. `TestPresenceChangedDashboardsNotIdle` checks that a rise with
  nothing tracked polls soon. The branch-watch and track tests now expect the dashboard
  searches in a poll with nothing tracked.
* End to end: a scratch daemon (`CODE_FOUNDRY_HOME=/tmp/…`,
  `CODE_FOUNDRY_GH_SEARCH_AS=mitchellh`, one project tracked: alexwaumann/code-foundry),
  `GhService/GetDashboard` called as Connect JSON over the unix socket with curl.
  authored 5 (4 repos), review_requested 50, reviewed 19 (3 repos), recently_merged 14.
  None are in the tracked repository, so before this change all four lists would have
  been empty. `include_untracked: true` returned the same counts. Of 51 latest reviews,
  41 had `commitSha` and 24 of those were on an older commit than the head. The other
  10 have no commit on GitHub (checked with `gh api graphql`).
* No projects: a scratch daemon (`CODE_FOUNDRY_HOME=$(mktemp -d)`, the real account,
  `project.list` says "no projects"). Its first poll ran the 4 dashboard searches
  (`searches=4 default_branches=0`, 57 details). GetDashboard returned authored 7 and
  recently_merged 50 across 3 repositories, with no tracked slugs. Before this change
  that poll had `searches=0` and the lists were empty.
* Old-cache heal: stopped the daemon, stripped `commitSha` and `reviewCommits` from the
  cached dashboard row in SQLite, and restarted it. GetDashboard served 51 reviews with
  0 commits. The next poll fetched details for exactly the 38 open PRs with reviews and
  restored 41 commits. The poll after that fetched 0 details.
