# Thread status persistence, ERROR "interrupted", reason classification

Daemon and view-model groundwork for the sidebar thread-list redesign (design record:
`/tmp/thread-list/index.html?v=14` rows, `?v=23` tooltip). The React UI is a separate
step; nothing under `gui/frontend/src/components` changed.

## What changed

* **Persistence.** Migration `0011_session_status.sql` adds `status`, `status_reason`
  and `status_changed_at` (unix ms, 0 = never known) to `sessions`. `saveSession` /
  `loadSessions` carry them; `Session.StatusChangedAt` is new. Writes happen on the
  runner goroutine (debounced `publishStatus`, now `persist=true`) and in `finish`
  (every disconnect), never on the terminal actor. A status write is the existing
  full-row upsert under `m.mu`; a turn produces a handful.
* **Disconnect rule** (`status.go`, `disconnectedStatus`): when a live process ends for
  any reason (exited, crashed, closed, daemon stopped) the session keeps its status and
  reason, except `StatusBusy`, which becomes `StatusError` / `"interrupted"`. The same
  rule runs in `New` for rows the daemon left live (a crash or SIGKILL:
  `"daemon restarted"`); since every published status is persisted, that row holds the
  last published one.
* **ERROR = 4** in `SessionStatus` (proto) and `StatusError` (store), cast-compatible.
  The detector never reports it; Claude's own API errors stay NEEDS_ATTENTION
  `"error: <code>"`.
* **Reconnect** clears status to unknown at spawn (`setStatus(StatusUnknown, "")`,
  persisted, stamped) and the new detector's first reading replaces it, as before.
* **Proto**: `status_changed_at = 26` (the brief said 25, but 25 is
  `linked_pull_requests`). `status_reason` (18) comment updated: it now persists.
* **CLI** `session list`: STATE is `disconnected (<disconnect reason>)`, STATUS is
  `error (interrupted)` for ERROR, REASON is always the status reason (`-` if empty).
  Before, REASON showed the disconnect reason for disconnected rows.

## GUI view model (for the UI step)

* `SessionView.statusReason: string`, `SessionView.statusChangedAtMs: number | null`,
  `SessionStatusView` gains `"error"`.
* `sessionBadge`: starting/closing win; a disconnected session shows `"attention"` or
  `"error"` when that is its persisted status, else `"disconnected"` (idle, unknown, or a
  legacy busy). New badge `"error"`, label "error". `SessionStatusIcon`'s `default`
  branch renders it as the generic Bot icon until the UI step styles it.
* **Attention rule.** `isAttention` (stores/sessions.ts; drives the sidebar Needs
  attention section via stores/context.ts, `attentionIds`, the count badge, window title,
  cmd+shift+a, the start page) is now `status === "attention"` in any state. Before it
  was "attention and not disconnected". With persistence a disconnected question or
  permission prompt is still waiting on the user, which is the point. ERROR is not
  attention.
* `statusKind(s)` -> `"done" | "permission" | "question" | "plan" | "error" |
  "interrupted" | "trust" | "notification" | "other"` and `statusDetail(s)` (lib/session.ts).
  Only attention and error statuses are classified; busy/idle/unknown are `"other"`.
  Mapping: `finished` done; `permission: …` and `waiting for approval: <Tool>` permission;
  `question: …` and `waiting for input` question (the latter is the no-screen inference
  for a question or plan); `plan: …`; `error: <code>` error; status error + `interrupted`
  interrupted; `trust: …`; `notification: …` and `bell` notification; `blocked: …`,
  `continue: …`, `menu: …` other (untested against real output). `statusDetail` is the
  text after the first `": "`, `""` if none.
* Table tests use reasons captured by replaying the claudestatus fixtures
  (`CLAUDESTATUS_TRACE=<fixture> go test ./internal/claudestatus -run 'TestReplayTrace$' -v`,
  `CLAUDESTATUS_TRACE_OPTS=noscreen` for `waiting for approval: Bash`).

## Mock daemon

* Sessions carry `statusReason` / `statusChangedAt`; every change goes through
  `World.setStatus` (stamps the time). `disconnectSession` applies the daemon rule;
  `reconnect` clears status.
* The default world is unchanged in rows (e2e pins its order); s-1 and s-2 got reasons.
  `POST /__mock/status-kinds` (or `MOCK_SCENARIO=status-kinds pnpm run mock`, which also
  reseeds on reset) adds one thread per kind: approval, question, plan, finished, Claude
  error, busy, idle, interrupted (disconnected, daemon stopped), and a disconnected one
  still asking a question (daemon restarted), with staggered `statusChangedAt`.
* `session/status` and `session/attention` take `&reason=`; `session/disconnect` takes
  `&status=busy|idle|attention` (the status at that moment). s-1 flips busy/idle every
  4 s, so specs that disconnect it pass `status=idle` to stay deterministic.

## Decisions and gotchas

* **Close captures the status when it begins.** The close sequence's Escape interrupts a
  running turn, so by exit the detector says idle. `beginClose` stores the reading;
  `finish` uses it when closing. Otherwise a thread closed mid-turn would end "idle".
* **`finish` reads the detector fresh**, not the published value, because a change may
  sit in the 100 ms debounce.
* **Attention persists on an explicit close too** (per the brief: other statuses are kept).
  A thread closed while a permission prompt or "finished" was showing stays in Needs
  attention until reconnected or removed. Usually the user closes the thread they are
  viewing, which already acknowledged "finished"; dialogs are not acknowledged. If this
  is noisy in practice, the fix is to demote attention to idle in the `ReasonClosed` path.
* **Persisted "finished" cannot be acknowledged while disconnected.** Acknowledge goes
  through the runner, which a disconnected thread does not have; viewing it does not
  clear it. Reconnect does.
* **`sleep N` is no good for keeping a live session busy:** Claude Code runs it as a
  background task and ends the turn ("finished"). A long tool-less generation (numbers 1
  to 800 in words, haiku) stays busy for 20+ s.

## Verification

* `make check` green. New tests: `internal/store/session/status_test.go` (rule table,
  stamping, every disconnect path persisted and read back, crash-left live rows, reconnect
  handover), CLI list rows, API mapping, `src/lib/session.test.ts` (captured reasons),
  badge and attention tables, mapping test. `make gui-e2e` green, with a new spec
  for the persisted badges.
* Live, scratch daemon (`CODE_FOUNDRY_HOME=/tmp/cf-status-e2e`, repo `~/tmp/cf-status-repo`,
  haiku/medium):
  * busy (`working: Numbers 1 to 800 in words`), SIGTERM, restart:
    `disconnected (daemon stopped)  error (interrupted)`.
  * busy, SIGKILL (row left `connected` + busy in SQLite), restart:
    `disconnected (daemon restarted)  error (interrupted)`.
  * supervised session at `permission: Do you want to create hello.txt?`, SIGTERM,
    restart: `disconnected (daemon stopped)  needs_attention  permission: Do you want to
    create hello.txt?`, `status_changed_at` still the moment the prompt appeared.
  * a turn that had ended (`finished`) survived the restart as needs-attention finished.
  * reconnect: STARTING with status unknown, then `idle  at prompt`. Close while idle:
    `disconnected (closed)  idle`.
* Not verified live: the GUI rendering of the new badges (no component work in this step;
  covered by the mock e2e spec on `data-session-badge` only).
