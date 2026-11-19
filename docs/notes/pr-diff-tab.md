# A pull request's diff in a tab of its own

The pull request page is losing its inline Code tab: a Diff button on the page opens the diff
in a tab of its own, beside the pull request's, so the diff gets the whole pane and the Diff
tab's viewer. This change builds that tab and the function the button will call
(`openPullRequestDiff`, `stores/prDiffPanel.ts`). The page and its Code tab are unchanged; a
later change swaps the Code tab for the button and adds Review to the tab's bar.

## Files

| Path | What |
| --- | --- |
| `internal/layout/identity.go` | kind `prdiff`: linked or not, one per space and pull request, key `prdiff:<slug lower>#<n>`; `prKey` shared with `pullrequest` |
| `gui/frontend/src/shell/identity.ts`, `shell/drag/outerFrac.ts` | the port of that kind and its size (0.45, floor 480, as `pullrequest`) |
| `src/surfaces/prDiffTarget.ts` | the tab: params `{ slug, number, path? }`, title `Diff #N`, id from the lower-case slug |
| `src/surfaces/prdiff.ts` | the surface: hidden from lists, no letter, no default tab |
| `src/stores/prDiffPanel.ts` | `openPullRequestDiff(ref, target?, opts?)` |
| `src/components/diff/PrDiffView.tsx` | the tab body |
| `src/components/diff/prDiff.ts` | GitHub's parsed diff as the Diff tab's file rows and counts |

## Decisions

- **Its own layout kind, not a `pullrequest` or `diff` tab with another param.** Identity is
  per kind: a `pullrequest` tab with a `view` param would be the pull request's own tab, and a
  `diff` tab needs a project and a checkout, which a pull request opened from the Pull Requests
  page does not have. `prdiff` is keyed like `pullrequest` (case-insensitive slug and number),
  so `Acme/App` and `acme/app` are one tab, and the file shown never changes which tab it is.
- **Open or focus.** An open diff tab for that pull request is shown where it is, as it is: its
  file and its slug's spelling kept (the open tab is what is passed to `openTab`, as
  `panelPullRequestTab` does). Otherwise it goes into the pane of the pull request's tab,
  after the tab that pane shows, which is the pull request's when the button is pressed on it.
  For a thread's tabs the daemon would put it there anyway; from the Pull Requests page the
  focused pane is the page's, and the test for that case fails without the pane.
- **No command.** Opening a surface's tab goes through the host seam everywhere today
  (`openPullRequestInPanel`, `openCheckoutDiff`), not through `internal/command`; this follows
  them. A thread can still reach the pull request through `view.open.pr`.
- **The Diff tab's viewer, fed from GitHub.** The library's `FileDiff` takes the parsed patch
  (`FileDiffMetadata`) and a `loadDiffFiles`, so `CodeDiff` gained a third input,
  `{ fileDiff, loadDiffFiles }`, and `DiffFile`'s code box (`DiffCode`: virtualized past 400
  rows, top line kept across a resize) takes any input. The file list is the Diff tab's own
  `FileList`: same rows, keys, keyboard, filter past 20 files, "N of M" and the steps. It reads
  only counts and lengths, typed now as `ListedView`, which a pull request's diff fills
  (`prDiff.ts`). The file header is the File and Diff tabs' `FileHeader`. Nothing needs a
  checkout, so any pull request shows.
- **One file at a time, as the Diff tab.** The Code tab drew every file in one scroll; this is
  the Diff tab's model, the file shown kept in the tab's params (the first until one is
  picked, then that one, so a push that sorts a file above it moves nothing). A file a push took
  out of the diff stays on screen saying so.
- **Hunks expand without a checkout.** As in the Code tab, expanding reads the head commit's
  copy once (`pullRequestFileLoader`, moved to `stores/prDiff.ts` and shared) and rebuilds the
  old side from it (`oldFromNew`).
- **The bar.** `base ← head` (truncating first), then the files control with the counts, then
  Unified | Split (the Diff tab's `StyleSwitch`), then the Review slot. At 680px of the tab's own
  width and wider (`PR_RAIL_MIN`) the list is a column on the left; narrower the files control is
  the only list, a popover holding the same `FileList`. The control stays at both widths, as in
  the sketch. The column's head drops its own counts (`totals={false}`): the bar shows them.
- **The Review slot** is `PrDiffView`'s `review` prop, drawn at the bar's right end in
  `pr-diff-review-slot`; nothing passes it yet.
- **Data as the Code tab had it.** The detail is watched (it re-reads on a push and every 60 s
  while shown); the diff is read only once the detail has loaded, so the daemon's cached diff
  answers; `syncPullRequestDiff` re-reads it once per new head; Refresh fetches from GitHub.
  States: loading, too large (with Open on GitHub), failed (with Retry), no files, cut at 4 MiB
  (with Open on GitHub), and a refresh that failed over the diff shown. They use the Diff tab's
  state components rather than the Code tab's banners.

## Differences from the sketch (v11, Diff tab)

- The column is the Diff tab's, 260px, with its head row ("1 of 3" and previous and next): the
  same list as the Diff tab, not a second one.
- The file's header is the Diff tab's two-line-high header (name, directory, wrap, copy path,
  Open on GitHub, Refresh), not the sketch's thin sticky row. Wrap and Refresh moved there from
  the Code tab's strip, as the Diff tab has them.
- One file at a time, as above.
- No Review button: a later change fills the slot.

## Gotchas

- A component test whose fake read never settles leaves it in flight in the resource's module
  state, and the next test's read of the same key never starts. The loading test's fake rejects
  when its signal aborts.
- The popover fades in: the e2e screenshot of the files menu waits for its animations to finish,
  or the header shows through it.
