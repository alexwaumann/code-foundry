# Worktree detail from status output; untracked directories expanded

Status: done on `cf/detail-from-status` (PR 3 of 3, after #169 FSEvents and #170 activity
tiers). `make check` is green. Verified end to end with a scratch daemon
(`CODE_FOUNDRY_HOME=/tmp/cf-dfs/home`, `daemon --dev`), a scratch project under
`~/cf-scratch-dfs` with a bare origin in `/tmp`, and the built GUI.

## What changed

| File | Change |
|---|---|
| `internal/store/project/parse.go` | `statusArgs`: `status --porcelain=v2 --branch -z --untracked-files=all --find-renames`. `parseStatusV2` keeps one `statusEntry` per record (path, source path of a rename or copy, X, Y, unmerged, untracked) in `statusInfo.Entries`, which replaces `Unmerged []string` |
| `internal/store/project/store.go` | the status job runs `statusArgs` and stores the entries on `wtSlot.entries` (replaces `wtSlot.unmerged`; same single writer, and a failed status keeps the last list) |
| `internal/store/project/detail.go` | a dirty `fillDetail` runs only `diff --numstat <merge base>`; `uncommittedFiles` and `headToWorktree` derive the letters and the untracked list from the entries. `countUntracked` fills untracked counts through a per-worktree memo (`detailState.lines`). `FileChange.IsDir` removed. The debug line gains `untracked_reads` |
| `internal/store/project/types.go` | `Status.Untracked` documented as a file count; the package comment names the FSEvents stream (it still said fsnotify) |
| `proto/codefoundry/v1/project.proto` | `FileChange.is_dir` removed (`reserved 8`, `"is_dir"`); `GitStatus.untracked` documented |
| `internal/api/project_detail.go`, `gui/frontend/src/api/worktreeDetail.ts` | `isDir` dropped from the mapping and the view model |
| `gui/frontend/src/components/overview/files.ts` | `splitPath` lost its trailing-slash (`notes/`) branch. Nothing else rendered the directory case |
| `gui/frontend/mock/github.ts`, `e2e/worktree-panel.spec.ts` | the mock's `notes/` row is two files; the spec checks them |

## Status flags

`--untracked-files=all` overrides `status.showUntrackedFiles` (`no` hid untracked files,
`normal` collapsed a directory to one `dir/` entry). `--find-renames` overrides
`status.renames=false`. Both verified with git 2.52 and the config set both ways
(`TestWorktreeDetailFromStatus` sets `showUntrackedFiles=no` and `renames=false` in the
repo). Ignored files stay hidden: no `--ignored`.

`Status.Untracked` now counts files: an untracked directory with three files counts
3, where it used to count 1. The GUI's "N changed" (staged + modified + untracked) and
the sidebar's dirty count grow accordingly. No GUI or CLI text described a directory as
one entry; the only consumers of the number add it up.

## XY mapping

`git status` reports X (HEAD → index) and Y (index → working tree). The detail wants one
letter for HEAD → working tree, which is what `git diff --name-status -M HEAD` reported
before. `headToWorktree` decides in this order (first match wins):

| XY | Letter | Why |
|---|---|---|
| `u` record (`UU`, `AA`, `DU`, `UD`, ...) | U | conflicted; listed apart from the ordinary entries, so no override is needed |
| `?` record | ? | untracked, counted with `countLines` |
| `AD`, `CD` | not listed | added (or copied) in the index, then deleted: in neither HEAD nor the working tree. The diff against HEAD did not list it either |
| `RD` | D at the **source** path | the new path is gone, and the old one left the index |
| `A.`, `AM`, `AT`, `.A` (intent to add) | A | either side is A |
| `D.`, `.D`, `MD`, `TD` | D | either side is D |
| `R.`, `RM`, `RT` | R, with the source | |
| `C.`, `CM` | C, with the source | only with `status.renames=copies` (see gotchas) |
| `T.`, `.T`, `MT`, `TM` | T | type change on either side |
| `M.`, `.M`, `MM` | M | everything else |

`TestHeadToWorktree` covers every row; `TestUncommittedFiles` covers U, `?`, the skipped
`AD`, and `git rm --cached` (a `D.` entry plus a `?` entry for the same path: the D wins
in `mergeFiles`, as before). `TestWorktreeDetailFromStatus` runs the real git over RM, AM,
AD, MD, ` D`, `D ` and an untracked directory.

`mergeFiles` is unchanged apart from `IsDir`: committed entries first, then uncommitted
ones (the working tree's letter wins), then untracked paths not already listed.

## Untracked line counts

`countUntracked` runs after `fillDetail`, over the capped list, for `?` rows only. Per
file it calls `os.Stat` and reuses the memo entry when size and mtime match; otherwise it
runs `countLines` (unchanged: 8 MiB read cap, NUL in the first 8000 bytes means binary).
The memo it returns holds only the paths listed now, so it never outgrows the current
untracked set; a clean recompute stores an empty memo. Stat comes before the read, so a
file written during the read has a newer mtime than its memo entry and is read again
next time. A file that vanished between status and stat gets no count and no entry. The
memo is written only by the worktree's `jobDetail` (with the head part, and kept when a
recompute fails) and dropped with the detail when the worktree goes away.

## Process counts

One round = `jobBase` + status + detail for a watched worktree (`TestDetailCache`, fixture
repo, feature worktree one commit ahead):

| Case | Before (base + status + detail) | After |
|---|---|---|
| clean, key unchanged | 1 + 1 + 0 = 2 | 1 + 1 + 0 = **2** |
| **dirty, key unchanged** | 1 + 1 + 3 = 5 | 1 + 1 + 1 = **3** |
| HEAD moved, clean | 1 + 2 + 5 = 8 | 1 + 2 + 5 = 8 |
| dirty → clean | 1 + 1 + 1, then 2 | same |
| unborn branch | 1 + 1 + 3 = 5 | 1 + 1 + 1 = **3** |
| no base, dirty | 1 + 1 + 3 = 5 | 1 + 1 + 1 = **3** |

The dirty detail lost `diff --name-status -M <head>` and `ls-files --others --directory`.
Mean of 20 runs, warm cache (`GIT_OPTIONAL_LOCKS=0`):

| Command | Scratch worktree | code-foundry checkout |
|---|---|---|
| status, old flags | 5.8 ms | 11.7 ms |
| status, new flags | 5.7 ms | 11.6 ms |
| `diff --name-status HEAD` (removed) | 5.7 ms | 7.1 ms |
| `ls-files --others --directory` (removed) | 5.3 ms | 9.5 ms |
| `diff --numstat <mb>` (kept) | 5.7 ms | 7.1 ms |

So a dirty recompute saves 11 to 17 ms here, and more on a large tree (the neovim
measurements in `repo-detail-cache.md`: 9.0 + 11.4 ms). The new status flags cost
nothing measurable when the untracked set is small. An unignored directory with
thousands of files (a `node_modules` missing from `.gitignore`) now makes status list
each file, and the detail lists up to `DetailFilesMax` (2000) of them; the first dirty
recompute reads each listed untracked file once and later ones only changed files.

## End to end

Branch binary, `daemon --dev`, project added with `project add`, worktree
`feat/notes` from `project.worktree.new`, one commit (`helper.go`), then: `git mv
names.txt greek.txt` plus an edit (RM), `rm gone.txt` ( D), and an untracked
`scratch/` with `data/logo.png` (PNG header, NUL bytes), `empty.txt` (empty) and
`todo.md` (three lines, the last unterminated). `GetWorktreeDetail` over Connect JSON
with the bearer token:

```
D  gone.txt                    +0 -3
R  greek.txt  (names.txt)      +1 -0
A  helper.go                   +5 -0
?  scratch/data/logo.png       binary
?  scratch/empty.txt           +0
?  scratch/todo.md             +3   (+4 after appending a line)
```

Debug log (paths trimmed):

```
17:29:24.167 worktree status changed head=1e9098eb08dc staged=1 modified=2 untracked=3
17:29:29.917 worktree detail clean=false git_runs=5 untracked_reads=3   # first call: head part + numstat
17:29:34.760 worktree detail clean=false git_runs=1 untracked_reads=1   # appended to todo.md
17:29:37.779 worktree detail clean=false git_runs=1 untracked_reads=1   # new scratch/new.txt
            worktree detail clean=false git_runs=1 untracked_reads=0   # new.txt removed
```

No warnings or errors in the log. The worktree panel (dark and light) shows the three
untracked files as ordinary `?` rows with their counts ("6 files · +10 −3"); screenshots
are in the PR body.

## Gotchas

* **Rename pairing differs from the old diff.** Status pairs renames between HEAD and the
  index; `git diff -M HEAD` paired them between HEAD and the working tree. With several
  similar files the two can pick different sources (seen in a probe: the diff paired
  `c → b2`, status `b → b2`). The numstat (merge base to working tree, still `-M`) may
  then key a file's counts under a different pairing, leaving a D row without its
  `−N`. `TestWorktreeDetailFromStatus` gives each file distinct contents for that reason.
* **Intent to add, then deleted** (`git add -N f; rm f`) shows as `.D`, so the detail
  lists D for a path HEAD never had (the old diff listed nothing). Status gives no way to
  tell it from a tracked file deleted in the working tree. Rare; left as is.
* **Copies** appear only with `status.renames=copies`, which `--find-renames` keeps (it
  raises detection to renames, never lowers it). They map to C. Forcing renames-only
  would need `-c status.renames=true` before the subcommand.
* **Unmerged entries keep their counts** from the numstat, as before
  (`TestWorktreeDetailConflicts`).
* `parseStatusV2` now checks that ordinary and rename records have a path field, so a
  truncated record is an error instead of being counted.
* `TestStreamBurstIsBounded` waited for `Untracked == 1` (the collapsed
  `node_modules/`); it now waits for 2000.
* The worktree isolation hook refuses `GIT_CONFIG_GLOBAL=` on a command line and quoted
  binary paths with spaces; the e2e ran from scripts in `/tmp/dfs-scripts`.

## Left out

* Filtering a huge unignored untracked directory (a per-directory cap, or collapsing past
  N files). The cap on `Files` (2000) bounds the detail; status itself lists every file.
