# plugin dev --watch

`code-foundry plugin dev <folder> --watch [--build "<cmd>"]` makes the daemon watch a dev
plugin's folder and, after each change, run the build and restart the plugin. It replaces
the plugin skill's per-edit `make build && plugin restart <name>`.

## Decisions

- **Polling in the plugin store** (`internal/store/plugin/devwatch.go`): one goroutine
  per watched dev plugin walks the folder every 500 ms and stats each file; a file is
  hashed (SHA-256) only when its size or mtime changed, so an identical rewrite is no
  change. A change acts once two consecutive scans agree. Not FSEvents: the cgo rule keeps
  the stream in the project store, which this store may not import, and a dev folder is
  small. Not the CLI: the watch has to survive the CLI exiting and the daemon restarting.
- **Skipped**: dot entries, `bin`, `dist` and `node_modules` at any depth, and the
  top-level folder (or file) of the manifest's `exec[0]`. Symlinks are not followed. Over
  5,000 files the watch logs one line and stops (`plugin list` stops saying watching).
- **Build**: `$SHELL -lc <cmd>` (the daemon's SHELL, else /bin/zsh; a login shell, so the
  user's PATH from their profile applies), cwd the dev folder, own process group
  (`childproc`, killed whole on timeout), 5-minute timeout, the plugin's minimal env
  without the API env: the build has the plugin's privileges, not the daemon's. Every
  output line goes to the plugin log as source `build`.
- **Command**: `--build` defaults to `make build`, kept with the dev link (migration 0059:
  `plugins.dev_watch`, `plugins.dev_build`); no manifest field. `--watch` set turns the
  watch on (and builds now, synchronously: a failed first build exits 1 with its last 20
  lines) or off; unset leaves it as it was, so a plain `plugin dev` re-run does not drop
  the watch. Running `plugin dev --watch` again is the way to rebuild by hand. Store API:
  `SetDevWatch(ctx, name, on, build)`; `Dev`/`DevShown` keep their signatures and the API
  calls `SetDevWatch` after a successful link.
- **Success** restarts the plugin and waits until it leaves `starting` (at most
  InitTimeout + 2 s); log "build ok in 1.4s; restarted". **Failure** logs "build failed
  (exit N); the running plugin is unchanged" and does not restart. **Permissions grew**:
  the restart's existing disable path fires; the watcher adds a line naming
  `plugin dev <path> --yes`, and the watch is off until that consent (it stays on in the
  database and resumes with it).
- **Lifecycle**: the watcher follows the entry (`syncDevWatch` at the end of `apply`, in
  `Disable`, in the removal path); it runs only for an enabled dev plugin with the watch
  on. `Close` stops the watchers before taking `opMu`, because a watcher may be inside
  `Restart`. A config change (folder, build, exec) updates the running watcher in place.
  Installing over the link or uninstalling clears the watch with the dev path.
- **After a daemon restart** the watch resumes from a fresh baseline and builds nothing
  until something changes: edits made while the daemon was down are not picked up until
  the next edit (or `plugin dev --watch` again).
- **Deterministic for agents**: `Surfaces.DevSettle(ctx, plugin)` scans now (no
  debounce) and waits for any build and restart in flight; the `GetSurface` and `Act`
  handlers call it first. It fails with `build failed: code-foundry plugin logs <name>`
  while the last build failed and nothing changed since.
- **GetSurface through a restart** (found by reading, then a failing test): during a
  restart the instance is `plugin down` with plugin state `starting`/`stopping` and the
  old process's cached view, and GetSurface returned that at once. It now waits through
  `plugin down` while the plugin is starting or stopping, as through `opening`; a plugin
  down for good (failed, disabled, crashed) still answers at once with what is cached.
- **CLI follow flag**: `wantsFollow` treated any `follow` or `watch` flag as "stream", so
  `plugin dev --watch` would have followed the log forever. Each follower now names its
  own flag (`plugin surface`: `watch`; the rest `follow`).

## Gotchas

- A build that rewrites a watched source with new content every time (a non-idempotent
  generator: timestamps, random ids) loops: the baseline is the scan that triggered the
  build, so the build's own changes count as the next change. The hash check only stops
  identical rewrites. Generate into an ignored folder (`bin`, `dist`, a dot folder).
- A build that writes into a watched folder but is idempotent costs one extra build: the
  first rebuild's output differs from the baseline, the second's does not.
- Each rebuild is a full shutdown and start of the plugin: in-memory state is gone, and
  open surfaces are reopened (showing the old view as "updating" until the new one).
- Tests drive the loop with fake ticks (`devWatchState.ticker`) and a `ticked` signal so a
  tick's scan finishes before the test edits again; sending the next tick is not enough
  (the scan of the previous one may still be running).
