# Worktree panel: distilled

The side panel's Worktree surface (`components/overview/WorktreeOverview.tsx`, mounted by
`surfaces/worktree.ts`) now shows only what matters about this worktree. It follows the
signed-off sketch (`docs/sketches/worktree-panel`, kept out of the repo). From top to bottom:

1. **Header**: icon, project @ branch, and the path. Its rule spans the panel border to
   border: the header has negative margins equal to the body's padding (`-mx-4`, or
   `-mx-3` under 340px).
2. **Who else**: the third header line, "N other threads · N shells". Hidden when both
   are zero.
3. **Git operation strip**: shown only while `status.operation` is set. It reads
   "Rebase in progress · 2 conflicts", with "step 3/6" when git records steps.
4. **Facts**: origin, vs <base>, working tree. Three cards, two per row under 340px.
5. **The branch's pull request**: one row for the newest open PR, else the newest PR.
6. **Changes**: a flat list with conflicts first, capped at ten rows.
7. **Commits**: one collapsed row. When opened, the log appears with the same cap.

## Decisions

- **Removed**: the Upstream/Base/Working-tree sync line; the whole GitHub activity
  section (monthly stats, default-branch CI and its failing checks, merged in the last
  7 days, "Your PRs for"); the file tree (folders, expand/collapse, the `e`/`E` keys, the
  WT badges); the freshness stamps; and the always-open log. Repository-wide data belongs
  to the Projects page, not to one worktree's panel. The panel is read-only: the agent
  creates PRs, and there are no buttons. The only exceptions are the two bodies kept
  exactly as they were: Initialize Git (no git) and Publish to GitHub (no remote). A
  repository with a non-GitHub remote just has no PR row.
- **Who else** counts, it does not list. The selectors return numbers (`otherThreads`,
  `shellsIn` in `overview/facts.ts`), so no component subscribes to the sessions or
  terminals slice.
  - Threads: unarchived threads whose `worktreePath` equals the path exactly, minus the
    selected thread (`selection.id`, which is `deriveContext`'s `activeSessionId`). A
    thread in a subfolder of the worktree is not counted. That follows the spec; if we
    want it counted, use `placeSession`.
  - Shells: terminals whose cwd is the path, not counting exited ones (an action run
    stays EXITED).
- **Facts**: `originFact`, `baseFact` and `workingTreeFact` are pure and table-tested.
  - The origin card's label is the upstream's remote (or origin, or the only remote).
  - The base is shown short ("origin/main" → "main") when its first segment is a
    configured remote.
  - Working tree: "N unmerged" in red takes precedence over "N changed"
    (staged+modified+untracked) and "clean".
- **Pull request row**: `branchPullRequest` picks the newest open PR by `createdAtMs`,
  then by number; failing that, the newest PR.
  - Open: ChecksBadge (only when there are checks), then ReviewBadge (only when there is
    a review state, and hidden under 340px).
  - Draft: the word "draft" plus checks. The sketch shows checks on a draft, so the draft
    row keeps them.
  - Merged or closed: the state word.
  - Click opens the PR tab. Cmd+click and cmd+Enter open it on GitHub.
  - Its testid is `overview-pr`, because `worktree-pr` is already the Projects page row
    chip, which is on screen at the same time.
- **Keyboard**: `useNav` walks the PR row, then the files, then the Commits row (Enter
  toggles it; → and ← open and close it), then the commits when the list is open. Files
  have no action yet (no Diff surface). Commits open on GitHub, as before.

## Path truncation

Each row is a four-column grid: `1.25rem | minmax(0,1fr) | 5ch | 5ch`. The + and −
columns are therefore fixed and right-aligned, blank at zero, and line up down the list
even across virtualised rows. "bin" fills the + column for a binary file with no counts.

- The path cell is a flex row. The directory span is `min-w-0 truncate` with
  `direction: rtl`, and its text is wrapped in LRMs (`‎` at both ends). The
  ellipsis therefore lands at the start, while the LRMs keep the slashes where they
  belong. The name span is `shrink-0 max-w-full truncate`: it only truncates when the
  name alone is wider than the cell.
- e2e checks this in both engines (`pathLayout` in `worktree-panel.spec.ts`), at 420px and
  at 280px:
  - the name is never cut;
  - the directory ends exactly where the name starts;
  - the visible characters read in order;
  - at 280px the start of the directory is hidden.
- Gotcha: WebKit reports odd boxes for characters hidden behind the ellipsis. The
  in-order check therefore only uses characters that are visible.
- A truncated directory starts up to one character to the right of an untruncated one
  (the ellipsis snaps to a glyph boundary). The sketch shows the same.

## The 10-row caps

`RowList` gets `capped`: short lists (60 rows or fewer, not virtualised) scroll inside
`maxHeight` too, not only the virtualised ones. Changes and Commits both pass
`maxHeight = 10 × 24px`, so the panel never grows past ten rows per list.

- A 120-file list virtualises inside 240px.
- A 12-commit log is a plain list that scrolls inside 240px.
- NavRow's `scrollIntoView` keeps the cursor row visible in either case.
- `detail.filesTruncated` adds a muted "list truncated" line under the list.

## Dead code

`repoActivityResource`, `getRepoActivity`, `RepoActivityView` and `DefaultBranchView` had
no reader once the GitHub section was gone, and the Projects page never used them. They
are deleted. The `repoActivity` gh event is still mapped (and simply ignored), and the
daemon's activity polling and the mock's RPC are unchanged. `buildFileRows` (the tree),
`EXPAND_ALL_UNDER` and `describeChanges` are replaced by the flat
`buildFileRows`/`splitPath` in `overview/files.ts`. The stale `Section` entry in the
tooltip guard's OWN_TITLE list is dropped.

## Mock daemon

The default world already has a shared worktree (feat-sidebar: s-4, s-5 and `top`), a
draft PR with 120 files and 12 commits (fix-resize, #145), and a non-GitHub remote
(dotfiles). New controls:

- `POST /__mock/worktree/operation?path=…&op=rebase&step=3&total=6&conflicted=2[&file=…]`:
  sets the status operation fields and puts U files at the top of that worktree's detail.
  With no `op`, the operation ends.
- `POST /__mock/gh/branch-pr?slug&head&number&title&state=open|draft|merged|closed[&ago][&append=1]`.

## Finding: the daemon never sends U files

Live, mid-rebase, the conflicted files come through as `M`. `detail.go` lists uncommitted
changes with `git diff --name-status HEAD`, and that reports an unmerged path as `M`. Only
`git diff --name-status` (index vs working tree) or `ls-files -u` says `U`.

The strip and the "N unmerged" card are correct, because they come from `GitStatus`. The
conflicts-first ordering and the conflict tag work against the mock but not live yet.
This is a small daemon follow-up: mark `U` for the paths `git status` reports as
unmerged.

## Tests

- Unit: `overview/facts.test.ts` 42, `overview/files.test.ts` 9,
  `overview/WorktreeOverview.test.tsx` 14, `surfaces/worktree.test.tsx` 11. The design
  guard is unchanged (strict, no allowlist).
- e2e (`worktree-panel.spec.ts`): 26 across WebKit and Chromium, 8 of them new overview
  tests:
  - the shared worktree layout and aligned columns;
  - the header rule, wrapping and truncation at 280px;
  - keyboard;
  - rebase and cherry-pick;
  - the 120-file and 12-commit caps with a draft PR;
  - PR state selection;
  - the main worktree with a live detail;
  - a non-GitHub remote.
- Updated: `nogit`, `prs` (its old overview block moved here), `workspace-panel`,
  `pr-panel`, `live-nogit`, `live-wspanel` and `live-prs`.

## End to end

The real app (`make gui-build`) ran with `HOME` and `CODE_FOUNDRY_HOME` under
`/tmp/cf-wtp`, so its WebKit storage is isolated too. The scratch repo had a bare local
origin and two worktrees:

- `cf/worktree-panel`: 2 commits unpushed, 4 ahead of and 1 behind main, one file
  staged, one modified and one untracked, 3 threads and a shell.
- `cf/plan-mode`: `git rebase origin/main` stopped at step 1/3 with 2 conflicts.

`session.focus`, then cmd+shift+E and T, opened the panel. It matched the sketch in dark
and light.

Gotchas:

- Worktree paths are the realpath (`/private/tmp/...`). A shell started with
  `--cwd /tmp/...` does not count as being in the worktree, because the match is exact.
  A real `$HOME` under /Users has no symlink, so this only affects scratch setups.
- `view.panel.worktree` is a GUI-local presenter, so the CLI reports it unavailable.
