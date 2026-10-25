# Workspaces v2, PR 6: the Add Project folder-of-repos scan

Status: done on branch `cf/workspaces-v2-scan` (off `main` after #351, PR 2). Design
record: `workspaces-v2-handoff.md` (§3 Workspace, the rooted managed dir; §6 last bullet;
§8 step 6). Built in parallel with PRs 3 (composer), 4 (Projects page cards) and 5
(skills); it touches none of their files beyond the mock's workspace message.

## What landed

| Path | What |
|---|---|
| `proto/codefoundry/v1/project.proto` | `ProjectService.InspectFolder(InspectFolderRequest{path}) -> InspectFolderResponse{path, is_repo, child_repos[] ChildRepo{path, name}}` |
| `internal/store/project/inspect.go` | `Store.Inspect` (`Folder`, `ChildRepo`) and the pure `ChildRepos(dir)` |
| `internal/store/project/projecttest/inspect.go` | the fake's `Inspect` (`Fake.Folders`, else from disk) |
| `internal/api/project_inspect.go` | the thin handler ("~" expands like Register) |
| `internal/command/commands_project_add_workspace.go` | `project.add-workspace <folder>` (Add Folder as Workspace), `FolderBackend`, `freeWorkspaceName` |
| `internal/command/commands_project.go`, `commandtest`, `all/all.go` | `InspectFolder` on `ProjectBackend` and its fake; the registration |
| `gui/frontend/src/api/addProject.ts` | `inspectFolder` -> `FolderInfoView` |
| `gui/frontend/src/stores/addProject.ts` | `folderOfRepos`, `addFolderAsWorkspace` (the command), `showAddedWorkspace` |
| `gui/frontend/src/components/addproject/FolderChoice.tsx`, `LocalFolderTab.tsx`, `src/lib/folderChoice.ts` | the two-choice state and its lines |
| `gui/frontend/mock` | `~/product` (web, api, docs-site; notes plain) and `~/mixed` (a `broken` child the mock refuses), `InspectFolder`, `project.add-workspace`, a workspace's `rootPath` and `defaultPrimary` |
| `gui/frontend/e2e/addproject-workspace.spec.ts` | the choice, both outcomes, editing drops it, an error in place |

## Decisions

* **Detection is the store's, with git's answer.** `Inspect` resolves the path like
  Register (absolute, symlinks resolved, under home) and asks `projectRoot` (the same `git
  rev-parse` Register acts on), so "is a repo" means exactly "Register would add a git
  repository": a folder inside a repository is a repo even with repositories below it, and
  no scan runs. Only then are the children listed (`ChildRepos`, a pure function over
  `os.ReadDir`, no git): immediate subfolders with a `.git` directory or file, one is
  enough. Hidden children (leading ".") are skipped, and so are symlinked ones: a link can
  lead outside the folder (or home), and Register would add whatever it resolves to. An
  unreadable folder is InvalidArgument; nothing is registered by an inspection.
* **The GUI asks only when it matters.** The Local folder tab inspects the path on every
  add (Enter, the button, Enter on a highlighted folder); a repository or a folder without
  repositories inside goes straight to Register as before. When the inspection fails (an
  outdated daemon, a refused path) the tab registers as before and Register's error is the
  one shown, so a plain folder behaves exactly as it did.
* **The choice**: the path input stays, the folder list and the Add project button make
  way for a heading ("~/product has 3 git repositories inside.") and two buttons in a
  grid, each with its one line beside it: **Add as workspace** (default, focused, so Enter
  takes it) — "The 3 repos inside become projects; this folder is their shared root for
  instructions and skills." (one repo: "The 1 repo inside becomes a project; this folder is
  its root ...") — and **Add as project** (outline) — "One folder. No git features for the
  repos inside." The task's labels ("Add as workspace") over the handoff's ("Add as a
  workspace"): shorter. Editing the path drops the question. Errors show under the
  choices and keep them.
* **`project.add-workspace` is a command** (every user action is one): the GUI invokes
  it, the palette prompts for the folder, the CLI is `code-foundry project add-workspace
  <folder>`. It composes ProjectService and WorkspaceService (InspectFolder, List,
  Register, workspace List and Create) in the command layer, the way other multi-step
  commands do, rather than a new RPC: no store owns both, and the two stores must not
  import each other. Refused with FailedPrecondition for a repository or a folder without
  repositories inside (pointing at `project add`).
* **Children**: registered in parallel (at most 4 at once; each Register reconciles and
  waits for status). One already registered (same path in List) is reused, not
  registered again. A linked worktree child registers its repository; members are deduped
  so two children of one repository do not trip the store's "listed twice".
* **Failure: no rollback, no workspace.** Every child is attempted; if any fails the
  command fails with each failure named and the ones it added listed ("could not add 1 of
  3 repositories in ~/product (docs: ...); no workspace was made; added and kept as
  projects: api, web"), and logs the same at warn. The added projects stay: they are
  useful on their own, unregistering them could drop a project the user added meanwhile
  from elsewhere, and running the command again reuses them. The same holds when the
  workspace's Create fails after the projects were added.
* **The workspace**: `Create{name, members: the project ids, root_path: the folder,
  default_primary: "workspace"}` (explicit, though it is the store's default for a rooted
  workspace). The store makes the managed dir and links the root's `CLAUDE.md`,
  `AGENTS.md` and `.claude` that exist. The name is the folder's; taken
  (case-insensitively, from the workspace List) or reserved (`workspace`) gives "<name>
  2", "<name> 3", ...; control characters become spaces and a long name is cut on a rune
  boundary so the suffix fits the store's 100 bytes. A race with another create of the
  same name fails cleanly with the store's error.
* **After Add as workspace** the dialog closes, a toast says "Added workspace <name>",
  and the Projects page is selected: its existing workspace list shows the new one (PR 4's
  cards replace that list; nothing here depends on its markup). Add as project behaves
  like the plain add (toast, the project's tab on the Projects page).

## Gotchas

* The mock has no WorkspaceService; the spec reads workspaces from `GET /__mock/workspaces`.
* The mock's `~/src` now also has repositories inside, so adding `~/src` itself asks; no
  existing spec added it.
* `connectMessage` already lived in `commands_theme.go`; reused.

## Verified

* `make check` green. Go: `TestChildRepos` (9 rows), `TestInspect` (real git and
  symlinks: a folder of repos, through a link, a repo, inside a repo, a plain folder,
  outside home, missing, empty), `TestProjectAddWorkspace` (rooted workspace, one repo,
  reused children, a taken name, a repo and a plain folder refused, a failing child,
  outside home), `TestFreeWorkspaceName`, the CLI e2e rows (missing folder, outside home),
  `TestAllRegistersEveryDomain`. Vitest: `folderChoice.test.ts`.
* `make gui-e2e` (WebKit, 4 workers) green, including `e2e/addproject-workspace.spec.ts`.
* Live, isolated (`CODE_FOUNDRY_HOME=/tmp/cfv2-gui6`): see the PR body for the run and
  the screenshots (dark and light) of the dialog's two-choice state.
