# Bottom panel, PR A: the daemon half (2026-10-11)

Terminals are moving into a per-content bottom panel under the main pane, keyed like the
side panel (`session:<id>` for a thread, `view:projects` for the Projects page). Its tabs
are derived from the daemon's terminal list by owner labels. This PR gives every shell
an owner, cleans shells up when the owner goes, and adds the commands the GUI needs.
PR B (GUI panel) and PR C (sidebar Terminals section removal) follow.

## Label contract

One place: `internal/termlabel` (a neutral, dependency-free package, so
`internal/command` imports nothing under `internal/store` and does not link libghostty). Also documented on
`Terminal.labels` in `proto/codefoundry/v1/terminal.proto`.

| Terminal | `kind` | `session` | `repo` | `worktree` |
|---|---|---|---|---|
| A thread's Claude terminal (session store) | none | thread id | none | thread's worktree |
| Shell for a thread (`terminal.new` with a thread) | `shell` | thread id | thread's repo | thread's worktree |
| Shell for a worktree (`terminal.new` otherwise) | `shell` | none | repo id | worktree path |
| Raw `TerminalService.Create` without labels | none | none | none | none |

A GUI should key tabs as follows:

* `session:<id>` tabs are terminals with `kind=shell` and `session=<id>`.
* `view:projects` tabs are `kind=shell` terminals without `session`, one group per
  `worktree`.

Don't use `session` alone to find shells, because the Claude terminal has it too.
`worktree` is the snapshot path (symlinks resolved, e.g. `/private/tmp/...`), the same
string `RepoService` reports.

Gotcha: `deriveContext` (gui/frontend/src/stores/context.ts) already maps a terminal's
`session` label to `activeSessionId`. Selecting a thread's shell therefore makes the
session commands apply to that thread. That is probably right for PR B, but it is there.

## terminal.new

* Owner, in order:
  1. the active thread (`ActiveSessionID`, read with `SessionService.Get`);
  2. the context worktree (`ActiveWorktreePath`: the GUI's selection, or the CLI's
     `--context-worktree`), matched exactly (with `ActiveRepoID` when given), else the
     deepest registered worktree containing it;
  3. the deepest registered worktree containing `--cwd`;
  4. the deepest registered worktree containing `--here`, the CLI's working directory
     (`DefaultToCwd`; the CLI always sends it).
* Start directory: `--cwd`, else the thread's worktree, else the context worktree path,
  else `--here`. From the CLI, a plain `code-foundry terminal new` starts where you are.
  With `--context-session` or `--context-worktree` it starts in that thread's or
  worktree's directory, because `--here` is consulted only when nothing else names an
  owner.
* Why two args. `--cwd` used to be bound to `ContextWorktree` and to `DefaultToCwd`, so
  the CLI's directory silently replaced `--context-worktree`, and a thread's shell started
  in the CLI's directory. `cwd` now has neither binding, and `here` carries the CLI
  default.
* Path matching: the path is resolved through its nearest existing ancestor (a folder that
  does not exist yet still resolves `/tmp` to `/private/tmp`). The comparison ignores
  case on macOS: APFS and HFS+ are case-insensitive by default, and `EvalSymlinks` keeps
  the case it was given, so resolving both sides would not canonicalise it. `/src/apple`
  is not inside `/src/app`.
* Refusal: InvalidArgument `"<path> is not inside a registered project"`. The CLI prints
  `code-foundry terminal.new: /tmp is not inside a registered project` and exits 2.
  With no path at all: "terminal.new needs a thread, a worktree, or --cwd inside a
  registered project".
* `When`: a thread, a worktree path in context, or the CLI (empty `ActiveView`, which
  every GUI context sets). The dashboard, the Pull Requests page, the composer (repo
  only), and an unplaced loose terminal don't offer it. `code-foundry commands` lists it
  as available everywhere. Knowing whether the working directory is in a project would
  mean sending it with `ListCommands`, which is not cheap. Outside a project, the refusal
  says why.
* Still bound to cmd+t.

## Cleanup

* The shell reaper (`internal/daemon/shells.go`) handles everything except the in-Remove
  step below. It only ever touches `kind=shell` terminals.
* Exit: a shell is removed as soon as it exits (`TerminalUpdated` with state EXITED). The
  GUI gets `updated` (EXITED) and then `removed_id`, back to back, with no grace period.
  A tab should just disappear. Claude terminals keep today's behaviour (the session store
  removes them itself), and so do unlabelled terminals.
* Thread removed: `session.Manager.Remove` kills and removes every `kind=shell` +
  `session=<id>` terminal after closing Claude and before forgetting the thread. If a
  shell will not die before ctx ends, Remove fails and the thread stays (tested). The
  reaper also handles `session.Removed`, which catches a shell `terminal.new` started
  between that cleanup and the delete. Closing a thread leaves its shells running.
* Worktree removed: on `repo.WorktreeRemoved`, every shell whose `worktree` equals the
  path is killed and removed, but only if the directory is gone (`os.Stat` says
  ErrNotExist). The repo store publishes WorktreeRemoved for every worktree of a project
  when a refresh fails (the listing becomes empty), and that must not kill shells. Every
  real removal deletes the directory: `repo.worktree.remove`, workspace removal, and
  `git worktree remove` outside the app. The cleanup runs in a goroutine, so
  `repo.worktree.remove` returns before the shells are gone.
* Project unregistered (`repo.RepoRemoved`, from `repo.unregister` and `repo.delete`):
  every shell with `repo=<id>` is killed and removed.
* Sweep: at start and every 60s, the reaper redoes all of the above from current state.
  It removes exited shells and kills the shells whose worktree directory is gone, whose
  project is not registered, or whose thread does not exist. The bus drops events for a
  full subscriber, so a missed event would otherwise leave a shell forever.
* Stopping the reaper cancels cleanups in flight; it does not wait for a shell's grace
  period (tested).

## Close

* `TerminalService.Close` (new RPC) and `terminal.close` ("Close Terminal", Terminal, id
  from context, no confirmation) do Kill (SIGHUP, SIGKILL after 3s) + wait for exit +
  Remove, and return when the terminal is gone.
* Shells only. With a thread selected, the active terminal is its Claude terminal. An
  unconfirmed SIGHUP to Claude is what `session.close` exists to avoid. So:
  * `terminal.CloseShell` refuses any other terminal with `ErrNotShell`, which the API
    maps to FailedPrecondition with "...; use session.close to end the thread".
  * The command is unavailable on such a terminal: `TerminalDeps.IsShell`, which the
    daemon wires to the terminal store, with the same reason.
  * The mock refuses it too.
* Helpers: `terminal.KillAndRemove(ctx, Store, id)` (plus `KillAndRemoveWhere`) work on
  any `terminal.Store`, including the fake. They wait on `Watch`, with a 250ms poll
  fallback because the bus drops events for full subscribers. A terminal that is
  already gone counts as success: Kill returning NotFound means it exited and was reaped
  just before. Removal by the reaper during the wait counts as success too. Only
  `CloseShell`'s up-front `Get` reports an unknown id as NotFound.
* `terminal.kill` and `terminal.remove` are unchanged.
* Proto change: only the RPC plus the labels comment. Generated code is committed (`make
  gen`).

## terminal.list

New read-only command (`code-foundry terminal list`): ID, state, cwd, and sorted
`k=v` labels. It existed nowhere before, and the e2e check needed it. The mock doesn't
have it (it doesn't have `session.list` either).

## view.bottom.toggle

Emits `UiIntent.ShowView{name: "bottom.toggle"}` (`command.ViewBottomToggle`), is always
available, and is bound to cmd+j. cmd+j was free in the Go registry, `ReservedChords`,
`viewActions` (gui/frontend/src/keys/bindings.ts), and the mock.
`TestPanelKeybindings` pins cmd+shift+e / cmd+j / cmd+t. Until PR B adds a presenter,
the GUI's `showView` returns false for the name, which is harmless.

## Mock (gui/frontend/mock/world.ts)

* Same label constants and the `shellLabels()` helper.
* `terminal.new` resolves the owner like the daemon (thread, exact worktree, deepest
  containing worktree, else the same refusal). `terminal.close` and `close()` refuse
  non-shells and are offered only on a shell. `when` is now thread-or-worktree, so
  e2e/app.spec.ts expects no `terminal.new` on the dashboard.
* Exited `kind=shell` terminals are removed in `kill()`. `close(id)` is used by
  `terminal.close` and `TerminalService.Close`. `session.remove` and `dropWorktree` (used by
  `repo.worktree.remove` and workspace removal) close the owner's shells.
* `view.bottom.toggle` is added (cmd+j).
* Seeds: `t-top` is a feat/sidebar worktree shell, and the new `t-s1-shell` is s-1's
  thread shell (`/bin/zsh -l` in CF).
  `terminal.close` is therefore offered on `t-top` but not on `t-logs` or a thread's
  Claude terminal. The sidebar hides `t-s1-shell` because it
  belongs to a known thread, so the pinned row order is unchanged. `t-logs`, `t-tests`
  and `t-tmp` stay unlabelled: e2e kills `t-logs` and expects the exit overlay, which
  auto-removal would break, and `t-tmp` sits outside any project.

## Between PR A and PR B

(Superseded by PR C, `bottom-panel-3-routing.md`: no terminal rows, no `terminal` selection.)

* The sidebar hides every terminal whose `session` label names a known thread
  (`lib/tree.ts`), and the `focusTerminal` intent (`stores/intents.ts`) selects that
  thread. A thread's shell (cmd+t on a thread) therefore has no row of its own and only
  shows up once PR B's bottom panel exists. Worktree shells still show under
  Terminals. The daemon's `terminal.new` emits no focus intent; the mock's does.
* e2e: `app.spec.ts` (no `terminal.new` on the dashboard) and `buttons.spec.ts` (a thread's
  new shell keeps the thread selected) were updated. The full WebKit run passed apart from
  that one test, which is now fixed; buttons/app/sidebar/panel pass on both browsers.
