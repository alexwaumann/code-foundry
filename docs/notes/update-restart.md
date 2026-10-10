# Update: one "Restart Now" (backend)

Status: Go half done on branch `cf/update-restart-go`. `make check` green. The frontend
half (the update dialog's "Restart Now") is a separate branch.

Before, applying an installed update took two actions: `app.relaunch` (the GUI re-execs)
and `daemon.restart` (the daemon closes its sessions and exits; the next client
auto-starts the new binary). Now `app.restart` ("Restart Code Foundry") does both, in
order: daemon first, then the window.

## What changed

| Where | Change |
|---|---|
| `proto/codefoundry/v1/update.proto` | `message RestartRequested {}`, `UpdateEvent.restart_requested = 3`, `rpc RequestRestart(RequestRestartRequest) returns (RequestRestartResponse { int32 delivered })`. Service and enum comments describe the one-step flow. |
| `internal/store/update` | `RestartRequested` bus event; `Service.RequestRestart() int` / `Store.RequestRestart` publishes it and returns the listener count. It does not touch the status. Package doc describes the flow. |
| `internal/api/update.go` | `RequestRestart` handler (one line); Watch and the EventService update source map the bus event to `restart_requested`. |
| `internal/command/commands_update.go` | `app.restart`, `BusySessions`, `AppRestart` JSON, `UpdateBackend.RequestRestart`, new `UpdateSummary` strings ("vX installed; restart Code Foundry to apply"; RESTART_REQUIRED: "vX installed and the app relaunched; restart Code Foundry to apply"). |
| `internal/command/commandtest` | `Update.RequestRestart` reports `Delivered`; `Session.Others` lists more sessions after `Current`. |
| `gui/relaunch.go` | The watcher is a `relaunchWatcher` (injectable `open`, `relaunch`, `retry`, `restartWait`). On `restart_requested` it relaunches once the stream ends, or after 15s with a warning, then stops watching. |
| `cmd/code-foundry/update.go` | The post-update hint points at `code-foundry app restart`. |

## app.restart

* Confirm (static): "Restart Code Foundry? Open threads keep their history and can be
  reconnected."
* DynamicConfirm: with N busy threads (live, not DISCONNECTED, and status BUSY) "N
  threads are still working and will be cut off mid-turn. Restart Code Foundry anyway?"
  ("1 thread is still working ..." for one); with none, the static message. The GUI
  dialog invokes with confirmed=true (the dialog is the confirmation); the palette and
  CLI (`--yes`) still get the confirm.
* Run: refuses (`ErrUnavailable`) while an update is DOWNLOADING; fails when the daemon
  cannot restart itself; counts live sessions; calls `RequestRestart`; then `Restart()`.
  A failed notify aborts before the restart. Message: "restarting Code Foundry: closing
  N sessions; the app relaunches once the daemon has stopped", or, when no GUI listened,
  "restarting the daemon: closing N sessions; no app window is connected (open it with
  `code-foundry gui`)". JSON `{sessions_closed, gui_notified}`.

## Decisions

* **One command, not a frontend sequence.** The GUI cannot run `app.relaunch` and then
  `daemon.restart` itself: after the relaunch nothing is left to send the second call,
  and in the other order the window loses its daemon mid-sequence. The daemon is the
  only party alive for the whole thing, and every user action is a registry command
  anyway, so the palette and CLI get it for free.
* **Order: announce, then exit, then relaunch.** `RequestRestart` runs before
  `Restart()` so every GUI hears it while the daemon is still serving. The host does not
  relaunch on the event; it waits for its Watch stream to end. The stream ends when the
  daemon cancels request contexts at shutdown (`daemon.go`: `cancelRequests`, right
  before `Shutdown` closes the listeners), so by then new connections fail, and the
  relaunched window's connect auto-starts the installed daemon (`gui/daemon.go`)
  instead of reaching the dying one.
* **A separate RPC rather than a flag on Relaunch.** `RequestRestart` keeps the status
  untouched (Relaunch moves Installed to RestartRequired, which would be wrong for a
  daemon about to exit) and keeps the handler thin. Its doc comment says clients wanting
  a restart invoke `app.restart`; calling the RPC alone would only make GUIs wait 15s
  and relaunch against the same daemon.
* **15s bound.** `Restart` waits 250ms, then shutdown closes the streams almost at once,
  so the normal wait is well under a second. The bound covers a daemon that hangs before
  cancelling requests: the user pressed "Restart Now" and should not be left with a
  window that never comes back. Relaunching anyway at worst reconnects to the old
  daemon, which is what `app.relaunch` alone did. Logged as a warning.
* **The host stops watching after a restart relaunch.** `Relaunch` quits the app; if the
  watcher reconnected meanwhile it would auto-start a daemon from the exiting host and
  race the new window's auto-start (the daemon lock makes that safe, but pointless).
* **If the app quits while waiting** (parent context ends before the stream does), no
  relaunch.
* **`app.relaunch` and `daemon.restart` stay** for the CLI: restarting only the daemon
  (no window open, or a scripted restart) and relaunching only the window (a GUI-only
  fix, or after `code-foundry update` with the daemon already current) are still
  useful, and `daemon.restart`'s confirm counts every live session, which is what a
  daemon-only restart cuts off.
* **Busy, not live, in the confirm.** Every live session disconnects either way and can
  be reconnected with its history, so the warning that matters is threads cut off
  mid-turn. The Run message still counts all live sessions.

## Gotchas

* `updatetest/fake.go` had nothing to change: it fakes the release source and
  installer, and tests drive the real `update.Store`. The `UpdateBackend` fake lives in
  `internal/command/commandtest/update.go`.
* `TestAllRegistersEveryDomain` lists every command name; adding a command means adding
  it there.
* CLI verbs resolve against the running daemon's registry, so `code-foundry app restart`
  says "unknown command" against an older daemon. Exercise it with an isolated
  `CODE_FOUNDRY_HOME` (the built binary auto-starts its own daemon there).
* The old daemon keeps the lock until its stores have closed (sessions closed and
  recorded); the new window's auto-start waits for it within the client's start timeout
  (10s), the same as after `daemon.restart`.
* The frontend mock server (`gui/frontend/mock/`) does not implement
  `RequestRestart` or `app.restart` yet; that belongs to the frontend branch.

## Verified

* Go tests: `TestAppRestart` (confirm strings for 0/1/2 busy, disconnected and idle not
  counted, refused while downloading, no restart hook, notify failure aborts, notify
  happens before `Restart`, JSON), `TestBusySessions`, `TestRequestRestart` (store: event
  delivered, status unchanged, no status or relaunch event), `TestUpdateRequestRestart`
  (Watch and EventService carry `restart_requested`), `TestRelaunchWatcherOnce`
  (table: status only, relaunch, restart waits for the end, repeated restart, 15s bound
  with warning, app quitting), `TestRelaunchWatcherRun` (reconnects after a plain end,
  stops after a restart), `TestWatchRelaunchAfterRestart` (real UpdateService over a
  Unix socket: no relaunch while the server is up, one relaunch when it closes).
* End to end with the built binary and an isolated home:
  `code-foundry app restart` without a terminal printed the confirm and "Re-run with
  --yes"; `--yes --json` printed `{"sessions_closed":0,"gui_notified":0}` and the daemon
  exited (socket removed). With `buf curl` following `UpdateService/Watch` on the
  socket, `app restart --yes` reported "the app relaunches once the daemon has stopped",
  and the stream printed the status, then `{"restartRequested": {}}`, then ended.
* Not exercised: a real Wails window relaunching (the frontend half is not merged).
