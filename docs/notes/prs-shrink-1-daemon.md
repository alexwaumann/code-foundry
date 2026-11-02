# PRs tables shrink, PR 1: "Everything else open" covers the last month

The Pull Requests page's "Everything else open in your projects" list now holds only
open pull requests updated in the last month. An abandoned pull request in a tracked
repository drops off instead of filling the list. PR 2 makes the page's tables drop
columns as they narrow and groups the two awareness tables by repository.

## What changed

* `internal/store/gh/poll_projects.go`: the open search gains
  `updated:>=<now - projectOpenWindow>` (30 days). It applies to the API query and to
  the github.com query behind "See all on GitHub".
* The window moves with every fetch, like the merged search's `merged:>=`, so the open
  list's queries are handled like the merged ones. `sameProjects` ignores them, and the
  `projects_fetched` row now saves them too (`Open`, queries only), so a restart shows
  the last cycle's window. Rows written before this change have no `Open`, and `apply`
  then keeps the full row's query.
* Page copy: the section caption is "not yours, not waiting on you · updated in the last
  month", and the card subtitle is "in your projects, updated in the last month". The
  mock's search URL carries the window.

## Decisions

* The window is on updated, not created: a long-running pull request that is still
  active stays on the list.
* 30 days, not a calendar month: the cut is the same at any time of the month.

## Gotchas

* Verified live 2026-11-02: in a type ISSUE search, `updated:>=` composes with repeated
  `repo:` qualifiers (cli/cli + golang/go: 139 = 18 + 121).
* `TestPollProjectsCache` ran both cycles within one second on the real clock, so the
  queries never moved and the test could not see a missing `Open` in the fetched row.
  It now uses a clock it moves a minute between the cycles, and asserts that both
  queries moved.
