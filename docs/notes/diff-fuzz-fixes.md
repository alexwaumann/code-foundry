# Diff fuzz fixes

Four findings from a fuzz pass over the Diff tab (diff viewer 2 to 4), fixed together.

## 1. An open lockfile diff froze the window on every unrelated save

`DiffFile` reads its file again on any change in the checkout (`useWorktreeChanges`,
`useStatusChanges`, throttled to one read per 250 ms). Each answer was a new object, so
`parseDiffFromFile` ran again on both sides and `CodeDiff` drew again, even though nothing
had changed. With a 1.2 MiB `package-lock.json` open, which the tab also picks without a
click because it sorts first, each save elsewhere blocked the main thread for 2.6 s.

**Fix:** a read whose sides equal the last one's (`sameSides`: status, error, and each side's
text, presence, binary, truncated and submodule flags) returns the last object. The parse
memo and the memoized `CodeDiff` then skip, and the only cost left is the transfer and
decode. Comparing 1 MiB of text takes about a millisecond.

**Measured** (dev daemon, headless WebKit, a requestAnimationFrame gap logger, a line
appended to another file every 1.5 s for 12 s, 1.2 MiB lockfile with 2,000 lines changed):
before, gaps of 2,615 to 2,707 ms, one per read. After, 8 reads and no gap over 50 ms
(the largest over 20 ms was 92 ms).

**Kept:** the worktree-wide subscriptions. They are how the file notices that a side which is
a ref has moved: the merge base after a fetch, HEAD after a commit, when the row's counts do
not change. They could be dropped if `DiffFile` took the list's resolved shas as part of its
stamp. That is a follow-up, as it changes when the file reads (a tested behaviour), and with
this fix those reads cost only the transfer.

## 2. A rename kept on screen after a side change showed every line as added

The tab keeps `file` and `oldPath` across a source change. When the file was no longer
listed, `pickRow` built its row with the tab's `oldPath`. A rename committed on the branch
then read `HEAD:<old name>` (absent) as its old side under HEAD → working tree, and the whole
file showed as added. The "no longer in this comparison" state applied only to a parse with
no lines.

**Fix:** a row for a file that is not listed has no `oldPath`. A rename the new comparison
still has is listed, with its own source. A swap still renames explicitly. Separately, a file
that is not listed but whose sides still differ shows its lines under a "Not in this
comparison's file list" notice. That can happen when the list is older than the read, or the
file is past the cap. The wording is not "no longer in this comparison", because the lines
under it show that the file is in it.

## 3. Untracked bulk pushed the tracked changes past the 10,000 cap

`fill` sorted by path and then cut, so 16,000 untracked files under an unignored
`node_modules/` took every row, and the 3 real changes under `src/` were not listed at all.

**Fix:** past the cap, `fill` sorts by `capRank` first (conflicts, then tracked changes, then
untracked files), cuts, and sorts what is kept by path. An untracked row is marked
(`CompareChange.untracked`) when `addUntracked` makes it, because with the working tree as base
its letter is `D`, the same as a tracked deletion. The totals still count every file.

**Measured** on the report's layout (400 × 40 untracked files plus 3 changes):
`CompareWorktree` before listed 10,000 of 16,003, all under `node_modules/`. After, it lists
the 3 changes and 9,997 untracked files.

**Not done:** skipping line counts for untracked rows past the cap. `addUntracked` runs before
`fill` narrows the list to the asked paths, so it cannot know which rows will survive, and the
totals count every file. Counting is already bounded at 64 MiB in total.

## 4. An agent's file pick landed in the user's sides, where it was never listed

`view.panel.diff <path>` with no sides is checked against the default sides (merge base →
working tree). The intent then picked the file in the user's own tab, which keeps whatever the
user compares (diff viewer 3). When that was HEAD → working tree and the change was
committed, the tab read "no longer in this comparison", while the agent was told it had
succeeded.

**Decision:** diff viewer 3's rule stays: the checkout's own tab is the user's, and a call with
no sources may only pick a file there. The intent picks at once, as before, when the user's tab
compares the sides the daemon checked. When it compares other sides (or is on a commit, whose
sides are the ones it came from), the intent first asks `CompareWorktree` for that one path in
the user's sides:
- Listed: the file is picked there, under the name and source those sides list it by.
- Not listed, or the comparison cannot say: it opens in a tab of the thread's own, comparing
  the sides the daemon found it in, as a call naming those sides would. The user's tab is left
  unchanged.

The second tab is "From thread · feature vs main", so it is clear whose it is. A pick never
moves what the user's tab compares, and it never shows a file that is not in the tab's
comparison. The agent's success now holds: what it asked for is on screen. The daemon is
unchanged, as it cannot know which sides the user's tab compares.

**Considered:** saying so in the unlisted state ("picked by the thread; not changed between
HEAD and Working tree"). That reports the problem but still does not show the change the agent
pointed at.

## Gotchas

- The check is asynchronous, so the panel opens at once and the pick lands when the answer
  comes (a few ms). The tab it lands in is found again at that point, in case the user moved
  in the meantime.
- In the drive harness, a project registered on a feature branch with no remote takes that
  branch as its default, so its merge base is HEAD. Clone the repository from a bare origin to
  get a branch with a real merge base.
