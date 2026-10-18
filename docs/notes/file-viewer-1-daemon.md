# File viewer 1: daemon RPCs (file read, worktree file diff, PR diff and files)

Status: done on `cf/file-viewer-1-daemon` (PR 1 of 5 of the file viewer series; PR 2,
the GUI foundation, runs in parallel; PRs 3-5 consume these RPCs). `make check` is green.
A and B were exercised against a scratch daemon (`CODE_FOUNDRY_HOME=/tmp/cf-fv1/home`,
`daemon --dev`, project `~/cf-scratch-fv1` with a bare origin in `/tmp`), C against this
repository's PR #171 through the same daemon. Read-only throughout: nothing here writes
to disk, git, or GitHub.

## What changed

| File | Change |
|---|---|
| `proto/codefoundry/v1/filesystem.proto`, `internal/fsx/read.go`, `internal/api/filesystem.go` | `FilesystemService.ReadFile`; `fsx.ReadFile`, `DetectMIME`, `TextMIME`, `LooksBinary` |
| `proto/codefoundry/v1/project.proto`, `internal/store/project/filediff.go`, `internal/api/project_filediff.go` | `ProjectService.GetWorktreeFileDiff` (`DiffScope`, `FileVersion`); `Store.WorktreeFileDiff` |
| `internal/store/project/detail.go` | `computeHeadPart` calls the shared `runMergeBase` (same exit-1 rule) |
| `proto/codefoundry/v1/gh.proto`, `internal/store/gh/pr_files.go`, `internal/api/gh_files.go` | `GhService.GetPullRequestDiff`, `GetPullRequestFile`; `Service.PullRequestDiff`, `PullRequestFile` |
| `internal/store/gh/http.go`, `http_raw.go`, `runner_rest.go` | `send` takes `sendOpts` (Accept, body limit, `truncated`); `RawRESTRunner.RESTRaw` |
| `internal/store/gh/queries/fragments.graphql`, `decode.go`, `gh.go`, `internal/api/gh.go`, `gui/frontend/src/api/gh.ts` | `baseRefOid` in `PullRequestSummary` → `PullRequest.BaseSHA` → `PullRequest.base_sha` → `baseSha` |
| `proto/codefoundry/v1/gitops.proto`, `internal/store/gitops/editor_file.go`, `ops.go` | `OpenEditor`/`Reveal` take `OpenOptions{WorktreePath, File, Line}`; `editorArgs` |
| `internal/command/commands_gitops.go` | `worktree.open.editor --file --line`, `worktree.reveal --file` |
| fakes | `projecttest.SetFileDiff`, `ghtest.SetPullRequestDiff`/`SetPullRequestFile`, gitopstest records the file |

## A. FilesystemService.ReadFile

`{base_dir, path, max_bytes}` → `{contents, size, truncated, binary, mime_type,
modified_at (unix ms), resolved_path, not_found, is_dir}`.

* `path` is absolute, `~`/`~/...`, or relative to `base_dir` (which must then be
  absolute; InvalidArgument otherwise). `resolved_path` is the cleaned absolute path as
  asked for, before following symlinks, so the viewer's breadcrumb matches what was
  clicked.
* The home check (`fsx.Within(root, …)`, the same rule projects use) runs on the
  symlink-resolved target: a link in a project pointing at `/etc/hosts` is
  InvalidArgument; a link under `/tmp` pointing back into home is read. A path that does
  not exist is checked lexically and comes back `not_found` (no error).
* Directories: `is_dir` with size and mtime only. FIFOs, sockets and devices are
  InvalidArgument (a FIFO would block the read).
* `max_bytes` 0 means 1 MiB, larger is clamped to 1 MiB, negative is InvalidArgument.
  Images come back as bytes like anything else.
* `mime_type`: our own extension table (markdown, html, css, js/ts, json, yaml, toml,
  svg, common images, pdf, fonts, archives, audio/video), else
  `http.DetectContentType` (`text/plain; charset=utf-8` for any text). `binary` is a NUL
  in the first 8000 bytes, or a type that is not text (`text/*`, json, xml, yaml, toml,
  svg count as text).

The connect code for "outside home" is InvalidArgument, like ListDirectories and
SearchFiles, rather than PermissionDenied.

## B. ProjectService.GetWorktreeFileDiff

`{project_id, path (worktree), file, old_path, scope}` → `{old, new: FileVersion{present,
contents, truncated, binary}, base_ref, merge_base, head, status, error}`.

* Base: `detailBase` (origin/<default> as `jobBase` resolved it, else the local default
  branch when on another branch), so the diff agrees with `GetWorktreeDetail`'s list.
  Merge base: `mergeBaseOf` reuses the worktree's cached head part when its key (head,
  base ref, base sha) matches, else runs `runMergeBase`, the helper `computeHeadPart` now
  shares. HEAD is resolved with `rev-parse` on every call, not taken from the snapshot,
  so a commit the status job has not seen yet does not pair a fresh tree with an old
  merge base.
* `WORKING`: old = `<merge base>:<old_path>`, new = the file on disk (untracked files
  included; missing = absent). `BRANCH`: old the same, new = `<head>:<file>`.
* **Deviation from the brief, on purpose:** without a base, `WORKING` compares with HEAD
  (and an unborn branch with the empty tree, i.e. old absent) instead of returning
  `error`, because that is what the detail's file list shows in that case (changes
  against HEAD); an error there would leave every row of the panel without a diff.
  `base_ref` and `merge_base` are empty so the GUI can label it. `BRANCH` without a base
  sets `error` ("the worktree has no base branch to compare with", "HEAD has no merge
  base with origin/main", "the branch has no commits yet") with empty sides.
* Git sides: `git --literal-pathspecs ls-tree -z --long --full-tree <rev> -- <path>`
  (type and size; no output for a missing path, exit 0), then `git cat-file blob <oid>`.
  A tree or submodule at the path is absent. Disk side: `Lstat`; a symlink reads as its
  target (what git stores), and a path through a symlinked directory that leaves the
  worktree is absent (git would not follow it either).
* Caps: 1 MiB per side (`truncated`). A blob over 32 MiB is not read at all (present,
  truncated, no contents): the runner buffers a command's whole stdout.
* `status` from the two sides: A, D, R (both present, `old_path` ≠ `file`), M (contents
  differ, or either side truncated), "" (equal or both absent).
* `file`/`old_path` must be local relative paths (`filepath.IsLocal`); `../x`, `/etc/x`
  and empty are InvalidArgument. Unknown worktree NotFound; a project without git
  FailedPrecondition. Not cached; 3 to 6 git processes per call (rev-parse, maybe the
  default-branch rev-parse, maybe merge-base, ls-tree + cat-file per git side).

Scratch daemon, worktree `feat/viewer` (one commit: README edit, `git mv names.txt
greek.txt`, `logo.png`; then README edited again, `gone.txt` removed, `notes.md`
untracked); contents base64-decoded, shas cut:

```
README WORKING   old "hello\n"  new "hello\nbranch\ndirty\n"  base origin/main mb c6d3bc2477 head ddc0461310 status M
README BRANCH    old "hello\n"  new "hello\nbranch\n"                                                        status M
greek.txt BRANCH (old_path names.txt)  old "one\ntwo\n"  new "one\ntwo\n"                                     status R
gone.txt WORKING old "bye\n"    new absent                                                                   status D
notes.md WORKING old absent     new "todo\n"                                                                 status A
notes.md BRANCH  both absent                                                                                 status ""
logo.png BRANCH  old absent     new "\x89PNG\r\n\x1a\n\0\0" binary                                           status A
file "../x"      invalid_argument: file "../x" must be a path inside the worktree
```

## C. GhService.GetPullRequestDiff / GetPullRequestFile

* `PullRequest.base_sha` (GraphQL `baseRefOid`, in `PullRequestSummary`, so both the poll
  detail and the full query have it). The SQLite cache is JSON (`baseSha,omitempty`): an
  old row decodes with it empty until the next fetch; no migration.
* `GetPullRequestDiff {repo_slug, number, refresh}` → `{diff, head_sha, base_sha,
  truncated, fetched_at}`: REST `GET repos/{o}/{r}/pulls/{n}` with `Accept:
  application/vnd.github.v3.diff`. Cached in memory per pull request (16 kept), served
  when its head equals the head of the cached `FullPullRequest` (memory or SQLite, what
  `GetPullRequestDetail` returns); `refresh` always fetches; a pull request whose head is
  not cached at all is fetched every time. So the GUI should load the detail first (the
  PR tab does), and re-read the diff on `pull_request_detail_updated`. 4 MiB cap, cut back
  to the last whole line. GitHub refuses diffs over its limits with HTTP 406
  (`RESTRaw` maps 406 and 422 to `ErrFailedPrecondition` → FAILED_PRECONDITION with
  GitHub's message). Cross-repository pull requests use the same endpoint.
* `GetPullRequestFile {repo_slug, ref, path}` → `{contents, truncated, binary,
  not_found}`: REST `GET repos/{o}/{r}/contents/{path}?ref={sha}` with `Accept:
  application/vnd.github.raw+json`. `ref` must be a full commit SHA (so a cached file
  never goes stale), `path` repository-relative (each segment `url.PathEscape`d). For
  the head side of a cross-repository pull request the caller passes the PR's
  `head_repo_slug` as `repo_slug`. 404 is `not_found`; so is a directory, which GitHub
  answers with its JSON listing even under the raw media type (told apart by
  `Content-Type: application/json`; files come back as
  `application/vnd.github.raw+json`). LRU of 128 files / 16 MiB, not-found answers
  included. 1 MiB cap.
* Both go through the worker (`submitFunc`, coalesced by id), `pace`, and `noteResult`, like
  `restWrite`, so auth failures, rate limits and network pauses apply globally.
* `HTTPRunner.send` takes `sendOpts{accept, limit}`; zero values keep the JSON Accept and
  the 32 MiB `maxBody`. It reads one byte past the limit to set `truncated`. Existing
  callers pass `sendOpts{}`; the JSON paths are unchanged (`TestHTTPRunnerRESTRaw` checks
  `REST` still sends `application/vnd.github+json`).

Against this repository (PR #171, `GetPullRequestDetail` first):

```
detail   head 1da04e1f… base 8c32657e… (base_sha new)
diff #1  84093 bytes, "diff --git a/docs/notes/detail-from-status.md …", truncated false   # 757 ms, one REST GET
diff #2  same fetched_at, no request (cached by head)
file     docs/notes/detail-from-status.md @ head: 9769 bytes, text
file     docs @ head: not_found (JSON listing)       file nope.txt: not_found (404)
```

## D. Open in editor / reveal a file

`OpenEditorRequest` and `RevealRequest` gain `file` (absolute or worktree-relative,
must be under home after following symlinks; `gitops.Options.Root`, default
`fsx.HomeRoot()`) and, for OpenEditor, `line` (0 = none). The store methods take
`OpenOptions` now.

* Reveal with a file: `open -R <file>`.
* OpenEditor resolves the editor exactly as before but with `PathPlaceholder` as the
  path, which yields the argv template; the folder case then substitutes the worktree
  (identical argv to before; the existing tests pass unchanged), the file case runs
  `editorArgs`: VS Code, VS Code Insiders, Cursor, Windsurf get `-g file:line` (`-g`
  inserted before the path argument), Zed and Sublime Text `file:line`, everything else
  (`open -a App`, IntelliJ, Nova, …) only the file. A configured command with `{path}`
  gets `file:line` in place of `{path}`.
* Commands: `worktree.open.editor --file <path> --line <n>` and `worktree.reveal --file
  <path>` (optional `Path` and `Int` args; the CLI makes a relative file absolute against
  its own cwd; a negative line is invalid). The palette still opens the worktree.

Not exercised against the scratch daemon: both would open Finder or an editor on the
desktop. `TestRevealOpenURLEditor` runs them with a fake runner (argv checked) and
`TestEditorArgs` covers each editor family.

## Gotchas

* **The gh worker paces every request** (`MinGap`, about a second apart in the log
  above). A PR file diff needs two `GetPullRequestFile` calls (base and head), so the
  first view of a file costs two paced requests; later views hit the cache. The GUI
  should show the diff text (`GetPullRequestDiff`) first and fetch full files only when
  asked to expand context.
* The diff's `head_sha`/`base_sha` are the cached detail's at fetch time, not parsed from
  the diff. GitHub's diff is against the merge base, while `base_sha` is the base
  branch's tip. A full old-side file fetched at `base_sha` can differ from the diff's
  old side when the base moved after the branch point. If PR 5 needs them to match, the
  merge base is `git merge-base` locally (when both commits are fetched) or REST
  `compare/{base}...{head}`'s `merge_base_commit`; neither is in this PR.
* `FileVersion` fields are named `old` and `new`; in TS that is `res.old` / `res.new`,
  which is legal as a property name.
* Truncated sides compare as different (status M) even when the first MiB is equal.
