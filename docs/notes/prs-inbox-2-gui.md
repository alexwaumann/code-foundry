# PRs page as an inbox, PR 2: the page

PR 1 (`prs-inbox-1-daemon.md`) made `GetDashboard` list every repository and added each
latest review's commit. This PR rebuilds the Pull Requests page on it: the viewer's review
inbox first, their own pull requests with what each needs, merges, then the charts.

## What changed

* The page always shows every repository. Gone: the scope button, the page-local store,
  the `a` key (and its help overlay line), the "no registered project has a GitHub remote"
  banner, `prs-scope` / `prs-show-all`. `getDashboard()` no longer takes
  `includeUntracked`; the request sends nothing (the daemon ignores the field anyway).
* Order (one `max-w-6xl` column): **Needs your review** (table, or Ember's inbox-zero card;
  the "Reviewed by you" sub-card under either), **Your open pull requests**, **Merged in
  the last 7 days**, then `ActivityCharts`. Headings carry no hint text.
* Keyboard order is page order: needs, reviewed, authored, merged. Nav keys are
  `review:`, `reviewed:`, `authored:`, `merged:` + `slug#number`. Enter/click opens the
  side panel, cmd+Enter/cmd+click GitHub, as before.
* Sidebar: `PullRequestsNav` shows an amber count of the pull requests that need review
  (hidden at 0 and before the dashboard loads), with the Tip "N pull requests need your
  review". Its selector returns a number, so the row re-renders only when the count does.
* One dashboard key for everyone: `DASHBOARD_KEY = "all"` in `stores/gh.ts`, used by the
  page, the sidebar, the composer's `#` pool and the pages bridge's `gh` source. The
  sidebar's watch (`useSidebarDashboard`, in `SidebarShown`) is now unconditional: it
  used to watch only while a thread had linked PRs, and the count needs it always. It
  selects nothing, so it costs the sidebar no renders; `SidebarList` no longer subscribes
  to "does any thread have linked PRs".
* `view.pullrequests`' description no longer says "across registered projects".
* `pr_detail_decode.go`: the PR panel's per-reviewer `stale` now matches the page (below).

## The rules as implemented

`prs/reviewQueue.ts` splits `reviewRequested` + `reviewed`:

* every PR in `reviewRequested` needs review. Why: "Requested · via team" when its known
  `reviewRequests` do not name the viewer (case-insensitive); "Requested" otherwise,
  including when the requests are unknown (a partial row, summary-only).
* a PR only in `reviewed` (deduped by slug#number; requested wins): find the viewer's
  latest review. None: reviewed, "You commented". Its `commitSha` differs from `headSha`
  (an empty `commitSha` included): needs, "Re-review · new commits". Dismissed: needs,
  "Re-review · review dismissed" (the commit check comes first). Else reviewed with the
  verdict: approved, changes requested, anything else (commented, pending) "You commented".
* an empty `headSha` (partial row) never makes a review stale.
* both lists sort by `updatedAtMs` desc, unknown last, stable.

Empty `commitSha` = stale, a change from DESIGN.md decided after PR 1: PR 1 heals old
caches by refetching, so an empty commit now means GitHub has no commit for the review,
which happens when a force-push dropped the reviewed commit. The panel's `Reviewer.Stale`
followed suit: `HeadRefOid != "" && (commit == nil || commit.oid != HeadRefOid)` (it was
"non-nil commit on another oid"). Table case added in `pr_detail_decode_test.go`.

`prs/authoredStatus.ts`, first match wins: Conflicts (mergeable conflicting or merge
state dirty), CI failing (failed > 0 or rollup failure/error), Changes requested, Behind
base, Blocked, Draft, Awaiting review · N (N pending requests, decision not approved),
No reviewers (no requests, no latest reviews, decision review required or none), CI
running, Ready to merge (approved or no decision, merge state clean / has_hooks /
unstable). Fallback "Open" (neutral) when none applies, e.g. GitHub has not computed the
merge state yet, or a required review where someone only commented.

* **Blocked is narrowed.** GitHub reports BLOCKED for a draft, for a missing required
  review and for required checks still running. Taken literally, rule 5 would turn nearly
  every awaiting-review PR in a protected repo into "Blocked" and Awaiting review / No
  reviewers / CI running would rarely show. So Blocked needs BLOCKED and not draft, not
  `review_required`, and no checks running; the others then read as their own status.
* Sort: ranks 1-5 (action needed) first in rank order, then everything else by
  `updatedAtMs` desc. Comments column: `comments + reviews`, plain count.

`prs/emberLine.ts`: the five rules of DESIGN.md in order. Counts are words up to ten
("Three of yours ...", "You merged two this week."), digits above. "Teammates owe you a
review" counts distinct pending requests (logins and teams) across the Awaiting-review
PRs. The quiet line rotates by local day of year; `InboxZero` reads the day through
`useNowSelect`, so it re-renders once a day at most. The title is always "Nothing
waiting on you". Meant to be replaced by a model call.

Merged rows sort by `mergedAtMs` desc in the page: the daemon's search is
`sort:updated-desc`, which put a PR merged 6 days ago above one merged 3 days ago.

## Look

Layout B and the Ember motif of the sketch. Tables share column templates, so the
reviewed sub-card (no header row, rows `opacity-60`, full on hover or under the cursor)
lines up under the queue. The `#` column is 5rem (4rem clipped five-digit numbers into
the author). Status pills are filled (`statusPill` in `pr/tones.ts`: error, warning,
success surfaces, neutral sunken), `rounded-sm`, `text-caption font-medium`, stretched to
the column like the sketch. Inbox zero: `Flame` size hero, state idle, decorative; title
`text-title`, line `text-body-sm` muted. The sketch's "Ember:" prefix on the line was
dropped: the spec's lines are full sentences.

## Gotchas

* Test ids: `pr-comments` and `pr-status`-style ids already exist in the PR panel; the
  page's cells use `prs-why`, `prs-verdict`, `prs-status`, `prs-comments`. The reviewed
  sub-card sits inside the `prs-review` section, so e2e selects rows by nav-key prefix.
* `tooltips.test.ts` had an allowlist entry for the old `PrTable`'s `title` prop; removed.
* `CODE_FOUNDRY_GH_SEARCH_AS` changes the searches, not the viewer: the dashboard's viewer
  stays the token's account. With `mitchellh` the lists are his, but "the viewer's
  review" is looked up as the token owner's, so every reviewed row reads "You commented"
  and every request "via team". For the populated screenshots the page's viewer was
  overridden to `mitchellh` by a local, uncommitted edit (not in this PR).
* The mock daemon (`mock/github.ts`) no longer filters to tracked repositories, matching
  the daemon. Fixtures gained `reviewRequests` and `latestReviews` with commits: #139
  requested by name, other-org/lib#77 via a team, ghostty-playground#14 reviewed on an
  older commit (stale), #133 approved on the head, other-org/lib#81 changes requested on
  the head. `POST /__mock/gh/inbox-zero` empties the queue.

## Verified

* `make check` green; `make gui-e2e` green (WebKit, 4 workers).
* Unit tables: `reviewQueue.test.ts`, `authoredStatus.test.ts`, `emberLine.test.ts`.
* e2e `prs.spec.ts`: section order and charts last, no scope button, needs rows and why
  (including the stale fixture), reviewed verdicts, authored status pills in sort order,
  the comments count, merged across repositories, keyboard order across the four lists,
  the sidebar pill and its tooltip before the page opens, inbox zero (card, idle flame,
  "#142 is approved and green" line, reviewed rows kept, pill gone) and one
  `GetDashboard` read per change shared by page and sidebar.
* Live: `make build`, a dev daemon on an isolated `CODE_FOUNDRY_HOME` with
  `CODE_FOUNDRY_GH_SEARCH_AS=mitchellh` (authored 5, requested 50, reviewed 19, merged
  14; 61 needing review, with several "Re-review · new commits" and stale reviews whose
  commit GitHub dropped, e.g. ghostty#12881), and the browser dev frontend (Vite, WebKit
  via Playwright) against it: the page, the lower sections and the sidebar pill with its
  tooltip, dark and light. Then a second isolated daemon on the owner's account (no
  review requests): the inbox-zero card with "Nothing to review. One of yours needs a
  hand, though." (a scratch repo PR with failing CI), dark and light. Not checked in the
  Wails window itself: nothing here touches the window chrome or drag regions.
