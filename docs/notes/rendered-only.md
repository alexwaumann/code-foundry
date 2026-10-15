# Rendered-only threads (decision record, 2026-10-12)

Update 2026-10-15 (`thread-lifecycle.md`): the daemon starts a thread's process when a message
is sent and stops it at its prompt cache expiry; there is no close or reconnect any more
(the GUI's Reconnect card goes in PR C). For a TUI-only feature, run `claude --resume <id>`
in a shell while the thread is stopped.

Status: **built**; daemon detail in `rendered-only-daemon.md`, GUI detail in
`rendered-only-gui.md`.

## Decision

Every thread is a rendered thread: `claude -p` over stream-json driven by
`internal/claudestream`, the conversation drawn by the GUI from `thread_items`. The
terminal thread mode (Claude Code's own interface in a PTY, attached through xterm.js,
status from a screen detector) is removed, not deprecated: no setting, no flag, no row
field, no migration guard.

Alex's reasoning (2026-10-12): the rendered experience is better and structured items
are what every planned feature needs (search in and across threads, citing a message,
file paths opening in the side panel, PR tags in the composer); thread status comes from
the stream instead of heuristics; and the app has no users yet, so this is the only cheap
moment to drop a mode. Two runners meant every feature twice or lopsided (context totals,
skill chips, per-turn cost, subagent chips and real status were already rendered-only).

## What was given up, knowingly

* Interactive-only Claude Code features: plan mode (already out), the TUI pickers
  (/model, /config, /mcp, /permissions, /login), trust dialogs, plugin install prompts,
  and whatever ships into the TUI next. Each one the app wants has to be built on the
  control protocol. Alex: work is 1–2 months behind on Claude Code versions, so there is
  time to add support before a new version lands there.
* A live effort switch still means a restart with `--resume` (`SetEffort`). Accepted.
* The Bedrock cache break after reconnect (`rendered-threads-followups.md` §0) has no
  terminal fallback any more. Follow-up once Alex has logs.
* Importing claude-foundry threads: resume over stream-json replays no history, so an
  import would be a one-time projection of the transcript. Not planned; Alex expects
  people to wrap up threads there and start new ones here.
* The escape hatch is the bottom shell: close the thread and run `claude --resume <id>`
  in a shell for anything TUI-only.

## What changed

* Proto: `SessionRender`, `Session.terminal_id` (9), `Session.render` (31),
  `CreateSessionRequest.render` (12) and `UiContext.active_session_rendered` (7) are
  removed with `reserved` markers.
* Daemon: the PTY runner, the Escape/Ctrl-C close sequence, the trust-dialog fallback,
  typed `/cd`, the positional first prompt, `internal/claudestatus` and
  `internal/daemon/detector.go` are deleted; `Options.NewDetector`, `DefaultRender`,
  `Cols`/`Rows` are gone; the `sessions.render` setting and `session.new --render` are
  gone; `thread.*` and `mcp*` commands are offered whenever a thread is active. Migration
  `0016` drops the `render` column. Details and the test port: `rendered-only-daemon.md`.
* GUI: the content pane is always the thread pane; `TerminalPane` and the terminal
  disconnected page are deleted (the thread composer's Reconnect card is the
  disconnected state); the composer's View picker and the header's "rendered" badge are
  gone; the mock daemon seeds rendered threads; e2e runs against the timeline. The
  xterm stack stays for the bottom shell panel. Details: `rendered-only-gui.md`.
* Docs: ARCHITECTURE §1, §4, §6, §7, §8 rewritten for one mode; PLAN has a
  "Rendered-only threads" entry. Older notes that describe the terminal mode
  (`phase2a-session.md`, `phase2b-status.md`, `thread-status-persistence.md`'s detector
  half, `workspaces-2-launch.md`'s typed `/cd`, `new-thread-composer.md`'s positional
  prompt, `rendered-threads-4-optin.md`'s View picker) are history; this note supersedes
  them where they disagree.

## Manual steps for Alex

* Old terminal-mode rows open as rendered threads with empty history after the
  migration (a reconnect resumes the Claude session; new turns render, old ones do not).
  Remove the ones not worth keeping.
* Delete `render = ...` under `[sessions]` in `~/.code-foundry/settings.toml` if present
  (otherwise it shows as an unknown-setting issue, non-fatal).
* Daemon restart: needed (Go, proto and a migration changed).
