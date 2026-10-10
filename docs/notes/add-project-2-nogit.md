# Adding projects PR 2: projects without git, and remoteless repositories

Status: done on branch `cf/add-project-nogit` (off `main` at the handoff commit). PR 2 of
`add-project-handoff.md`; built in parallel with PR 1 (path completion and the home-only
boundary in `repo.Register`, which this PR does not touch). `make check`, `make gui-e2e`
and `make gui-build` green; exercised against a scratch daemon (below).

## What landed

| Path | What |
|---|---|
| `proto/codefoundry/v1/repo.proto` | `Repo.git` (10); `RepoService.InitGit(InitGitRequest{id}) -> InitGitResponse{repo}` |
| `internal/store/repo/nogit.go` | `probeGit`, the synthetic checkout, `requireGit` / `ErrNotGit`, `Git.InitGit`, `InitRepository` (exported for PR 4's `repo.Create`) |
| `internal/store/repo/store.go` | `Register` accepts a plain directory (`projectRoot`); `repoMeta.Git` (seeded on load and register, kept by reconcile); reconcile branches on `.git`; status/base no-ops, no watches, poll reconciles; worktree/ref ops refuse; default branch from `HEAD` without origin |
| `internal/store/repo/types.go`, `base.go`, `detail.go` | `Repo.Git`, `Store.InitGit`, `Snapshot.Owner`; base and detail refuse/skip without git |
| `internal/store/repo/repotest/fake.go` | `NotGit` (Register makes plain projects), `InitGit`, git checks in `CreateWorktree` / `ListRefs` |
| `internal/store/workspace`, `internal/store/session` | `workspace.RequireGit`: Create, AddRepo and new-workspace threads refuse a plain project; `session.Create` with a new worktree refuses before the namer runs |
| `internal/api/repo.go` | `InitGit`, `git` in the proto mapping |
| `internal/command/commands_repo.go`, `commands_repo_git.go`, `commands_gitops.go`, `all/all.go` | `NotGitFunc`; `repo.git.init`; `repo.worktree.*`, `git.*`, `pr.*` gated with a reason; `all.Deps.NotGit` |
| `internal/daemon/daemon.go` | `NotGit` from the repo snapshot (`Snapshot.Owner`) |
| `gui/frontend/src/api/repo.ts` | `RepoView.git`, `isRemoteless` |
| `gui/frontend/src/components/projects/NoGitBadge.tsx` | The "No git" pill |
| `gui/frontend/src/lib/threadRow.ts`, `components/sidebar/SidebarRow.tsx` | `noGit` in the row model; the badge in thread rows; "<project> · No git" for terminal rows |
| `gui/frontend/src/components/projects/WorktreeState.tsx`, `ProjectsPage.tsx` | Folder icon + badge + path instead of branch/status/PR |
| `gui/frontend/src/components/overview/WorktreeOverview.tsx` | `NoGitBody` (Not a git repository + Initialize Git); `PublishToGitHub` (disabled, "Coming soon") for a remoteless git repo |
| `gui/frontend/src/components/compose/*`, `lib/compose.ts`, `stores/compose.ts` | Only Current checkout for a plain project (`threadPlace` honours `noGitCheckout`); no refs load, no base, no Also in; Also in and `repoSource` know about git |
| `gui/frontend/src/lib/projects.ts` | `addableRepos` leaves out plain projects (workspace Add project) |
| `gui/frontend/mock` | `repo-wr` "writing" (`~/Documents/writing`, no git), `repo.git.init`, `RepoService.InitGit`, git checks; `repo-sk` "sketches" stays the remoteless git repo |
| `gui/frontend/e2e/nogit.spec.ts`, `e2e/live-nogit.spec.ts` | 4 mock tests per engine; opt-in live test |

## Decisions

* **Git or not is `.git` at the project path.** Reconcile stats `<path>/.git` (`probeGit`)
  and runs no git command when it is missing. A registered git repository is always its
  main worktree, which always has `.git`, so the stat is exact for every project the store
  can hold. `load` seeds `Git` the same way, so at daemon start a git project is never
  published as one without git while its first reconcile is pending.
* **Register decides with git's own answer.** `rev-parse --git-common-dir` failing with
  exit 128 and "not a git repository" means a plain directory; any other failure (git
  missing, dubious ownership) is still an error, not a silent plain project. A file
  outside a repository is refused ("is not a directory"); a file inside one still maps to
  its repository as before. Bare repositories are still refused.
* **The synthetic checkout** is one `Worktree{Path: project path, IsMain: true}` with an
  empty branch and head and a zero `Status` (`RefreshedAt` zero too). Status and base jobs
  return at once for it; `WorktreeDetail`, `ListRefs`, `CreateWorktree` and
  `RemoveWorktree` fail with `ErrFailedPrecondition` wrapping `ErrNotGit`.
* **Detecting `git init` outside the app is the poll.** A plain project has no watches;
  the 30 s poll loop requests its reconcile (a stat) every round, like a repo in error. No
  fsnotify watch on the folder: kqueue opens a descriptor per entry of a watched
  directory, and a plain folder can be large (it could be `~/Documents`). In-app
  `repo.git.init` refreshes right away.
* **The flip reseeds the worktree slot** from `git worktree list`, so the first event after
  `git init` already carries the branch (no "git project with an empty branch" frame).
* **InitGit lives in the repo store** (stores own processes): `git config --get
  init.defaultBranch` (else `main`), `git init --quiet -b <branch>`, `git commit --quiet
  --allow-empty -m "Initial commit"`, refresh. The user's git config applies (identity,
  signing, hooks). If the commit fails after a successful init, the project is refreshed
  (it is a git project now, on an unborn branch) and the error says the commit failed.
  `InitRepository` is exported for PR 4's `repo.Create`.
* **Default branch without origin** is `git symbolic-ref --quiet --short HEAD` in the main
  worktree (an unborn branch included), falling back to the old chain (local main/master,
  the main worktree's branch, "main") when HEAD is detached. With origin nothing changed:
  `origin/HEAD` first. `ListRefs` before the first reconcile asks `remote get-url origin`
  to pick the rule. Consequence: in a remoteless repo whose main checkout sits on a
  feature branch, new worktrees branch from that feature branch.
* **CreateWorktree's start-point fetch without remotes** was already a no-op
  (`fetchStartPoint` lists remotes and returns when the ref names none); the existing
  `TestCreateWorktreeFetchInLocalOnlyRepo` covers it. Remoteless repos needed nothing else
  in the store.
* **Commands get `NotGitFunc`** (a context predicate, like gitops' `LocalOnly`); the daemon
  answers it from the repo snapshot through `Snapshot.Owner` (the repo with a worktree at
  the active path, else the active repo id). `repo.git.init` is available only when it is
  true; `repo.worktree.new/remove`, `git.fetch/pull/push` and `pr.*` only when false, with
  "project is not a git repository" as `WhyUnavailable` (before "repository has no
  remote", which a plain project also is). `worktree.open.editor`, `worktree.reveal`,
  `terminal.new`, `session.new` stay available.
* **The composer's worktree options are GUI-side**, from the repo view model, as before:
  `threadPlace` gets `noGitCheckout` and always answers the existing checkout for a plain
  project (ignoring any draft worktree, base or Also in), so `session.new` is sent with
  `worktree=<path>` only. The daemon refuses `new-worktree` there anyway, before the
  namer runs, so the CLI gets the same rule.
* **Workspaces refuse plain projects in the stores** (`workspace.RequireGit` in Create and
  AddRepo, the session store's new-workspace path), and the GUI hides them from Add
  project and Also in. Remoteless git repos stay eligible.
* **Diff, Files and Pull request surfaces** needed nothing: Diff and Files are still
  always disabled, and the Pull request surface needs a GitHub slug, which a plain
  project never has. The overview never asks for a plain project's detail.
* **Publish to GitHub** shows for `git && no remotes && reconciled` (`isRemoteless`), in
  the GitHub activity section where "No GitHub remote" used to be. It is a plain disabled
  button (not a command yet); the tooltip sits on a wrapper span because a disabled button
  gets no hover events in every engine. PR 4 replaces it with `repo.github.publish`.

## Gotchas

* **protojson omits `git: false`.** `repo register --json` for a plain folder has no
  `git` key; read a missing key as false.
* **The mock's fifth project is named "writing"** so it sorts last: existing tests pick
  projects by position (⌘4 is still sketches).
* **Two Playwright runs in one checkout clash** on `test-results/` (one deletes the
  other's artifacts). Run the live spec after `make gui-e2e`, not alongside.

## Verified

* `make check` green; Playwright (mock) all green on WebKit + Chromium, including
  `e2e/nogit.spec.ts`: both overviews, Initialize Git from the overview button, the
  composer, the sidebar row, the workspace pickers.
* Scratch daemon (`CODE_FOUNDRY_HOME=/tmp/cf-nogit-home`, `bin/code-foundry daemon --dev`)
  with plain folders under `~/cf-nogit-scratch/`:
  * `repo register --path ~/cf-nogit-scratch/notes-folder --json`: one main worktree, no
    branch, no `git` key (false). `repo worktree new` and `git push` answered "not
    available in this context: project is not a git repository"; `workspace new demo
    --repos <id>` answered "notes-folder is not a git repository; workspaces need git in
    every project". `repo git init --context-repo <id> --json`: `git: true`, default
    branch `main`, main worktree on `main` with the README untracked; `git log` shows the
    one empty "Initial commit". A second `repo git init` answered "project is already a
    git repository".
  * `e2e/live-nogit.spec.ts` (WebKit, Vite dev server on the scratch daemon) with
    `~/cf-nogit-scratch/drafts-folder`: registered by the CLI, a terminal there showed
    "drafts-folder · No git" in the sidebar, the Projects page showed the folder icon and
    the badge, the overview showed Not a git repository with Initialize Git enabled; after
    `repo git init` by the CLI the open overview became `drafts-folder@main` with the sync
    line, files and a disabled Publish to GitHub, and the terminal row read
    "drafts-folder · main".

## Open

* The Initialize Git button was clicked only against the mock; against the real daemon
  `repo.git.init` ran from the CLI (same command, same RPC).
* A plain project inside a later-initialized parent repository stays a plain project
  (its own `.git` is what counts); re-registering the parent registers the parent.
