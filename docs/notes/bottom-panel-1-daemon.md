# Bottom panel, PR A: the daemon half (2026-10-11)

Terminals are moving into a per-content bottom panel under the main pane, keyed like the
side panel (`session:<id>` for a thread, `view:projects` for the Projects page). Its tabs
are derived from the daemon's terminal list by owner labels. This PR gives every shell
an owner, cleans shells up when the owner goes, and adds the commands the GUI needs.
PR B (GUI panel) and PR C (sidebar Terminals section removal) follow.

## Label contract

One place: `internal/termlabel` (a cgo-free leaf package, so
`internal/command` can import it without linking libghostty). Also documented on
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
  2. the active worktree, when `ActiveRepoID` + `ActiveWorktreePath` name a registered
     worktree;
  3. the deepest registered worktree containing `--cwd` (or the active worktree path).
     This covers the CLI and also a stale GUI context. Matching resolves symlinks
     first, and `/src/apple` is not inside `/src/app`.
* cwd: `--cwd` when given, else the owner's worktree (the thread's worktree for a
  thread).
* `--cwd` is now `DefaultToCwd`. The CLI always sends its working directory (it used to
  default to `$HOME`). The arg is still bound to `ContextWorktree`, so the CLI's cwd
  stands in for the worktree in `When`, and the GUI's active worktree is the default.
  As a result, from the CLI `--context-worktree` is overridden by the working directory,
  and with `--context-session` the shell belongs to the thread but starts in the CLI's
  working directory.
* Refusal: InvalidArgument `"<path> is not inside a registered project"`. The CLI prints
  `code-foundry terminal.new: /tmp is not inside a registered project` and exits 2.
* `When`: a thread, or a worktree path in context. The dashboard, the Pull Requests page,
  the composer (repo only), and an unplaced loose terminal don't offer it.
  `code-foundry commands` (no context, no cwd sent) therefore lists it as `no`, but
  `code-foundry terminal new` works.
* Still bound to cmd+t.

## Cleanup

* Exit: the daemon removes a `kind=shell` terminal as soon as it exits (the shell
  reaper, `internal/daemon/shells.go`, on `TerminalUpdated` with state EXITED). The GUI
  gets `updated` (EXITED) and then `removed_id`, back to back, with no grace period. A
  tab should just disappear. Claude terminals keep today's behaviour (the session store
  removes them itself), and so do unlabelled terminals.
* Thread removed: `session.Manager.Remove` kills and removes every `kind=shell` +
  `session=<id>` terminal after closing Claude and before forgetting the thread. If that
  fails (ctx ends), Remove fails and the thread stays. Closing a thread leaves its shells
  running.
* Worktree removed: the reaper subscribes to `repo.WorktreeRemoved` and kills and removes
  every `kind=shell` terminal whose `worktree` equals the path. That covers a thread's
  shells too (they carry the thread's worktree). The bus hook catches every path:
  `repo.worktree.remove`, workspace removal, and `git worktree remove` outside the app
  (seen on the next reconcile). It runs in a goroutine, so `repo.worktree.remove`
  returns before the shells are gone.
* Not done: unregistering a project (`repo.RepoRemoved`) leaves its shells alone. They
  still carry `repo=<id>` if we want that later.

## Close

* `TerminalService.Close` (new RPC) and `terminal.close` ("Close Terminal", Terminal, id
  from context, no confirmation) do Kill (SIGHUP, SIGKILL after 3s) + wait for exit +
  Remove, and return when the terminal is gone. Shared helper:
  `terminal.KillAndRemove(ctx, Store, id)` (plus `KillAndRemoveWhere`), which works on
  any `terminal.Store` including the fake. It waits on `Watch` with a 250ms poll
  fallback, because the bus drops events for full subscribers. If the reaper removes the
  terminal first, that counts as success.
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
  containing worktree, else the same refusal). `when` is now thread-or-worktree, so
  e2e/app.spec.ts expects no `terminal.new` on the dashboard.
* Exited `kind=shell` terminals are removed in `kill()`. `close(id)` is used by
  `terminal.close` and `TerminalService.Close`. `session.remove` and `dropWorktree` (used by
  `repo.worktree.remove` and workspace removal) close the owner's shells.
* `view.bottom.toggle` is added (cmd+j).
* Seeds: `t-top` is a feat/sidebar worktree shell, and the new `t-s1-shell` is s-1's
  thread shell (`/bin/zsh -l` in CF). The sidebar hides `t-s1-shell` because it
  belongs to a known thread, so the pinned row order is unchanged. `t-logs`, `t-tests`
  and `t-tmp` stay unlabelled: e2e kills `t-logs` and expects the exit overlay, which
  auto-removal would break, and `t-tmp` sits outside any project.

## Between PR A and PR B

* The sidebar hides every terminal whose `session` label names a known thread
  (`lib/tree.ts`), and the `focusTerminal` intent (`stores/intents.ts`) selects that
  thread. A thread's shell (cmd+t on a thread) therefore has no row of its own and only
  shows up once PR B's bottom panel exists. Worktree shells still show under
  Terminals. The daemon's `terminal.new` emits no focus intent; the mock's does.
* e2e: `app.spec.ts` (no `terminal.new` on the dashboard) and `buttons.spec.ts` (a thread's
  new shell keeps the thread selected) were updated. The full WebKit run passed apart from
  that one test, which is now fixed; buttons/app/sidebar/panel pass on both browsers.
