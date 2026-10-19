# Plugin environment changes for running threads, thread.restart, plugin env for shells (2026-10-18)

A follow-up to the plugin stack (`docs/notes/plugins-3-events-flags-env.md`: the session
environment hook; `plugins-6-thread-terminal.md`; `plugins-11-gui-gaps.md` item 5, left
static because "the thread data has no process start time"). Decisions are Alex's of
2026-10-18. A running thread now learns that the plugins' environment for its scope
changed, the user restarts Claude for it with the same conversation, and bottom-panel
shells get the plugins' environment when they start.

## What is here

| Piece | Where |
|---|---|
| Staleness: fingerprint per spawn, check, summary | `internal/store/thread/envstale.go`; `record.envPrint`; `Thread.PluginEnvStale`, `PluginEnvChange` (not persisted); `SpawnExtras.Sources` / `ExtrasSource`, `SpawnInfo.Probe` (`spawnextras.go`); `claudeCommand` returns the extras it applied |
| The user's restart | `internal/store/thread/restart.go` (`Store.Restart`, `RestartNote`), `effort.go` (`maybeRestart` / `beginRestart` shared with the effort restart; `respawn` records the extras), `stream.go` (`threadCmd.restart`, held sends) |
| Plugin side | `plugin.Contribution.Sources` (`ContributionSource`: plugin, display name, its env, PATH, add-dirs), `SpawnScope.Quiet`, bus event `plugin.EnvironmentChanged` (push, withdraw, drop) in `internal/store/plugin/environment.go` |
| Daemon glue | `internal/daemon/plugin_env.go`: `startPluginEnvWatch` (plugin events → `thread.Manager.CheckSpawnExtras`), `shellScope`, `pluginShellExtras`; `plugin_hooks.go` maps `Sources` and `Probe` |
| Shells | `internal/store/terminal/extras.go`: `SpawnExtras`, `SetSpawnExtras`, `spawnEnv` (by labels; the store stays program-agnostic) |
| Proto | `Thread.plugin_env_stale = 56`, `Thread.plugin_env_change = 57`; `ThreadService.Restart(RestartThreadRequest{id}) → RestartThreadResponse{thread, restarted}` |
| API | `internal/api/thread_restart.go`; `threadToProto` maps the two fields |
| Command / CLI | `thread.restart` ("Restart Claude", `thread restart <id>`; `commands_thread_restart.go`), `thread get`'s `plugin environment:` line, `plugin env`'s closing paragraph; left out of the agent guide (`guide.leftOut`, budget) |
| GUI | `components/thread/EnvStaleNote.tsx` in the thread header; `ThreadView.pluginEnvStale`, `pluginEnvChange`; `sameThread` counts keys (below); Settings → Plugins line |
| Mock / e2e | `MockThread.pluginEnvChange`, `POST /__mock/thread/envstale`, the mock's `thread.restart`; `e2e/plugin-env-restart.spec.ts` |
| Skill | `reference/host-api.md` SetEnvironment: running threads show "Plugin environment changed" and the user restarts; new shells get env and PATH |

## Decisions

* **Fingerprint, not values.** Each spawn and respawn records, per source (plugin), its
  variable names with a SHA-256 prefix of each value, a hash of its PATH entries and of
  its add-dirs (`printOf`). Values are never kept in the clear, logged or sent: the proto
  carries a bool and a summary of names. The fingerprint lives on the record in memory;
  a daemon restart ends every process anyway.
* **Recomputed, not edge-triggered.** `CheckSpawnExtras` asks the extras function again
  for every running thread (`SpawnInfo.Probe`: no wait, no log lines; the plugin store's
  `SpawnScope.Quiet`) and compares. So pushing the same values is no change, a change
  undone clears the line again, another scope's change does not touch the thread, and a
  dropped bus event is caught by the next. The daemon calls it after any plugin event that
  may change a contribution (`EnvironmentChanged`, `Changed` for enable, disable, grants
  and crashes, `Removed`), draining a burst into one check.
* **Summary** (`changeSummary`): one clause per source in id order, names only:
  "Hello removed CF_HELLO", "GitHub Actions added 2 variables" (one name is named, more are
  counted), "changed X", "changed its PATH entries", "changed its folders"; joined with
  "; ", at most 200 bytes. A display-name change alone is no change.
* **Cleared** by the next spawn, by a respawn (the effort restart counts too: it re-reads
  the contribution) and **when the process ends** (`detach`): a stopped thread's next
  start gets the current environment anyway, so it is never shown stale. The decision said
  "cleared on the next spawn/respawn"; clearing at the process's end follows from it, and
  the idle stop at cache expiry therefore also clears the line.
* **`thread.restart` reuses the effort restart.** `maybeRestart` begins it once Claude is
  at its prompt; a user's restart (`wantRestart`) does not wait for quiet the way an
  effort change does: a running turn is interrupted (once; Claude withdraws a pending
  permission request or question), and background agents and shells stop with the old
  process (`respawn` already ends them as "restarted"). `respawn` resumes Claude's
  current session id (`--resume`, the conversation it is on, `/clear` included), with the
  row's model, effort, mode, grants and the current extras. Sends during the restart are
  held for the new process (as during an effort restart). The timeline gets "Restarted
  Claude"; "Set effort to …" only when the effort changed in the same restart.
* **Forced fallback.** If the interrupted turn has not ended after `CloseTimeout` (10 s),
  the restart goes ahead anyway (stdin closed, SIGTERM, SIGKILL as for any restart), the
  open turn is closed and the status reset, so held sends never wait on a turn that
  ignores the interrupt.
* **Any thread.** A thread whose Claude is not running is left as it is (`restarted:
  false`; the CLI says its next message starts Claude with the current environment). A
  closing process is not restarted.
* **Confirmation** (`threadRestartConfirm`): only when the restart cuts something off.
  Mid-turn (working, starting, waiting on an answer): "Restart Claude for <name>? The
  conversation continues; the current turn is interrupted." Background work: "Restart
  Claude for <name>? The conversation continues, but 1 background agent is running;
  restarting stops it." (the archive rules: `archiveInterrupts`). The confirm button says
  "Restart Claude".
* **Header line, header only.** `EnvStaleNote` after the flag chip: a plug icon and
  "Plugin environment changed", a dot, a link-style **Restart** (a `CommandButton` for
  `thread.restart`, so it is the palette's command with its confirmation) and "to apply",
  `text-caption-sm text-muted-foreground`, truncating before the button. Its tooltip (the
  change is hidden information) is the summary and "Claude is still running with the old
  environment. Restart restarts the Claude process with the new one; the conversation
  continues." Not in the sidebar's line 2 or `thread list`; `thread get` has a line:
  `plugin environment: changed since Claude started (Hello removed CF_HELLO); thread restart <id> applies it`.
* **Shells** get the env and PATH entries (not the add-dirs, which are Claude's) at spawn
  through a terminal store hook keyed by labels (`terminal.SpawnExtrasFunc`), the same
  plugin-store contribution as a thread's (`SessionEnvironment`, no wait). Scope
  (`shellScope`): a thread's shell → that thread's spawn scope (its project, workspace
  members, or no project; its owner, so a plugin's own thread's shell skips that plugin);
  a project's shell → the project; any other shell → the no-project scope; a thread the
  store no longer knows falls back to the shell's project label. Only `kind=shell`
  terminals: action runs and plugins' terminals get nothing. Running shells keep their
  environment (no staleness for shells). The env goes over the daemon's and the defaults,
  under the spec's own; PATH entries go in front of the resulting PATH. A login shell's
  `path_helper` on macOS moves them after the system paths (they stay on PATH).
* **`plugin env`** ends with "New threads in scope get this, and new bottom-panel shells in
  scope get the env and PATH entries too. Running threads and shells keep what they started
  with; a thread shows "Plugin environment changed" until restarted (thread restart <id>)."
  Settings → Plugins says the same in one line.

## Gotchas

* `sameThread` (`stores/threads.ts`) compared only the old view's keys, so an optional
  field that appears in an update (`pluginEnvStale`, and in principle `owner`) was "the
  same thread" and the update was dropped. It now compares key counts first.
* The forced-restart test needs a status wait, not an items wait: the restart note lands
  before the debounced status publishes.
* `thread.restart` pushed the agent guide over its 29,000-byte budget; it is a user's
  action, so it joined `guide.leftOut` (with `pr.checks`).
* The mock's `/__mock/thread/<action>` routes are whitelisted by a regexp in
  `mock/server.ts`: a new action needs it there too (404 otherwise).

## End to end

(filled below after the run)
