# Threads never show their process state (thread lifecycle, PR C of 3)

Status: built on branch `cf/hide-connection-state`, on main after PR B (#108, the daemon
starts Claude on send and stops it at cache expiry; `docs/notes/thread-lifecycle.md`).
Frontend, the mock daemon, and two small Go changes (below).

## The decision (with Alex, 2026-10-15)

The GUI never shows whether a thread's `claude` process runs. The user sees the same
conversation and composer either way; a message always continues a thread. The frontend
still receives `state` and reads it internally where behaviour needs it, but nothing on
screen says connected, disconnected, starting, closing, reconnect or close.

## What changed

* **Composer** (`ThreadComposer.tsx`): the Reconnect card (`thread-disconnected`,
  `reconnect`) and its focus "flip" juggling are gone; the composer always renders and
  `canSend` no longer needs `connected` (the daemon accepts a message in any state). The
  model / effort / permission pickers work on a stopped thread (the daemon writes the row).
  Send-while-busy and Interrupt are unchanged. The card also hosted the snooze lines:
  they moved into the composer as a note row above the prompt (`thread-snooze-note`:
  "Snoozed until Thu 9:00 AM" with Unsnooze, or "Snooze ended · 2 min ago" in the warning
  tone).
* **Cold-cache note** (`lib/coldCache.ts`): no `connected` gate. It shows whenever the
  thread is idle past its expiry and not working, so after the idle stop every stopped
  thread with a result shows it. It still hides while Claude starts for a message (that
  is working: `sessionBadge(...) === "busy"`). Wording unchanged.
* **Retry note** (`lib/retryNote.ts`): no state gate; the daemon clears `retry` when the
  process ends.
* **Thread pane**: the `SessionIndicator` ("starting…"/"closing…", with its indeterminate
  bar) is gone. Starting shows the pane's ordinary Working row ("Working" plus the time
  since the message; no "Starting Claude…"); closing shows nothing. The Watch stream's chip
  reads "catching up…" (`thread-catching-up`). "No messages yet." no longer needs
  `connected`.
* **Badges and line 2** (`lib/session.ts`, `lib/statusLine.ts`): `SessionBadge` is busy /
  idle / attention / error / unknown. Starting reads as busy (whatever status it
  persisted: a resend to a finished or interrupted thread is working); a stopped or
  stopping thread keeps attention and error, anything else (idle, unknown, a stale busy)
  is idle. `statusLine` has no starting/closing kinds. `threadGroup` follows the badge
  (starting sorts under Working). `SessionStatusIcon` drops the unplugged icon; the row is
  never dimmed (`offline`, `data-offline` gone).
* **Removed actions**: `RowMenu` Reconnect and Close, the header's Close button,
  `closeSession`/`reconnectSession`, the comments naming cmd+shift+w. The help overlay
  says "A thread keeps its history, and a message always continues it."
* **MCP panel**: Refresh and per-server Reconnect are always enabled (the daemon starts
  Claude for them); the status ask (`ensureMcpStatus`) runs for any thread (no refresh:
  cached status, no start); the empty state is "Checking MCP servers…" while Claude runs or
  a refresh is in flight, else "No MCP status yet. Refresh to check."
* **Start page and Projects**: "N connected" is gone (running and waiting stay; running
  includes a thread starting for a message). `worktreeThreadCount` counts the threads on a
  worktree whether or not Claude runs (title "2 threads on this worktree"), archived ones
  left out; the workspace row's `workspaceThread` is the most recently active
  non-archived thread. The cleanable tag's tooltip ends "nothing running in it".
* **Update dialog**: the busy list follows the daemon's restart count
  (`command.ActiveSession`/`RestartCostOf`): `restartCutsOff` names each thread's loss
  ("working", "waiting on you", "2 background agents and 1 shell", "reporting finished
  work"); heading "N threads would be cut off"; body "Restarting now cuts these threads
  off. Let them finish first, or restart anyway: they keep their history, and a message
  continues each."; the `readyOpen` variant (open but idle threads that "reconnect") is
  gone: with nothing cut off it is "No thread is working or waiting on you, so nothing
  will be interrupted." `SessionView` maps `background_wake_pending`. `DaemonStatus` is
  the daemon connection and is unchanged.
* **`SessionView`** drops `exitCode`, `disconnectReason` and `lastError` (nothing reads
  them); `SessionStateView` is documented as internal.
* **Go**: the hidden `session.reconnect` is deleted for good (a revert of PR B's
  `d9ecbc82`: the command, `Command.Hidden`, `SessionBackend.Reconnect`, the commandtest
  fake; it is an unknown command again). The workspace removal refusal said "close it
  first", which no longer exists: "…running in <path>; archive it first (that stops
  Claude)" (`archiveThem`).
* **Mock daemon**: `session.close`/`session.reconnect` removed; Send starts a stopped
  thread (user item at once, the reply after a ~2 s handshake, `ThreadWorld.start`);
  set-effort on a stopped thread keeps it for the next start; MCP refresh/reconnect work
  without a process. Scripted states: `stopped` (was `closed`: the idle stop, last result
  past the TTL so the cold-cache note shows) and `crashed` (PR B's failed start: "Claude
  did not start: exit code 1: …", status error "did not start"). The test hook
  `session/disconnect` is `session/stop`. Restart confirmations and archive/snooze
  confirms follow PR B's copy (background work named).

## Decisions made here (not in the brief)

* **Starting wins over a persisted attention/error** in the badge, line 2 and the sidebar
  group: the daemon keeps the old status until Claude is up, and the user just sent a
  message. Side effect: an MCP refresh on a stopped thread shows it working for the
  couple of seconds Claude takes to start.
* **No Interrupt while starting**: the daemon cannot interrupt before the handshake (no
  connection yet), so the button appears once Claude is on the turn.
* **Snooze lines moved into the composer** rather than dropped.
* **Worktree counts leave archived threads out**; snoozed ones count.
* **The restart count includes background work** (PR B's final rule), so the dialog's
  heading is "would be cut off" rather than "working or waiting on you".
* **`SessionView` lost the three disconnect fields** instead of keeping dead data.
* **The workspace refusal's wording** changed in Go (the only user-visible "close" left).
* **The cleanup prediction still reads `state`**: the daemon's guard counts threads with a
  process (unchanged by PR B).

## Remaining grep hits (`disconnect|reconnect|"connected"|closing|Close thread|Reconnect`)

Over `gui/frontend/src` (production files), every remaining hit is one of:

* **DOM observers**: `ResizeObserver`/`MutationObserver` `.disconnect()` (App, Sidebar,
  ThreadPane, Timeline, CompletionCard, TerminalHost, VirtualStack, UsageChart,
  terminal/theme).
* **Closing UI** (tabs, dialogs, menus, the palette, a code fence): panel.ts, prPanel.ts,
  compose.ts, snoozeDialog.ts, actionDialog.ts, actionActions.ts, publish.ts,
  addProject.ts, RowMenu (rename focus), ActionsMenu, Composer, ThreadComposer (palette
  input), panel/keys.ts, codeActions.ts, api/errors.ts, bottomActions.ts ("starting and
  closing shells"), NewTab ("closing this dialog deletes it").
* **Stream liveness** (not the process): api/stream.ts, terminal/attach.ts and
  TerminalHost's "Reconnecting…" (the bottom shell's Attach stream), stores/events.ts,
  bottomActions.ts, bottomPanel.ts, worktreeDetail.ts, dockAlerts.ts, thread.ts (the
  Watch), api/app.ts and stores/update.ts (the page reconnecting to a daemon),
  DaemonStatus (the daemon connection page).
* **MCP servers** (a server's connection and its Reconnect action, `thread.mcp-reconnect`):
  stores/mcp.ts, McpSurface, lib/mcp.ts, api/mcp.ts, surfaces/mcp.ts.
* **Internal state reads** (behaviour, nothing shown): api/session.ts (the type and its
  mapping), lib/session.ts `sessionBadge` and `restartCutsOff`, lib/projects.ts
  `threadHolds` (mirrors the daemon's cleanup guard), ThreadPane `running` (a stale busy
  on a stopped thread is not a turn), McpSurface `asking` (which empty-state line).

## Tests

* Unit: `lib/session.test.ts` (sessionBadge table, no lifecycle badges, threadGroup with
  starting, restartCutsOff incl. background and wake), `statusLine.test.ts`,
  `coldCache.test.ts` (stopped, stopping, starting), `retryNote.test.ts`,
  `projects.test.ts` (`worktreeThreadCount`, cleanable title, the guard),
  `workspaceTarget.test.ts`, `update.test.ts` (copy, `cutOffLabel`), `stores/sessions.test.ts`,
  `bindings.test.ts` (starting sorts under Working, a stopped idle one with the idle),
  `HeaderActions.test.tsx` (no Close even when listed), `SidebarRow.test.tsx` (a stopped
  row looks like any other), `surfaces/mcp.test.tsx` (stopped: enabled, cached status),
  `api/mapping.test.ts` (the dropped fields). Tests for deleted behaviour were removed.
* e2e (mock): `sessions.spec.ts` (badges, no dimming, a stopped thread's composer sends
  and gets the answer, a running thread that stops looks the same, no Close/Reconnect in
  header, row menu, palette or chords), `thread.spec.ts` (a failed start: error item,
  composer, a message starts it; a stopped thread at its prompt with the cold-cache
  note), `mcp-panel.spec.ts` (stopped and never-reported threads), `settings.spec.ts`
  (help overlay text), `snooze.spec.ts` (the note row; a message unsnoozes),
  `update.spec.ts`, `start.spec.ts`, `projects.spec.ts`, `workspace-panel.spec.ts`,
  `buttons.spec.ts`, `thread-reconnect.spec.ts` (chip "catching up…"), and the rest that
  asserted the card. Live specs archive instead of `session close`.
