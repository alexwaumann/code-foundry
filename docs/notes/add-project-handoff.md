# Adding projects: design handoff

Decided with Alex on 2026-10-10. Four PRs, each on its own `cf/<name>` branch off `main`
with a `docs/notes/add-project-<n>-*.md` note. Alex's answers to the open questions are
folded in below; do not reopen them.

## Problem

`repo.register` is a one-argument palette prompt with no completion, and the daemon
refuses anything that is not inside a git repository. There is no way to clone from
GitHub or to start a new project from the app. T3 Code (the reference) allows non-git
projects ("Turn diffs are unavailable because this project is not a git repository"),
offers an "Initialize Git" button, has a "New project" action that runs `git init` from a
name, and clones by `owner/repo` or URL into a picked folder. We copy that shape.

## Fixed decisions

* **Home only.** Every project path (register, clone destination, new project) must
  resolve (symlinks followed) to a directory under the user's home. Enforced in the
  daemon, so the CLI obeys too. No escape hatch. The allowed root is a store option
  (`repo.Options.AllowedRoot`, default `$HOME`) only so tests can use temp dirs.
* **Where clones and new projects live. Not configurable.**
  `~/.code-foundry/projects/<owner>/<repo>` for clones,
  `~/.code-foundry/projects/<name>` for new projects (`paths.Projects()`).
* **Non-git projects are a synthetic single checkout.** `Repo.Git == false`, one
  `Worktree` entry at the project path with `IsMain: true`, empty branch and head, zero
  status. Threads and terminals run there ("Current checkout" only). The state must be
  obvious: a "No git" badge where a branch would show (sidebar, Projects page), the
  overview replaces branch/status/worktree sections with "Not a git repository" and an
  **Initialize Git** button, the composer shows only Current checkout. Nothing renders an
  empty branch or a zero status as if it were real.
* **Remoteless git repos** keep working (worktrees under `worktrees/_local/` already do).
  Fetch is skipped, the default branch comes from `HEAD` of the main worktree, PR/CI UI
  stays hidden (slug gating already exists), and the overview shows **Publish to GitHub**.
* **Workspaces exclude non-git projects** from member pickers. Remoteless git repos stay
  eligible.
* **gh CLI for clone and create** (`gh repo clone`, `gh repo create`), so the user's auth
  and protocol settings apply. **In-process GraphQL** (existing `internal/store/gh`
  transport) for repository search and lookups.
* **GitHub input accepts only** an `https://github.com/owner/repo[.git]` URL, `owner/repo`,
  or the search box. No ssh URLs (work policy is https only), no other hosts.
* **Search is Enter-to-search.** Exact `owner/repo` text is looked up immediately on
  Enter too. Never a request per keystroke.
* **Dialog tabs, in order: New, Local folder, GitHub.** Entry points: `repo.add` in the
  palette, the Projects page button, the project picker's empty state, and a button in
  the top bar next to New thread and New terminal.
* **Publish visibility picker (revised 2026-10-10):** read the owner org's
  `members_can_create_{public,internal,private}_repositories` from REST
  `GET /orgs/{org}` with the existing token. Those fields are returned only to org
  owners. When present, offer only the allowed visibilities and default to the most open
  one, order Public > Internal > Private. When absent, offer all three and default
  Public. Personal account: Public / Private, default Public. Private is never the
  default (Alex's org disables it). A refused choice shows gh's error verbatim and the
  picker stays open.
* **Initial commit on init/create** (empty, "Initial commit") so worktrees can be created;
  branch from `git config --get init.defaultBranch`, else `main`.

## PR 1: path completion and folder picker (`cf/add-project-paths`)

* `FilesystemService.ListDirectories(prefix)` (new proto `filesystem.proto`): completes a
  typed prefix (`~`, `~/x`, `/Users/me/x`) to directories under home. Returns entries
  with `path`, `name`, `is_git` (has `.git`), `registered` (already a project), and the
  longest common completion. Dotdirs only when the prefix's last segment starts with
  `.`. Case-insensitive match (APFS). Bounded (200 entries) and sorted. Rejects prefixes
  outside home with `InvalidArgument`.
* Palette `path` argument type: suggestion list under the input (reuse the cmdk list),
  `Tab` completes to the common prefix or the highlighted entry, `/` descends, `Enter`
  submits. Works for every `path` arg (register, worktree remove, ...). Mock daemon
  implements it over a fake tree; Playwright covers tab completion.
* Native folder picker: Wails host `AppService.PickDirectory(startDir)` using
  `application.OpenFileDialog().CanChooseDirectories(true)`, button beside the palette
  input when the Wails runtime is present (hidden in the browser dev mode). Result is
  validated daemon-side like any other path.
* `repo.Register` enforces the home boundary (`AllowedRoot`). Clear error text: "<path>
  is outside your home directory".

## PR 2: non-git and remoteless projects (`cf/add-project-nogit`)

* `repo.Register` accepts any directory under home. Proto `Repo.git bool`. Store: reconcile
  of a non-git repo skips every git command and publishes the synthetic main entry;
  a non-git path that later gains `.git` (Initialize Git) flips to git on refresh.
  Default branch for a repo with no `origin`: `git symbolic-ref --short HEAD` in the main
  worktree. `CreateWorktree` skips fetch when there is no remote.
* `repo.git.init` command (Project category, `When: repo is not git`): `git init -b
  <default>`, empty initial commit, refresh. `repo.worktree.*`, gitops, diff/files
  surfaces gain a `When` / gating on `git`.
* GUI: `git` on the repo view model; the badge, overview, composer, Projects page,
  workspace pickers as described above. Mock daemon gets a non-git project and a
  remoteless project; Playwright covers both overviews.

## PR 3: Add Project dialog and GitHub clone (`cf/add-project-dialog`), after 1 and 2

* Status: PR 1 merged as #18, PR 2 as #20 (2026-10-10). PR 3 built on
  `cf/add-project-dialog`: `docs/notes/add-project-3-dialog.md`.
* `repo.add` command opens the dialog (GUI-only presentation, like `session.new` opening
  the composer). Tabs New / Local folder / GitHub. Local folder = PR 1 completion + picker
  + register. New tab is wired in PR 4 (shows a disabled placeholder until then).
* `RepoService.SearchGitHub(query)` (GraphQL `search(type: REPOSITORY)`, 20 results,
  owner/name/description/visibility/is_archived) and `LookupGitHub(owner, name)`.
* `RepoService.Clone(owner, name)` server-streaming: runs `gh repo clone owner/name
  <projects>/<owner>/<repo> -- --progress`, streams stderr lines, then registers and
  returns the repo. Refuses if the destination exists. Dialog shows progress and the
  error on failure. `repo.clone` CLI verb prints progress.
* GitHub tab input parsing (https URL / owner/repo / free text) is a pure function with
  table tests.

## PR 4: create and publish (`cf/add-project-create`), after 3

* Status: PR 3 merged as #23. PR 4 built on `cf/add-project-create`:
  `docs/notes/add-project-4-create.md`.
* `RepoService.Create(name)` -> `<projects>/<name>`, `git init -b <default>`, initial
  commit, register. `repo.create` command; the New tab.
* `RepoService.Publish(repo_id, owner, name, visibility)` runs `gh repo create
  <owner>/<name> --source <main path> --remote origin --push --<visibility>`, refreshes.
  `repo.github.publish` command (`When: git and no origin`). Owner picker from
  `viewer.login` + `viewer.organizations`. Used by the New tab's optional publish step and
  the overview's Publish to GitHub button.
