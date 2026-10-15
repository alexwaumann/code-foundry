# Rendered threads: the MCP panel tab

Update 2026-10-15 (`thread-lifecycle.md`): the MCP status is kept and persisted while the
thread is stopped; a refresh or a server reconnect starts a stopped thread without a
prompt.

Status: built on branch `t3code/mcp-panel` (follow-ups §2, `rendered-threads-followups.md`;
design: `docs/sketches/mcp-panel/`, variant B). `make check` and `make gui-e2e` green; the
daemon side exercised end to end with an isolated home and haiku (below). Mock screenshots
in `mcp-panel/` (`mcp-{dark,light}.png`, `-panel.png` crops); the live ones are Alex's.

## What was built

* **`internal/claudestream`** (`mcp.go`): `Conn.McpStatus` (the `mcp_status` control
  request, parsed by `ParseMcpStatus` into `[]McpServer`: name, status, `serverInfo`,
  error, `config.type` as `Transport()` with stdio for none, scope, source, tools with
  `annotations {readOnly, destructive, openWorld}`) and `Conn.McpReconnect(server)`
  (`mcp_reconnect {serverName}`; a server that still fails is a `*ControlError` carrying
  its error). `Init.McpServers` decodes `system/init`'s `mcp_servers [{name, status, source}]`.
* **Session store** (`internal/store/session/mcp.go`). The status is cached in memory on the
  thread's log (`threadLog.mcp`), never persisted; `ItemsSnapshot.Mcp` carries it and
  every new answer is a `McpChanged{SessionID, Seq, Status}` thread event in the log's seq
  order (Status nil when dropped). Checks:
  * after every `system/init` (the start of a turn), off the runner goroutine; system/init's
    `mcp_servers` fill in servers the answer lacks (`fillFromInit`), and while the answer
    is unsettled (a server pending, an init server missing, or none at all on the process's
    first check: `mcpUnsettled`) it asks again every 3 s, at most 5 more times;
  * `Store.McpStatus(id, refresh)`: the cache; `refresh` asks now (connected threads only,
    else FailedPrecondition); without it a connected thread never checked is asked once,
    a thread not running returns nil;
  * `Store.McpReconnect(id, server)`: `mcp_reconnect`, then `mcp_status` again (trigger
    reconnect, `Server` set). Claude refusing (the server still fails) is the result's
    `Error`, not an error; an unknown server is ErrNotFound (checked against the cache,
    and Claude's own "Server not found: …").
  * The cache is dropped when the process ends (exit, close, daemon stop); an effort
    restart keeps it. Out-of-order answers (a turn's check racing a refresh) are ordered
    by a ticket taken before asking: an older answer never overwrites a newer one, and a
    drop cancels the checks in flight.
* **Proto** (`thread.proto`): `ThreadService.McpStatus(McpStatusRequest{session_id,
  refresh}) → McpStatusResponse{status}` and `McpReconnect(McpReconnectRequest{session_id,
  server_name}) → McpReconnectResponse{status, error}`; messages `ThreadMcpStatus
  {checked_at, trigger, server, servers}`, `McpServer {name, status, server_name, version,
  error, scope, source, transport, tools}`, `McpTool {name, description, read_only,
  destructive, open_world}`, `ThreadMcpChange {session_id, seq, status}`; enums
  `McpServerStatus` (CONNECTED, FAILED, NEEDS_AUTH, PENDING, DISABLED; UNSPECIFIED for a
  newer Claude's) and `McpCheckTrigger` (TURN_START, REFRESH, RECONNECT);
  `ThreadItemsSnapshot.mcp = 5`, `ThreadEvent.mcp = 7` (Watch only; EventService's thread
  source still carries pending requests only). Handlers: `internal/api/thread_mcp.go`.
* **Commands** (`internal/command/commands_mcp.go`, `McpBackend` embedded in
  `ThreadBackend`): `thread.mcp [--refresh] [--full]` (a table: SERVER, STATUS, SCOPE,
  TRANSPORT, VERSION, TOOLS, under "MCP servers: N of M connected (checked 12s ago, at the
  start of the last turn)", then each server's error or login hint, and with `--full` its
  tools with "read-only"/"writes", "destructive", "open-world"); `thread.mcp-reconnect
  --server <name>` ("reconnected X: connected" or "reconnect X failed: <Claude's reason>
  (<status>)"); `view.panel.mcp` "Show MCP Servers" (ShowView `panel.mcp`). All three
  `hasRenderedThread`.
* **GUI.** `src/api/mcp.ts` maps the proto (`McpStatusView`, `McpServerView`,
  `McpToolView`) and reads `McpStatus` once (`getMcpStatus`); `src/api/thread.ts` adds the
  snapshot's `mcp` and the `mcp` event. The status lives on the thread store's log
  (`ThreadLog.mcp`, fed only by the thread's Watch, which is open whenever the thread is
  selected, also while the panel is expanded over it); `lib/mcp.ts` `shareMcp` keeps
  unchanged servers by identity, so a check every turn re-renders only cards that
  changed. `stores/mcp.ts`: narrow selectors (`useMcpServerNames` shallow,
  `useMcpServer`, `useMcpHeader`), reconnects and refreshes in flight, `reconnectMcp`
  (`thread.mcp-reconnect`, quiet; a refusal is toasted "Could not reconnect X") and
  `refreshMcp` (`thread.mcp --refresh`). Surface `surfaces/mcp.ts` ("MCP", lucide Plug,
  hotkey M; enabled for a rendered thread, hidden otherwise, a disconnected one included),
  `stores/mcpPanel.ts` and `mcpPanelCommand` (`stores/views.ts`, case `panel.mcp`).
  `components/mcp/McpSurface.tsx`: header (amber plug, "MCP servers", "N of M connected";
  clock + "Checked 12s ago, at the start of the last turn" on a 1 s clock in its own
  component; refresh button), one card per server (dot or spinner, name, mono version,
  pill; "scope · transport · N tools"; red mono error or the amber login hint;
  Reconnect, muted, amber-bordered on failed / needs-login, absent on connecting and
  disabled; the "N tools" disclosure; tool rows with mono name, truncated description and
  hint icons, each with a tooltip). Failed cards get a red border, needs-login amber,
  disabled is dimmed. While a reconnect runs the card reads Connecting… and the button
  spins. `@container`: tighter padding under 340px.
* **Mock** (`mock/mcp.ts`): the sketch's six servers on the scripted rendered thread
  (`POST /__mock/thread?state=…`, none when closed or crashed), the two RPCs, the three
  commands; a reconnect takes 700 ms, turns the failed server connected with three tools,
  keeps the needs-login one and returns a refusal.

## Decisions and gotchas

* **Decided with Alex (2026-10-12):** variant B; Reconnect the only action (no
  enable/disable); hint icons with tooltips (eye "Read-only", triangle "Destructive",
  globe "Open-world (reaches outside the server)", pencil "Writes"); a panel tab, rendered
  threads only. Tooltips are allowed here because the icon hides the information
  (`tooltip-status-reason.md`'s rule); the refresh icon button has a plain `title`.
* **Writes means "not read-only".** Claude 2.1.296 sends only the hints a server set to
  true (`{}` for none), so an absent `readOnly` is shown as the pencil (MCP's default
  `readOnlyHint` is false). Destructive and open-world show only when set: MCP defaults
  both to true for non-read-only tools, which would mark every unannotated tool.
* **No descriptions from claude.ai connectors.** Real `mcp_status` tools carry only name
  and annotations (both connectors probed); the row then shows the name alone.
* **The first turn's check can be empty or pending.** Claude starts MCP servers in the
  background: right after the handshake `mcp_status` answered `[]` in one live run and
  "pending" in another, while `system/init` listed the servers. Hence the fill from init
  and the short polling; a later turn always settles it.
* **Publishing on every check**, not only on a change: the header dates the last check,
  so its time must move; it is one small event per turn. The GUI's `shareMcp` keeps the
  cards from re-rendering.
* **A connected thread with no turn yet** (a reconnect) has no check: the surface asks
  once (`ensureMcpStatus`, a read through `ThreadService.McpStatus`, not a command); the
  answer arrives on the Watch.
* **`mcp_reconnect` of a failing server is a control error** whose message is the
  server's error ("ENOENT: …"): mapped to the result's `error`, not an RPC failure, so the
  CLI and the card both show it. A reconnect of a claude.ai connector marked needs-auth
  connected it at once in the probe (its login had been made elsewhere): the "then
  reconnect" path works.
* Registering `thread.mcp*` needs `McpBackend` on `ThreadBackend`: embedded in
  `commands_thread.go` (the only edit there) so `all.Register` passes the one thread
  backend.
* e2e: the surface's M key needs the panel focused; with a rendered thread selected the
  composer has focus, so the spec opens the panel with the header's toggle. Radix keeps a
  closing tooltip in the DOM while it fades: the spec looks for the one not closed.

## Verification

* `make check` green (gofmt, vet, staticcheck, `go test -race ./...`, typecheck, lint,
  vitest: 102 files, 1965 tests). New Go tests: `claudestream/mcp_test.go` (the captured
  fixture; `ParseMcpStatus` table: every status, missing serverInfo, tools with and
  without annotations, unknown status; transport; Conn wire shapes and the reconnect
  error), `session/mcp_test.go` (`mcpFromWire` table, ticket ordering and drop,
  `mcpUnsettled`/`fillFromInit` table, init → status through the fake Claude with the
  event's seq, cached read vs refresh, close drops it, reconnect table: needs-auth →
  connected, still failing, unknown, empty name, terminal thread), `api/thread_mcp_test.go`
  (mapping, Watch snapshot + events, RPC codes), `command/commands_mcp_test.go`
  (availability, table/`--full` output, reconnect messages, ShowView, `FormatMcpStatus`
  table). The fake Claude answers `mcp_status`/`mcp_reconnect` from `CF_FAKE_CLAUDE_MCP`.
  Frontend: `api/mcp.test.ts`, `lib/mcp.test.ts` (relative time and the checked line,
  meta, hints, reconnect/attention, `shareMcp`), `surfaces/mcpTarget.test.ts`,
  `surfaces/mcp.test.tsx` (SidePanel: listing, every card, tools and hints, reconnect
  spinner → connected, refusal toast, refresh, first ask, stopped thread), thread store.
* `make gui-e2e` green: 632 passed, 28 skipped (the live specs and SHOTS-only screenshots), no failures or flakes (17.6 min). `e2e/mcp-panel.spec.ts`: palette → tab with six
  cards in their states, pills, meta, error, login hint, which cards get Reconnect and
  tools; M and the ShowView open it; tools expand, hint tooltips by hover; Reconnect on
  the failed card → Connecting… with a spinner → Connected with its tools, "3 of 6
  connected", "after reconnecting playwright"; a needs-login refusal toasts; refresh;
  hidden for a terminal thread (panel list, M, palette, ShowView).
* `make gui-build` green.
* **Fixture** `internal/claudestream/testdata/mcp.jsonl`, captured 2026-10-12 from Claude
  Code 2.1.296 (haiku, medium, `/Users/alex/.cf-probe/repo`, plus `--mcp-config` with a
  stdio server whose command does not exist; `--strict-mcp-config` not used): system/init
  trimmed to its MCP fields; `mcp_status` with `broken` (failed, dynamic, stdio, "ENOENT:
  no such file or directory, posix_spawn 'stdio'"), `claude.ai Claude Docs` (connected,
  claudeai-proxy, Claude Docs 0.1.0, 8 tools), `claude.ai Google Drive`, `Google
  Calendar`, `Gmail` (needs-auth); `mcp_reconnect broken` (error, the ENOENT);
  `mcp_reconnect claude.ai Gmail` (success); `mcp_status` again (Gmail connected,
  StatelessServer ESF, 23 tools). The t3-code server is injected into this agent's own
  session only; a plain `claude -p` here has the claude.ai connectors.
* **Live**, isolated daemon (`CODE_FOUNDRY_HOME=/tmp/cf-mcp-home ./bin/code-foundry daemon
  --dev`), the probe repo, a rendered haiku thread (`session new --model haiku --effort
  medium --permission supervised --render rendered --prompt "Reply with the single word
  ok."`):
  * first turn: `thread mcp` said "no MCP servers (checked 16s ago, at the start of the
    last turn)" (the empty first answer, before the fill and polling existed); `--refresh`
    then listed Claude Docs (connected, 0.1.0, 8 tools) and Drive, Calendar, Gmail (needs
    login, with the `/mcp` hint). After the fix: daemon restarted (the thread disconnected
    "daemon stopped": `thread mcp` → "no MCP status: the thread is not running"),
    reconnected (first read asked at once: 1 of 4 connected), a turn sent ("checked just
    now, at the start of the last turn", all four servers);
  * `thread mcp-reconnect --server "claude.ai Claude Docs"` → "reconnected claude.ai
    Claude Docs: connected" in 0.4 s; the table then says "after reconnecting claude.ai
    Claude Docs"; `--server nope` → NotFound "thread … has no MCP server \"nope\"";
    `--full` listed Docs' tools (batch/create writes, delete writes + destructive,
    export/guide/query/read read-only).
  * Not verified live: the GUI against the live daemon (Alex takes the live screenshots);
    a failed server through the daemon (the daemon passes no `--mcp-config`; covered by
    the captured fixture and the fake).

## Follow-up: long names (2026-10-13)

A long version tag or tool name made the panel scroll sideways: both were `shrink-0`
in their flex rows, so they pushed the status pill (or the hint icons) past the card.
The server name itself already truncated. Now the card's title row and each tool row
share one pattern: the name and its secondary text sit in a `min-w-0 flex-1` group, the
name is `shrink-0 max-w-full truncate` (so it wins and only truncates once it alone fills
the row) and the secondary text (version, description) is `min-w-0 truncate` and gives
way first; the pill and the hint icons stay `shrink-0` outside the group. Full names
and versions are in `title`. The e2e "long names truncate" test stretches the names in
the DOM and asserts the panel body has no horizontal overflow and every pill sits inside
its card; `SHOTS_LONG=1` with `SHOTS` takes the screenshots with the stretched names
(`mcp-long-{dark,light}-panel.png`, mock data).
