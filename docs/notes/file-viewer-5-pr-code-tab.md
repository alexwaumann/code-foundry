# File viewer 5: the PR panel's Code tab

PR 5 of 5 of the file viewer (1: daemon RPCs, 2: code foundation, 3: File and Diff panel
tabs, 4: path chips, 5: this). Frontend only. The pull request panel's third inner tab,
Code, was a disabled stub; it now shows the pull request's diff: a strip, a foldable
file list, and every file in one virtualized `CodeView` from `@pierre/diffs`.

## Files

| Path | What |
| --- | --- |
| `src/api/prDiff.ts` | `getPullRequestDiff` → `PullRequestDiffView`, `getPullRequestFile` → `PullRequestFileView` (UTF-8 decoded); GitHub's refusal (FAILED_PRECONDITION) is marked so `isTooLargeMessage` can tell it apart |
| `src/api/gh.ts` | `PullRequestView.headRepoSlug` (proto `head_repo_slug`, already in the poll and the full query) |
| `src/stores/prDiff.ts` | `pullRequestDiffResource` (key `pullRequestKey`), `refreshPullRequestDiff`, `syncPullRequestDiff` (re-read on a new head), `readPullRequestFile`, `expandFailed` |
| `src/stores/prPanel.ts` | `PrInnerTab` gains `code`; `PrSection` gains `files` (the list's fold, per panel tab) |
| `src/components/pr/diffModel.ts` | `parsePrDiff` (library `parsePatchFiles` → `PrDiffFile` rows), `oldFromNew`, `prFileLoader` |
| `src/components/pr/PrCode.tsx` | the tab: `Strip`, `Notice`, `FileList`, `FileHeader`, `Diff` |
| `mock/prDiff.ts` | a three-file diff (rename, binary, a four-hunk change) for every pull request; #140 refused as too large; `POST /__mock/gh/pr-push` moves a head |
| `e2e/pr-code.spec.ts` | open, list, diff, split, row scroll, expansion, head move, refresh, too large |

## Loading

- The tab mounts only once the detail has loaded (the surface renders a skeleton before
  that), so the daemon's diff cache, keyed by the cached detail's head, applies on the
  first read.
- `pullRequestDiffResource` has no keep-alive. The tab selects the detail's `headSha`
  narrowly and, when it differs from the diff's `headSha`, invalidates the diff once per
  new head (`syncPullRequestDiff` remembers the head it asked for, so a daemon whose
  detail has not moved yet cannot start a loop). The gh store already re-reads the detail
  on `pull_request_detail_updated` and every 60 s while shown, so a push reaches the tab
  through the head.
- Refresh (the strip's button) calls with `refresh=true` and writes the result into the
  resource; a failure keeps the diff and shows "Could not refresh: …".
- Parsing is client-side (`parsePatchFiles`, about 2 ms for #171's 84 KB), memoized per
  read. Binary files are found by git's `Binary files a/x and b/x differ` line (the
  library parses them as hunk-less changes or additions).
- In development and e2e, StrictMode's double mount can read the diff twice (the
  resource re-runs a fetch watched again while in flight); production reads once.

## Layout

- The Code tab makes the surface fill the panel body (`min-h-0 flex-1`): the header and
  the inner tab bar stay, the strip and the file list sit under them, and the diff takes
  the rest and scrolls itself (the CodeView is its own scroll container).
- Strip: the file list's toggle with "N files · +a −d", then Unified | Split (the
  Usage page's `Segmented`), the wrap toggle and refresh (icon buttons with tooltips,
  since their meaning is hidden). Both choices are the codeView store's, so they apply to
  the thread's diffs too.
- File list: the worktree panel's Changes row (status letter coloured A green, M amber,
  D red, R blue; directory muted, truncating from its start; + and − columns; "bin"),
  but as buttons that scroll the diff to that file (`scrollTo({ type: "item", align:
  "start" })`). 7.5 rows, then it scrolls. Folded per panel tab.
- Notices (warning tone, like the surface's stale banner) with "Open on GitHub", which
  opens the pull request's Files page through `openUrl`: GitHub refusing the diff
  ("too large"), and the daemon's 4 MiB cut ("showing its first N files").

## Our own file headers, not the library's

Tried the library's sticky header first (`disableFileHeader: false`). It is themed and
reads fine, but it shows `-0 +0` on binaries and pure renames, counts deletions before
additions with hyphens, and its rename row truncates both paths. `renderCustomHeader`
keeps the library's sticky positioning (`stickyHeaders: true`) with our row inside: fold
chevron, the status letter, the path as the list draws it (old path in the tooltip for a
rename), then `+a −d`, `binary`, or "N lines · Show file" for a folded long file. 36 px
tall; `itemMetrics.diffHeaderHeight` says so, and `itemMetrics.lineHeight` is 19 to
match code.css (in scroll mode the CodeView lays rows out from the metrics instead of
measuring them).

## Folding

- Binary files start folded (nothing to show).
- Files whose hunks add up to more than 1500 rendered lines (`COLLAPSE_OVER`) start folded,
  with "N lines · Show file" in the header. Lock files and generated code are the usual
  cases. 1500 is about 80 screens of a 400 px panel; smaller files open.
- The chevron folds or opens any file. The choice is the item's `collapsed` with a
  bumped `version` (the CodeView re-reads an item only when its version changes); it
  lasts while the tab is mounted.

## Hunk expansion: the old side is rebuilt, not fetched

The brief was to fetch the new side at the head and the old side at `base_sha` and fall
back to no expansion where the old side did not match. Instead `prFileLoader` reads only
the head copy (one paced `GetPullRequestFile`, from `headRepoSlug`, or the base repository
when that is unknown: GitHub keeps every pull request's head commit there too) and
`oldFromNew` rebuilds the old side: the unchanged runs between hunks come from the head
copy, each hunk's old lines from the patch. That is exactly the file the diff was made
against (the merge base). It costs half the requests and cannot drift when the base
branch moved after the branch point. It checks every hunk's new-side lines against the
head copy; on a mismatch (a cut copy, another commit), a binary, a missing file or a file
over 1 MiB, the loader throws, the file stays unexpanded, and a toast says why ("Cannot
expand path").

Checked on real data: for #166's three biggest changed files, the rebuilt old sides are
byte-identical to `git show <merge-base>:<path>`. On this repository's recent merged pull
requests `base_sha` equalled the merge base (branches are rebased before merging), so
the drift the brief worried about shows on open pull requests whose base moved.

- The library calls the loader only on the first expand click of a changed or renamed
  file (added and deleted files carry their whole side).
- Pure renames get `{ oldFile: null, newFile }`, as the library asks.

## Out of scope

Review-thread markers (annotations) are not drawn. No per-file "viewed" state, no file
search.

## Gotchas

- The library turns pointer events off while it scrolls (`pointerEventsOnScroll`), and
  Playwright's scrolling into view can leave a target under a sticky header. The e2e
  clicks inside the diff at the element's own place once it takes pointer events
  (`clickInDiff`).
- `pr-panel.spec.ts` expected the Code tab disabled; it now expects it enabled.

## Verified

- `make check` green.
- `e2e/pr-code.spec.ts` (3 tests) on WebKit and Chromium, 24/24 with `--repeat-each=4`;
  `e2e/pr-panel.spec.ts` on WebKit (its Code tab assertion now expects it enabled).
- Live (`make gui-build`, isolated `CODE_FOUNDRY_HOME`, a scratch clone on #173's head
  branch registered as a project so its panel opens #173): 26 files, `+939 −603` as
  GitHub counts them; the file list and its rows scroll the diff; Unified and Split;
  maximized; dark → light re-themes the open diff live. Expanding the 451 unmodified lines
  above `docs/ARCHITECTURE.md`'s hunk loaded 100 lines whose text matches `git show
  1ad520da:docs/ARCHITECTURE.md` (line 352 checked).
- The panel was at its default 420 px width, not 400 (resizing it needs a drag).
