# Remove unused RPCs and proto fields (2026-11-11)

24 RPCs and three fields that nothing called or read are gone from the protocol, the handlers,
the stores where only they reached, and the mock. A daemon restart is needed after the update;
the GUI and the CLI call none of them, so an old GUI against a new daemon, or the other way
round during an update, is unaffected.

## How "unused" was established

For each RPC, on current main: its request type and method name grepped over the whole repo
(Go with tests, TS, the mock and e2e, scripts, docs, skills, plugins, pluginsdk). Commands call
API handlers in-process through the backends in `internal/command` (wired in `internal/daemon`
and `internal/command/all`); none of these handlers is one of them. Nothing in `cmd/` or
`internal/client` calls them, the GUI outside `src/gen` never does, and the owner checked that
no plugin calls the daemon API directly (plugins use their allowed commands and the event
feed; threads use CLI verbs and `code-foundry events --source …`).

Kept because they are in use: GhService.GetPullRequest, UpdateService.Install, Relaunch and
RequestRestart.

Two callers turned up that are not callers of the daemon, and were moved:

- `gui/frontend/e2e/fixtures.ts`'s `emit()` posted Connect JSON to the mock's
  `UiService/Emit`. It now posts the same body to a mock control endpoint, `POST /__mock/emit`.
  The type-name grep missed it (a URL string), the method grep found it.
- `src/api/endpoint.test.ts` used `EmberService.GetStatus` as its sample unary call of a
  service with a stream; it uses `ThreadService.List`.

## What went

| RPC or field | What a thread or plugin uses instead |
|---|---|
| ThreadService.Watch (the thread list) | EventService's thread list source (`events --source thread-list`) |
| Gh/Action/GitOps/Memory/Plugin/Settings/Skill/Terminal/Workspace Service.Watch | EventService, one source each |
| ThemeService (List, Watch: the whole service) | EventService's theme source; `theme list` |
| GhService.ListChecks | `pr checks`, GetPullRequest, the PR detail |
| GhService.Refresh, Track, Untrack | `pr refresh`; the daemon tracks registered projects' repos itself |
| ThreadService.Close, Reconnect | a message starts a stopped thread; idle threads stop themselves |
| EmberService.GetStatus, ListTasks | `ember status`, `ember board`, WatchBoard |
| GitOpsService.List | the gitops event source |
| PluginService.RefreshRegistries | `plugin browse --refresh` (Browse with refresh) |
| UiService.Emit | commands emit in-process (`command.BusEmitter`) |
| ProjectService.GetWorktreeFileDiff | GetWorktreeCompareFile |
| WorktreeDetail.log, log_total | ListCompareCommits (the Diff tab's commits) |
| GetDashboardRequest.include_untracked | nothing: it was ignored |
| PluginEnvVar.value | nothing: it was never filled (values stay in the daemon) |

Each removed field's number and name is reserved in its message. Removed messages' names are
not reused. `DiffScope` and `LogEntry` went with their only users.

## Code that went with them

- `thread.Manager.Reconnect` and the Store interface's entry; the store's tests start a stopped
  thread through an unexported `reconnect` helper in `manager_test.go`. `Manager.Close` stays
  (archive, snooze, remove and Ember use it).
- `settings.Store.Watch` was reached only by SettingsService.Watch; it is now an unexported
  test helper of the settings package.
- The gh checks-only path: `Service.Checks`, `Store.Checks`, `jobChecks`, `job.ref`,
  `fetchChecks`, `RefChecks`, `cache.loadChecks`/`saveChecks`, the ghtest fake's
  `SetChecks`/`Checks`. `queries/checks.graphql` and `decodeChecks` stay (PR detail pages,
  default-branch CI). The `gh_ref_checks` table and its schema stay untouched, and `prune` still
  drops its old rows; the cache test inserts a row by hand to keep that covered.
- `project.Store.WorktreeFileDiff`, `FileDiffRequest`, `WorktreeFileDiff`, `DiffScope` and
  `readBlob` (`readRevSide` does the same for compare). `readObject`, `parseLsTree`,
  `readWorktreeFile`, `diffStatus`, `FileVersion` and `currentBase` are the compare path's.
- The detail's `git log -n 100` and `git rev-list --count` in `computeHeadPart`, `parseLog`,
  `logFormat` and `validUTF8` (only `parseLog` used it). A changed HEAD now costs a clean
  worktree's detail three git commands, not five (`detail_cache_test.go`'s `headOnly`).
- The handlers whose only stream was Watch kept a bus (and gh/gitops a done channel) that
  nothing read; `NewGh`, `NewGitOps`, `NewAction`, `NewMemory`, `NewPlugin`, `NewSkill` and
  `NewWorkspace` lose those parameters.
- The mock's `mock:emit` script (it pushed intents through Emit); its routes for the removed
  RPCs. The mock's `fileDiff` stays (compare reuses it) and takes a `branch` flag instead of
  the enum.

## Gotchas

- The stream tests of the removed handlers now read EventService's source for the same store
  (`watchSource` in `events_test.go`; `ghEvents` reads the gh source's first snapshot event
  first, so nothing published after it is missed). The gh source starts with its snapshot
  events, which the old GhService.Watch did not send; the tests skip by type as before.
- The mock's worktree details carried commit seeds in `log`, but `server.ts` never passed them
  to MockFiles, so the Diff tab's commit list was only ever the generated "Older commit"
  rows. Without `log` the seeds keep only their head sha and the commit list is unchanged.
- WorkspaceService.Watch called `EnsureDirs` before its snapshot; EventService's workspace
  source does that on connect and on resume (`events_seq_test.go` covers it).

## Recorded, not changed

The plugin event feed (`pluginsdk/manifest.go`, `EventSources`) carries ten sources: project,
workspace, threads, thread, gh, gitops, settings, update, action, plugin. Terminal, skill,
memory, theme and search are not among them, so a plugin cannot follow those.
