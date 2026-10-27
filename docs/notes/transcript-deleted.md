# Transcript deleted: a thread that cannot continue

Claude Code deletes transcripts (`~/.claude/projects/<slug>/<session>.jsonl`) older than
its `cleanupPeriodDays` setting, 30 days by default. Before this change the daemon saw the
missing file in `resumeLaunch` and quietly started a new conversation under the old
thread's name and history: a note in the timeline, `LastError`, and a Claude that
remembered none of it. Now such a thread is refused and says why.

## Decisions

- **Refuse, never start fresh.** `resumeLaunch` returns `ErrTranscriptMissing`
  (FAILED_PRECONDITION). The text is the same everywhere (store, CLI, mock): "Claude Code
  deleted this thread's transcript (its cleanupPeriodDays setting, 30 days by default), so
  the conversation cannot continue. This is a Claude Code setting, not a Code Foundry one."
- **"Deleted" means a saved conversation.** `ClaudeSessionID` is set only once the
  transcript was seen (`discoverTranscript`), and a fresh start clears it, so a thread
  whose first spawn failed before Claude wrote anything is not flagged: it still starts a
  new conversation as before (`needsTranscript`).
- **Reseed is the only way back** (`thread reseed`: FreshStart, which skips the check and
  clears the flag). The GUI has no escape hatch apart from Archive and Remove; an agent
  or the CLI can still reseed.
- **Resident threads are exempt.** Ember reseeds every epoch and the user cannot archive
  it. If its transcript is gone it starts a new conversation with the old note.
- **`Thread.TranscriptMissing` is computed, not persisted.** It is checked at daemon start
  (`transcriptIndex`: a stat per thread, and on the first miss one glob of every project
  dir's transcripts, not a glob per thread), when a process ends (`runner.finish`, off
  `m.mu`), and when a start is refused or a Fork finds the file gone. It is never checked
  per snapshot, because a miss globs. A transcript put back clears the flag on the next
  send (`refuseTranscriptMissing` re-checks the disk for a flagged thread).
- **Nothing is written on a refusal.** `startStopped` calls `resumeLaunch` before it
  recreates worktrees or records the user item. `refuseStart` releases the reservation
  and restores the thread's previous status (the busy status the start set was never
  published). Send also refuses up front on the flag, before naming or a resume note.
- **Entry points.** Send, Reconnect, `running()` (McpStatus refresh, McpReconnect), Fork,
  plus McpStatus without refresh and SlashCommands for a flagged stopped thread. Wakes go
  through Send and fail cleanly: the drain logs "wake not delivered" with the reason and
  moves on.
- **CLI exit 1, no help pointer.** `internal/api/command.go` maps the error to a command's
  own failure (`CommandFailed` detail), so the CLI prints the words and exits 1 rather
  than exit 2 with "Run `code-foundry help …`". `thread.list` marks the row
  `[transcript deleted]`. `thread.get` adds a line. `--json` carries `transcriptMissing`
  (protojson's camelCase, like every other field).
- **GUI.** `ThreadView.transcriptMissing?: true` (optional, so `sameThread` counts its
  arrival). The header gets an amber `Badge` with `Trash2`. The composer card shows
  `TranscriptDeletedNote` in place of the cold-cache line (a cold cache means nothing
  without a conversation), with outline xs Buttons for Archive (hidden once archived)
  and Remove. These are the existing `archiveThread` and `removeThread`, so Remove keeps
  the daemon's confirmation. Editor, attach, paste, drop and send are off, and the
  placeholder reads "Transcript deleted". Line 2 is `transcriptDeleted` (red, trash icon,
  then the place) and wins over every other status. `threadGroup` puts the thread with
  the errors. The row menu's Fork is disabled. Lineage and Ember worker words count it
  as an error.
- No timeline note was added: the composer note says it where the user would type.

## Gotchas

- Archiving the selected thread selects the dashboard (put-away-focuses-dashboard), so
  the note's Archive button takes the user out of the thread. The e2e reopens it from
  the Archived section.
- The disabled editor is `contenteditable=false`. Playwright refuses to click it, so the
  spec forces the click to prove that typing does nothing.
- The old `TestSendStartsNewConversationWhenTranscriptGone` is replaced by
  `transcriptmissing_test.go`. `docs/notes/thread-lifecycle.md` points here.

## Verification

- Store tests (`transcriptmissing_test.go`). Table tests: Send, Reconnect, McpStatus
  refresh and Fork refuse; slash commands, MCP status and reconnect refuse once flagged;
  nothing is spawned or written and the status is kept. A restored transcript resumes.
  Reseed starts a fresh session. Archive and remove work. The flag is computed on
  disconnect and at restart. A timer wake to a dead subscriber logs and adds nothing.
- CLI test (`cmd/code-foundry/transcript_test.go`): thread send, fork, mcp,
  mcp-reconnect and commands go through the command service against the fake store,
  print the message and exit 1. thread get has the line and `transcriptMissing`.
- Vitest: view mapping, line 2 and group, sidebar row, row menu, note component.
  Playwright: `e2e/transcript-deleted.spec.ts` against the mock.
- End to end: the built daemon with `CODE_FOUNDRY_HOME` and `CLAUDE_CONFIG_DIR` under
  /tmp and `cmd/fakeclaude` as `claude`. I made a no-project thread, wrote its transcript
  so it was discovered, deleted the file while it ran, and archived it. thread get/list
  showed the flag. send, fork, mcp --refresh, mcp-reconnect and commands each printed
  the message and exited 1, and the thread stayed archived. After a daemon restart the
  flag was still there and send still refused. `thread reseed`, then send, started a
  new `--session-id` with no `--resume` and cleared the flag.
- Screenshots (dark, light) from the mock's `transcript-deleted` scenario are in the PR
  body.
