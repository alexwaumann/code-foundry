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
- **The list carries no message bodies.** `ProjectService.GetCompareCommit` reads the one commit on
  screen, when it is clicked, and takes only a full sha. A message can be any size and the list is
  read again on every live update: a review measured 1,268 MiB for 100 commits of 5 MiB, because
  the cut came after buffering the whole log.
- **Two real SHAs, no mode.** A click sets `base` to `ref:<parent>` and `head` to `ref:<sha>`. The
  pickers, the file list and the diff need nothing new. The tab only adds `commit` and what All
  changes goes back to (`backBase`, `backHead`, `backPath`, `backOldPath`).
- **A merge compares against its first parent.** The daemon sends only that one.
- **A shallow clone's last commit says so.** Git shows it with no parents, as it does a root, so it
  compares against the empty tree and every file reads as added. The list asks
  `rev-parse --is-shallow-repository` only when a commit has no parent, and the band says the
  parent is not on this machine. In a shallow clone that is every parentless commit, a real root
  included: git cannot tell them apart without reading the shallow file, and the sentence is true
  of both as far as this checkout can show.
- **A root commit compares against the empty tree**, as `ref:<empty tree>`. `resolve` lets that one
  sha past `^{commit}` and labels it "Empty tree". It is the SHA-1 constant `detail.go` already
  uses, so a root commit in a SHA-256 repository cannot be compared.
- **Picking a side, or swapping, leaves the commit.** That is a comparison of the user's own now,
  and All changes would go back past it.
- **The list keeps the sides from before the commit,** so it stays whole while moving between
  commits, and clicking one does not read it again. All changes goes back to the first view
  however many commits were looked at.
- **Live updates pause on a commit,** for the list, the log and the file. Refresh still reads, and
  a window focus does not. All changes reads the log again, as its sides have not changed and
  nothing else would.
- **A thread's file pick leaves a commit.** The daemon found that file in the tab's own sides, so
  the tab goes back to them, or the file would read as gone. A call with no file changes nothing.
- **Moving between commits keeps the last file list up** until the next answers (`lastView`). The
  list unmounting would lose the scroll in Commits on every click. The diff pane shows the loader
  meanwhile: a stale row must not be read against the new sides, or kept as the tab's file.
- **The file is the new list's to pick.** A click sets none, so the first file shows.
- **Open or folded is a tab param,** like the list's fold.
- **The section does not fold with the list.** Its height counts in `topListFit`, so opening it can
  fold the list on top, and it used to go with the list: one click took the toggle away, `commits=1`
  kept it that way, and below about 432 px it never showed. It now sits outside what folds, so a
  short panel trades the file rows for the commit rows and the toggle stays. `e2e` walks 250 to 600
  px in both layouts, open and folded.
- **The open list takes about a third of the tab,** eight rows at most in the rail and three on
  top, and two at least. At 250 px that leaves the code some lines on top and the rail some files.
- **A branch that nets to nothing keeps its commits.** A commit and its revert differ in nothing,
  so the whole-tab "No changes" gave way to the list and "No changes" in the diff's place. With no
  commits either it is still the whole tab.

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
- A subject is cut at 1 KiB and a body at 8 KiB, ending in "…", and both are made valid UTF-8
  (`commitText`): one bad byte would fail the whole response, as a path's did
  (`docs/notes/diff-viewer-1.md`).
- **Nothing past those caps reaches the daemon's memory.** `runFields` hands git's stdout to
  `fieldWriter` as it arrives, which keeps the start of each NUL-ended field. `%<(N,trunc)` would
  have been shorter, but git leaves a subject that is not valid UTF-8 uncut. Measured with 100
  commits of a 5 MiB subject and a 5 MiB body, listed five times: peak RSS 3,849 MiB before and 88
  MiB after, peak heap 3,572 MiB and 5 MiB. `TestCompareCommitsHugeMessages` keeps it.
- `git log` runs inside `guarded` like the rest of a comparison, with `--no-show-signature` (or
  `log.showSignature` puts gpg's output in the stream), `--no-mailmap` (a fifo in `mailmap.file` hung
  the read for 30 s) and `--encoding=UTF-8` (`i18n.logOutputEncoding` made junk rows). The parser
  takes a row only if it starts with a sha, and a parent only if it is one.
- A date that cannot be read is no date, not the year 1. A commit with no message reads "(no
  message)" in the list and the band.
- A long subject takes two lines in the band, with the rest in a tooltip. The body scrolls, and the
  band stops at 40% of the column and scrolls too, so the diff stays in reach on a short panel.
- A commit with no changes, such as `--allow-empty`, keeps the list and its message, and "No
  changes" takes the diff's place.
- A commit no longer in the list (rebased away) shows its sha alone, or "Cannot compare" if the
  object is gone. All changes works from both.
- Open on GitHub does not know whether the commit is pushed, as the Changes tab's did not.
- A GUI on an older daemon gets no section: the read fails and nothing else depends on it.

## Tests

The rules are in vitest (`commits.test.ts`, `DiffView.test.tsx`) and Go (`compare_commits_test.go`,
real git: a merge, a root, a shallow clone, the cap, huge messages, a hostile config). e2e keeps the
foot of the rail, a long list scrolling inside itself in both layouts, the place in the list across
a click, the band over the diff, the toggle at every height, and a long message on a short tab.
