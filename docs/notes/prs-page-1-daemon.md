# PRs page rethink, PR 1: project-wide lists in the daemon

The Pull Requests page gets two awareness lists over every tracked repository (every
project with a GitHub remote): "everything else open" and "merged in the last 7 days".
This PR is the daemon, proto, view model and mock side. PR 2 builds the page on it.

## What changed

* `internal/store/gh/poll_projects.go`: one GraphQL request per poll cycle
  (`query PollProjects`), two searches across all tracked repositories at once:
  * open: `is:pr is:open archived:false repo:A repo:B … -author:L -reviewed-by:L
    -review-requested:L sort:updated-desc`
  * merged: `is:pr is:merged merged:>=SINCE repo:A repo:B … sort:updated-desc`, SINCE
    being the same `recentlyMergedWindow` cut the dashboard's merged search uses.

  L is `searchLogin()` (`@me`, or `Options.SearchAs`). Both queries are GraphQL
  variables. `first: 50` each (`searchFirstProjectOpen`/`Merged`), halved on a 502/504
  through the dashboard's `shrinkSearches` (sticky, floor 10). A renamed repository is
  searched under its `CanonicalSlug`, because search does not follow renames.
* The document is `pollPlan.build` with `projects: true`, sections only, so it reuses
  the fingerprint fragments, `decodePoll`, `needsDetail`, `fetchDetails` and the new
  shared `resolveFingerprints`. The open list uses `PullRequestFingerprint` (checks)
  and the merged list uses `PullRequestIdentity`. Details reuse what the dashboards,
  watched branches and the previous project lists hold, so only moved PRs are fetched.
  The first fetch of 100 PRs took about 22s live. Later cycles took about 3s.
* Cadence: `applyPoll` calls `pollProjects` after its own snapshot, events and cache
  writes, and before `Polled`. It shares the poll's tiers (60s foreground, slower in
  the background or with no GUI) and runs whether or not the page is open. It is
  skipped, and the lists cleared, when nothing is tracked or `dashboards_enabled` is
  off. If the dashboard poll fails, the projects request does not run that cycle.
* State: `Snapshot.Projects` (`ProjectPullRequests{Open, Merged ProjectList; FetchedAt;
  LastError}`), not inside `Dashboard`. `knownPullRequests`, `CachedPullRequests`,
  `prChanges`, `mergedShown` and the stats all read `Dashboard` or the branch lists, so
  none of them sees the new lists. They do not feed `PullRequestChanged`, wakes, linked
  PR branch matching, the needs-review count or the stats. `TestPollProjects` pins
  this.
* Mergeability rechecks (`s.recheck`, for PRs GitHub reports as UNKNOWN) have one owner
  per PR. The dashboard poll owns those its lists or the branch lists hold. For those,
  `pollProjects` refetches only when the fingerprint says so
  (`fingerprintNeedsDetail`), and puts their recheck counts back after its fetch.
  Without that, the two requests shared the counter: if GitHub settled between the two
  detail fetches, the projects fetch consumed the recheck, and the dashboard's copy
  (which the project list then reused) stayed UNKNOWN until the PR moved again
  (`TestPollProjectsLeaveDashboardRechecks`). The rechecks of project-only PRs are
  `pollProjects`' own, and the poll's cleanup keeps them.
* Cache: gh_activity rows `"projects"` (the lists, written when they change) and
  `"projects_fetched"` (the fetch time and the merged queries, written every cycle,
  like the poll row). These are only new keys in the existing key/value table, so no
  migration is needed (schema.sql's comment lists them). On load, a newer
  `projects_fetched` row moves the fetch time and the merged `merged:>=` window forward.
  This matters because the first cycle after a restart does not run right away: a
  recent poll row makes it wait out the interval (`store.go`, `pollNext`). Without the
  second row, `projects_fetched_at` and the merged search URL's date would read stale
  for that interval.
* Events: `DashboardUpdated` goes out when the lists, totals, open query or error
  change. A fetch time alone does not send it, and neither does the merged query, whose
  `merged:>=` moves every cycle. Like the dashboard's own fetch time, the projects'
  fetch time and error travel in `Polled` (`projects_fetched_at`,
  `projects_last_error`), which is sent after the projects request. Without that, the
  page's "older of the two fetch times" would go stale whenever the lists did not
  change. A cycle that clears the lists (dashboards turned off) sends two
  `DashboardUpdated`, one for the dashboard and one for the projects.
* Proto: `ProjectPullRequests {pull_requests, total_count, search_url}`, plus
  `GetDashboardResponse.project_open` (12), `project_merged` (13),
  `projects_fetched_at` (14) and `projects_last_error` (15), and
  `GhEvent.Polled.projects_fetched_at` (3) and `projects_last_error` (4).
  `search_url` is `https://github.com/search?q=<QueryEscape(webQuery)>&type=pullrequests`,
  where `webQuery` is the API query with its repositories as an OR group (see Gotchas).
  The API maps renamed repositories back to the tracked slug (`localRepos`), as it does
  for the dashboard lists.
* GUI (src/api only): `DashboardView.projectOpen`, `projectMerged`
  (`ProjectPullRequestsView {pullRequests, totalCount, searchUrl}`),
  `projectsFetchedAtMs` and `projectsLastError`. The polled `GhEventView` gains
  `projectsFetchedAtMs` and `projectsLastError`. No component changed. The pages
  skill's `gh` source lists the new keys, because pages receive the whole
  DashboardView.
* Mock: `projectOpen` and `projectMerged` for alexwaumann/code-foundry and
  ghostty-playground, and `POST /__mock/gh/project-merged-capped[?shown=3&total=64]`.
  `src/test/prWorld.ts` mirrors the lists for vitest.

## The diff column

Every table can show +additions/−deletions. Open PRs get them from `PullRequestDetail`.
Merged ones get them from `PullRequestSummary` (the closed half of
`PullRequestDetails`). The merged searches select only identity, but every merged PR
still goes through the detail fetch, and that fetch carries additions and deletions.
The live check showed this: 50 of 50 recently merged, 14 of 14 project merged and 50 of
50 project open had them. A `partial` placeholder (detail fetch pending or failed) has
none until the next poll fills it in. A PR with 0/0 omits both fields in proto JSON;
that is a zero value, not a missing one.

## Gotchas

* **Search type ISSUE, never ISSUE_ADVANCED.** ISSUE ORs repeated `repo:` qualifiers.
  ISSUE_ADVANCED ANDs them and silently returns 0. Re-checked live on 2026-11-02: the
  merged search over cli/cli and junegunn/fzf returned 14 with ISSUE and 0 with
  ISSUE_ADVANCED. The dashboard's merged section uses ISSUE_ADVANCED for its
  parenthesised OR; do not copy that. `TestProjectSections` and `TestProjectsDocument`
  pin ISSUE.
* **search_url needs an OR group.** github.com's web search uses the advanced syntax,
  which ANDs repeated `repo:` qualifiers just as ISSUE_ADVANCED does. The URL's query
  therefore groups them: `(repo:a OR repo:b …)`, or a plain `repo:a` for one
  repository. Checked live with ISSUE_ADVANCED: the open search over cli/cli and
  junegunn/fzf with the group and the three exclusions returned 116, the same as the
  ISSUE search, while ungrouped it returned 0. The API query stays on ISSUE with
  repeated qualifiers. `ProjectList` keeps both (`Query`, `WebQuery`). The mock and
  prWorld build the URL the same way.
* A `repo:` naming a missing repository is ignored when another one in the query is
  valid (checked live), so one bad tracked repository does not empty the lists.
* Negated qualifiers are filters, not boolean operators, so they are fine under ISSUE.
  `-review-requested:` can lag GitHub's index, so a row can also be in the dashboard's
  review list. PR 2's page drops such duplicates.
* The fake runner's `opsSince` skips `PollProjects`, because most poll tests pin the
  dashboard poll's requests, and a cycle's projects request can fall on either side of
  the mark. `countSince` and `docSince` count and read it where it matters.

## Verification

* `make check` green.
* Live: daemon from this branch with an isolated `CODE_FOUNDRY_HOME`, cli/cli and
  junegunn/fzf cloned under home and added with `project add --path`. GetDashboard over
  the Unix socket returned project_open with 50 shown of `total_count` 116 (the same
  count as a direct `gh api graphql` search), project_merged with 14 of 14, both search
  URLs, and `projects_fetched_at` set. The polled event carried `projectsFetchedAt`. A
  `GhService.Refresh` ran a second cycle (projects about 3s after the poll). After a
  restart the lists came back from the cache.
