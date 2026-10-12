# Rendered threads: cold-cache signal + context totals

Status: done on branch `t3code/rendered-threads-cold-cache` (follow-ups §4,
`rendered-threads-followups.md`). `make check` and `make gui-e2e` green; the daemon side
exercised end to end with an isolated home and haiku (below).

## What was built

* **Daemon.** After every stream-json `result` of a rendered thread the session records
  `ContextTokens` (the context size), `ContextModel` (the model that answered the turn)
  and `LastResultAt`, persisted on the `sessions` row (migration
  `0015_session_context.sql`: `context_tokens`, `context_model`, `last_result_at`).
  `CacheExpiresAt` = `LastResultAt` + the cache TTL, derived (computed at load, on each
  result, and by `Manager.SetCacheTTL`), not persisted. `internal/store/session/context.go`.
* **Setting** `sessions.cache_ttl_seconds` (Int, default 3600, 60..86400, live, right
  after `sessions.render`): the prompt-cache lifetime of the Claude API in use. The daemon
  registers a settings `OnChange` hook (`applyCacheTTL`, `internal/daemon/settings.go`)
  that calls `SetCacheTTL`, which recomputes every thread's expiry and publishes an
  `Updated` for each thread whose expiry moved (nothing when the TTL did not change).
* **Proto** `Session.context_tokens = 33`, `cache_expires_at = 34`,
  `context_reread_usd = 35`. The reread cost is computed when sent (`contextRereadUSD`,
  `internal/api/session_usage.go`) with `pricing.RereadCost`: context tokens at the
  cache-write rate of `ContextModel` (else the row's model when it is a full id), the 1 h
  rate when the TTL is over 5 minutes, else the 5 min rate; 0 when unpriced (an alias
  alone never prices). Terminal threads leave all three unset.
* **CLI.** `session.list` has a CONTEXT column: `25K · cache expires in 1 min`,
  `25K · cache expired`, `-` (terminal threads, no result yet). `--json` carries the
  fields as is.
* **GUI.** `SessionView.contextTokens`, `cacheExpiresAtMs`, `contextRereadUsd`
  (`src/api/session.ts`). `ColdCacheNote` (`components/thread/ColdCacheNote.tsx`) is a
  muted line inside the composer card above the prompt:
  "Cache expired · the next message re-reads 25.7K tokens (~$0.26)". Tokens are the
  Usage page's `fmtTok`; the cost is `fmtUsd` with a `~`, `<$0.01` under a cent, and is
  left out when 0 (unpriced).

## The rule for the line

`coldCacheNote` (`src/lib/coldCache.ts`, table-tested) shows the line only when all hold:

* the thread is rendered and `state === "connected"`;
* `status !== "busy"` and no permission request or question is pending;
* the composer draft's phase is `idle` (no send in flight);
* `contextTokens > 0` and `cacheExpiresAtMs` is set (a thread with no result shows
  nothing);
* now ≥ `cacheExpiresAtMs`.

`ColdCacheNote` holds one 30 s interval per mounted composer (cleared on unmount) and
re-renders only itself; its selectors are one field each. Sending hides the line at once
(phase leaves idle), it stays hidden while Claude works, and the next result's expiry is
in the future, so it returns only once that one passes. A reconnected thread keeps its
persisted `LastResultAt`, so the same rule applies after a reconnect or a daemon restart:
anything older than the TTL is cold.

## Decisions and gotchas

* **A result's `usage` is the sum over the turn's API calls, not the context.** A turn
  with a tool call makes two or more requests and `result.usage` adds them up (fixture
  `bash`: result 4 + 37430 + 9582 + 298 = 47314, the context 24783; live probe below:
  74744 vs 25047 over three calls). The context is the **last top-level response's**
  `input + cache_read + cache_creation + output` (Claude Code's definition; the first
  turn of the `compact` fixture gives 22221, exactly the `pre_tokens` of the compaction
  that follows). The projector keeps the last top-level usage it sees (`message_start`,
  the `assistant` frame, then `message_delta`'s final counts; subagent frames ignored)
  and falls back to `result.usage` only when it saw none, which equals it for a one-call
  turn. An interrupted turn's result reports zeros; the streamed usage still counts.
* **Compaction**: `compact_boundary.post_tokens` becomes the context (the compaction's
  own result has zero usage).
* **A result with no usage at all** (a local command) records nothing: the cache was not
  touched. **`/clear`** (`ConversationReset`) clears the totals, so nothing shows until
  the next result.
* The expiry counts from the result, not from each request inside the turn: the last
  request of a turn is moments before its result, and the cache refreshes on every hit.
* `ContextModel` is persisted because the row's model is usually an alias ("haiku"),
  which has no price; the answering model ("claude-haiku-5-5") does.
* `SetCacheTTL` is a `*Manager` method, not on `session.Store`: only the daemon calls it.
  The settings hook runs under the settings store's lock and takes the session store's;
  the session store never calls into settings while holding its own lock (settings
  readers use the atomic snapshot), so the order is safe.
* The GUI clock may lag one tick (30 s); that can only delay the line, never show it
  early.

## Verification

* Go: `TestTurnContext`, `TestCacheExpiry`, `TestProjectContext` (every fixture's
  per-result context), `TestRenderedContextTotals` (fake claude: recorded after the
  result, live `SetCacheTTL` publishes the new expiry, persisted across a restart with
  another TTL, `/clear` resets), `TestTerminalThreadHasNoContextTotals`,
  `TestRereadCost`, `TestContextRereadUSD`, `TestSessionContextOnTheWire`,
  `TestApplyCacheTTL`, `TestCacheTTLField`, `TestListContext` and a `session.list` row.
* Frontend: `lib/coldCache.test.ts` (the rule and the cost format), the mapping test.
  Mock daemon: `mock/context.ts`, `POST /__mock/thread/cache?id=&ago=<s>[&tokens=&model=]`;
  the scripted thread starts warm (25.7K, opus 4.8, 2 min ago), each mock turn adds 1.5K.
  `e2e/thread-cold-cache.spec.ts`: dark and light, the line shows for an expired thread
  above the prompt, hides on send, stays hidden while busy and after the fresh result;
  the composer's own timer shows it (Playwright clock, +31 s); a pending prompt hides it;
  a large context and an unpriced model.
* Live, isolated home `/tmp/cf-cold-home`, `sessions.cache_ttl_seconds 60`, haiku /
  medium, supervised, rendered, in `~/.cf-probe/repo`:
  * Turn 1 (no tools): turn end 2 in / 25 out / 15012 read / 7384 write = 22423;
    `session.list --json` `contextTokens 22423`, `cacheExpiresAt` = result + 60 s,
    `contextRereadUsd 0.002802875` (5 min write rate, TTL ≤ 5 min). Past 60 s:
    `22.4K · cache expired`.
  * `settings set sessions.cache_ttl_seconds 3600`: at once `cache expires in 59 min`,
    reread `0.0044846` (1 h rate); back to 60: `cache expired`.
  * Turn 2 (Bash after a permission): the turn end sums three calls (74744); the
    session says 25047, which is the transcript's last assistant record
    (2 + 24758 + 247 + 40).
  * Daemon stopped and restarted: the disconnected row keeps 25047 and the expiry;
    after `session reconnect` the same, `cache expired` once 60 s passed.
* Screenshots: `/tmp/cf-cold-shots/thread-cold-cache-{dark,light}.png` (mock, Playwright).
