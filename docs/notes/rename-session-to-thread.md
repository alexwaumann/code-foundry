# Rename session to thread (2026-10-16)

The product has said "thread" in its copy since the new thread composer, while the code,
wire, settings, CLI and database still said "session". This sweep makes thread the one
name for the record (the sidebar row, its lifecycle, its store). "Session" survives only
where it is Claude Code's word: the resume / session id, `claude_session_id`, "Allow for
session", `--session-id`, Claude's own slash command text, `CLAUDE_CODE_*SESSION`.

Four PRs: #140 proto + Go, #141 database, #144 frontend, and this one (docs).

## Decisions

- **One `ThreadService`.** `SessionService` merged into it; `thread_lifecycle.proto` holds
  the lifecycle messages. `Watch` streams every thread, like Terminal and Repo `Watch`;
  the per-thread stream is `WatchThread`. The all-threads event source is `THREAD_LIST`
  because `THREAD` was taken by the conversation source. Every `session_id` is `thread_id`.
- **No aliases for command ids.** `session.*` is `thread.*` outright (`code-foundry
  thread new`, `keybindings.thread.new`). The CLI is only ever called from inside the
  app's threads with fresh help text, so an alias table would outlive its use.
- **Settings are rewritten on load, not migrated on disk.** `decode` maps `[sessions]`
  to `threads.*` and `keybindings."session.*"` to `thread.*`; the next Update writes the
  new names. A key under both names keeps the new one.
- **Env and flag.** `CODE_FOUNDRY_THREAD` and `--context-thread`. The CLI reads
  `CODE_FOUNDRY_SESSION` as a fallback for one release (`paths.EnvThreadLegacy`), for a
  thread started by an older daemon; the daemon sets only the new name. Remove after the
  next stable.
- **Database tables renamed (migration 0022).** `sessions` → `threads`, `session_*` →
  `thread_*`, `session_thread_cache` → `thread_cache`, every `session_id` column →
  `thread_id`. SQLite rewrites child `REFERENCES` on `RENAME TO`; the one index is
  recreated by hand. `TestThreadsMigrationKeepsRowsAndCascades` builds a 0021 database
  with a row in every table and checks rows, cascade and index after the upgrade. The
  newer-schema guard means an older daemon refuses the upgraded file.
- **Frontend: plural for the list, singular for one conversation.** `api/threads.ts` +
  `stores/threads.ts` (records) beside `api/thread.ts` + `stores/thread.ts` (the open
  thread's items). Panel keys `thread:<id>`, test ids `thread-*`,
  `thread-permission-allow-session` kept.
- **History stays.** `docs/notes/*` and `docs/sketches/*` keep their wording and file
  names (`session-usage.md`). Only live docs changed. The tagline is "fleets of Claude
  Code threads".
- **Terminal owner label** value `session` → `thread` (in memory only).

## Gotchas

- "thread" contains r-e-a-d in order, so the composer's fuzzy file matcher ranks
  `@READ` against thread sample paths; the e2e specs type `@READM`.
- Claude's permission suggestion field `destination: "session"` is Claude's protocol
  value. An early frontend pass renamed it; restored.
- The frontend built `UiContext` by spreading its own object into the proto, so the
  active thread id went out empty once the field was `activeThreadId`. Fixed in #140 by
  passing the view model to `create(UiContextSchema, ctx)`.
- `scripts/next-version.sh` reads `type!:` as a major bump; the proto merge commit is a
  plain `feat(proto):`.
- `TestExitWithoutCloseDisconnects` failed on main after #140: `Process.Done` closed as
  soon as `cmd.Wait` returned, before the stderr reader had the crashing process's last
  line (the fake claude binary from `fake-claude-binary.md` exits fast enough to show
  it). `Done` now waits up to 200 ms for stderr EOF; bounded so a grandchild holding
  the pipe cannot delay the exit.
- A `code-foundry status` from a dev build auto-starts a daemon on the real home and
  migrates its database. Use `CODE_FOUNDRY_HOME` for every manual check.
