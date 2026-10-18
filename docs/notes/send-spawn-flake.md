# TestSendSpawnFailure flake: a broken stdin pipe is a gone process

`TestSendSpawnFailure/claude_exits_before_its_handshake` failed now and then in CI
(`make go-test`, `-race`), on main at 7bce6920 and during the git-freshness series.

## Cause

A product bug, not a test-ordering one. The runner writes the `initialize` control
request right after the spawn. Usually the pipe buffers the line and the fake (a missing
fixture: it exits 2 at once) is gone before it answers; stdout ends, `Initialize`
returns `claudestream.ErrClosed`, `onInitialized` ignores it and `maybeExited` records
"Claude did not start: exit code 2: <last stderr line>".

When the process has already exited before the write, the write fails with EPIPE (Go
ignores SIGPIPE for pipes other than its own stdout). `Conn.write` wrapped that as a
plain error, so `onInitialized` saw a non-`ErrClosed` error while the runner had not
yet seen the exit, and called `failStart`: the timeline said "Claude did not start:
claudestream: write: write |1: broken pipe: fake claude ..." instead of the exit code,
and `maybeExited` (now closing) added nothing. Users with a Claude that dies at once saw
the pipe error.

## Fix

`claudestream.Conn.write` wraps a write whose reader is gone (EPIPE, `os.ErrClosed`
after exec closed the pipe, `io.ErrClosedPipe`) as `ErrClosed` too, keeping the cause.
Every caller already treats `ErrClosed` as "the process is gone or going" (handshake,
settings retries, `controlErr`, MCP checks). `TestConnWriteToGoneCLI` covers the three
pipe kinds.

## Reproduction

`go test ./internal/store/thread -run TestSendSpawnFailure -race -count=100`: 4 of 100
failed before (all "claudestream: writ…" error items). After: 0 of 300, and 0 of 200
with `GOMAXPROCS=2`.
