# Rename repo to project (2026-10-17)

The product has said "project" in its copy for a long time, while the code, wire,
settings, CLI and database still said "repo". This sweep makes project the one name
for a registered folder (git or not), its worktrees and its store. "Repository" survives
only where it means the GitHub repository or a git repository on disk: `repo_slug`,
`head_repo_slug`, `is_cross_repository`, `GitHubRepository`, `RepositoryVisibility`,
`GetRepoActivity`, `TrackGhRepo`, the `repo-slug` arg of the `pr.*` commands,
`project.clone`'s `repo` arg (owner/repo), `gh repo clone/create`,
`<projects>/<owner>/<repo>` clone paths, `release_repo` and the updater, the GitHub
`RepoCard` / `RepoBadges` / `RepoLink` components, "Not a git repository".

Four PRs: #158 proto + Go + CLI + settings, #159 database, #161 frontend, and this one
(docs). #160 fixed a thread-store flake that surfaced on main in between.

Settings › Source control with the renamed Projects section:
`rename-repo-to-project/settings-source-control-dark.png` and
`rename-repo-to-project/settings-source-control-light.png`.

## Decisions

- **One `ProjectService`.** `repo.proto` is `project.proto`, message `Project`, every
  `repo_id` that means the owning project is `project_id`, the event source is
  `EVENT_SOURCE_PROJECT` with `ProjectEvent`. Workspace RPCs are `AddProject` /
  `RemoveProject`.
- **Store packages.** `internal/store/repo` is `internal/store/project`; the old
  `internal/store/project` (create and publish) is `internal/store/newproject`, so the
  registered-project store gets the plain name.
- **No aliases for command ids.** `repo.*` is `project.*` outright (`project.add`,
  `clone`, `create`, `delete`, `unregister`, `refresh`, `list`, `git.init`,
  `github.publish`, `worktree.new/remove/cleanup`), `workspace.add-repo/remove-repo` are
  `add-project/remove-project`. Same reasoning as the thread rename: the CLI is only
  called from inside the app's threads with fresh help text.
- **New `project.list`** (name, id, path; `--json`). Error hints had pointed at a
  `repo list` that never existed.
- **Arg and flag.** `--project` (`ContextProject`) and `--context-project`. No env var
  carried the old name, so there is no env fallback this time.
- **Settings are rewritten on load, not migrated on disk.** `legacyPrefixes` maps
  `[repos]` to `projects.*` (section id `projects`, title "Projects") and
  `keybindings."repo.*"`, `ui.focus.repo` and `workspace.add-repo/remove-repo` to their
  project names; the next Update writes the new names. The worktree directory setting's
  placeholder is `{project}`; `{repo}` still expands to the same value.
- **Remove after the next stable:** the `repos.` / `keybindings.repo.*` /
  `ui.focus.repo` / `workspace.add-repo` / `workspace.remove-repo` rewrites in
  `internal/store/settings/file.go` and the `{repo}` fallback in
  `internal/daemon/settings.go`, together with the session → thread shims.
- **Database tables renamed (migration 0026).** `repos` → `projects`, `repo_id` →
  `project_id` in threads, workspace_members and actions, `actions_repo_name` recreated
  as `actions_project_name`. A plain `ALTER TABLE … RENAME` is enough because the GUI and
  daemon always ship together. `TestProjectsMigrationKeepsRowsAndCascades` builds a 0025
  database with rows in every affected table and checks the rows, the actions cascade
  and index after the upgrade, and that an older build refuses the file.
- **Wire values.** The wake payload JSON says `project_id`; the terminal owner label is
  `project` (in memory only).
- **Frontend.** `api/project.ts`, `stores/projects.ts` (the list) beside
  `lib/projects.ts` (the Projects page model, `ProjectsSlice`), `ProjectView`,
  `useProjectsStore`, `projectId`, `activeProjectId`, `focusProject`, the `"project"`
  event source, `data-project`. Saved state is migrated: `code-foundry.panel` v2 rewrites
  `repo` worktree tabs to `project`, `code-foundry.workIn` v2 moves `byRepo` to
  `byProject`. The mock's fixture ids (`repo-cf` …) are opaque data and stay.
- **History stays.** `docs/notes/*` and `docs/sketches/*` keep their wording and file
  names, as do completed-step records in `PLAN.md` (Phase 1b, the Adding projects PRs).
  Only live docs changed: ARCHITECTURE, PLAN's status and open items, and the
  `thread.new --projects` help text.

## Gotchas

- `toUiContext` spread the view model into the proto, so the active project would have
  gone out empty without a type error, the same trap as #140. It now maps field by field.
- Blanket renames hit fixture values (a fixture project literally named "repo") and
  GitHub text: `repo.git` / `repo.githubSlug` property accesses, `gh repo create`,
  `fix(repo)`. Every sweep needs a read, not just a replace.
- Two frontend specs checked `startsWith("repo.")` and had matched nothing since #158.
- The mock had given `project.refresh` a `cmd+alt+r` chord the daemon lacks; a
  keybindings spec broke once its category became Project.
- `make gui-e2e` collides on the default ports 7799 / 9255 between worktrees; set
  `E2E_MOCK_PORT` / `E2E_VITE_PORT`.
- `src/stores/projects.ts` and `src/lib/projects.ts` share a base name; imports say which.
- `workspace_members.project_id` never had a foreign key to projects, so deleting a
  project leaves its members. Adding the key means rebuilding the table; out of scope.
- The threads table's `report_*` columns contain "repo", so the migration test's leftover
  checks grep `repo_id` and `repo%` rather than "repo".
- An older build refuses the upgraded database ("migration 26 unknown to this build").
- `code-foundry project --help` prints nothing: there is no group help (same on main
  before the rename).
- #160: `TestWakeLimit` flaked on main. A wake queued behind the parent's handshake went
  out after the dropped turns had raised the wake-limit stop, and `sent()` cleared the
  flag. Now only the user's own message clears it (`sent(byUser bool)`).
