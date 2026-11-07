# Diff viewer 1: compare two sources of a checkout

`ProjectService.CompareWorktree` lists what differs between two sources of one checkout, and
`GetWorktreeCompareFile` reads one file's two sides when it is looked at. Store code is
`internal/store/project/compare.go`; `internal/api/project_compare.go` only maps.

## Decisions

- **Two calls.** The list costs one `git diff` however large the files are; contents cost a
  read per file, and only for the file on screen. A comparison of thousands of files never
  reads them.
- **Sources.** Merge base, working tree, staged, ref, either way round. Git has no form with
  the working tree or index as the old side, so those run reversed (`-R`). Unset sources are
  merge base to working tree: what the Changes list showed, and the test pins that.
- **Merge base is its own kind**, not a flag on a ref. The default has to keep meaning "what
  this branch changed" as main moves on, while a ref a caller names has to mean that commit,
  as `git diff A B` does. A flag would be one more thing for every caller to get right.
- **One `git diff --raw --numstat -z`.** One rename pass instead of two, and `--raw` gives the
  modes, which is how a submodule is told apart. `--no-textconv`, `--no-ext-diff` and
  `--ignore-submodules=none` are explicit so user config cannot change the answer.
- **The list holds what the detail holds.** The info card counts the detail's files, so a row
  missing here was "No changes" beside a count. A dirty submodule is listed (`none`, not
  `dirty`, and its working side reads `<sha>-dirty`, git's own form), and so is an embedded
  repository, as `dir/` with `Submodule` set. `none` also overrides an `ignore` setting in
  `.gitmodules`, which the detail honours: there the Diff tab can list more than the card,
  never less. That is the side to be wrong on for a surface people review with.
- **The list caps at 10000, the totals do not.** Both go in the response.

## The boundary

Refs and paths come from callers, the model among them.

- A ref passes `checkRef` (no leading `-` or `^`, range, `:`, glob, whitespace or control
  character, at most 256 bytes), then `rev-parse --verify --quiet --end-of-options`. `^HEAD`
  matters: rev-parse echoes the exclusion back, `^<sha>`. What it answers is kept only if it is
  a bare full sha, so only that reaches a later command.
- Paths never reach `git diff`. The whole diff is listed and matched in Go. That also keeps a
  rename whole: a pathspec on one side of it turns it into an add.
- A read names its path behind `--literal-pathspecs … --`, or opens it under an `os.Root` at
  the checkout. `.git` is refused in any case and at any depth, as written (`comparePath`) and
  where the path leads (`followParents`), by `GetWorktreeFileDiff` too. NUL and over-long
  paths too. The second check exists because `os.Root` only stops links that leave: a tracked
  `x -> .git` stays inside, and `x/config` read the repository's config, tokens in remote URLs
  included. It walks the directories with `Lstat` and `Readlink` before the read. A link
  swapped in between the walk and the open is not caught; that takes a process already
  running in the checkout, which can read `.git` itself.
- Only a refusal's message leaves the daemon, and it holds only what the caller sent. Any other
  failure is logged and answered "git could not read this comparison" (`readError`):
  `GitError` names the command and the directory.
- `readWorktreeFile` moved to `os.Root`, for `GetWorktreeFileDiff` as well. It used to resolve
  the parent, lstat, then open, so a link swapped in between was followed, and a FIFO swapped
  in blocked for good. It now opens with `O_NOFOLLOW | O_NONBLOCK` and judges what it opened,
  as `fsx.ReadFile` does.
- Untracked files are counted through the same root, so a link is one line and never what it
  leads to. Counting has a 64 MiB budget per comparison.
- A name that is not UTF-8 cannot travel in a proto string, and one such path failed the whole
  response. APFS refuses these on disk, but a tree can hold one. They are left out of the list
  and the totals and counted in `skipped_names`, a rename from one as well, for the GUI to say
  so. A row would have needed a lossy name that opens nothing and can collide.

## What a checkout's config can still run

`guarded` (`runner.go`) covers every git command of `CompareWorktree` and `CompareFile`,
through the context so it holds for the commands shared with the rest of the store: `-c
core.fsmonitor=false` and `GIT_NO_LAZY_FETCH=1`. Both reach the `git status` that `git diff` runs
inside a dirty submodule.

**Clean filters still run.** `filter.<name>.clean` and `filter.<name>.process`, for a path whose
attributes name that filter, on the `git diff` forms with the working tree as a side (`git diff
<sha>`, `git diff` and both with `-R`), and with the submodule's own config inside a submodule
that is checked for changes. Forms with no working tree side (`--cached`, two shas) and the
other commands run none. They stay because the diff needs them: a file on disk is what a clean
filter turns into the stored bytes (LFS, git-crypt), so without one every such file differs
from its own commit (`TestCompareCleanFilterStays`). Git has no switch for all filters, only
per name, and `--attr-source` would drop `text` and `eol` as well.

`git status` and the detail's numstat have the same exposure today, plus `core.fsmonitor` for
status. Neither is changed here. `GetWorktreeFileDiff` is not guarded either: it keeps lazy
fetch, and nothing in the GUI calls it after diff viewer 2.

**A partial clone without an object gets an answer, not a fetch.** The list and the read both
say so in `error` (`objectsMissing`), where the Changes list would have fetched. `ls-tree
--long` does not fail here, it prints the size as `BAD`, so that entry goes on to the read,
which does. What the clone has still compares.

## Gotchas

- A ref that names nothing is an answer (`error`), not a failure: a tab remembers a ref that
  can be deleted. `rev-parse --quiet` says so with exit 1, but with exit 128 and no stderr for
  a reflog entry past the end. A repository it cannot read is also 128, with stderr, and stays
  an error.
- `git diff` on the index side lists an unmerged path twice (U, then M, numstat twice).
  `git diff <commit>` lists it as M, or not at all if the working tree matches. So
  `ls-files --unmerged` decides, on every comparison that touches the index or disk.
- An uninitialized submodule's directory has no `.git`, and git walks up: `rev-parse HEAD`
  there answers with the worktree's own HEAD. `hasGitDir` checks first.
- `git rm --cached` leaves a path both listed as D and untracked. It is on both sides, so M,
  with no counts.
- `os.Root` gives no exported error for "path escapes", so any lstat failure but a permission
  one reads as absent.

## Several checkouts

A request names one project and one worktree. A thread with several checkouts is several
calls; `ThreadService.Checkouts` lists them. A project id with another project's worktree is
NotFound.

## Not done here

`GetWorktreeFileDiff` stays until nothing calls it. No GUI yet: diff viewer 2.
