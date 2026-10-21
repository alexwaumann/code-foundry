# CLI fuzz fixes (2026-10-21)

Fixes for the CLI and command-registry fuzz report (cli findings 1-14, api finding 6).

## Decisions

- **Empty ids.** The daemon still treats an empty raw value as absent (the palette sends
  blank fields), so the guard is on the CLI: `ArgSpec` gained `id` and `context_bound`,
  and the CLI refuses an id or context-bound flag set to an empty or blank value
  (`--id "$CHILD"` with CHILD unset). A `DefaultToThreadEnv` flag keeps `--flag=` as its
  opt-out. On the daemon side an `ids` list of only blanks is an `InvalidArg`, and
  `thread.remove`/`thread.archive` from the CLI (no active view) refuse the caller's own
  thread unless `--id` names it. The GUI (whose context thread is the one in view) is
  unaffected; a plugin that builds a context with no view and no `id` is refused too.
- **Invoke order** is now name, arg syntax, id resolution, availability, required args,
  confirmation. Resolving first lets `When` see a full id (`terminal close 3ec0`), and the
  project resolver lets `When` see a project named by name or path.
- **Missing context arg.** From the CLI a required context-bound arg with no value is
  reported as `missing --id (default: the active thread; there is none)` instead of "not
  available in this context". The GUI keeps `ErrUnavailable` (it only offers what is
  available).
- **git.* and worktree.*** default `--worktree` to the CLI's working directory
  (`DefaultToCwd`); an explicit `--context-worktree` wins. `pr.*` do not: their
  availability matches the worktree path exactly, so a subdirectory would read as "not
  on GitHub".
- **Positional ids** on archive, remove, pin, sidebar, interrupt, snooze, agents, mcp,
  commands, terminal close/kill/remove, and project delete; rename's name and label's
  `add` are positional. Leftover words name the single unset id flag ("did you mean --id
  8f3a?"); when a positional took the first word it says so (`thread send 8f3a "hi"`).
- **Project refs.** `ProjectID` is an id kind without a prefix that resolves through a
  `RefResolver` (id, unique name, or a path inside the project) for every project arg
  that took only an id. An unknown ref passes through for the backend to say not found.
- **Daemon restart mid-wait.** A Canceled/Unavailable error while the CLI's own context
  is live is `daemon connection lost (it stopped or restarted)` (exit 1). `thread wait`
  and the wait half of `thread send --wait` (as a `thread.wait`, never a second send)
  retry once for the time left of `--for`. `action wait` does not: runs are forgotten on
  restart.
- **Short ids.** A value under 4 characters still passes resolution through (many
  callers and tests use short fake ids); a NotFound from such a call gets "(an id suffix
  needs at least 4 characters)". `thread.focus` and `ui.focus.terminal` look the id up
  first since they only emit an intent.

## Gotchas

- The first reconnect after `daemon restart` races the stopping daemon's lock: the
  auto-started daemon exits with "another daemon is already running" and the client
  waits 10s for it. `rewait` pauses a second and tries connect up to three times.
- `thread wait --json` on a timeout prints `{"timedOut":true,"error":...}`; the message
  no longer carries `(deadline_exceeded)`.
- The CLI strips a store sentinel's leading code words ("invalid argument: ") from
  messages; a few messages that wrap the sentinel twice still show one.

## Not done

- `thread new` does not use the working directory as its worktree (the report's aside).
- `thread unsubscribe --timers` with none still says "thread not found: ... has no
  subscription".
- thread.new `--model` still shows the settings default and its current value.
