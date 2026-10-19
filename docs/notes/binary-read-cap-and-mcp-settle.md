# Binary read cap and MCP settle after a restart

PR 1 of 2 (2026-10-18). Daemon only: no GUI or CLI output changes. PR 2 shows PDFs in the
File tab and stacks on this one.

## A. ReadFile reads non-text files up to 32 MiB

`fsx.ReadFile` capped every read at `MaxReadBytes` (1 MiB). The File tab shows images from
these bytes, so an image over 1 MiB rendered broken, and PDFs (attachments up to 20 MiB)
need the whole file.

* Text (a text MIME type and no NUL in the first `BinarySniff` bytes) stays capped at
  1 MiB whatever `max_bytes` asks: the viewer only shows the first MiB of text.
* Anything else is read up to `max_bytes`, clamped to `MaxBinaryReadBytes` (32 MiB).
* `max_bytes == 0` is still 1 MiB for every file, so the current GUI (which sends 0) is
  unchanged. Negative is still InvalidArgument.
* The type is decided before the rest is read: an 8000-byte head (`BinarySniff`, which
  also covers `http.DetectContentType`'s 512) goes to `DetectMIME` and `LooksBinary`, then
  the cap is chosen and the rest read into a buffer sized from the stat. A large log is
  never read past 1 MiB. `Truncated` is `size > len(contents)` against the stat size: a
  file that grew after the stat is cut at the stat size (not truncated by that measure),
  one that shrank reads short.
* The parameter was renamed `max` -> `maxBytes`: `max` shadowed the builtin the new code
  needs.
* Proto comments (`ReadFile`, `ReadFileRequest.max_bytes`, `ReadFileResponse.contents`)
  say the new limits; `make gen` regenerated the comments only.
* Connect has no message size limit set on either side (no `WithReadMaxBytes` /
  `WithSendMaxBytes`), so a 32 MiB response goes through as is.

## B. MCP status settles after Claude (re)starts

`McpStatus(id, refresh)` and `McpReconnect` on a stopped thread start Claude without a
prompt (no `system/init`, so no turn check) and asked `mcp_status` once, right after the
handshake. Claude starts MCP servers in the background, so that answer was often `[]`,
and it was published and persisted over the good cached list: the panel read "0 of 0
connected" until the next turn.

* **One settle loop.** `settleMcp` is the turn check's polling, factored out: after the
  first answer, while `mcpUnsettled`, ask again up to `mcpPendingPolls` (5) times every
  `Options.McpPollInterval` (default `mcpPendingInterval`, 3 s; the tests use 10 ms) with
  trigger refresh, on its own goroutine, ending when the conn is done. A turn's check,
  a refresh and a reconnect all use it. The RPCs still return the first answer at once;
  the later ones arrive as `McpChanged` events (the GUI's Watch).
* **No server list replaced with nothing.** `threadLog.answerMcp`: an answer that lists no
  servers, from a process that has not listed one yet, takes the cached servers as
  pending (Name, Scope, Source, Transport kept; Status pending; Tools, Error, ServerName,
  Version cleared), so the header reads "0 of 5 connected" with connecting spinners and
  the loop keeps polling (pending is unsettled). A truly empty answer with an empty cache
  is published as is.
* **Not on a turn's check.** There `system/init`'s `mcp_servers` already fill in what the
  answer lacks (`fillFromInit`), and init is the process's server list: an empty answer
  with an empty init means no servers, so the cache is not used.
* **The last poll takes the answer as it is.** If Claude still lists nothing after the
  fifth poll (15 s), the servers are taken as gone (removed from the config) and the empty
  list is published; otherwise a thread whose servers were removed would show them
  connecting forever. A server that takes longer than that to start shows again on the
  next turn's check.
* **"First check of a process" lives on the thread log**, per Conn (`mcpState.conn`,
  `reported`), replacing `streamState.mcpChecked` (runner-goroutine only, so a refresh
  could not set it). Whichever check of a process is applied first is the first one; an
  effort restart's new Conn starts over. `dropMcpChecks` (the process ended) also clears
  it. Late answers of an old process are still dropped by ticket, and a dropped answer
  does not touch the per-process state.
* **Fake Claude knobs.** `CF_FAKE_CLAUDE_MCP_EMPTY=<n>`: a process's first n `mcp_status`
  answers list no servers; `CF_FAKE_CLAUDE_MCP_PENDING=<n>`: the n after those list every
  server pending (name, status, config, scope, source only).
* CLI: `thread.mcp` already prints pending as "connecting" ("MCP servers: 0 of 5 connected"
  with a "connecting" row per server), so its output needed no change. One wording quirk
  left as is: a refused reconnect whose status is still the pending fill reads "reconnect
  broken failed: ENOENT … (connecting)", the status the check saw.

## Verification

* `make check` green.
* Tests. `internal/fsx/read_test.go` (table additions): text over 1 MiB with a 32 MiB max
  (by extension and sniffed: capped, truncated), text under the cap with a 32 MiB max
  (whole), a 3 MiB PNG with a 32 MiB max and with 4x the limit (whole, not truncated), a
  2 MiB PNG with max 0 (1 MiB, truncated), max 20 on a PNG (under the head), a binary over
  32 MiB (clamped, truncated), a `.txt` with a NUL (binary: read whole), negative max.
  Large fixtures are sparse files made in the test. `internal/store/thread/
  mcp_settle_test.go`: `answerMcp` table (new process lists none -> cached as pending;
  same process before and after it listed servers; a process after another; not kept on
  the last poll or a turn; nothing cached; servers listed replace the cache; a late answer
  of an ended process dropped, state untouched) and, on the fake Claude, a stopped thread's
  refresh and reconnect with none-then-all, pending-then-connected, and none-pending-
  connected: the RPC's answer is the cached servers pending, every event before the last
  lists servers (no "0 of 0"), the last is settled; plus "servers gone" (Claude never lists
  one: five polls, then the empty list). Breaking the fill (keep always false) fails them.
* End to end, isolated daemon (`CODE_FOUNDRY_HOME=/tmp/cf-pr1-e2e`, `HOME=/tmp/cf-pr1-e2e/
  home`, `advanced.claude_path` = the built `cmd/fakeclaude`, `CF_FAKE_CLAUDE_MCP` = the
  captured fixture, `CF_FAKE_CLAUDE_MCP_EMPTY=1`, `CF_FAKE_CLAUDE_MCP_PENDING=1`), a
  no-project thread:
  * first `thread.mcp` (no turn yet, nothing cached): "no MCP servers (checked just now)",
    then after the polls "1 of 5 connected" (broken failed, Claude Docs connected 0.1.0 8
    tools, three needs login);
  * daemon restarted (thread disconnected "daemon stopped"), `thread.mcp`: the cached
    "1 of 5 connected"; `thread.mcp --refresh`: "MCP servers: 0 of 5 connected", all five
    "connecting" with scope and transport; a few seconds later "1 of 5 connected" again;
  * daemon restarted, `thread.mcp-reconnect --server broken`: "reconnect broken failed:
    ENOENT … (connecting)", the table "0 of 5 connected … after reconnecting broken",
    then settled to "1 of 5 connected";
  * `FilesystemService.ReadFile` over the Unix socket (curl, Connect JSON): a 3 MiB PNG
    (valid, noise) with `maxBytes` 32 MiB returned all 3147775 bytes, identical to the
    file, not truncated, image/png; with `maxBytes` 0: 1 MiB, truncated; a 3.2 MB `.log`
    with 32 MiB: 1 MiB, truncated, text/plain.
* Not verified: a real Claude's restart against the live claude.ai connectors (the fake
  replays the captured answers); the GUI (unchanged here; it still asks with max 0).
