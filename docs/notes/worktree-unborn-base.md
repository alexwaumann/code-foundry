# Worktree from an unborn branch

A coworker's `git init` folder (no commit yet) failed `thread.new` with a new
worktree: `git worktree add --no-track -b cf/... <path> main` → `fatal: invalid
reference: main`. Nothing hardcodes main or master on that path: `defaultBranch`
(no origin) returns the branch the main checkout's HEAD names, unborn included, and
`git worktree add` cannot branch from a ref with no commit. The same state is left
behind when Add project's initial commit fails (signing, no identity) since the
project stays registered as git.

## Decisions

- Detect and repair, don't explain. `CreateWorktree` calls `ensureBorn` before the
  branch-from-base path: when the main checkout has no HEAD commit and the base is
  the default or names the checkout's own unborn branch (`main` or
  `refs/heads/main`), it makes the empty initial commit, refreshes the repo, and
  carries on. Many users are non-technical and an empty commit is harmless. Any
  other base is left to git and fails as before.
- One place. Every worktree (composer, `thread.new --worktree`, workspaces, CLI)
  goes through `CreateWorktree`, so the GUI needs no change.
- The commit message is `chore: initial commit` (conventional commits), shared with
  Add project through `initialCommitMessage`. It is the user's repository, not Code
  Foundry's, so nothing marks it as ours.
- When the commit itself fails the error is
  `<name> has no commits yet and the initial commit failed: <git stderr>`
  (ErrFailedPrecondition) instead of git's "invalid reference".

## Verification

`make check` green. End to end with an isolated daemon (`CODE_FOUNDRY_HOME`):
`repo.add` on a fresh `git init` folder with one untracked file, then
`repo.worktree.new --branch cf/x` created the commit and the worktree, the file
stayed untracked, and a second worktree (explicit `--base main`) added no second
commit. Daemon-side fix: users get it on their next update.

## Gotcha

The Go build cache can hold a cgo link line from another T3 worktree's
`libghostty-vt.a`; `go clean -cache` fixes a `make check` that fails only in
`internal/store/terminal`.
