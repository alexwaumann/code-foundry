# Opening a pull request with nothing cached

Status: PR 2 of 3 on "PRs load really slow", reported by a user. PR 1 (`pr-detail-stale-first.md`)
made any cached copy answer at once; a pull request with no copy still waits 1.5 to 6.8 s at the
daemon. This PR does not shorten that wait, it changes what the wait looks like and starts it
sooner. Next: user jobs ahead of the poll (`cf/pr-queue-priority`).

## What changed

* **Seeded view.** With no detail, the surface paints from the row the GUI already holds: the
  dashboard's six lists or any branch list on screen, the freshest by `updatedAtMs`
  (`freshestRow`). The header is complete. The box shows what the detail would show too, through
  `readiness()` itself on a `seedDetail`, so the two cannot drift. The rest is bars: the verdict,
  the footer's controls, the body. No row at all, or only a partial one: the old skeleton.
* **Nothing can be pressed.** `seedReadiness` drops every row's action and task, the footer is
  bars, the ⋯ menu is a placeholder of the same size, and `data-seeded` marks the surface. Open on
  GitHub stays: it is a link and needs nothing. The tabs work; the body stays bars until the detail.
* **Prefetch** (`stores/prPrefetch.ts`). A 150 ms dwell of the pointer on a row of the PRs page's
  tables, the sidebar's linked PR tag or a thread info PR row, or of the keyboard cursor on the
  page, reads the detail. One dwell runs at a time, so a fast sweep cancels itself. Two at once, 8
  a minute, and past either it drops rather than queues. Nothing for a key with data or a read in
  flight, nothing while the poll reports an error, and a failed prefetch stops them all for 60 s.
* **Diff.** `useDiffWarm` reads the diff 600 ms after a current detail lands, only for the surface
  on screen, and waits while any detail read is in flight. Nothing behind a `refreshing` copy (its
  head may be about to go), after `fetchFailed`, for a diff already read for this head, or for one
  that failed. The tab's own read is the daemon's memory by then.
* **`abortOnRelease`** on the detail and the diff, with `readOnce` beside `watch`, and `abandon` in
  the daemon's queue. See Decisions: the option alone would have done nothing.
* **The tag.** A click on the sidebar's tag reads the shown pull request first and still opens its
  tab last, so it stays the active one.

## Decisions

* **`abortOnRelease` was right only with a daemon change.** `submit` left a cancelled reader's job
  in the queue and it ran anyway, so aborting freed nothing. `abandon` now takes the reader off and
  drops a read nobody waits for. It is opt-in (`submitRead`: the detail and the diff) because
  `submitFunc` also carries merges, reviews and reverts, which must run once asked for.
* **`watch(key)()` is banned on the detail now.** With `abortOnRelease` it aborts its own read at
  once, which is what the tag's read and a prefetch built the same way would have done. `readOnce`
  is that pattern with the watch held until the read ends. A test pins why.
* **A background refresh joining a queued read pins it** (`q.read = false`): a client was told
  `refreshing` and is owed the event. The reverse, a reader abandoning a background job it
  promoted, leaves it promoted: rare, one request, and it keeps the code small.
* **No verdict on an open seed.** "Ready to merge", "You can't merge this" and "Auto-merge on" need
  write access, auto-merge and the unresolved conversations, none of them in a row. Bars instead:
  a green headline turning amber is the jarring case. Merged and closed are settled, so theirs show.
* **"Blocked by branch protection" is dropped.** It is what remains once every other reason is ruled
  out, and the conversations cannot be yet.
* **A row without `mergeState` shows no review or mergeability rows.** A summary-only row from an old
  cache would otherwise claim "No reviews yet".
* **A stale row still shows.** Rows are at most a poll old in normal use, and the flip when the
  detail lands (Open to Merged, 2 running to all passed) reads as an update. Hiding rows by age was
  more code for a rare case; only the actions could mislead, and they wait.
* **A row that leaves its list during the wait stays** (`useSeedRow` keeps it, checked against the
  key), or a landing poll would swap a painted header for a skeleton.
* **A failed detail keeps the seed** with "Could not load the rest" and "Readiness unknown", and no
  bars left pulsing. Not found still wins: the row is the thing that is out of date.
* **`headerAges` omits the closing time when unknown** instead of "closed —". Only a seed lacks it.
* **Low priority is GUI-side.** A daemon-side class for the diff needs a proto field, in the queue
  another PR is changing. Waiting for the detail reads to drain plus the abort covers the case of
  a diff ahead of the next pull request, unless the diff has already started.
* **The thread info rows are wired but do nothing today.** The card watches every linked detail, so
  each is warm or in flight by the time a pointer gets there.

## Verified, and not

* `make drive` (mock, WebKit) with the detail delayed 5 to 12 s: #142 painted seeded with no button
  in the box and no ⋯ menu, landed in place with Merge and the menu, then one diff read; a real
  hover on #139 sent one detail read.
* e2e: a sweep, a resting pointer, rows scrolling under a still pointer.
* Go: `TestAbandon`, `TestAbandonedReadSendsNothing` (fails with `abandon` removed).
* Not run: the built Wails GUI, a real daemon or GitHub, a real rate limit, the wait timed against
  a real fetch. The rate-limit cases are the poll's `lastError` and a failed read, faked.

## Gotchas

* `E2E_MOCK_PORT` is a base: each worker takes the next port, so `E2E_VITE_PORT` must not sit just
  above it or Playwright says it is in use.
* `playwright cli click` waits for the read it started, so a delayed seed is gone by the next
  command: click from `eval`.
* `pr-panel.spec.ts`'s `reviewer picker (screenshots)` (`SHOTS` only) fails on main too: not this.
* Mock detail fixtures may have an empty `headSha`; a detail with none never warms a diff.

## Tests

* `seed.test.ts`, `PullRequestSurface.seed.test.tsx` (reads held at a gate), `prPrefetch.test.ts`,
  `resource.test.ts`, `PullRequestsPage.test.tsx`, `SidebarRow.test.tsx`.
* `e2e/pr-open-instant.spec.ts`: the real pointer only (plus the SHOTS screenshots). The mock's
  `gh/pr-detail-delay` drives it.
