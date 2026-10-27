# Thread lifecycle, PR B of 3: threads start on send and stop at cache expiry

Status: built on branch `cf/thread-lifecycle` (PR #108), on main after PR A (#105, with
its wake hold) merged. `make check` green, `make gui-build` green,
exercised live (below). PR C removes the GUI's connection UI (the list at the end).

## The decision (with Alex, 2026-10-15)

Users never need to know whether a thread's `claude` process runs. The daemon starts it
when a message is sent and stops it when the thread has idled past its prompt cache
expiry. `session.close` is gone; `session.reconnect` stayed registered but hidden until PR
C, which deleted it (`docs/notes/hide-connection-state.md`). This PR is the daemon and CLI; PR C removes the GUI's connection UI.

## What was built

* **Send to a stopped thread starts it** (`lifecycle.go` `startStopped`, `thread.go`
  `Send`). The thread is reserved (`record.reserve`: STARTING with a `reserved` channel,
  the guard Reconnect used, now with something to wait on), the user item is written at
  once (`recordUser`; the outgoing message keeps its id so `sendMessage` delivers it under
  it without a second item), then the conversation resumes (`resumeLaunch`: `--resume`
  when the transcript is there, else a new conversation, Reconnect's fallbacks) with the
  message as the first prompt (`record.first`, Create's path). Send returns that item.
  * While STARTING (a runner not initialized yet) a send is queued (`runner.queue`): its
    item goes in at once, after the first prompt's (which is then written first so the
    order holds), and it goes out after the first prompt once Claude answers
    (`onInitialized` drains `streamState.queued`). Send never waits for the handshake.
    While a start is reserved (no runner yet) Send waits on the reservation, then queues.
  * While CLOSING Send waits for the exit, then starts a new process. A send the runner
    takes after its close began gets `errProcessGone` and does the same.
  * A send held by an effort restart that does not complete (the new process cannot
    exec, exits before its handshake, never answers it; or a close or daemon stop during
    the restart) gets `errProcessGone` too (`failHeld`): Send waits for the exit and
    starts the thread with the message as its first prompt, so it is never lost (during
    a daemon stop it gets ErrClosed). If the new start fails as well, the message stays in
    the timeline with "Claude did not start: …" after it.
  * A start that fails (worktree gone, `claude` missing, no handshake, exit before it):
    Send still returns the accepted item, an error item follows ("Claude did not start:
    <reason>"), status ERROR `did not start` (`ReasonStartFailed`), disconnect reason
    `spawn failed`, the thread stays stopped; the next message tries again. One error
    item per failed start (`addErrorOnce` skips only a repeat of the same line). A start
    that races the daemon's shutdown fails with ErrClosed and no timeline line: spawn's
    commit re-checks `m.closed` and kills the new process (`runner.abandon`), so
    `m.wg.Add` never races Shutdown's `Wait`.
  * A conversation whose transcript is gone is refused (FAILED_PRECONDITION, nothing
    written) and the thread is flagged `transcript_missing`; only a resident thread still
    starts a new one with the "Started a new conversation" note. Superseded by
    `docs/notes/transcript-deleted.md` (2026-10-27).
  * Sending unarchives and unsnoozes as before. Respond on a stopped thread is
    FAILED_PRECONDITION ("no pending request … Claude is not running"); Interrupt is a
    no-op success.
* **Idle threads stop at cache expiry** (`stopIdle`, `stopIdleLoop`, `runner.onIdleCheck`).
  A wall-clock check every `Options.IdleCheckInterval` (30 s; the snooze wake loop's
  pattern, `m.wg`, `m.ctx`) pokes every CONNECTED runner (non-blocking, capacity-1
  channel); the runner decides on its goroutine with the pure `idleHoldOf`, which names
  the first hold: closing, starting (or an effort restart's handshake), a message on its
  way (first prompt, queued, held by a restart), an effort change waiting, a pending
  request, busy (not `AtPrompt`), background work (`Session.BackgroundWork()`, which
  includes PR A's wake hold, plus the runner's own shell count and `wakePending`), an
  unfinished item, grace (`Options.IdleGrace`, 5 min since the process started:
  `runner.startedAt`, reset by an effort restart), cache warm (`now < CacheExpiresAt`, or
  last activity + TTL without a result). Nothing holds: `beginClose` with
  `runner.disconnectAs = ReasonIdle` ("idle"), logged at info with the idle time. Status
  and reason are kept (a "finished" unseen stays amber); viewers do not matter. Threads
  overdue at startup have no process: nothing to do.
* **Settings on a stopped thread** (`setLive`, `updateStopped`, `SetEffort`):
  SetModel, SetPermissionMode and SetEffort change and persist the row without starting
  Claude; `EffortPending` stays false; the next spawn passes the row (`claudeCommand`).
  A closing thread counts as stopped; a reserved start is waited out; a live but starting
  thread gets the control request after its handshake (`runner.ready`); a request that
  meets `claudestream.ErrClosed` (an idle stop raced it) waits for the runner to go and
  writes the row.
* **Slash commands and MCP status outlive the process** (`threadcache_db.go`, migration
  `0021_session_thread_cache.sql`: one row per thread, two JSON columns, cascading). The
  runner no longer clears them at exit (`dropMcpChecks` only discards checks in flight).
  They are written when they change (MCP saves in check-ticket order: `persistMcp` drops
  a save older than the last one) and loaded with the thread's log, so they survive a
  daemon restart; the next handshake and turn refresh them. `McpStatus(refresh=true)` and
  `McpReconnect` on a stopped thread start Claude without a prompt (`running`: one start
  at most, then wait for `ready`); the grace keeps it up 5 minutes. `McpStatus(false)`
  returns the cached status without starting anything. Send refuses `/clear` and the like
  from the saved list before any start.
* **Process death**: mid-turn (busy, compacting, a pending request) adds one error item
  "Claude stopped unexpectedly (exit code 1: <stderr line>)" ("killed" for a signal);
  before the handshake "Claude did not start: exit code N: …"; at the prompt nothing (the
  next message starts it). The status rules are unchanged (busy becomes ERROR
  "interrupted"). Wording never says connected or disconnected.
* **Commands**: `session.close` is gone (registry, chord cmd+shift+w, CLI verb,
  `SessionBackend.Close`). `session.reconnect` stays registered but hidden
  (`Command.Hidden`: out of List, so no palette entry, help, chord or CLI verb; Invoke by
  name still runs it): today's GUI sends only to a connected thread and offers its
  Reconnect card otherwise, and a push to main ships a tip release, so without it no
  thread could continue until PR C, which deletes it. `session.list` drops the STATE
  column (`--json` keeps `state` and `disconnect_reason`). `daemon.restart`,
  `app.restart` and the CLI's after-update line count what a restart cuts off by
  archive's predicate (`ActiveSession` = `archiveInterrupts`: starting, busy, a
  permission prompt or question, background agents or shells, or the wake hold) and name
  it (`RestartCost`): "Restart the daemon? Threads keep their history; a message starts
  each again." / "1 thread working or waiting on you and 2 background agents will be cut
  off. Restart the daemon anyway?"; results "restarting the daemon (cuts off 1 background
  shell); …"; the CLI "… restarting cuts off …" or "nothing running"; JSON
  `threads_interrupted` (threads that lose something) replaces `sessions_closed`. `thread.mcp`/`thread.commands` no
  longer say "reconnect it first"; `thread.set-effort` on a stopped thread says "uses
  effort high from its next message"; descriptions drop "connected".
* **Archive and snooze confirm background work** (the coordinator's ask): `ConfirmIf`
  is "busy, prompting, background agents/shells running or the wake hold"; the message
  names them: "Archive thread drv? 2 background agents and 1 shell are running; archiving
  stops them." / "… Claude is about to report background work that just finished;
  archiving loses that report." (`archiveInterrupts`, `midTurn`, `backgroundRunning`).
* **Proto** (additive): `Session.background_wake_pending` (42, PR A's wake hold, so the
  command layer sees it); the rest is comments: SessionState is daemon-managed and internal to
  clients, `disconnect_reason` lists "idle" (and the rest), ERROR "did not start", Send
  starts a stopped thread, settings on a stopped thread go to the row, MCP status and slash
  commands outlive the process; the Send RPC returns at once. The `Close` and `Reconnect`
  RPCs stay for compatibility. `make gen`.
* **Development aids**: `CODE_FOUNDRY_IDLE_GRACE` and `CODE_FOUNDRY_IDLE_CHECK` (Go
  durations) set the grace and the check interval of a daemon (like
  `CODE_FOUNDRY_GH_SEARCH_AS`; invalid values are logged and ignored).

## Decisions made here (not in the brief)

* **Queued sends write their item at once** and Send returns it, so "never fails" holds
  even when the handshake then fails; the start failure is told by the error item.
* **The first prompt of a Create is written early only when needed** (a send queued
  behind it): Create's own timing is unchanged otherwise.
* **The note for a lost transcript** (new); before, only `LastError` said it, which no
  user saw once reconnecting became automatic.
* **Restart counts include prompting threads** for `app.restart` too (it counted busy
  only): a pending permission is lost to a restart as well. `BusySessions` and
  `LiveSessions` are replaced by `RestartCost`/`ActiveSession`; the JSON field is
  renamed (`threads_interrupted`); nothing in the GUI read it.
* **Restart counts include background work and the wake hold** (decided in review:
  killing background work is the worst failure), with archive's predicate.
* **The wake hold goes on the proto** (`background_wake_pending`): the commands only see
  proto sessions, and PR A kept it off the wire.
* **A start's failure status** is ERROR `did not start` (a new reason; the GUI shows the
  error item; PR C may style it like "interrupted").
* **`midTurn` for the process-death item** stays busy/compacting/pending: a crash at the
  prompt with background work running adds no line; the background calls already end as
  errors "the thread's process ended before …".
* **MCP refresh/reconnect starts a thread without unarchiving it** (a message and
  Reconnect unarchive; an MCP check is not the user working with the thread).
* **RunIn while a start is reserved** is refused ("starting; try again"): the row's cwd
  cannot change under a spawn that already read it.
* **`ReasonSpawnFailed` covers a handshake that never came** (it was "closed").
* **Workspace and worktree removal guards** still count only threads with a process
  (unchanged): a stopped thread whose worktree was removed fails its next start with
  "Claude did not start: … worktree … no such file or directory".

## Gotchas

* **The fake replays a capture's ids**: a resumed process's first turn has the same
  message ids as the first process's, so its items replace the old ones in the log
  instead of adding; lifecycle tests wait on deliveries and status, not a turn count.
* **`ready` closes after the row says connected** (`onInitialized`'s end): closed before,
  a caller of `running` read STARTING (a race-run failure).
* **Worktree sandbox**: `third_party/ghostty-vt` copied from the main checkout with the
  `.pc` prefix rewritten was not enough; the shared Go build cache still linked another
  worktree's `libghostty-vt.a`. `GOCACHE=/tmp/cf-lifecycle-gocache` for every go and make
  call fixed it. `gui/frontend/node_modules`: `pnpm install --frozen-lockfile --offline`.
* **`code-foundry daemon status` auto-starts a daemon**: a loop waiting for "no daemon"
  never ends. Stop an isolated daemon with SIGTERM to its pid.

## Tests

* Review round: `effort_test.go` a send held by an effort restart whose new process
  cannot exec (`TestRenderedSetEffortRespawnExecFails`: the message stays with both
  failures after it, the next message starts the thread), exits before its handshake,
  or never answers it (`CF_FAKE_CLAUDE_RESUME_EXIT` / `_RESUME_HANG` with `_ONCE`: the
  thread starts again with the held message, one delivery), and a close during the
  restart (the held send starts the thread again); `TestSpawnAfterShutdownBegan`;
  `TestThreadLogMcpSavesInOrder`; the send-while-starting tests hold the handshake with
  `CF_FAKE_CLAUDE_INIT_GATE` instead of timing it; api maps `background_wake_pending`;
  archive confirms the wake hold.
* `session/lifecycle_test.go`: send to a stopped thread (item before Claude is up, one
  delivery under the item's id, `--resume`, unarchived, no note); a lost transcript (new
  conversation, the note right before the message); send while starting
  (the handshake held: returns at once, items and deliveries in order) and two racing sends to a stopped thread (one process); send while closing (waits
  for the exit, a new pid, one delivery); start failures (worktree gone, `claude`
  missing, exit before the handshake: the item, one error item, ERROR `did not start`,
  then a retry works); Respond/Interrupt on a stopped thread; settings on a stopped thread
  (row, persisted across a restart, no spawn, the next argv); slash commands and MCP status
  across a daemon restart (snapshot, `SlashCommands`, cached `McpStatus` without a start,
  `/clear` refused from the saved list); process death (mid-turn: one "Claude stopped
  unexpectedly (exit code 1: fake claude: exit 1)"; idle exit 0 and 1: none); the idle
  stop on a fake clock (not a second early, at the expiry, status kept, reason idle, no
  item, the next send starts it; the loop on its own tick; TTL changes both ways; no
  result counts from the last activity; the grace); holds through the runner (a pending
  permission, a background shell, a background agent, a message queued behind the
  handshake, the wake after a shell's end until Claude's turn ended); archived and snoozed
  threads passed by; `idleHoldOf` table (every hold, the boundaries).
* Updated: the MCP tickets (`dropMcpChecks`), MCP and slash commands kept after a close
  and an MCP refresh/reconnect starting a stopped thread, set-effort on a stopped thread,
  the start-crash and effort-restart-crash wording, the write-permission end to end (a
  send after a daemon restart starts the thread).
* `api/thread_test.go`: a send to a stopped fake thread connects it.
* `command`: the removed commands are unknown, the registry list and chords, session.list
  (header without STATE, no state words in rows), the hidden `session.reconnect` (runs,
  never listed, no chord), `RestartCostOf` table (turns, prompts, background agents and
  shells, the wake hold, the joined sentence), app.restart and daemon.restart
  confirmations and results (background work too), archive/snooze background confirmations,
  set-effort on a stopped thread, the new MCP/slash wording. `cmd/code-foundry`:
  `activeThreads`. `daemon`: `envDuration`.

## Live run (2026-10-15, Claude Code 2.1.300)

Isolated daemon (`CODE_FOUNDRY_HOME=/tmp/cf-lifecycle-home CODE_FOUNDRY_IDLE_GRACE=20s
CODE_FOUNDRY_IDLE_CHECK=5s ./bin/code-foundry daemon --dev`), `sessions.cache_ttl_seconds
= 60`, a scratch project `~/.cf-lifecycle-scratch` (a plain folder: git commands outside
the worktree were not available to the builder), `claude-haiku-5-5[1m]` at medium. All
removed afterwards.

```
01:46:21 $ cf session new --repo 1d5a4463c4f2 --model 'claude-haiku-5-5[1m]' --effort medium \
           --name "lifecycle check" --prompt "Remember the word tangerine for later. Reply with just: ok"
created thread lifecycle check (s-d663d946a3ae) in /Users/alex/.cf-lifecycle-scratch
01:46:36 $ cf session list
ID              NAME             STATUS           REASON    WORKSPACE  PRS  CONTEXT                         WORKTREE
s-d663d946a3ae  lifecycle check  needs_attention  finished  -          -    22.4K · cache expires in 1 min  /Users/alex/.cf-lifecycle-scratch
# log 01:47:25.611 stopping idle thread at its prompt cache expiry session=s-d663d946a3ae idle=1m2s
# log 01:47:25.745 session disconnected session=s-d663d946a3ae reason=idle exit_code=0
$ cf session list --json   ->  SESSION_STATE_DISCONNECTED idle SESSION_STATUS_NEEDS_ATTENTION finished
01:47:34 $ cf thread send --id s-d663d946a3ae --text "What word did I ask you to remember? Reply with just the word."
# spawned: … --resume 6418f13f-b82c-4a11-8e5d-bbe498b80fc8 --model claude-haiku-5-5[1m] --effort medium …
#4 you: What word did I ask you to remember? Reply with just the word.
#5 claude: tangerine
01:47:51 $ cf thread send … --text "Use the Bash tool with run_in_background set to true to run: sleep 120. …"
$ cf thread agents   ->  no subagent runs in this thread · 1 shell in the background
01:49:15 (cache expired 01:48:55)  ->  SESSION_STATE_CONNECTED, background_shells_running 1, no stop
# log 01:49:54.715 background shell ended task=blw18s6ln
#11 claude: The background `sleep 120` finished with exit code 0.
# log 01:51:00.612 stopping idle thread at its prompt cache expiry idle=1m4s; disconnected reason=idle
# daemon restarted (SIGTERM, the rebuilt binary)
$ cf thread commands  ->  42 slash commands
$ cf thread mcp       ->  MCP servers: 1 of 4 connected (checked 3 min ago, at the start of the last turn)
$ cf thread set-model --id s-d663d946a3ae 'claude-4.5-haiku[1m]'  ->  … uses Haiku 4.5
$ cf thread set-effort --id s-d663d946a3ae medium  ->  … uses effort medium from its next message
$ cf session list --json  ->  DISCONNECTED idle claude-4.5-haiku[1m] medium   (no process started)
01:53:52 $ cf thread send … --text "Reply with just: ready"
# spawned: … --resume 6418f13f-… --model claude-4.5-haiku[1m] --effort medium …
#14 claude: There's an issue with the selected model (claude-4.5-haiku[1m]) …   (404 on this account, as the snooze note recorded)
$ cf thread set-model … 'claude-haiku-5-5[1m]'  (live: "Set model to `claude-haiku-5-5[1m]`")
$ cf thread send … --text "Which word did I ask you to remember at the start? …"   ->  #19 claude: tangerine
# log 01:55:09.638 stopping idle thread … idle=1m2s
$ cf session close …      ->  unknown command "session close"
$ cf session reconnect …  ->  unknown command "session reconnect"
$ cf daemon restart </dev/null  ->  Restart the daemon? Threads keep their history; a message starts each again.
```

Not exercised live: a start failure (unit tests only), the send-while-starting queue and
send-while-closing wait (fake Claude), the wake hold's gap (PR A's fake knob), the GUI.

## What PR C must change in the GUI

Inventory taken on this branch (paths under `gui/frontend/` unless absolute; lines as of
this PR). First decide what `SessionView.state` means now: it gates far more than the
connection UI (sending, the working/starting rows, the cold-cache and retry notes, MCP
buttons, sidebar grouping, counts). Likely: keep `starting` (the "Starting Claude…" row
is honest while a message waits for the handshake) and treat the rest as status-only.
The daemon accepts a message in any state now.

Production:

* `gui/app.go:137-138` appMenu comment: cmd+shift+r is no longer `session.reconnect`.
* `src/api/session.ts` 17 `SessionStateView`, 37/48-51 `state`, `exitCode`,
  `disconnectReason`, `lastError`, 228-233 `stateMap`, 261-269 mapping, 19-21/72/78-80
  comments ("disconnected", "reconnecting"): shrink or drop.
* `src/stores/sessionActions.ts` 12/14 `SESSION_COMMANDS.reconnect/close`, 37-39
  `reconnectSession`, 45-47 `closeSession` (`session.close` is gone; remove both), 59-62
  archive comment. Then delete the hidden `session.reconnect` from
  `internal/command/commands_session.go` (and `Reconnect` from `SessionBackend` and the
  commandtest fake) in the same PR.
* `src/stores/sessions.ts` 153-156 `isRunning` (busy and not disconnected: status only),
  158-163 `connectedCount` (remove), 29/132 comments.
* `src/stores/update.ts` 51-58 `useLiveSessionCount` (count what a restart cuts off like
  `command.RestartCostOf`: turns, prompts, background work, `backgroundWakePending`), 67
  busy names.
* `src/lib/session.ts` 3-30 `sessionBadge`/`badgeLabels` (starting/closing/disconnected
  badges), 125-140 `threadGroup` (state-based groups: status only), 143-166
  `disconnectReason` + `disconnectCause` (the Reconnect card's text: delete).
* `src/lib/statusLine.ts` 10-11, 20, 33-34, 48, 55-59: starting/closing line kinds.
* `src/lib/projects.ts` 216-219 `isLiveThread`, 222-230 `liveThreadCount`, 238-254
  `CleanupSessions`/`threadHolds` (the daemon's cleanup guard is unchanged: it still
  counts only threads with a process), 286 tooltip "no live thread or terminal".
* `src/lib/coldCache.ts` 14, 24-29: the note only shows while `connected`; drop the gate
  (an expired cache now usually means Claude stopped; the next message re-reads it).
* `src/lib/retryNote.ts` 12, 42-46: `connected` gate.
* `src/lib/update.ts` 123 comment, 249-257 copy "can be reconnected", "It'll reconnect
  with its history".
* `src/lib/tree.ts` 141 comment ("closing, offline").
* `src/surfaces/workspaceTarget.ts` 9, 91-99 `liveWorkspaceThread` (filters
  `isLiveThread`).
* `src/components/thread/ThreadComposer.tsx` 17/23 imports, 46-50 `keyboardElsewhere`
  comment, 103-166 the `Reconnect` card (`thread-disconnected`, "Not connected · cause",
  the reconnect button; it also hosts "Snoozed until", Unsnooze and "Snooze ended": move
  those), 186/208/210 `live` and `canSend` gated on `connected` (allow sending always),
  196/216-283 reconnect focus "flip" logic, 305 the card replacing the composer, 319
  comment (cmd+shift+w).
* `src/components/thread/ThreadPane.tsx` 56 comment, 67/77/79-80 `live`, `busy`,
  `working` from state, 96 the Watch "reconnecting…" chip (stream, keep; drop the state
  clause), 107 "No messages yet" gated on `connected`.
* `src/components/thread/rows.tsx` 621-645 `WorkingRow` "Starting Claude…" (keep if
  `starting` stays).
* `src/components/thread/ColdCacheNote.tsx` 16/30, `RetryNote.tsx` 18/32: pass `state`.
* `src/components/thread/HeaderActions.tsx` 2/109: the `session.close` Power button.
* `src/components/session/SessionParts.tsx` 91-110 `SessionIndicator` "starting…" /
  "closing…".
* `src/components/session/SessionStatusIcon.tsx` 1, 7-10, 16-20: `Unplug` for
  disconnected, spinner for starting/closing.
* `src/components/session/SessionLink.tsx` 3/14: aria label from `sessionBadge`.
* `src/components/sidebar/SidebarRow.tsx` 182/188-192 `data-session-badge`, 238-242
  `offline` dimming (`opacity-50`, `data-offline`), 456-459 comment.
* `src/components/sidebar/RowMenu.tsx` 2/18 imports, 80 state, 147-166 Reconnect / Close
  items.
* `src/components/mcp/McpSurface.tsx` 61/81 Refresh disabled unless `connected`,
  136/202 the per-server MCP Reconnect disabled unless `connected` (keep the button; the
  daemon now starts a stopped thread for it), 255/260 `ensureMcpStatus` only when
  connected (the cached status is there while stopped), 272 copy "The thread is not
  running. Reconnect it to see its MCP servers."
* `src/components/start/StartPage.tsx` 16/92-94/118: "N connected" count.
* `src/components/help/HelpOverlay.tsx` 73-74: "A closed thread stays listed,
  disconnected, and Reconnect resumes its conversation."
* `src/components/projects/WorktreeState.tsx` 6/44-52 "N live threads",
  `useCleanable.ts` 14/23, `ProjectsPage.tsx` 74/366-367: follow `projects.ts` and
  `workspaceTarget.ts`.
* `src/components/update/UpdateDialog.tsx` 11/113/223-224: follow `stores/update.ts`.
* `src/keys/bindings.ts` 129-131, 374: comments naming `session.close` / cmd+shift+w.
* `src/surfaces/agentsTarget.ts` 14 comment.
* The slash card: `Commands` now come with the snapshot for stopped threads too, so the
  ListSkills fallback is only for threads Claude never answered (`docs/notes/
  slash-commands-2-gui.md`).

Mock (`mock/`): `world.ts` 63/73 `state`/`disconnectReason`, 193-198
`archiveInterrupts` (add the background-work case like the daemon), 505 `isConnected`,
571 the live count, 629-639 and 827-838 seeds (DISCONNECTED/STARTING/CLOSING rows),
861-871 run-in, 909-910 removal guard, 1050-1063 `disconnectSession`, 1109, 1227/1250/2333,
1261-1271 wake, 1275-1288 `reconnect()`, 1300-1318 tick, 2116-2125 and 2140-2147 the
`session.close`/`session.reconnect` entries (delete), 2270/2296 copy; `server.ts` 18-25,
48-50, 372-377 close/reconnect stubs, 593, 610/624-629 `session/disconnect`;
`thread.ts` 72, 109, 580 and 1052 ("not connected; reconnect it first": a send should
start the thread); `mcp.ts` 82/103.

E2E (`e2e/`): `sessions.spec.ts` (badges, `data-offline`, the Reconnect card, Meta+Shift+w,
FocusSession focusing reconnect: mostly rewrite), `buttons.spec.ts` 98-138 (Close button),
`live.spec.ts` 30/33/202/224-254/298-300, `live-prsession.spec.ts` 6, `live-files` 85,
`live-skills` 89, `live-workspace` 29/66, `live-sidebar` 33/111, `live-wspanel` 116 (all
`session close` cleanups: use `session remove` or nothing), `thread.spec.ts` 495-519,
`snooze.spec.ts` 81/174-191/264-279, `archive.spec.ts` 110/153-155, `panel.spec.ts`
502-521, `bottom-panel.spec.ts` 163-176, `layout.spec.ts` 175-178, `app.spec.ts` 209,
`start.spec.ts` 10-13/41-81, `sidebar.spec.ts` 324/393-394/489, `projects.spec.ts`
183-200, `update.spec.ts` 136, `compose.spec.ts` 110. Not affected: `thread-reconnect.spec.ts`
(the Watch stream chip), `mcp-panel.spec.ts` (MCP server reconnect).

Unit tests: `lib/session.test.ts` 16-48/77-89, `stores/sessions.test.ts` 4/31/154-182/271-304,
`lib/statusLine.test.ts`, `lib/coldCache.test.ts` 8/29-31, `lib/retryNote.test.ts` 12/25-26,
`lib/projects.test.ts` 224-266, `surfaces/workspaceTarget.test.ts` 68-82,
`surfaces/mcp.test.tsx` 21/58/180-189, `components/thread/HeaderActions.test.tsx`
34-137, `components/sidebar/SidebarRow.test.tsx` 39-139, `api/mapping.test.ts` 23/328-334,
`lib/update.test.ts` 132-171; fixtures only: `stores/dockAlerts.test.ts`,
`stores/context.test.ts`, `keys/bindings.test.ts`, `surfaces/mcpTarget.test.ts`,
`surfaces/agents.test.tsx`, and the factories that set `state: "connected"`.

## Daemon restart

Needed after merging: Go, the command registry and migration 0021 changed.
