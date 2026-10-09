# Config home moves to ~/.code-foundry; worktrees live under it

Status: done on `t3code/user-settings-storage-location`, rebased on `main` (e541c75).
`make check` is green. The daemon + CLI were exercised end to end under a scratch `$HOME`
(below).

## Layout

```
~/.code-foundry/                   $CODE_FOUNDRY_HOME still overrides it
  settings.toml
  db.sqlite
  daemon.sock  daemon.token  daemon.port  daemon.lock
  logs/daemon.log
  worktrees/<owner>/<repo>/<branch, "/" -> "-">
  worktrees/_local/<repo name>/<branch>      repos without a GitHub origin
```

Before: `~/Library/Application Support/code-foundry/` for state and
`<repo parent>/<repo>.worktrees/<branch>` for worktrees.

## Decisions

* **A dot-directory in the user's home**, like `~/.claude` and `~/.t3`. Paths are short
  and have no space, and the socket path (`~/.code-foundry/daemon.sock`, ~37 bytes) is far
  under macOS's 103-byte limit. `paths.DirName` is the name, `Paths.Worktrees()` the
  worktree root.
* **owner/repo, not the repo's directory name.** Two repos named `api` from different
  owners would collide under `worktrees/<repo>`. Repos without a GitHub origin go under
  `_local/<repo name>`; GitHub owner names cannot start with `_`, so it never collides.
* **The slug is read at creation time.** `CreateWorktree` runs `git remote get-url origin`
  rather than using `repoMeta.GitHubSlug`, which is empty until the repo's first reconcile
  after a daemon start. Without this, a worktree created right after a cold start would
  land in `_local/`.
* **`repo.Options.WorktreeRoot` is required and absolute.** The store stays free of
  `internal/paths`; the daemon passes `p.Worktrees()`. `repotest.Fake` has a matching
  `WorktreeRoot` field (default `/worktrees`).
* **`repos.worktree_dir` is unchanged.** It still overrides the default and `{repo}`
  still expands to the repository name.
* **Discovery is unaffected.** Worktrees come from `git worktree list`, so existing
  worktrees at the old sibling paths (or anywhere else) keep showing up. Only new ones
  go to the new root.
* **No automatic migration.** The owner is the only user, so the old home is moved by
  hand (below) instead of a startup migration that would have to stop a running daemon
  at the old socket first.

## Moving an existing install

Done for the owner's machine on 2026-10-08, after this change was on `main`:

1. `make build` in the main checkout, so nothing can start an old daemon afterwards.
   An old build that runs after the move auto-starts a fresh daemon in the old home.
2. Stop the old daemon. There is no `daemon stop` command and the CLI is not
   necessarily on PATH; `bin/code-foundry status` in the checkout prints its pid.
   Stopping it ends its terminals and Claude Code processes; sessions are recorded as
   disconnected.
3. `mv ~/Library/Application\ Support/code-foundry ~/.code-foundry`. `~/.code-foundry`
   must not exist yet, or `mv` nests the old home inside it.

Worktrees in `<repo>.worktrees/` can stay where they are, or be moved with
`git worktree move <old> ~/.code-foundry/worktrees/<owner>/<repo>/<branch>`.

## Verified

Built `bin/code-foundry`, set `HOME` to a temp dir, registered a repo with
`origin = git@github.com:acme/widget.git` and one with no remote:

* `status` reported `home /tmp/…/.code-foundry` and the socket inside it.
* `repo worktree new` created `worktrees/acme/widget/alex-feat-x` and
  `worktrees/_local/plain/fix-y`; git created the parent directories.
* After killing the daemon, `repo worktree new` auto-started a fresh one (uptime 0s) and
  still created `worktrees/acme/widget/cold-start`, so the slug does not depend on
  the first reconcile.

## Gotchas

* `code-foundry --help` and `commands` talk to the daemon and auto-start one. Run them
  with a scratch `HOME` or `CODE_FOUNDRY_HOME` when testing, or they create the real
  `~/.code-foundry`.

* `/tmp` is a symlink to `/private/tmp`, and created worktree paths are resolved, so the
  daemon e2e test compares against `EvalSymlinks(home)`.
* Worktrees under `~/.code-foundry` no longer inherit parent-directory config that sat
  next to the checkouts (`.envrc`, `.tool-versions`/`mise.toml`, `.editorconfig` in
  `~/projects/`).
