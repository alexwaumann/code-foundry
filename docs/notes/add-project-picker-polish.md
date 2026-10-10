# Add Project dialog: default tab, close button, owner filtering and caching, cancel deletes

Status: done on branch `t3code/4992b689` (off `main` after #29). Follow-up to the four
add-project PRs (`add-project-handoff.md`), from Alex's review of the dialog.

## What changed

| Path | What |
|---|---|
| `proto/codefoundry/v1/repo.proto` | `ListPublishOwnersRequest.allow_stale`, `ListPublishOwnersResponse.stale`; `RepoService.Delete(id)` |
| `internal/store/gh/queries/publish_owners.graphql`, `owners.go` | `viewerCanCreateRepositories` per org; orgs with it false are dropped before the REST policy read. The complete list is also written to `gh_activity` (`publish_owners`) and loaded at start; `Owners.CachedPublishOwners` serves it however old it is, with a stale flag |
| `internal/store/project` | `Store.Delete(id)`: unregister, then `os.RemoveAll`, only for a folder directly inside the projects directory (`Deletable(path)`); refused while that project is being published. `Repos` gains `Unregister` |
| `internal/api/repo_create.go` | `ListPublishOwners` honours `allow_stale`; `Delete` |
| `internal/command/commands_repo_create.go` | `repo.delete` (Delete Project; `When`: project in the projects directory; `Confirm`); `ProjectDeps.Deletable` |
| `internal/daemon/daemon.go` | `Deletable` from the repo snapshot + `project.Store.Deletable` |
| `gui/frontend/src/stores/addProject.ts` | Always opens on Local folder; `created` + `busy`; `closeAddProject` (cancel) deletes a created-but-not-kept project, `finishAddProject` keeps it |
| `gui/frontend/src/stores/publish.ts` | `deleteProject` (repo.delete, sent confirmed) |
| `gui/frontend/src/components/addproject/AddProjectDialog.tsx` | Close button top right (disabled while New is busy); `LocalFolderTab` gets `active` |
| `gui/frontend/src/components/addproject/NewTab.tsx` | Keep it local only with the publish step on; Done without an icon; registers `created`/`busy` with the store; keeps the chosen owner across list refreshes |
| `gui/frontend/src/components/addproject/LocalFolderTab.tsx` | Focus on show (rAF, like New); permanent `~/` prefix (`homeRelative` / `homeDisplay` in `palette/paths.ts`), `data-path` carries the full path |
| `gui/frontend/src/components/publish/usePublishOwners.ts` | GUI-side last list; `allowStale` first, then a fresh fetch when the daemon says stale; errors hidden while a list is known |
| `gui/frontend/src/api/publish.ts` | `listPublishOwners({allowStale})` -> `{owners, stale}` |
| `gui/frontend/mock` | `Delete` / `repo.delete`, `removeRepo`, `stale: false` |
| `gui/frontend/e2e` | `create.spec.ts` cancel-deletes test; `addproject.spec.ts` / `paths.spec.ts` for the `~/` prefix and the always-Local default |

## Decisions

* **Owners come from GitHub's own flag.** `Organization.viewerCanCreateRepositories` is
  what github.com's owner picker greys out ("insufficient permission" for orgs that let
  only owners create, and the enterprise "disabled by policy" case). Verified live with
  `gh api graphql` against Alex's account (both orgs true). Orgs with it false are not
  listed at all and cost no REST call. The REST `members_can_create_*` read still decides
  which visibilities to offer for the orgs that remain.
* **Two-level cache, no TTL on display.** The daemon's 10 minute in-memory cache now also
  lands in sqlite (`gh_activity`, key `publish_owners`, `cacheVersion` envelope like the
  other rows) and is loaded at start, so a restarted daemon has the last list. The GUI
  asks with `allow_stale` first and shows whatever comes back at once; when the daemon
  marks it stale the GUI asks again without the flag and swaps in the fresh list. The
  GUI also keeps the last list in memory, so reopening the dialog never shows the
  spinner. A partial list (an org's policy failed transiently) is still not cached.
* **Owner choice survives a refresh.** `usePublishOwners` calls back with the first owner
  and the list for every arrival; the New tab and the publish dialog keep the current
  owner while the new list still has it, else fall back to the viewer.
* **Cancel deletes through a command.** `repo.delete` is a real command (Delete Project,
  with `Confirm`), so the CLI and palette can use it too. The dialog's cancel path sends
  it already confirmed: the user's cancel is the decision, and the project was made
  seconds ago by the same dialog. It is only available for a folder directly inside
  `~/.code-foundry/projects` (what New makes), never for a registered folder elsewhere;
  `Remove Project` stays the non-destructive one. A GitHub repository a failed publish
  left behind (created, push failed) is not touched: the gh token has no `delete_repo`
  scope.
* **No closing while busy.** Escape, the overlay and the close button are ignored while
  New is creating or publishing; deleting the folder under a running `gh repo create
  --push` would be worse than a dialog that waits (publish is bounded at 5 minutes).
* **`~/` is fixed in the Local folder input.** The state is still the full `~/...` path
  (the completion helpers and the daemon see no change); the input shows the rest.
  `homeRelative` normalizes what is typed, pasted or picked: a pasted `~/x` is not
  doubled, an absolute path under a `/Users/<name>` home is tildified, any other
  absolute path is read relative to home (the input cannot name anything outside it; the
  daemon still refuses symlinks out). The native folder picker's absolute result goes
  through the same function.
* **Always Local folder.** The "New when there are no projects" rule is gone; the
  onboarding path still opens the dialog, now on Local folder with the path focused.

## Verification

* `make check` green. New Go tests: `TestPublishOwners` (owners-only org dropped, one
  REST call per listed org, `CachedPublishOwners` fresh then stale),
  `TestPublishOwnersPersisted` (a second store over the same database serves the list
  without a request), `TestDelete` (6 cases), `TestDeleteWhilePublishing`,
  `TestDeleteRepo`, `TestListPublishOwners` (`allow_stale`), `repo.delete` rows in
  `TestRepoCreateAndPublish`. Vitest: `homeRelative` / `homeDisplay`.
* `make gui-e2e`: 349 passed, 3 failed on the first full run. Two were
  `start.spec.ts` "onboarding" expecting the New tab (updated to Local folder with the
  path focused). The third, and two more on a rerun, were `compose.spec.ts` on Chromium
  timing out on a plain click while another session's Playwright run shared the CPU;
  one of them failed the same way on `main`. With the machine idle, `compose.spec.ts`
  on Chromium passed 14/14. `e2e/create.spec.ts`, `addproject.spec.ts`, `paths.spec.ts`:
  38/38 on both engines.
* Scratch daemon (`CODE_FOUNDRY_HOME=~/.cf-picker-scratch`, `bin/code-foundry daemon
  --dev`): `ListPublishOwners {allowStale:true}` fetched in 2.7 s the first time
  (alexwaumann, black-blossom, dream-shader; both orgs `viewerCanCreateRepositories`
  true), then 0.4 ms; after a daemon restart the same request answered from sqlite in
  0.8 ms with no GitHub request in the log. `repo create cf-picker-test` then
  `repo delete --repo <id> --yes` -> "deleted <id>", folder gone; `repo delete` on this
  worktree (registered from elsewhere) -> "not available in this context: project is
  not in the projects directory; use Remove Project". The scratch home must be under
  `$HOME` (the projects directory is checked against it): `/tmp/...` is refused.
* Built app on the scratch daemon: the dialog opens on Local folder with the path
  focused, the close button top right, the permanent `~/` before the typed text.
  Mock screenshots (Playwright): the owners picker, a refused publish with Keep it
  local, and the bare Done once the publish step is unchecked.
* Not verified live: cancelling the dialog from the built app after a real refused
  publish (covered against the mock in `create.spec.ts`); the native folder picker
  mapped through `homeRelative`.

## Gotchas

* **ESLint's `no-unnecessary-condition` and `AbortSignal.aborted`.** After `if
  (ac.signal.aborted) return;` TypeScript narrows the property to `false` for the rest
  of the async function, so a later `!ac.signal.aborted` is "always truthy". Read it
  through a function (`aborted()`).
* **Worktree build** needs `third_party/ghostty-vt` copied from the main checkout with the
  `.pc` prefix rewritten, as in the earlier add-project PRs.
