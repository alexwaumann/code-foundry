# Drop Claude's set_cwd echo (no empty turn after a move or Run in)

A user saw an empty "Worked" turn end right after "Moved this thread to …" with real
Claude, on both a running thread (restarted for needs_trust) and a stopped one started
for the move. PR #490's `cdResultOwed` dropped a bare empty `result` after an ok
set_cwd, which is what fakeclaude wrote, not what Claude writes.

## What Claude writes (Claude Code 2.1.316)

Captured from the daemon's stdin/stdout (a temporary tee in `claudestream.Conn`, not
committed) for a running move after a needs_trust restart, a stopped thread started in
home with `--resume` for the move, and `thread run-in` on a running idle thread. All
three are the same:

```
> control_request  set_cwd {path}
< system/ui_invalidate          event ui.render
< command_lifecycle started     command_uuid C (Claude's own, not a message's)
< control_response              success {status ok, cwd, changed true, transcript_relocated true}
< system/init                   cwd = the new folder, tools, mcp_servers, …
< result                        success, is_error false, num_turns 0, result "",
                                duration_api_ms 0, 0 tokens, total_cost_usd = the session's total so far
< command_lifecycle completed   command_uuid C
```

Claude runs the change as a command of its own. The `started` comes before the answer.
`streamStatus` reads any `command_lifecycle started` as a turn starting (busy), so by
the time the result came a "turn" was running and the old skip (no turn running) never
matched. The result then ended that turn: a 0.0 s turn end, "finished" needs attention,
`wakeOver`, and `thread wait` settled.

The capture, trimmed (tools, MCP servers, skills) and anonymised, is
`internal/claudestream/testdata/set-cwd.jsonl`.

## The rule (`internal/store/thread/setcwd_echo.go`, `runner.echo`)

* An ok set_cwd (`streamCd`) sets the echo owed (`expect`).
* While owed, the next `command_lifecycle started` whose uuid is not a message sent
  since the set_cwd is the echo's: its uuid is kept and the line is dropped.
* The echo's first `result` is dropped, and so is every lifecycle line for its uuid. A
  terminal state (completed, cancelled, …) ends the echo.
* Dropped lines skip the projection (no turn end), the status (no busy, no finished),
  `wakeOver` and the acknowledge, like the old drop did. The echo's `system/init`
  and `ui_invalidate` go through: the init gives `checkMcp` the MCP servers for the new
  cwd, and neither moves status or the timeline.
* A message sent meanwhile is not swallowed. Claude runs commands in order, so the
  echo's lines come before a later message's turn. `sendMessage` no longer clears the
  state; it records the message's uuid (`sent`), and a `started` with that uuid ends
  the wait for an echo. A `started` for another command inside the echo also stops it
  dropping results.
* Bounds: an echo must start within `cdEchoWait` (5 s) of the answer. A result while
  owed with no echo started is a turn's own (it clears the state). A restart clears it.
  So a Claude that writes no echo never has a later command of its own (a background
  task's turn) taken for one.

## Tests

* Fakeclaude: `CF_FAKE_CLAUDE_SET_CWD_ECHO=<capture>` replaces
  `CF_FAKE_CLAUDE_SET_CWD_RESULT`. It writes the capture's lines before its
  control_response, then its own answer, then the lines after (`SetCwdEcho`).
* `TestSetCwdEmptyResultIsNotATurn` (move, run in) uses the capture. Without the fix it
  fails on both ("needs attention finished", 2 turn ends), as real Claude did.
* `TestCdEchoDrop` (table, captured lines): the echo, the echo then a message's turn, a
  message sent before the echo is read, no echo (a message's turn, a bare result), no
  set_cwd, an echo past the wait, a command starting inside the echo.

## Verified with real Claude

`CODE_FOUNDRY_HOME=/tmp/cf-cwd-cap`, scratch repos under `~/cf-cwd-scratch`,
`claude-sonnet-5-5[1m]` at medium. A `thread wait --until attention --after #3 --for
20s` ran across each move. Before the fix, the same moves drew "#5 turn end: success,
0.0s, 0 in / 0 out tokens".

1. Stopped thread, `thread move cwlib`: started in home with `--resume`, moved. Debug
   log "dropped a line of claude's set_cwd echo" for the started, the result and the
   completed. Timeline ends at the note. The wait timed out. Status after: idle (at
   prompt); the old build left "needs attention (finished)". A send: "The word was
   WALRUS, and pwd printed …/cwlib".
2. Running thread, `thread move cwtool` (a fresh project): needs_trust, restart,
   set_cwd ok, echo dropped, no turn end, the wait timed out, and the status was
   unchanged. A send recalled BADGER with `pwd` in the project.
3. Running idle thread in cwdemo + cwlib, `thread run-in cwlib`: echo dropped, no turn
   end, the wait timed out, and the status was unchanged. A send recalled FERRET with
   `pwd` in cwlib.

The scratch repos, the home and the transcripts were removed afterwards.

## Gotchas

* The echo's `result` carries `total_cost_usd` as the session's running total and
  `modelUsage` with the whole session's tokens. Had it been projected, the turn cost
  would have been 0 (a delta), but the usage fields were not a turn's.
* The echo's lines are already queued when `SetCwd` returns (the conn answers the
  control request directly, while events go through the pump). So the runner sees the
  answer first, then the `started`, even though Claude wrote the `started` first.
* Pre-trust writes the scratch paths into Claude's config; those entries stay (harmless,
  and other live sessions write that file).
