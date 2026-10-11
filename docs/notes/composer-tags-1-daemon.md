# Composer tags 1: daemon completion and file references

Status: done on branch `cf/composer-daemon-completion` (PR 2 of 4 for composer skill and
file tags). Daemon side only: the GUI editor (inline tags, the `/` and `@` popovers) comes
in the later PRs and consumes what is here. `make check` green; exercised against a real
scratch daemon (below).

## What landed

| Path | What |
|---|---|
| `proto/codefoundry/v1/filesystem.proto` | `FilesystemService.ListSkills`, `SearchFiles`; `SkillSource`, `Skill`, `SkillScope`, `FileMatch` |
| `internal/fuzzy` | pure subsequence matcher: `Score`, `Rank` (table tests) |
| `internal/fsx/skills.go` | `ReadSkills(claudeDir, nested, log)`, `SkillDescription` (frontmatter / first line) |
| `internal/fsx/files.go` | `GitFiles`, `WalkFiles`, `WithParentDirs`, `FileIndex` (TTL cache, mutex) |
| `internal/api/filesystem.go` | the two handlers and `checkout` (repo → dir, home boundary, git or not) |
| `internal/store/session/filerefs.go` | `rewriteFileRefs`, `stripFileRefs`; called in `Manager.Create` |
| `gui/frontend/src/api/filesystem.ts` | `listSkills`, `searchFiles`, `SkillView`, `FileMatchView`, `FileSearchView` |
| `gui/frontend/mock/filesystem.ts` | both RPCs over the mock world; `POST /__mock/files`, `GET /__mock/files/calls` |

## Decisions

* **Skill sources.** Per checkout: `.claude/skills/<dir>/SKILL.md` (name = directory) and
  `.claude/commands/**/*.md` (name = stem; nested directories are not namespaced). User
  scope: `~/.claude/skills/<dir>/SKILL.md` and `~/.claude/commands/*.md` (top level only).
  Sorted by name (case-insensitive) within a source; sources in request order; user last.
  Duplicates across scopes are all returned (the GUI decides). A skill directory that is a
  symlink is followed, and so is a `.claude/commands` directory that is one (paths are
  reported under the symlink).
* **Descriptions.** The frontmatter's top-level `description:` (plain, quoted, or a `>`/`|`
  block joined on one line) for skills and commands; a command without one falls back to
  its first non-empty, non-heading body line. Whitespace collapsed, clipped to 300 runes.
  Only the first 64 KiB of a file is read.
* **Candidates.** Git checkouts: `git ls-files -co --exclude-standard -z` (tracked plus
  untracked-not-ignored), deduplicated, capped at 200,000 files, plus every parent
  directory. Without git: a walk skipping `.git`, `node_modules` and dot-directories
  (dotfiles kept), not following symlinks, capped at 50,000 entries. If `git ls-files`
  fails (broken `.git`) the walk is used. git runs with the redirecting `GIT_*` variables
  scrubbed and `GIT_OPTIONAL_LOCKS=0`, like the repo store's runner, so a search never
  rewrites the index (which would fire the repo watcher).
* **Git or not** comes from the repo store's `Repo.Git`; for an explicit `path` of a project
  the store thinks has no git, `.git` is checked at that path.
* **Cache.** `fsx.FileIndex` caches each checkout's candidate list for 5 s (key: git flag +
  resolved path), at most 32 checkouts, oldest evicted; expired entries are dropped on every
  miss. The 5 s count from the end of the listing, so a listing slower than that is still
  reused. Concurrent misses for one checkout wait on a single in-flight listing, which runs
  on `context.WithoutCancel` of the request with a 30 s bound: a search whose request is
  cancelled (the composer cancels the previous one per keystroke) returns Canceled at once
  while the listing finishes and fills the cache for the next keystroke.
* **Ranking.** Tier first: exact base name > base-name prefix > base-name subsequence >
  whole-path subsequence. Within a tier, a bonus per query character landing at a segment
  start or after `/ . - _ space` (4) or right after the previous hit (1), maximised over all
  alignments by a small DP (greedy matching missed boundary hits); a greedy subsequence
  check rejects non-matches first without allocating. Ties: shorter path, then path. Empty
  query: depth, then path. Matching is byte-wise on lower-cased ASCII; non-ASCII names match
  only byte-for-byte.
* **Validation.** `repo_id` is required (InvalidArgument), unknown is NotFound; `path` must be
  absolute, resolve under home (InvalidArgument; like ListDirectories), exist (NotFound) and
  be a directory (InvalidArgument). Any path under home is accepted, not only the repo's
  known worktrees, so a worktree the repo store has not reconciled yet still works. A
  negative limit is InvalidArgument; 0 → 50; > 200 → 200. ListSkills applies the same checks
  per source but skips (WARN log) a source whose project is unknown or whose checkout is
  missing or cannot be resolved, so one stale source does not hide the others or the
  user's skills; a malformed source (no repo id, relative, outside home) still fails it.
* **File references in the first prompt.** Token: `cf-file://<repoId>/<percent-encoded
  relative path>` (the GUI writes it after `@`), ending at whitespace or the end of the
  prompt. `Manager.Create` rewrites it after the switch that resolves or creates the
  thread's worktree(s) and before `spawn`, because Create creates worktrees synchronously
  (new worktree and new workspace alike). Resolution: a workspace member with that repo id
  (members come from `workspaceMember`'s workspace or `newWorkspace`'s result, not a
  snapshot re-read), else the thread's own repo → its cwd. Result: `<worktree>/<decoded
  path>` (a trailing `/` kept for directories; leading slashes dropped so `//etc/x` stays
  inside). Unknown repo, a `..` segment (also when percent-encoded), a bad escape or a
  decoded control character (`%00`): the scheme and repo id are dropped, leaving
  `@<rel>`, and one WARN lists the dropped tokens. A token without `/` after the repo id
  is left alone.
* **The namer** (branch slug) runs before the worktrees exist, so it gets the prompt with
  every reference reduced to its relative path (`stripFileRefs`), never the raw scheme.
* `rewriteFileRefs` returns the dropped tokens alongside the prompt (a small deviation from
  the planned `string` result) so the caller logs with session context.
* **Mock**: every project has `DEFAULT_FILES` (`README.md`, `package.json`, `src/index.ts`,
  `src/components/Composer.tsx`, `src/components/ThreadRow.tsx`, `docs/notes/x.md`, the two
  SKILL.md files) and the project skills `review` and `deploy`; the user has `commit`.
  `POST /__mock/files?repo=…&path=…` replaces a project's list (no `path`: empty);
  `/__mock/reset` restores it. The mock ranks by tier/length/path only (no bonus).

## Gotchas

* **The token ends only at whitespace**, so punctuation right after it is part of the path:
  `(see @cf-file://r/a.md)` resolves `a.md)`. The live check hit this with a `)`. The GUI
  must put a space (or end of text) after every tag, or percent-encode trailing punctuation.
* **Spaces** are decoded into the absolute path, as planned. Whether Claude Code's `@`
  mention then attaches a path with a space was not checked (it likely stops at the
  space); the model still sees the full path as text. Revisit in the GUI PR if it matters.
* **Scratch daemons**: the home boundary is the real `$HOME`, not `CODE_FOUNDRY_HOME`. With
  `CODE_FOUNDRY_HOME=/tmp/…` the new worktrees live under `/tmp`, so `SearchFiles` with
  `path` set to such a worktree is InvalidArgument. Installed daemons keep worktrees in
  `~/.code-foundry/worktrees`, under home. Put scratch repos under `~`.
* `~/.claude/skills` can hold Claude's own sync store (`synced/<uuid>/…`, `.trash`); those
  directories have no top-level `SKILL.md` and are skipped.
* The worktree has no `third_party/ghostty-vt`; copying the main checkout's build (same
  pin) and fixing the `.pc` prefix avoids a zig rebuild.

## Live check (scratch daemon, 2026-10-10)

`make build`; `CODE_FOUNDRY_HOME=/tmp/cf-pr2-e2e/home bin/code-foundry daemon --dev`; a
scratch repo `~/cf-pr2-scratch/web` (one commit: `README.md`, `src/index.ts`,
`src/components/Composer.tsx`, `docs/notes/x.md`, `.gitignore` ignoring `build/` and `*.log`,
`.claude/skills/demo/SKILL.md`, `.claude/commands/fix.md`; then an untracked
`src/new-untracked.ts`, an ignored `build/out.js` and `debug.log`); `repo add` → id
`7f28667358da`. Connect JSON over the loopback port with the bearer token:

```
POST /codefoundry.v1.FilesystemService/ListSkills {"sources":[{"repoId":"7f28667358da"}],"includeUser":true}
 -> demo "A demo skill for the PR 2 check." (project), fix "Fix the failing test." (project)
POST .../SearchFiles {"repoId":"7f28667358da","query":"comp"}
 -> src/components (dir), src/components/Composer.tsx
POST .../SearchFiles {"repoId":"7f28667358da"}
 -> .claude/ .gitignore README.md docs/ src/ (depth 1), then depth 2 incl. src/new-untracked.ts
POST .../SearchFiles {"repoId":"7f28667358da","query":"out"}          -> {} (ignored)
POST .../SearchFiles {"repoId":"7f28667358da","path":"/tmp","query":"x"} -> invalid_argument
POST .../SearchFiles {"repoId":"nope","query":"x"}                     -> not_found
```

Prompt rewrite: `session new --repo 7f28667358da --new-worktree --model haiku --effort
medium --prompt "say the path in @cf-file://7f28667358da/README.md and stop (ignore
@cf-file://r-unknown/docs/notes/x.md)"` → branch `cf/read-readme-path-only`. Daemon log: one
WARN `file references outside the thread's projects` with
`refs=[cf-file://r-unknown/docs/notes/x.md)]`. Claude's transcript, first user message:
`say the path in @/private/tmp/cf-pr2-e2e/home/worktrees/_local/web/cf-read-readme-path-only/README.md
and stop (ignore @docs/notes/x.md)`; its answer was that absolute path. No ERROR lines.
Thread closed, daemon stopped, scratch home, repo and `~/.claude/projects` dirs removed.
The mock was also run (`MOCK_PORT=7811 pnpm run mock`) and both RPCs plus
`/__mock/files` and `/__mock/files/calls` answered as documented.

## Verified

* `make check`: gofmt, vet, staticcheck, `go test -race ./...`, frontend typecheck, lint,
  vitest (1054).
* Go tests: `internal/fuzzy` (tiers, boundary bonus, ranking, empty query, limit);
  `internal/fsx` (`WithParentDirs`, `GitFiles` on a real `git init` repo with tracked,
  untracked and ignored files, `WalkFiles` skips and cap, `FileIndex` search incl. git
  fallback and TTL, `SkillDescription` table, `ReadSkills` incl. symlinked and unreadable
  skills and nested vs top-level commands); `internal/api` (`ListSkills`, `SearchFiles`
  over Connect: scopes, order, git and non-git projects, error codes);
  `internal/store/session` (`rewriteFileRefs` table, `stripFileRefs`,
  `TestCreateRewritesFileRefs` for an existing worktree, a new worktree, a workspace
  thread and a new workspace, and that the namer never sees the raw scheme).

## Daemon restart

The installed daemon must be restarted for the new RPCs and the prompt rewrite. Nothing in
the GUI calls them yet; an older daemon answers Unimplemented (mapped to
`OutdatedDaemonError` by the API layer).
