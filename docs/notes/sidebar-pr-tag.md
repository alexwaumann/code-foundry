# Sidebar PR tag: state and number instead of "1 PR"

Status: branch `cf/sidebar-pr-tag`. GUI only: no daemon, proto or command change. The
behaviour was agreed with Alex before the build (2026-10-19).

## What landed

| Path | What |
|---|---|
| `gui/frontend/src/components/sidebar/linkedPrTag.ts` | pure: `linkedPrState`, `linkedPrTone`, `fresher`, `findLinkedPr`, `linkedPrTag` (exclusion, one vs many, worst-state tone), `linkedPrTagText`, `linkedPrTip` |
| `gui/frontend/src/components/sidebar/useLinkedPrs.ts` | `useLinkedPrsDashboard` (one dashboard watch for the list), `useLinkKeys`, `useLinkedPrFacts` (narrow selectors over the gh resources) |
| `gui/frontend/src/components/sidebar/LinkedPrsBadge.tsx` | the chip, moved out of `SidebarRow.tsx`, with its `Tip` |
| `gui/frontend/src/components/sidebar/SidebarRow.tsx` | uses the chip; the row tooltip stays shut over a badge that has its own `Tip` |
| `gui/frontend/src/components/sidebar/Sidebar.tsx` | `SidebarList` calls `useLinkedPrsDashboard` |
| `gui/frontend/e2e/linkedprs.spec.ts` | new tag expectations, a states test, `SHOTS=<dir>` sidebar shots |

## Behaviour

* Closed pull requests are left out: they neither count nor show. A thread whose links
  are all closed has no tag.
* One left: the state icon (`prs/prState` `prStateLook`, the thread header's icons) and
  the bare number, `142`, no `#`. Open green, draft muted with the draft icon, merged
  violet with the merge icon; colours are `pr/tones` `toneText` for the
  `pr/model` `stateBadge` tone, the PR surface header's. The chip keeps its old tint
  shape (`bg-<tone>/15`, hover `/30`) so it sits beside the workspace badge unchanged.
* Two or more: "3 PRs", coloured by the worst state: any draft, else any open, else
  merged when all are.
* Unknown: a linked pull request the GUI has not read is counted. Alone, it shows its
  number in the neutral tone with the generic pull-request icon. In a count, unknown
  ones never make it green or merged on their own: open or draft ones still decide, and
  a count of merged and unknown ones only is neutral (not "all merged").
* Superseded by docs/notes/sidebar-pr-tag-plus.md (2026-10-31): several show as the worst one +N, no tooltip, click opens PR tabs.
* Click unchanged: opens the Linked PRs surface for the thread and goes on to the row,
  which selects it.
* Tooltip (`Tip`, right side, so it never covers the rows below): one PR says its state
  and title ("Open · feat(gui): …"; "State unknown · #147" without a title); several list
  "#142 · Open" per line, newest first like the surface, at most five then "+N more" (the
  sidebar's tooltip cap, `TipWaiting`). The row's own tooltip does not open while the
  pointer is on a `[data-tip]` inside the row, and closes when it moves onto one, so the
  two never show together.

## Where the state comes from (and why some PRs read unknown)

Nothing new is fetched per row. `useLinkedPrFacts` reads, with selectors that return the
stores' own `PullRequestView` objects (so a row re-renders only when one of its pull
requests is re-read):

1. `pullRequestDetailResource` entries: the cached detail the Linked PRs surface, the
   thread header (one linked PR) and PR tabs read. The resource never evicts, so a PR
   once opened stays known for the session.
2. The viewer's `tracked` dashboard (`dashboardResource`): authored open PRs, review
   requested, reviewed, merged in the last 7 days. `SidebarList` watches it while any
   thread has links: one watch for the whole list, a daemon cache read on each
   `dashboard` event, the same key the composer's `#` reads.
3. Any branch's list already read (`branchPullRequestsResource`, any state).

The freshest read by `updatedAtMs` wins (detail first on a tie). Partial poll entries are
skipped, as in the composer's pool.

Rejected: watching `pullRequestDetailResource` per row. It re-reads every 60 s while
watched and a stale daemon entry costs one GraphQL request each, so a sidebar with 30
linked PRs would spend ~1800 requests an hour on chips.

Gotcha, by design: a closed PR, or one merged more than 7 days ago, is on no dashboard, so
it reads unknown (and counts) until something reads its detail: opening the thread
(its header reads a single linked PR's detail) or its Linked PRs list. Then it drops out
or turns merged. The e2e test shows this with #131 (closed, on no dashboard): "4 PRs",
then "3 PRs" after the list opens. Without gh (not authenticated, dashboards disabled)
everything reads unknown and the chip is neutral; that is the old count's information.

## Sizes

The chip stays one `text-caption-sm` line (16px) with a 12px icon on the name line (22px),
so `rowSizes.ts` is unchanged. "142" with its icon is a few px wider than "1 PR"; the
name truncates first (the badges are `shrink-0`), no wrap at the default width (shots).

## Verification

* `make check` green.
* Unit: `linkedPrTag.test.ts` (table: exclusion, single vs count, worst-state tone,
  unknown, tooltip cap, `fresher`, `findLinkedPr`); `SidebarRow.test.tsx` (no tag when all
  closed, one open/draft/merged with icon and colour, unknown neutral, count with a closed
  one left out, fresher detail over dashboard, re-render on a state move).
* e2e (`linkedprs.spec.ts`, WebKit, mock): the states test above plus the existing
  badge tests with the new text.
* Screenshots: the Playwright mock (`SHOTS=<dir> pnpm exec playwright test
  e2e/linkedprs.spec.ts -g "sidebar tag screenshots"`). A scratch daemon would need
  Claude transcripts with pr-link records pointing at real PRs in open, draft, merged and
  closed states, so the mock was used; the frontend is the same build.
