# API retry note

Status: built on branch `t3code/pre-release-readiness-checklist` (2026-10-13), from the
pre-release review: coworkers share a 200k tokens/min/model limit over Bedrock, so a
fleet of threads will 429 more often than the TUI did, and a thread waiting on a retry
showed only "Working" with no output.

## What Claude Code does

Claude Code retries retryable API errors itself (429, 529, 5xx, connection errors) with
backoff, up to `max_retries`. Over stream-json each attempt is one frame:

```
{"type":"system","subtype":"api_retry","attempt":3,"max_retries":10,"retry_delay_ms":20000,
 "error_status":429,"error":"rate_limit","uuid":"…","session_id":"…"}
```

`error_status` is null for connection errors with no response (then `no_response`
carries `waited_ms`/`retry_wait_ms`); `error` is Claude's category (`rate_limit`,
`overloaded`, `server_error`, …). Nothing announces that a retry went through: the
next frame of any other kind is the signal, and Claude's own REPL clears its retry
banner the same way. Shape read from the 2.1.296 binary's `SDKAPIRetryMessage` schema;
no capture, since a 429 is hard to force (the parse test's lines are hand-written to it).

The `rate_limit_event` frame already in the captures is something else: the
subscription usage windows (five-hour / seven-day, `status` allowed / allowed_warning /
rejected). Bedrock users never see it, and a rejected window surfaces as a 429 retry
anyway, so it stays parsed and unrendered.

When retries run out the turn ends with an error result (`api_error_status` 429 →
status reason `error: 429`, the sidebar's "Error · 429"); unchanged.

## What was built

* `claudestream.APIRetry` (`system/api_retry`), parsed like the other system frames.
* `Session.Retry *APIRetry` {Attempt, MaxRetries, RetryAt, Status, Error}: set by the
  runner on each frame (`RetryAt` = the frame's time + `retry_delay_ms`), replaced by
  the next one, cleared by the next frame of any other kind (`clearRetry`, which reads
  the snapshot first so the common path costs no publish) and when the process ends
  (`detach`). Published, never persisted. Logged at INFO with the counters.
* Proto `Session.retry = 36` (`ApiRetry {attempt, max_retries, retry_at, error_status,
  error}`); `SessionView.retry: ApiRetryView | null`.
* GUI: `lib/retryNote.ts` (`retryNote`, `retryCause`, `fmtRetryIn`) and
  `components/thread/RetryNote.tsx`, mounted in the composer above the cold-cache note,
  same slot and size, amber: "Rate limited · retrying in 20 s (attempt 3 of 10)",
  "API overloaded · …", "API error 503 · …", "No response from the API · …". A 1 s tick
  runs only while a retry is pending; past the due time it says "retrying now" until
  the daemon clears it. Connected threads only (a disconnected thread shows its
  Reconnect card).
* Mock: `POST /__mock/thread/retry?id=&in=&attempt=&max=&status=&error=` (`clear=1`
  ends it); the thread says busy meanwhile. e2e: `thread-retry.spec.ts`.
* Store test `TestAPIRetryFollowsStream`: two frames spliced into the text-table
  capture after "status requesting" (published in order, then cleared by the stream
  event), and a second turn that stalls on a retry until the process exits.

## Not done

* The sidebar row still says "Working" during a retry. The note is where the user looks
  when a thread is quiet; a "Waiting on rate limit" row variant can follow if it turns
  out people watch the list instead.
* `session.list` has no column for it.
* Subagent retries (`tool_progress` with `subagent_retry`) are not surfaced.

Screenshots (mock, Playwright): `api-retry-note/dark.png`, `api-retry-note/light.png`.
