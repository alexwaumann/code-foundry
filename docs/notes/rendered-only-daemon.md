# Rendered-only threads: daemon (2026-10-12)

Daemon half of `rendered-only.md`. Every thread is `claude -p` over stream-json; the
terminal thread mode and everything that existed only for it is gone. The PTY stack
(terminal store, `TerminalService`, the bottom shell, `terminal.*`) stays.

## Deleted

* `internal/claudestatus/` (screen/OSC/transcript detector, replay fixtures) and its
  only consumer `internal/daemon/detector.go`; `internal/daemon/session_driver_test.go`
  (CF_DRIVE_HOME driver that attached to a thread terminal).
* Session store: the PTY `run` loop, `mailbox`/`observe`/`attach`, `onEvent`,
  `write`, `connect`, `checkStartup`/`trustVisible`/`screen`, the Escape/Ctrl-C close
  sequence (`beginClose`/`closeNext`/`onExit` and their constants), typed `/cd`
  (`sendCd`, `cdEnterGap`, `cdSending`, `cdTimer`), `awaitFirstPrompt`, the trust
  dialog parser (`trustDialog`, `parseTrustDialog`, `keyDown`, `keyEnter`),
  `StatusDetector`/`DetectorFactory`/`ScreenTextFn`/stub detector, `Render` and its
  constants, `Session.TerminalID`, `Session.Render`, `CreateOptions.Render`,
  `Options.NewDetector`/`Cols`/`Rows`/`DefaultRender`, `renderOrTerminal`, the
  positional `-- <prompt>` argv tail.
* Settings: `sessions.render` (`KeyRender`, `Sessions.Render`, `RenderTerminal`/
  `RenderRendered`, `settingsRender`).
* Command/API: `session.new --render`, `SessionRenders`, `hasRenderedThread`,
  `Context.ActiveSessionRendered`, `Render`/`TerminalId` mapping, `sessionError`'s
  terminal-store fallback, the "use session.close" hint on terminal close.
* Migration `0016_drop_session_render.sql`: `ALTER TABLE sessions DROP COLUMN render`
  (DROP COLUMN needs SQLite 3.35+; modernc sqlite 1.60.1 applies it, in `internal/db` tests and on a populated v15 DB).

## Simplified

* `spawn` always starts the stream (`startStream` folded in); `claudeCommand` has no
  prompt; `launch.argv` always adds `streamArgs`. The runner keeps `st *streamState`
  (always set by `spawnStream`), and the status is `r.st.sd` directly; `run` is the
  former `runStream`, `beginClose`/`closeNext`/`shutdown` the former stream variants.
* `streamStatus` lost its no-op detector methods; its reason strings are unchanged
  (the GUI classifies by `permission:`, `question:`, `finished`, `error:`).
* RunIn: `tryCd` waits for `AtPrompt` + `cdSettle`, then `streamCd` (set_cwd).
  `unsentCd` is the queued request only.
* `liveStream`, `thread()` and the sessiontest fake no longer refuse anything for its
  mode; `thread.*` and MCP commands are available whenever a thread is active.
* Kept on purpose: `trustWorktree`/`PreTrust` (spawn and RunIn pre-trust; set_cwd
  refuses an untrusted folder), `Options.Terminals` (Remove still kills a thread's
  shells), `termlabel` (shell labels only now), `terminal.Spec.Observer`,
  `ObserveEvent` and `Store.ScreenText` (no production caller any more; PTY infra).

## Tests

* One harness (`manager_test.go`): `newEnv` / `newFixtureEnv(fixture)` /
  `newFixtureEnvAt(path, vars)` run the fake claude (`fakeclaude_test.go`). New fake
  knobs: `CF_FAKE_CLAUDE_SPAWN=<dir>` records `{argv, cwd, env}` per pid (`e.spec(id)`
  replaces `terms.Spec(TerminalID)`); SIGUSR1/SIGUSR2 exit 0/1 (`e.exit(id, code)`, -1
  is SIGKILL). `connected()` waits for the first status, so no start-up update is still
  in flight when a test starts counting events.
* Statuses come from captures instead of a settable detector: a turn-less capture for
  busy, `ask` for a question, `write-allow` for a permission, `text-table` for idle or
  finished (`status_test.go`, `runin_test.go`).
* Barriers that read the fake detector's transcript lines now use a side effect of a
  sentinel line (a pr-link or a usage record) and assert every update seen is the
  sentinel's (`usage_test.go`, `prlink_test.go`).
* `repotest.Fake.MakeDirs` / `workspacetest.Fake.MakeDirs` (opt-in): claude now really
  starts in the worktrees Create makes, so they must exist.
* Deleted as terminal-only: trust dialog, Escape/Ctrl-C close, typed /cd, waits for
  the positional prompt, detector publishing, acknowledge on attach, probe and
  real-claude trust tests, `TestDefaultRender`, terminal-refusal cases. Added:
  `TestCloseTerminatesAfterTimeout` (stdin closed, SIGTERM after CloseTimeout),
  `TestOpenReportsRemovedSettings`, a session-grants `TestLaunchArgv` case.

## Gotchas

* A pending question or permission does not survive a disconnect: the stream runner
  drops pending requests before reading the final status, so "crash/close at a
  question" ends as error "interrupted" (the terminal mode kept the question). The
  ported `TestStatusSurvivesDisconnect` asserts this; a daemon crash still keeps it.
* The fake's cwd reads back symlink-resolved (`/private/var/...`): compare with
  `samePath`.
* Test options that set `o.Env` must append: the fake's own variables are in it.

## Smoke test (isolated home, real claude, haiku)

Old binary (main, 293da80) first, so the migration runs on real rows:

    CODE_FOUNDRY_HOME=/tmp/cf-ro-smoke /tmp/cf-old-bin/code-foundry daemon --dev &
    code-foundry repo add ~/cf-scratch-ro
    code-foundry session new --worktree ~/cf-scratch-ro --model haiku --effort low --render terminal --name old-terminal
    code-foundry session new ... --render rendered --name old-rendered
    kill -TERM <pid>          # sqlite: render 1 and 2, schema version 15
    # added render = "terminal" under [sessions] in settings.toml

New binary (`make build`) on the same home:

    ./bin/code-foundry daemon --dev &      # schema 16, no render column
    # log: level=WARN msg="settings: value ignored" key=sessions.render reason="unknown setting"
    session list               # both old rows disconnected (daemon stopped)
    thread items --id <old-terminal>       # (no items yet)
    session reconnect --id <old-terminal>  # started a new conversation; connected, idle at prompt
    session new --worktree ~/cf-scratch-ro --render rendered --prompt hi
                               # flag provided but not defined: -render (exit 2)
    session new --worktree ~/cf-scratch-ro --model haiku --effort low --prompt "say hi"
    session list               # auto-named say-hi-greeting, needs_attention finished, 22.1K context
    thread items --id <id>     # you: say hi / claude: Hi! ... / turn end: success, $0.0021
    session close --id <id>    # disconnected (closed)
    session reconnect --id <id>            # argv: claude -p ... --resume <claude id> --model haiku --effort low
    thread send --id <id> "say bye"; thread items --id <id>   # items 4-6 appended
    terminal list              # empty: no thread terminals
    kill -TERM <pid>           # no claude left running

Scratch repo, home and the scratch transcripts were removed afterwards.

## Manual steps for Alex

* After the daemon restart, old terminal-mode rows open as rendered threads with an
  empty timeline; a reconnect resumes their Claude session (new turns render, old ones
  do not). Remove the ones not worth keeping.
* Remove `render = ...` from `[sessions]` in `~/.code-foundry/settings.toml`; until
  then it is a non-fatal "unknown setting" issue.
