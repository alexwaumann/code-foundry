# PRs page rethink, PR 2: the page

PR 1 (prs-page-1-daemon.md) added the project-wide lists. This PR builds the Pull
Requests page on them. Everything is in `gui/frontend/src/components/prs/`. No daemon
change.

## Layout, top to bottom

1. **Charts, half height.** `ActivityCharts` H goes from 170 to 92. Every gridline stays,
   but the y axis labels only 0 and the top tick (`labelledTicks`). The current, partial
   month gets a value label beside its hollow marker, as well as the newest closed month
   (`labelledIndexes`; the partial label carries `data-partial`). The hover and the single
   tooltip are unchanged.
2. **Five summary cards** (`SummaryCards.tsx`): Needs your review, Reviewed by you, Your
   pull requests, Everything else open, Merged · 7 days. Each card has a label
   (text-label, muted), a count (text-display-sm, in the warning colour when something
   needs review) and one truncated text-caption subtitle. Clicking a card shows only its
   section. The selected card gets a ring and the others drop to 50% opacity. A second
   click, or Escape anywhere on the page, shows everything again. Clicking puts focus back
   on the list, so j/k keep working. A card whose section has no rows is muted and
   disabled. Below 640px of container width (side panel open) the cards wrap three to a
   row.
3. **Sections**: Needs your review, Reviewed by you, Your open pull requests, Everything
   else open in your projects, Merged in the last 7 days. A section with no rows is not
   rendered. When every section is empty, one muted line says "No open pull requests, and
   nothing merged this week."

Ember (`InboxZero.tsx`, `emberLine.ts` and its test) is gone from the page. The Flame
component is untouched. The mock's `gh/inbox-zero` control stays: it now hides the review
section.

## Model (`pageModel.ts`, pure, table-tested)

* **Everything else**: `projectOpen` minus anything in reviewRequested, reviewed or
  authored, plus repeats, deduped by lower-case slug + number, newest updated first. The
  daemon's search already negates those lists, but GitHub's index can lag.
* **Status for someone else's PR** (`otherStatus`): `authoredStatus` with the same kinds,
  icons and labels (Conflicts, CI failing, Changes requested, Behind base, Blocked, Draft,
  Awaiting review · N, No reviewers, CI running, Open). The one difference is `ready`:
  "Approved" when the review decision is approved, and "Mergeable" when the repository
  requires no review. "Ready to merge" is an author's call, so the authored table keeps it
  for the viewer's own PRs.
* **Merged**: the union of `recentlyMerged`, which marks a row as involving the viewer
  and covers any repository, and `projectMerged`. Deduped (the involving copy wins), newest
  merge first. Rows only in the project list are dimmed, with the same quiet class as
  reviewed rows.
* **Counts with caps.** A list is capped when `pullRequests.length < totalCount`. The
  cap's hidden part is `totalCount - shown`.
  * Everything else = rows + hidden. Beyond the cap, the search's negations already left
    out the viewer's own PRs.
  * Merged: involving = rows from recentlyMerged. More = project-only rows + hidden −
    the viewer's merges in a tracked repository (`trackedSlugs`) that the capped list did
    not return. GitHub counted those in its total, and they are already counted as
    involving. Then clamp at 0. Never fewer than the rows shown.
* **Card subtitles.** Needs review is "N requested · M re-review": requested and
  requested_team count as requested, new_commits and dismissed as re-review, and a zero
  part is dropped. At 0 it reads "nothing waiting on you". Yours shows two status counts
  at most. The **order is a decision**: statuses that need the author (rank ≤ 5, worst
  first) come first, then ready to merge, then the ones waiting on others. So the mock
  reads "1 CI failing · 1 ready to merge". Plain worst-first would have dropped "ready to
  merge" for "awaiting review", which tells the author nothing. Merged reads "N involving
  you · M more". The section title says "… more in your projects". "nothing this week"
  at 0.
* **Filter auto-clear** (`liveFilter`): a filter whose section has no rows is dropped
  while rendering (`setPicked(null)`, the "adjust state on change" pattern, not an
  effect). It stays dropped when the section refills.
* **Freshness** (`olderFreshness`): the header shows the older of the dashboard's and
  the project lists' fetch times. The project time counts only once it is non-null, so a
  daemon with nothing tracked shows the dashboard's. The error shown is the dashboard's,
  else the projects'. `usePollStore` now keeps the polled event's `projectsFetchedAtMs` /
  `projectsLastError`, and `useProjectsFreshness` mirrors `useFreshness` for them.

## Tables

Every table has a header row. "Reviewed by you" is its own section now, with Repository,
#, Author, Title, Your review, Checks, Diff, Age. Review, reviewed and everything else
share one grid template, so their columns line up down the page. Every table has a Diff
column just before Age or Merged. It shows `+a −d` in text-code, tabular, with grouped
thousands, in the success and error text tokens. It is empty for a `partial` row (0/0 is a
real zero and shows). A section whose project list is capped (`pullRequests.length <
totalCount`) ends with "Showing X of Y · See all on GitHub", which opens `searchUrl`
through `openUrl`. X and Y are the section's own numbers: the rows it shows and the count
its title and card give. The project search's own numbers are not used, because the merged
table is a union. With the merged list capped at 3 of 64, for example, the table shows 5
rows and the title says 65, so the footer reads "Showing 5 of 65".

Keyboard order is the order of the visible sections. A filter limits it to one section.

## Mock

The project-open #146 and #131 clashed with mock/prDetail.ts's fork and closed fixtures,
so they are renumbered #149 and #144 in mock/github.ts and src/test/prWorld.ts.

## Gotchas

* A long merged list (more than 60 rows, which happened live: 50 involving + 14) is
  virtualized by `RowList` inside its 520px scroll box, like any long section before.
* The Diff column's floor (4.5rem) adds to the tables' minimum width. Beside the side
  panel the tables were already wider than the page, and they still are.
* The `role="listbox"` (focus on mount, `aria-activedescendant`, `useNav`'s keys) wraps
  the sections only. The banners, charts and cards sit outside it. Each cap footer is a
  `NavRow` option (`cap:<section>`) after its section's rows, not a button: j/k reach it,
  and Enter, click and cmd+click open the search. No button is left inside the listbox.
* Escape is handled on the wrapper around the whole body, so it works from the list or a
  card. It is skipped when `defaultPrevented`: an open Radix tooltip or menu takes the
  first Escape, and the second one clears the filter.

## Verification

* vitest: `pageModel.test.ts` (status labels, dedupe, merged union and counts capped and
  uncapped, subtitles, cards, liveFilter, olderFreshness), `activity.test.ts`
  (labelledIndexes, labelledTicks), `ActivityCharts.test.tsx` (0/top ticks, current month
  label), `PullRequestsPage.test.tsx` (order, headers, Diff, dimming, hidden sections,
  inbox zero with no Ember, the empty line, card filter + Escape + keyboard + auto-clear,
  cap footer + link, the older-of-two header), `stores/gh.test.ts`.
* e2e (`prs.spec.ts`): the card row's geometry (one row under the charts, which are less
  than 100px; three a row beside the side panel, none clipped), and a capped list arriving
  over the gh stream with its footer.
* Live: `make gui-build` and an isolated `CODE_FOUNDRY_HOME` with cli/cli and
  junegunn/fzf added as projects. 116 others open (50 shown, capped footer), merged
  64 = 50 involving + 14 more, and the card filter on Merged. Theme switched through the
  isolated home's settings.
