# Phase 2a: Session store

> **Superseded (2026-10-10):** `repo.register` (`code-foundry repo register --path`) was removed. Add a folder with `code-foundry repo add <folder>` on the CLI, or the Add Project dialog (`repo.add`) in the app; see `add-project-remove-register.md`. Mentions below are historical.

Status: done on branch. `make check` is green. Exercised end to end with the built binary
on a temp `CODE_FOUNDRY_HOME`, with the daemon started from inside a Claude Code session
(so the env scrub was exercised for real), against Claude Code 2.1.294. The timings are
listed below.

## Layout added

| Path | What |
|---|---|
| `internal/store/session/session.go` | `Session`, `State`, `Snapshot`, bus `Event`s (`Updated`, `Removed`, `*Snapshot`), `CreateOptions`, `Store` interface, errors, disconnect reasons |
| `internal/store/session/detector.go` | `Status`, `StatusDetector`, `ScreenTextFn`, `DetectorFactory`, `NewStubDetector` |
| `internal/store/session/manager.go` | `Manager`: Create, Fork, Reconnect, Rename, Close, Remove, Shutdown, worktree resolution, naming dispatch |
| `internal/store/session/runner.go` | One goroutine per connected terminal: observer mailbox, connect detection, trust-dialog answer, transcript tail, detector feed, close sequence, exit handling |
| `internal/store/session/claude.go` | Verified CLI flags, argv builder, slug rule, Claude paths (`$CLAUDE_CONFIG_DIR` aware), uuid |
| `internal/store/session/trust.go` | Pre-trust writer for `~/.claude.json` (lock + atomic replace), `parseTrustDialog` |
| `internal/store/session/transcript.go` | `tailer` (fsnotify + poll), `pidSessionID` |
| `internal/store/session/naming.go` | `ClaudeNamer`, `slugify`, `firstUserText` |
| `internal/store/session/db.go`, `internal/db/migrations/0003_sessions.sql` | Persistence |
| `internal/store/session/sessiontest` | In-memory `Fake` store |
| `internal/store/terminal` (additive) | `Spec.Observer`, `ObserveEvent`, `Store.ScreenText` (+ fake support) |
| `internal/api/session.go` | Thin `SessionService` handler; `sessionEventToProto` is reusable by the events stream |
| `internal/command/commands_session.go` | `session.new/list/focus/close/reconnect/rename/fork/remove`; `all.Deps.Session` |
| `internal/daemon/env.go` | Env scrub at startup |
| `proto/codefoundry/v1/ui.proto` | `UiIntent.FocusSession{session_id}` (field 5, additive) |

## Verified Claude CLI facts (2.1.294, `claude --help` plus experiments)

* `--model <alias|full name>`: aliases `fable`, `opus`, `sonnet`. `haiku` also works (checked
  with `-p`).
* `--effort low|medium|high|xhigh|max`.
* `--session-id <uuid>` sets the conversation id, so the transcript is `<uuid>.jsonl`.
* `--resume <id>`. `--resume <id> --fork-session --session-id <new>` works: the fork runs
  under the id we chose.
* `-p` skips the trust dialog. `--no-session-persistence`, `--tools ""`, and
  `--strict-mcp-config` are accepted with `-p`.
* `-n/--name` exists. It is not used: our names live in the session store.

## Decisions

**Claude session id is chosen, not guessed.** New sessions and forks are spawned with
`--session-id <uuid>`, and reconnects with `--resume <id>`. Discovery then waits for that
one known file instead of picking "the newest .jsonl" in a directory that other sessions in
the same worktree also write to. `claude_session_id` is set (and persisted) only once the
transcript file exists. Before the first message there is no file and nothing to resume.

**Transcript path rule.** `<claude dir>/projects/<slug>/<id>.jsonl`. The slug is the cwd
**with symlinks resolved** (`/tmp` → `/private/tmp`) and every non-`[A-Za-z0-9]` character
replaced by `-`. Verified: `/Users/alex/.t3/projects/sat-prep` →
`-Users-alex--t3-projects-sat-prep`, and `/tmp/cf2a_slug test.v2` →
`-private-tmp-cf2a-slug-test-v2`. If the file is not in the computed dir, the code falls
back to globbing `projects/*/<id>.jsonl`, because Claude may shorten very long slugs. The
file appears with the first message, which was 54 ms after Enter in the e2e run. The tailer
watches the project dir with fsnotify (or `projects/` until the project dir exists) and also
polls on the 1 s tick. It starts at EOF for resumes, so history is not replayed. It handles
partial lines and truncation, and skips lines over 8 MiB.

**`/clear` rotation** is followed through Claude's per-process record
`<claude dir>/sessions/<pid>.json` (`{"pid","sessionId","cwd","status",...}`). Claude rewrites
it when `/clear` starts a new id and removes it on exit. Each tick, the runner reads it for
the terminal's pid and switches the tailer when `sessionId` changes. Verified e2e: `/clear`
moved the session from `6505…` to `5682…` and the new transcript was discovered. That file
also carries `"status":"busy"|"idle"`, which may interest 2b.

**Trust.** Claude records an accepted dialog as `projects[<realpath>].hasTrustDialogAccepted
= true` in `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` if set). I verified this by
diffing the file before and after accepting in `/tmp/cf2a-trust1`, and Claude's own error
text says the same. A minimal entry `{"hasTrustDialogAccepted": true}` is enough: Claude
filled in the rest itself. Claude's trust check also walks up to trusted parents.

* Before every spawn, the store writes the entry for the worktree's real path, unless it is
  already true. It takes proper-lockfile's lock convention (bundled in Claude: a
  `<file>.lock` directory, stale after 10 s), re-reads the file, edits only that entry, and
  replaces the file atomically with the original mode. Nothing is written for
  already-trusted paths (`/Users/alex/projects/code-foundry` was untouched).
* The fallback, if the entry did not take, is to read the rendered screen
  (`ScreenText`) while STARTING. Claude preselects **"No, exit"**, so the runner sends Down
  until `❯ Yes, I trust this folder` is selected, then Enter. Keys are at least 300 ms
  apart, with at most 12 keys. CONNECTED is not declared while the dialog is visible.
  `parseTrustDialog` is table-tested on screens captured from the real dialog.
  `TestRealClaudeTrustDialogFallback` (gated by `CF_REAL_CLAUDE=1`) ran it against real
  Claude: the dialog was answered and the session was CONNECTED after 2.3 s.

**Store requires a registered worktree.** `Create` resolves `(repo?, worktree?)` against the
repo store: a repo alone means its main worktree, a path alone is matched (symlink-aware)
against every registered repo's worktrees, and anything else fails with
FailedPrecondition. Trust is therefore only ever written for worktrees of registered repos,
as the plan requires. `labels.worktree` is the repo store's worktree path exactly.

**State machine.**

| From | Event | To |
|---|---|---|
| (new) | Create/Fork/Reconnect spawn | STARTING |
| STARTING | alt screen on, or title set, with no trust dialog on screen; or `StartTimeout` (15 s) | CONNECTED |
| STARTING/CONNECTED | Close/Remove | CLOSING |
| CLOSING | process exit | DISCONNECTED "closed" |
| STARTING/CONNECTED | exit 0, no close requested | DISCONNECTED "exited" |
| STARTING/CONNECTED | exit ≠ 0, no close requested | DISCONNECTED "crashed" (Kill through TerminalService gives 129, which counts as crashed) |
| any live | daemon shutdown | DISCONNECTED "daemon stopped" |
| live row on load | daemon died without shutdown | DISCONNECTED "daemon restarted" |

On exit, the runner removes the terminal after recording the exit code. Close blocks until
DISCONNECTED (bounded by the 10 s close timeout plus the terminal store's 3 s kill grace).
Reconnect without a resumable conversation starts a new one and says so in `last_error`.

**Graceful close = Escape, Ctrl-C, Ctrl-C (deviation from "Escape, Ctrl-U, /exit").**
I tested the brief's sequence first. With the user's `editorMode: "vim"`, Escape leaves
INSERT for NORMAL mode, Ctrl-U and `/exit` become vim edits, and Enter **submitted the
leftover text ("t") as a prompt to the model**. Ctrl-C clears input in any mode and arms
"Press Ctrl-C again to exit", and the second Ctrl-C exits (code 0) through Claude's normal
graceful path. Escape still goes first so a running turn is interrupted. The Ctrl-C pair
repeats every 2 s until exit, and at 10 s the terminal is killed. A user typing `/exit`
themselves is fine: that is the "exited" path.

**Auto-naming.** On the first real user line in the transcript (`type:"user"`, not
meta/sidechain, text content that is not a tool result or a `<command-…>` wrapper), the
store runs
`claude -p --model haiku --no-session-persistence --tools "" --strict-mcp-config <prompt>`
in `/tmp` with a 20 s timeout. The output is reduced to a kebab slug (at most 5 words,
60 chars). There is one attempt per session per daemon run, none if a name was given or set
by Rename, and none for forks (they inherit `<parent>-fork`, because their transcript
replays the parent's first message). With no tools and no MCP servers, a hostile first
message cannot make the naming call do anything but answer. It took 1.4–1.6 s.

**Status.** The runner feeds `StatusDetector.Output` from the observer mailbox,
`Transcript` from the tailer, and `Tick` every 1 s. A changed `Status()` publishes after a
100 ms debounce. State changes publish immediately. `last_activity_at` moves on every
output chunk, but activity-only updates are published at most every 15 s and persisted at
most every 30 s. An idle Claude still redraws every few seconds, so faster publishing was
noise (the first e2e run, at 5 s, showed an update every 5 s from an idle session).

**Initial prompt** is typed once `❯` is on screen (CONNECTED fires on the title/alt switch,
before the input box is drawn), then Enter 300 ms later.

**Env scrub.** At daemon startup, before any store starts, `CLAUDECODE`, every
`CLAUDE_CODE_*`, and also `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_AGENT_SDK_VERSION` are
unset. The extra three describe the parent session too, and `CLAUDE_EFFORT` would override
the effort the user picked. `CLAUDE_CONFIG_DIR` and API keys are kept. Names are logged, but
values are not (one is a token). The e2e daemon logged 11 removed variables. Spawned
terminals add no env of their own.

**Terminal observer hook.** `Spec.Observer func(id string, ev ObserveEvent)` is called on the
actor goroutine for each output chunk (after the emulator has consumed it), each title
change, each alt-screen change (both immediate, not throttled), and exit (always last). It
must not block and must not call back into the store (deadlock). The session runner pushes
events into an unbounded mailbox and does everything else on its own goroutine.
`ScreenText(ctx, id)` formats the active area only (rows × cols, no scrollback) in plain
mode through a selection over `PointTagActive`.

**Bus and API.** The store publishes `session.Updated` and `session.Removed` as
`bus.Publish[session.Event]`. Publishing, snapshot rebuild, and the DB write happen under one
mutex, so all three agree on order. `*session.Snapshot` also implements `Event`, so an events
multiplexer can treat a resync as an event. `api.NewSession(store, bus)`: `Watch` sends the
snapshot first, then events, and re-sends the snapshot if the subscriber dropped events.
`sessionEventToProto` and `sessionToProto` are package-level for `events.go` (2c).

## Commands

`session.new {repo?, worktree?, model?, effort?, name?, prompt?}`, keybinding `cmd+n`. It is
available when there is an active repo or worktree, or one is given explicitly. Model enum:
`fable opus sonnet haiku`; effort enum: `low medium high xhigh max`. It emits
`FocusSession` after the store has published the new session.
`session.close/reconnect/rename/fork/remove/focus` need `--id` or `active_session_id`.
`session.reconnect` calls Get first and refuses with FailedPrecondition unless the session
is DISCONNECTED. `session.fork` also emits `FocusSession`. `session.list` (added for the
CLI) prints a table, or the proto with `--json`.

## End-to-end run (2026-10-08, Claude Code 2.1.294)

Daemon: `CODE_FOUNDRY_HOME=/tmp/cf2a-home ./bin/code-foundry daemon --dev`, started from
inside a Claude session. The attach, write, and watch steps used
`internal/daemon/session_driver_test.go` (gated by `CF_DRIVE_HOME`), which talks to the
loopback listener like the GUI and renders snapshots in libghostty.

| Step | Observed |
|---|---|
| `repo register --path /Users/alex/projects/code-foundry` | registered |
| `session new --worktree /Users/alex/projects/code-foundry --model opus` | argv `claude --session-id <uuid> --model opus`; STARTING → CONNECTED in **491 ms** (title set); no dialog (already trusted, config untouched) |
| Attach | 1.9 KB snapshot in 1 ms, `alt=true`; rendered the banner, `❯ Try "fix typecheck errors"` between rules, `-- INSERT --` footer |
| Write "reply with the single word pong" + Enter | transcript discovered **54 ms** after Enter, `claude_session_id` set; auto-named `pong` in **1.55 s** |
| `session close` | CLI round trip **0.63 s**; exit 0; DISCONNECTED "closed" |
| `session reconnect` | argv `claude --resume <id> --model opus`; CONNECTED in **510 ms**; snapshot shows `❯ reply with the single word pong` / `⏺ pong` |
| Write `/exit` + Enter | DISCONNECTED "exited", exit 0, **250 ms** |
| Scratch repo `/tmp/cf2a-trustrepo` (fresh `git init`, never trusted), `session new --model haiku --effort low` | "pre-trusted worktree" logged; CONNECTED in **493 ms**; screen shows the prompt, no dialog; `~/.claude.json` gained `/private/tmp/cf2a-trustrepo` |
| SIGTERM daemon with that session connected; restart | both listed DISCONNECTED ("exited", "daemon stopped") |
| `session reconnect` both | the first resumed its conversation; the second (no message was ever sent) started fresh with `last_error` "no saved conversation to resume…"; a second reconnect was refused (exit 2, FailedPrecondition) |
| `session fork` | argv `--resume <id> --fork-session --session-id <new>`; `pong-fork`; snapshot shows the parent's history |
| `/clear` in the resumed session | "claude switched session id" then the new transcript was discovered |
| `session rename`, `session remove` (connected) | remove = graceful close + delete in **0.73 s** |
| `session new --worktree /tmp/cf2a-trustrepo --prompt "reply with the single word pong"` | `/tmp` path matched the registered `/private/tmp/...` worktree; the prompt was typed once `❯` appeared; transcript and name followed |
| `CF_REAL_CLAUDE=1` dialog fallback test | dialog answered (Down, Enter), CONNECTED **2.35 s**, close **785 ms** |

Afterwards the scratch dirs, their transcript dirs, and the two e2e transcripts in this
repo's project dir were deleted. The scratch trust entries (`/private/tmp/cf2a-*`) remain in
`~/.claude.json`.

## Gotchas

* **Vim mode breaks typed commands** (see Close). Never type text into Claude unless the
  screen shows it is in a state to receive it.
* **CONNECTED precedes the input box** by up to a few hundred ms (longer after the trust
  dialog). Anything typed has to wait for `❯`.
* **No message, no transcript, no resume.** `--resume` of an id with no file fails, so
  Reconnect checks the file and starts fresh instead.
* **Realpath everywhere.** Trust keys and slugs use `/private/tmp`, not `/tmp`. The repo store
  also resolves symlinks, so worktree matching compares both forms.
* **Rewriting `~/.claude.json` re-sorts its keys** (Go maps). Values are preserved exactly:
  numbers stay raw and HTML is not escaped. Only new trust entries cause a write.
* **Claude titles its own terminal** from an AI summary ("✳ Pong reply") and writes
  `{"type":"ai-title"}` lines to the transcript. This could replace the `claude -p` naming
  call later. Haiku sometimes answers with one word ("pong") despite "3-5 words".
* **Ctrl-C's "again to exit" arm survives other keys**: Ctrl-C, typing, Escape, Ctrl-C
  exits. Anything that sends Ctrl-C for other reasons must keep this in mind.
* **A Finder-launched daemon has a minimal PATH**, so `claude` (in `~/.local/bin`) may not
  resolve, for the terminal spawn or for the naming call. Phase 0/packaging should give the
  daemon a login-shell PATH.
* `internal/store/session/probe_test.go` (gated by `CF_PROBE_DIR`) is the harness used for
  the experiments above: it drives any program through the terminal store with scripted
  keys and screen dumps.

## Merge notes

* **2b detector**: one line in `internal/daemon/stores.go`, in the `session.Options` literal
  (it is there as a comment):

  ```go
  NewDetector: func(f session.ScreenTextFn) session.StatusDetector { return claudestatus.New(f) },
  ```

  This assumes `claudestatus.New(session.ScreenTextFn)` returns a type with
  `Output([]byte)`, `Transcript([]byte)`, `Tick(time.Time)`, and
  `Status() (session.Status, string)`. If 2b defines its own `Status` type, wrap it in an
  adapter that casts: the values mirror the proto (0 unknown, 1 busy, 2 idle, 3 needs
  attention).
* **2c**: `ui.proto` gained `FocusSession`, and its generated TS
  (`gui/frontend/src/gen/codefoundry/v1/ui_pb.ts`) is regenerated on this branch. If 2c also
  ran `make gen`, keep either copy and rerun `make gen`. For the events stream, subscribe
  with `bus.Subscribe[session.Event]` and convert with `sessionEventToProto`; the snapshot
  comes from `st.session.Snapshot()`.
