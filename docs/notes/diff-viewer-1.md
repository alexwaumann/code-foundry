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
  `--ignore-submodules=dirty` are explicit so user config cannot change the answer or run
  anything.
- **The list caps at 10000, the totals do not.** Both go in the response.

## The boundary

Refs and paths come from callers, the model among them.

- A ref passes `checkRef` (no leading `-`, range, `:`, glob, whitespace or control character,
  at most 256 bytes), then `rev-parse --verify --quiet --end-of-options`. Only the sha reaches
  a later command.
- Paths never reach `git diff`. The whole diff is listed and matched in Go. That also keeps a
  rename whole: a pathspec on one side of it turns it into an add.
- A read names its path behind `--literal-pathspecs … --`, or opens it under an `os.Root` at
  the checkout. `.git` is refused in any case, at any depth. NUL and over-long paths too.
- `readWorktreeFile` moved to `os.Root`, for `GetWorktreeFileDiff` as well. It used to resolve
  the parent, lstat, then open, so a link swapped in between was followed, and a FIFO swapped
  in blocked for good. It now opens with `O_NOFOLLOW | O_NONBLOCK` and judges what it opened,
  as `fsx.ReadFile` does.
- Untracked files are counted through the same root, so a link is one line and never what it
  leads to. Counting has a 64 MiB budget per comparison.

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
