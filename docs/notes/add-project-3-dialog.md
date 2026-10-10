# Adding projects PR 3: the Add Project dialog and GitHub clone

Status: done on branch `cf/add-project-dialog` (off the handoff commit after PRs 1 and 2
merged). PR 3 of `add-project-handoff.md`. `make check`, `make gui-e2e` and
`make gui-build` green; exercised against a scratch daemon with the CLI and the GUI
(below).

## What landed

| Path | What |
|---|---|
| `internal/paths` | `Projects()` = `<config home>/projects` (clones `<owner>/<repo>`, PR 4's new projects `<name>`) |
| `internal/store/gh/search.go`, `queries/search_repositories.graphql`, `queries/lookup_repository.graphql`, fragment `RepositoryCard` | `Finder`: `SearchRepositories(query)` (GraphQL `search(type: REPOSITORY, first: 20)`) and `LookupRepository(owner, name)`, one paced request each on the store's worker, never cached |
| `internal/store/gh/reporef.go` | `ParseRepoRef`: `owner/repo`, `https://github.com/owner/repo[.git]`, `github.com/owner/repo`; refuses ssh, http and other hosts |
| `internal/store/gh/ghtest/search.go` | Fake `Finder` |
| `internal/store/clone` | `Cloner`: `gh repo clone <owner>/<name> <dest> -- --progress` with streamed output lines, the destination rules, cleanup, register; `clonetest.Fake` |
| `proto/codefoundry/v1/repo.proto` | `RepoService.SearchGitHub`, `LookupGitHub`, `Clone` (server streaming `CloneRepoEvent`: `progress` lines, then `repo`); `GitHubRepository` (with `clone_path`, `clone_path_exists`), `RepositoryVisibility` |
| `internal/api/repo_github.go` | Handlers; `CloneRepo` / `CloneRef` (no stream) back the `repo.clone` command |
| `internal/command/commands_repo_add.go` | `repo.add` (Title "Add Project"; the GUI presents it as the dialog, the CLI prints a hint) and `repo.clone <repo>` |
| `internal/command/commands_repo.go` | `repo.register` is now "Add Project (local folder)", path described as "Project folder (a git repository or any folder)" |
| `cmd/code-foundry/clone.go` | `cliPresenters`: `repo.clone` streams `RepoService.Clone` and prints progress |
| `internal/daemon` | The cloner (gh from `advanced.gh_path`, else PATH, else Homebrew), wired into the Repo handler and `all.Deps.Clone` |
| `gui/frontend/src/lib/githubRef.ts` | `parseGitHubInput`: repo / search / error, table tested |
| `gui/frontend/src/api/addProject.ts` | View models, `searchGitHub`, `lookupGitHub`, `cloneRepo` (stream), `appendProgress` |
| `gui/frontend/src/components/addproject/*` | The dialog: tabs New (placeholder), Local folder, GitHub |
| `gui/frontend/src/components/palette/pathCompletion.tsx`, `usePathListing.ts` | Path completion factored out of the palette: `usePathCompletion`, `PathSuggestions`, `PickFolderButton` (the palette and the Local folder tab share them) |
| `gui/frontend/src/stores/addProject.ts` | Open state, `registerFolder`, `selectAddedProject` |
| `gui/frontend/src/keys/bindings.ts` | Presenters: `repo.add` opens the dialog, `repo.clone` opens it on GitHub (and replaces its palette prompt) |
| Entry points | Palette `repo.add`; title band button `sidebar-add-project` (beside New thread; the band has no New terminal button since #21); Projects page "Add project"; the project picker's empty state |
| `gui/frontend/mock/clone.ts` | Mock GitHub (12 repositories), lookup, search, clone (5 lines over ~1.5 s; `fail` fails; `octo-org/already-here` exists); `GET /__mock/github/calls` |
| `gui/frontend/e2e/addproject.spec.ts`, `e2e/live-addproject.spec.ts` | 8 mock tests per engine; an opt-in live clone |

## Decisions

* **The clone store is its own package (`internal/store/clone`)**, not part of the repo
  store: it owns one kind of process (gh) and no state but the in-flight set, and
  registers through `repo.Store.Register` like any caller. Nothing to publish: the
  registration publishes the repo.
* **Destination rules, in order:** valid `owner/name` (`gh.NormalizeSlug`, which also
  rules out `.`/`..`); not already being cloned (case-insensitive, `FailedPrecondition`);
  nothing at the destination (`AlreadyExists`); the projects directory created 0700 and
  resolved under the allowed root (home) *before* anything is downloaded, so a
  `CODE_FOUNDRY_HOME` outside home fails fast instead of after the download (Register
  would refuse it anyway). The owner directory is created 0700 too.
* **Failure cleanup:** on any gh failure, timeout or cancellation, the destination is
  removed (it did not exist before; the in-flight claim keeps two clones apart), and the
  owner directory too if this clone created it and it is empty. A failed *registration*
  keeps the clone and says so ("cloned into X but could not add it as a project").
  Registration runs on a fresh 30 s context, so a client that disconnects right after the
  download does not leave an unregistered clone.
* **Output streaming:** stdout and stderr go through one line splitter. A line ending in
  `\r` (git's counters) is `transient`; the GUI replaces it with the next line, the CLI
  redraws it in place on a terminal and drops it otherwise. `\r\n` re-sends the line as
  final. Errors carry the last 8 final lines (plus a dangling transient one).
* **Error codes:** `AlreadyExists` (destination), `NotFound` (gh says "Could not resolve
  to a Repository"), `InvalidArgument`, `FailedPrecondition` (busy, outside home),
  `DeadlineExceeded` (15 min), `Canceled`, `Unknown` with gh's tail for everything else.
  A lookup of a missing repository is a plain `NotFound` (the GraphQL partial-result
  wrapper is dropped).
* **Clone is a short-lived stream**, outside the "one Watch + one Attach" budget only while
  a clone runs. Closing the dialog cancels it (the daemon kills gh and removes the
  partial clone); the dialog says so while it runs. Switching tabs does not (the GitHub
  tab stays mounted).
* **`repo.clone` on the CLI is a CLI presenter** (`cmd/code-foundry/clone.go`): the verb,
  flags and help still come from the registry, but it calls `RepoService.Clone` itself so
  progress prints as it happens; `Invoke` would answer only at the end. The command's
  `Run` (used by anything that invokes it) clones without progress. In the GUI, both
  `repo.add` and `repo.clone` are presenters that open the dialog, so the palette never
  runs a 15-minute unary Invoke.
* **One "Add Project" in the palette:** `repo.add`. `repo.register` keeps the palette path
  prompt as "Add Project (local folder)".
* **GitHub input:** Enter (or the Look up / Search button) is the only trigger. An exact
  `owner/repo` or a github.com URL looks up (a card, already selected); other text
  searches (a list; picking one shows its card, Back returns to the list). ssh, http and
  other hosts are refused locally with the accepted forms. Text with a space, `a/b/c`,
  `user:x` and the like are searches; `c++/rust` (not a valid pair) too.
* **Destination already there:** search and lookup carry `clone_path` and
  `clone_path_exists` (the daemon stats it), so the list says "already cloned" and the
  card offers **Add existing folder** (`repo.register` on that path) instead of Clone.
* **After success** the dialog closes and selects the new project's overview once the repo
  event has arrived (`selectAddedProject` waits up to 5 s for the repos store).
* **New tab** is a disabled placeholder ("Coming soon"). The dialog opens on Local folder.
* **Visibility** is an enum (`RepositoryVisibility`), ready for PR 4's publish picker.

## Gotchas

* **Clones must land under home.** With `CODE_FOUNDRY_HOME=/tmp/...` the projects
  directory is outside home and every clone fails with "outside your home directory".
  Use a scratch home under `$HOME` (e.g. `~/.cf-clone-scratch`) for live checks.
* **Focus in the GitHub tab** moves to the input one frame after the tab activates: a
  click on the tab trigger focuses the trigger after Radix switched tabs on mousedown.
* **The palette test that typed "add project"** now finds `repo.add` first;
  `e2e/paths.spec.ts` types "add project local folder".
* **`go test` against a stale cgo cache** (see add-project-1-paths.md): this worktree
  needed its own `third_party/ghostty-vt` copy plus `CGO_LDFLAGS=-L…/lib`.
* **The CLI presenter skips the daemon's argument validation**, so `repo clone` with no
  repository reports ParseRepoRef's "no repository given" rather than "missing required
  argument".

## Verified

* `make check` green (new Go tests: `TestParseRepoRef`, `TestSearchAndLookup`, the decode
  fixtures captured from GitHub, `TestClone` (9 cases), `TestCloneBusyAndCancel`,
  `TestLineWriter`, `TestExecRunner`, `TestSearchAndLookupGitHub`, `TestCloneStream`,
  `TestCloneRef`, `TestRepoAddAndClone`, `TestPresentClone`, CLI e2e rows; vitest
  `githubRef.test.ts`, `addProject.test.ts`).
* `make gui-e2e` 310/310 (WebKit + Chromium), including `e2e/addproject.spec.ts`: every entry
  point, tab order and New's placeholder, Local folder completion + register + error,
  lookup (owner/repo and URL, case), missing repository, ssh and other-host refusals,
  no request while typing (`/__mock/github/calls`), search + pick + back, clone success
  with streamed lines and the new project opened, clone failure with the transient line
  and gh's error, existing destination added as a folder.
* Scratch daemon (`CODE_FOUNDRY_HOME=~/.cf-clone-scratch`, `bin/code-foundry daemon
  --dev`): `code-foundry repo clone alexwaumann/dotfiles` printed git's progress and
  "cloned dotfiles into ~/.cf-clone-scratch/projects/alexwaumann/dotfiles", the project
  registered (git, `main`, slug `alexwaumann/dotfiles`); the URL form then answered
  "already exists"; `alexwaumann/does-not-exist-xyz` printed gh's "Could not resolve"
  and left nothing behind; the projects dir is `drwx------`. SearchGitHub and
  LookupGitHub over loopback returned the expected repositories and a clean NotFound.
* `e2e/live-addproject.spec.ts` against that daemon and the Vite dev server: searched
  `dotfiles user:alexwaumann`, looked up the `.git` URL, cloned with the dialog (progress
  streamed), landed on `dotfiles@main`, then unregistered and deleted it.

## Not verified

* A large clone's transient counters in the dialog and the CLI's in-place redraw on a
  real terminal (the small repository finished its counters at once; covered by unit
  tests and the mock).
* The new title band button in the real Wails window (drag region): the button sits in
  the existing `no-drag` controls span like its neighbours; check by hand.
* The native folder picker in the Local folder tab (same component as the palette's; it
  cannot be driven headless).
