# Adding projects PR 1: path completion and folder picker

> **Superseded (2026-10-10):** `repo.register` (`code-foundry repo register --path`) was removed. Add a folder with `code-foundry repo add <folder>` on the CLI, or the Add Project dialog (`repo.add`) in the app; see `add-project-remove-register.md`. Mentions below are historical.

Status: done on branch `cf/add-project-paths`. First of the four PRs in
`add-project-handoff.md` ("PR 1: path completion and folder picker"). `make check`,
`make gui-e2e` and `make gui-build` green; exercised against a scratch daemon (below).

## What landed

| Path | What |
|---|---|
| `proto/codefoundry/v1/filesystem.proto` | `FilesystemService.ListDirectories(prefix)` -> entries (`path`, `name`, `is_git`, `registered`), `completion`, `truncated` |
| `internal/fsx` | `Within` (the home boundary, case-insensitive), `HomeRoot`/`ResolveRoot`, `Lister.List` (completion). Table tests over a temp tree |
| `internal/api/filesystem.go` | Thin handler: builds the registered set from the repo snapshot (repo paths and their worktree paths), maps `fsx.ErrInvalidArgument` to `InvalidArgument` |
| `internal/store/repo` | `Options.AllowedRoot` (default `$HOME`); `Register` refuses a resolved path, or a main worktree, outside it: "<path> is outside your home directory" |
| `internal/store/repo/repotest` | `Fake.AllowedRoot` (optional, lexical) |
| `internal/daemon` | Resolves home once (`fsx.HomeRoot`) and passes it to the repo store and the Filesystem handler |
| `gui/pickdir.go` | `AppService.PickDirectory(startDir)`: `app.Dialog.OpenFile()` with directories only, attached to the window as a sheet, opened at the nearest existing ancestor of the typed path (else home); "" on cancel |
| `gui/frontend/src/api/filesystem.ts` | View models, `listDirectories`, `PathRejectedError` (InvalidArgument) |
| `gui/frontend/src/palette/paths.ts` | Pure: `typedDir`, `entryPath`, `descendInto`, `tabCompletion` |
| `gui/frontend/src/components/palette/usePathListing.ts` | 100ms debounced listing, `useAppHost` |
| `gui/frontend/src/components/palette/CommandPalette.tsx` | Folder suggestions under every `path` prompt, Tab / `/` / Enter, folder button |
| `gui/frontend/mock/filesystem.ts` | ListDirectories over a fake home (same rules as fsx); `repo.register` in the mock refuses paths outside it |
| `gui/frontend/e2e/paths.spec.ts` | Tab completion, `/` descent, Enter on an entry, dotdirs, outside home, the 200 bound |

## Decisions

* **The package is `internal/fsx`, not a store.** It owns no process and publishes
  nothing; it is the rules (boundary + completion) shared by the repo store and the
  handler. The handler passes `Registered` as a closure over the repo snapshot, so fsx
  does not import the repo store (the repo store imports fsx for `Within`).
* **One root for both "~" and the boundary.** `Lister.Root` is what `~` expands to and
  the allowed root. In the daemon both are the resolved `os.UserHomeDir()`; tests point
  it at a temp dir.
* **Boundary checks after symlinks.** `Register` checks the resolved directory and then
  the resolved main worktree, so a symlink under home pointing outside, and a linked
  worktree under home of a repository outside it, are both refused. ListDirectories
  resolves the listed directory before the check, so `~/escape/` (a symlink out) is
  `InvalidArgument`; a symlinked entry is listed (with its target's `is_git` and
  `registered`) because listing a name leaks nothing and Register refuses it anyway.
* **Case-insensitive boundary.** `Within` compares the root prefix with `EqualFold`,
  like APFS, so `/users/alex/x` is inside `/Users/alex`.
* **A missing directory is an empty listing, not an error**, as long as it would be
  inside home (the user is typing towards it). Unreadable directories (TCC-protected
  `~/Library/...`, permission denied, a file) are empty too.
* **A prefix without a trailing slash lists its parent**, so `/Users/alex` (no slash) is
  refused as outside home; `/Users/alex/` and `~` work. "" and `~` both mean `~/`.
* **Completion** is computed over every match (before the 200 cut), case-insensitively,
  spelled like the first match: `~/co` with `Code` and `code-foundry` completes to
  `~/Code`. With one match it is that entry plus `/`.
* **Registered includes worktree paths.** Registering a worktree registers its
  repository, so it already counts as added.
* **Palette keys.** `Enter` submits what is typed (the "Use …" row stays highlighted
  first); `ArrowDown` + `Enter` submits a folder; `Tab` descends into the highlighted
  folder, else extends to the common completion (fetching right away if the debounced
  listing is not for this input yet); `/` on a highlighted folder descends into it,
  otherwise it is just typed. Path values lose a trailing slash on submit.
* **Stale listings** stay visible while the next request is in flight only while they
  list the same directory (`typedDir` equal); after descending they would name wrong
  paths.
* **Folder button** only when `appInfo()` answers (the Wails host). It fills the input
  with the absolute path; the user still presses Enter and the daemon validates it.
* **Errors in the list.** A refused prefix shows the daemon's reason; a daemon without
  FilesystemService (the GUI updated, the daemon not restarted) shows the usual
  "restart the daemon" message; anything else shows nothing.

## Verification

* `go test ./internal/fsx ./internal/store/repo ./internal/api ./internal/daemon ./gui`
  (new table tests: `TestList`, `TestListFlags`, `TestWithin`, `TestCommonFoldPrefix`,
  `TestRegisterAllowedRoot`, `TestFilesystemListDirectories`, `TestPickStart`; the
  daemon e2e now also checks the boundary and ListDirectories).
* Scratch daemon (`CODE_FOUNDRY_HOME=/tmp/cfp-home`): `code-foundry repo register --path
  /tmp` -> "invalid argument: /tmp is outside your home directory"; registering a
  worktree under `~/projects` registered `code-foundry`; ListDirectories over loopback
  returned `~/projects/code-foundry/` with `isGit` and `registered`, and `/etc/` was
  `invalid_argument`.
* `make gui-e2e` (WebKit + Chromium) including `e2e/paths.spec.ts`.
* Not verified: the native folder dialog. It cannot be driven headless; the browser e2e
  only checks the button is absent without the Wails host. Check it by hand in the app.

## Gotchas

* `TestRegister*` and every repo-store harness now set `AllowedRoot` to `os.TempDir()`;
  the workspace store's git test and the daemon e2e (which sets `HOME` to its temp dir)
  were updated the same way. A new test that registers a temp-dir repo through the real
  store needs one of the two.
* Go's build cache keys cgo packages on flags, not on the `.pc` file pkg-config reads, so
  a worktree can link against another checkout's `third_party/ghostty-vt` path (here
  `/tmp/cf-bare-binary`, since deleted). Workaround used: `make check
  CGO_LDFLAGS="-mmacosx-version-min=13.0 -L$PWD/third_party/ghostty-vt/lib"`, which
  changes the key. `go clean -cache` also works.
* Wails v3 beta.28 has no package-level `application.OpenFileDialog()`; it is
  `application.Get().Dialog.OpenFile()`. Cancel returns `""` with no error.
