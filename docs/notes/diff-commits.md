# Diff tab: Commits

A folded **Commits** section at the foot of the file list (`components/diff/CommitList.tsx`, in the
rail and in the list on top) lists the branch being compared. A click compares one commit with
its parent. It brings back what the Changes tab's commit list gave, and more: the commit's own
diff, not only its GitHub page.

## Decisions

- **A new RPC, not the detail's log.** `ProjectService.ListCompareCommits` (`compare_commits.go`).
  `WorktreeDetail.log` is HEAD against the checkout's base, so it could not follow the sides, and
  it has no parents or message bodies. The list is `base..head` on the commits the two sides stand
  on; the working tree and the index count as HEAD. Swapped sides have nothing the head has and
  the base does not, so the section goes away. It uses the same `openCompare` as the file list,
  with the same refusals.
- **Two real SHAs, no mode.** A click sets `base` to `ref:<parent>` and `head` to `ref:<sha>`. The
  pickers, the file list and the diff need nothing new. The tab only adds `commit` and what All
  changes goes back to (`backBase`, `backHead`, `backPath`, `backOldPath`).
- **A merge compares against its first parent.** The daemon sends only that one.
- **A root commit compares against the empty tree**, as `ref:<empty tree>`. `resolve` lets that one
  sha past `^{commit}` and labels it "Empty tree". It is the SHA-1 constant `detail.go` already
  uses, so a root commit in a SHA-256 repository cannot be compared.
- **Picking a side, or swapping, leaves the commit.** That is a comparison of the user's own now,
  and All changes would go back past it.
- **The list keeps the sides from before the commit,** so it stays whole while moving between
  commits, and clicking one does not read it again. All changes goes back to the first view
  however many commits were looked at.
- **Live updates pause on a commit,** for the list, the log and the file. Refresh still reads, and
  a window focus does not.
- **Moving between commits keeps the last file list up** until the next answers (`lastView`). The
  list unmounting would lose the scroll in Commits on every click. The diff pane shows the loader
  meanwhile: a stale row must not be read against the new sides, or kept as the tab's file.
- **The file is the new list's to pick.** A click sets none, so the first file shows.
- **Open or folded is a tab param,** like the list's fold.

## When it shows

**Commits shows only with nothing taken away: no `--hide` and no narrowed list.** One rule covers
what was asked for. `--hide files` hides it. `--hide compare` is what fixes a tab's sides. A narrowed
list is here too, because a commit that touches none of its paths would read "No changes". Show
controls and Show all files bring it back. A thread's tab with a title, a note or `--base` and
`--head`, and the compare bar still there, does show it: the user can change those sides anyway,
and All changes returns to the thread's.

## Limits

- The list caps at 500 (`CompareCommitsMax`), with "First 500 of N commits" under it, and
  virtualizes past `RowList`'s 60. `rev-list --count` runs only at the cap.
- A subject and a body are cut at 8 KiB and made valid UTF-8 (`commitText`): one bad byte would fail
  the whole response, as a path's did (`docs/notes/diff-viewer-1.md`).
- `git log` runs with `--no-show-signature`, or `log.showSignature` would put gpg's output in the
  stream, and inside `guarded` like the rest of a comparison.
- A commit with no changes, such as `--allow-empty`, keeps the list and its message, and "No
  changes" takes the diff's place.
- A commit no longer in the list (rebased away) shows its sha alone, or "Cannot compare" if the
  object is gone. All changes works from both.
- Open on GitHub does not know whether the commit is pushed, as the Changes tab's did not.
- A GUI on an older daemon gets no section: the read fails and nothing else depends on it.

## Tests

The rules are in vitest (`commits.test.ts`, `DiffView.test.tsx`) and Go (`compare_commits_test.go`,
real git: a merge, a root, the cap). e2e keeps the foot of the rail, a long list scrolling inside
itself in both layouts, the place in the list across a click, and the band over the diff.
