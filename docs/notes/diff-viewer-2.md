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
- Going back: an older build shows a migrated tab as blank, as its `diffOfTab` wants a path. The
  user can close it.

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

## Removed

The Changes tab's commit list has no replacement here: the approved design has no place for it,
and the thread info card shows only ahead and behind counts. A commit no longer opens on GitHub
from the side panel. The file list, totals, conflicts first and every empty state carried over.
