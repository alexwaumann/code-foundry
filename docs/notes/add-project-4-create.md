# Adding projects PR 4: create a project and publish it to GitHub

Status: done on branch `cf/add-project-create` (off `main` after PR 3 merged as #23).
PR 4 of `add-project-handoff.md`, the last one. `make check`, `make gui-e2e` and
`make gui-build` green; exercised end to end against a scratch daemon (below).

## What landed

| Path | What |
|---|---|
| `proto/codefoundry/v1/repo.proto` | `RepoService.Create(name)`, `ListPublishOwners()`, `Publish(repo_id, owner, name, visibility)`; `PublishOwner {login, kind, allowed, known}`, `PublishOwnerKind` |
| `internal/store/project` | `Store.Create` (name rules, mkdir 0755, `repo.InitRepository`, register) and `Store.Publish` (`gh repo create`, refresh); `GhError` (gh's words as the message); `projecttest.Fake` |
| `internal/store/gh/owners.go`, `queries/publish_owners.graphql` | `PublishOwners`: GraphQL `viewer { login organizations(first: 100) }`, then REST `GET /orgs/{org}` per org for `members_can_create_*_repositories`; 10 minute in-memory cache; `ghtest` fake |
| `internal/api/repo_create.go` | Thin handlers; `projectError` maps the store errors (a gh failure is `Unknown` with gh's tail as the whole message) |
| `internal/command/commands_repo_create.go` | `repo.create <name>`; `repo.github.publish` (repo, owner, name, visibility enum; `When`: git and no origin) |
| `internal/daemon` | The project store (gh like the cloner's), `HasOrigin` from the repo snapshot |
| `cmd/code-foundry/registry.go` | A several-line `Unknown` error prints as "code-foundry <cmd> failed:" and the lines as they are |
| `gui/frontend/src/lib/publish.ts` | Pure: `projectNameError`, `projectsDirFrom`, `visibilityOptions`, `defaultVisibility`, `keepVisibility` (table tested) |
| `gui/frontend/src/api/publish.ts`, `stores/publish.ts` | `listPublishOwners`; `createProject` / `publishProject` over the commands; the publish dialog's open state |
| `gui/frontend/src/components/publish/*` | `PublishPicker` (owner menu + visibility radio group + unknown-policy hint + gh's error), `usePublishOwners`, `PublishDialog` |
| `gui/frontend/src/components/addproject/NewTab.tsx` | The New tab |
| `gui/frontend/src/components/overview/WorktreeOverview.tsx` | Publish to GitHub is live (opens the publish dialog); the "Coming soon" wrapper is gone |
| `gui/frontend/src/keys/bindings.ts` | Presenters: `repo.create` opens the dialog on New, `repo.github.publish` opens the publish dialog for the active project |
| `gui/frontend/mock/create.ts` | Owners dev / acme (unknown) / octo-org (Public + Internal), Create, Publish (private to octo-org and the name "taken" fail like gh); `GET /__mock/projects/calls` |
| `gui/frontend/e2e/create.spec.ts` | 6 tests per engine (below) |

## Decisions

* **A project store, not more repo store.** `internal/store/project` owns the two new
  processes (git for Create through `repo.InitRepository`, gh for Publish) and no state
  beyond the publishes in flight; the repo store registers and refreshes, and publishes
  the results. Create reuses PR 2's `InitRepository` (branch from
  `init.defaultBranch`, else `main`; empty "Initial commit"), Publish reuses the clone
  store's `clone.Runner` / `ExecRunner` (non-interactive gh, last lines kept).
* **Name rules** (`project.ValidateName`, mirrored by `projectNameError` in the GUI): not
  empty, at most 100 characters (GitHub's repository name limit, so a project can be
  published under its own name), not starting with `.` (so not `.` or `..`), only
  letters, digits, `-`, `_`, `.`. Refusals are `InvalidArgument`.
* **Create leaves nothing behind on failure.** `os.Mkdir` (not `MkdirAll`) of the project
  folder, so two creates racing for one name give one `AlreadyExists`; a failed `git
  init` or initial commit removes the new folder (unlike `repo.git.init`, which keeps a
  half-initialized repository: there the folder is the user's). A failed registration
  keeps the folder and says so. The projects directory is created 0700 and checked under
  home before anything is made, like clones.
* **Publish preconditions:** the project is git and has no remote named `origin` (other
  remotes are fine: gh adds origin). One publish per project at a time
  (`FailedPrecondition`). The GitHub name defaults to the project's name. After gh
  returns, success or not, the project is refreshed: gh may have created the repository
  and added origin before a failed push.
* **gh's error verbatim.** `GhError.Error()` is gh's tail (stdout and stderr merged, last 8
  lines), so the Connect message the GUI shows (`rawMessage`) and the CLI prints is
  exactly what gh said, with no prefix. The CLI prints a several-line one under
  "code-foundry repo.github.publish failed:" and exits 1; a one-line one keeps the usual
  "code-foundry: <cmd>: <message> (unknown)".
* **Owners and visibilities.** The viewer is first with Public and Private (known). Each
  organization: REST `GET /orgs/{org}`; when any `members_can_create_{public,internal,
  private}_repositories` field is present the policy is known and `allowed` is the true
  ones (an absent internal field means the org cannot have internal repositories;
  `members_can_create_repositories: false` allows nothing). Absent fields (the viewer is
  not an owner), a 404 or a 403 mean unknown: `allowed` lists all three and `known` is
  false. A transient REST failure answers unknown for that org and the list is not
  cached; a complete list is cached for 10 minutes per daemon run. The org requests go
  through the gh store's worker, paced like every other request.
* **Picker rules** (`lib/publish.ts`): the options are `allowed` in the order Public,
  Internal, Private. Default: the first option that is not Private (Public when unknown);
  an owner that allows only Private gets no default, so the choice is deliberate.
  Changing owner keeps the current choice when the new owner allows it, else takes its
  default. Unknown policy shows a hint that GitHub does not show the policy and a
  refused choice can be changed.
* **The GUI goes through the commands.** The New tab invokes `repo.create`, then
  `repo.github.publish` with the new project's id as both the `repo` arg and the only
  thing in the context (no worktree, session or terminal), so the daemon's `When` judges
  that project and not what happens to be selected. `ListPublishOwners` is a read RPC
  called directly.
* **New tab flow.** Create first; publish is a second step. A refused publish keeps the
  dialog, the picker and gh's error under it; the name is locked (the project exists),
  Create becomes Publish, and **Keep it local** closes on the project. Success closes the
  dialog and opens the project's overview (`selectAddedProject`). The New tab stays
  mounted when hidden, so switching tabs does not lose a created project.
* **The destination line** is `<config home>/projects/<name>`, with the config home taken
  from the settings file's path (`SettingsSnapshot.path`), tildified; before settings
  arrive it reads `~/.code-foundry/projects`. No new RPC for it.
* **The dialog's default tab:** New when there are no projects (nothing to add yet: start
  one), else Local folder (`defaultAddProjectTab`). Explicit tabs (`repo.clone` opens
  GitHub, `repo.create` opens New) win.
* **Publish dialog:** owner, visibility and the GitHub name (default the project's; the
  same name rules), "As owner/name", Publish. The overview's button opens it directly;
  `repo.github.publish` from the palette opens it for the active project (only listed
  for a git project without origin).

## Gotchas

* **Org owners and the policy fields.** The `members_can_create_*` fields come back only
  for org owners, and owners can usually create any visibility regardless of the member
  policy. The decision (handoff, "Publish visibility picker") is to follow the fields
  when present; if an owner ever needs a visibility the members may not use, the CLI
  still takes any of the three.
* **`gh repo create --push` needs a commit.** Projects from Create and `repo.git.init`
  have the empty initial commit; a remoteless repository with an unborn HEAD gets gh's
  error.
* **Test harness: do not freeze `gh.Options.Now`** in store tests that submit jobs: the
  worker's scheduling uses it and the test hangs. `owners_test.go` ages the cache entry
  instead.
* **Worktree build:** this worktree needed its own `third_party/ghostty-vt` (copied from
  the main checkout with the `.pc` prefix rewritten) and `go clean -cache`, as in PR 1/3.

## Verified

* `make check` green. New Go tests: `TestValidateName`, `TestCreate` (8 cases),
  `TestCreateRealGit`, `TestPublish` (11 cases), `TestPublishBusyAndTimeout`,
  `TestDecodeOrgPolicy`, `TestPublishOwners` (order, policy, 10 minute cache, a partial
  list not cached), `TestPublishOwnersWithoutREST`, `TestCreateRepo`,
  `TestListPublishOwners`, `TestPublishRepo` (gh's message exact), `TestRepoCreateAndPublish`,
  `TestInvokeFailed`, CLI e2e rows. Vitest: `lib/publish.test.ts`, `api/publish.test.ts`.
* `make gui-e2e`: 337 of 338 on the first full run; the one failure was
  `workspaces.spec.ts` "a single-project thread sends exactly what it did before" on
  Chromium (the composer sent before the refs' default base arrived, unrelated to this
  change), green 15/15 on `--repeat-each=3` of that spec. `e2e/create.spec.ts`, 6 per
  engine: New without publish (live name errors, destination, AlreadyExists in place, the
  new project's overview); New with publish to octo-org (dev first with Public/Private,
  octo-org Public/Internal, Public selected, no Private); acme unknown (all three, the
  hint, Public; a choice kept or dropped across owners); a refused publish ("taken": gh's
  text exact under the picker, picker kept, project registered, name locked, retry, Keep
  it local); the overview's button on sketches (refusal, then publish as
  acme/sketchbook private); the palette's `repo.github.publish` and `repo.create`.
* `make gui-build` green.
* Scratch daemon (`CODE_FOUNDRY_HOME=~/.cf-create-scratch`, `bin/code-foundry daemon
  --dev`):
  * `code-foundry repo create cf-scratch-test` -> "created cf-scratch-test in
    ~/.cf-create-scratch/projects/cf-scratch-test (58d9ac133ea1)"; registered as git on
    `main` with one commit; projects dir `drwx------`, project `drwxr-xr-x`. Again ->
    "already exists (already_exists)"; `repo create .bad` -> the name rule, exit 2.
  * `ListPublishOwners` over loopback: alexwaumann (user, Public+Private) and two orgs
    Alex owns, each known with Public+Private (no internal field: not enterprise orgs).
  * `repo github publish --repo 58d9ac133ea1 --owner github --visibility public` ->
    "GraphQL: alexwaumann does not have the correct permissions to execute
    `CreateRepository` (createRepository)", gh's words; nothing created.
  * `repo create cf-scratch-publish-test`, then `repo github publish --repo <id> --owner
    alexwaumann --visibility public` -> "published cf-scratch-publish-test to
    https://github.com/alexwaumann/cf-scratch-publish-test (public)". The project then had
    `remotes: [origin]`, slug `alexwaumann/cf-scratch-publish-test`, upstream
    `origin/main`; `.git/config` has origin at the https URL and main tracking it; GitHub
    shows a PUBLIC repository whose `main` is the local "Initial commit" (same sha).
    Publishing again -> "not available in this context: project already has an origin
    remote".
  * `e2e/live-create.spec.ts` (WebKit, Vite dev server on the scratch daemon): created a
    project with the New tab (destination read `~/.cf-create-scratch/projects/<name>`),
    the picker listed alexwaumann first with Public/Private (Public) and the two orgs, the
    overview's Publish to GitHub opened the dialog with the project's name; nothing was
    published; the project was unregistered and deleted.
  * `gh repo delete alexwaumann/cf-scratch-publish-test --yes` failed: the gh token lacks
    the `delete_repo` scope. **The public repository
    `alexwaumann/cf-scratch-publish-test` still exists** (one empty commit); delete it by
    hand or after `gh auth refresh -h github.com -s delete_repo`. The scratch home is
    removed.

## Not verified

* Publishing from the GUI against real GitHub (only the CLI published for real; the GUI
  publish path is the same command, covered against the mock).
* An organization with internal repositories, or one whose policy is unknown, against
  real GitHub: Alex's orgs are owned by him and not on an enterprise plan.
