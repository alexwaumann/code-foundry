# Diff viewer 2: the multi-file Diff tab replaces Changes

One Diff tab per checkout (`components/diff/`, `surfaces/diff.ts`, `surfaces/diffTarget.ts`)
compares two sources file by file, over the RPCs from diff viewer 1. The Changes tab and the
one-file Diff tab are gone, with their files and store.

## Decisions

- **One tab per checkout.** The id is project and worktree only, so sources and the file shown
  are params: picking a file or a source changes the tab, it never opens another.
- **The rail is decided by the panel's real width** (`useWidth`, `RAIL_MIN` 620: a 260px rail
  and a readable diff), never the window's. A split group or a narrow panel in a wide window
  gets the list on top.
- **File by file.** Only the file on screen is read. `DiffFile` is keyed by the row, so moving
  on drops the last file's text.
- **The file being read stays until the reader moves.** The list is live and sorted, so nothing
  about a row's position may move the pane. A tab with no file takes the first and keeps it
  (`keep`, into the tab's params: no activation, no focus), so a new file sorting above it does
  not take over. A file that leaves the list stays on screen, read as usual, and says "no
  longer in this comparison"; if it returns, it is simply there. That holds for the last file
  too, so a tab with a file never falls to the empty state. A source change keeps it on the same
  terms. Swapping sides is the one move that renames it: a rename runs the other way, and the
  file is listed under its other name.
- **The open file follows the list.** It reads again on what the list reads on (`useStatusChanges`
  too, for the index), and when its row's letter or counts change, whatever said so, so the code
  never says less than the row. Refresh reads both. The empty and "Cannot compare" states have
  their own.
- **The list keeps its place by file.** The cursor moves with the file on screen, not with the
  list, and `RowList`'s `keepPlace` goes back to the row at the top after an update. Neither
  `VirtualRows` nor `NavRow` scrolls on a list change or a row mounting any more, for any list:
  both only on the cursor moving. The virtualized list used to scroll to the cursor on every
  render (its deps held an inline `rowKey`).
- **The list on top is fitted to the tab's height** (`topListFit`, `useHeight`): up to five rows,
  never leaving the code under `CODE_MIN` (180), and folded when that is fewer than two. At
  1280x800 a stacked split's tab is 342px: the list folds and the code has 218px (it was 33), and
  the fold button brings the list back. Measured in e2e at 1280x800 alone (730 tab, 420 code),
  1920x1080 split (482, 202, one list), 1024x640 split (262, 138: the whole tab, folded).
- **The filter box shows for as long as it is filtering,** whatever the list's length. The filter
  and the user's fold are tab params, as cheap as anything else a tab keeps, so they outlast a
  tab switch, and an automatic fold stays automatic until the user touches it.
- **A side's label needs only its own source.** A failed read shows both, and only the merge base
  needs an answer: the last `baseRef`, else "merge base".
- **The base picker keeps two `origin/main` rows on purpose.** "merge base" is what the branch
  changed, and stays right as main moves on. The plain ref is that commit, as `git diff A B`.
- **Titles are `<head> vs <base>`, retitled when the comparison answers.** A checkout that is
  not the thread's own leads with the project name, as "Changes · web" did, because a thread's
  checkouts often share a branch.
- **A tab that has never shown is titled "Diff".** Its name comes from the comparison, and
  nothing is read off screen.
- **`openCheckoutDiff` keeps an open tab as it is.** Coming back from the info card is not a
  reset of what the user was comparing.

## Migration: panel store version 6

`migratePanelV5` turns a stored `changes` tab and every old one-file `diff` tab (they have a
`scope` param; new ones never do) into the checkout's one tab.

- All of a checkout's tabs in a panel become one, where the first stood. Its file is the one a
  group shows now, else the last opened, and it takes that tab's scope: `branch` is `head=ref:HEAD`.
- A Changes tab titled plain "Changes" was the thread's own checkout. With a project in the
  title it was not, and that title is kept until the tab first shows.
- A tab naming no worktree is dropped rather than left blank.
- It runs twice to the same place. The store is shared by every build on a machine, and an older
  build writes its own version number back over a newer store.
- Going back: an older build's `diffOfTab` wants a path, so a migrated tab with a file renders
  as that one-file diff, and one with none is blank. The user can close it.

`view.panel.changes` never existed, so no verb needed keeping. `view.panel.diff --path --scope`
still works: `panel.diff` maps `scope` to sources.

## Gotchas

- `useWorktreeChanges` only fires when the detail changes, and `git add` of an edit leaves the
  detail the same (the merge base to the working tree did not move). A comparison of the index
  would go stale, so `useStatusChanges` also watches HEAD and the staged, modified and untracked
  counts. A second `git add` on an already staged file changes none of those: that one waits for
  the next event, a window focus or Refresh.
- `RowList`'s `maxHeight` takes `"100%"` for the rail. It needs a definite parent, hence the
  `relative` and `absolute inset-0` pair around it.
- `SourcePicker` turns cmdk's filter off and lists at most 100 refs, as a repository can have
  thousands.

## Cost of a list read

The list runs git on each tab show and live update, where Changes read the daemon's cached
detail. Measured on a 100000-file scratch repository with 500 files changed on the branch, 30
dirty and 20 untracked, on this machine under load: `git diff --raw --numstat` 190-320 ms,
`ls-files --unmerged` 40-75 ms, `ls-files --others` 180-225 ms, so about 500 ms a read. The status
and the detail's numstat the daemon already runs per change are 220-410 ms each, so a read
roughly doubles the git work per change. It runs off the UI thread, so nothing stalls, but on a
busy thread it would run back to back. So the wait before a live update's read is twice the last
read (`listPace`), 250 ms to 3 s, which caps it at about a third of the time. Repositories where a
read is under 125 ms keep the 250 ms they had. The file's own read is one file and is not paced.

## Removed

The Changes tab's commit list has no replacement here: the approved design has no place for it,
and the thread info card shows only ahead and behind counts. A commit no longer opens on GitHub
from the side panel. Whether to keep it is still open; `FileList` is a column of sections, so a
second one fits under the rows. The file list, totals, conflicts first and every empty state
carried over.
