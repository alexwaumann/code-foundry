# Rendered threads — follow-ups (intent)

Status: **facts gathered 2026-10-11; polish batch (§0) scheduled 2026-10-12, the rest not.** Nothing here is in the four
rendered-threads PRs (`rendered-threads-handoff.md` §4). Each section is a candidate
follow-up PR once PR 4 ships. Protocol facts come from the Agent SDK wire types
(`/tmp/cf-sdk-ref/package/sdk.d.ts`, `npm pack @anthropic-ai/claude-agent-sdk`) and
from live probes against Claude Code 2.1.296 with haiku; "verified" means probed.

## Constraints (Alex, 2026-10-11)

* **No hooks.** Managed settings on the work laptop forbid hooks, including stream-json
  `hook_callback` hooks registered through `initialize`. Nothing below may depend on them.
* **Bedrock.** Work traffic uses the Bedrock API. Prompt cache TTL is **1 hour** on the
  main thread, **5 minutes** for subagents. The CLI exposes the TTL only in hook inputs
  (`PreModelSwitch.cache_ttl`, `SessionStart.prompt_cache_likely_expired`), so the daemon
  computes expiry itself.
* No plan mode, no mode switching for a thread, terminal mode stays the default
  (`rendered-threads-handoff.md` §3).

## 0. Polish batch (Alex, 2026-10-12, from testing rendered mode)

One PR, branch `t3code/rendered-threads-followups-fixes`, before §2–§4.

* **Composer loses focus after send.** PromptEditor (ProseMirror) is made non-editable
  while the draft is `attaching`/`starting`; ProseMirror drops focus then and nothing
  takes it back at `idle`. Fix: remember focus at send, refocus when the phase returns
  to idle.
* **Thread width setting.** `appearance.thread_width` enum compact | comfortable |
  full, default comfortable. compact = today's 784px column / 720px composer;
  comfortable = 1040 / 960; full = no cap. One CSS variable drives both. Numbers are a
  first guess, adjustable later.
* **Jump-to-bottom chip.** Timeline already knows `atBottom`; when unpinned, a chip
  floats centred above the composer ("Jump to bottom", down arrow); click scrolls down
  and re-pins. No new-message count for now.
* **Tables.** Thicker border, rounded outer corners, header cell styling (muted fill);
  the 1px `var(--border)` cells read as floating text, worst in dark mode.
* **Cache after reconnect (reported: breaks within the hour).** Probed 2026-10-12 with
  haiku on the Anthropic API (no Bedrock env on this shell): close + `session.reconnect`
  and daemon kill + reconnect both kept the cache (first turn after reconnect wrote 41
  and 2075 tokens, read 25k). The resumed argv differs only by `--resume`. Not a daemon
  bug on that path; open questions: Bedrock TTL (5 min vs 1 h?), threads with session
  grants (Reconnect spawns with empty grants, the effort restart keeps them), how the
  break was judged. Side finding: turn 2 of a fresh conversation rewrote ~9k tokens
  (read 15371 / write 9061 after turn 1 wrote 9939) in one probe, not in the other.

## 1. Document attachments (PDF, text) — deferred (Alex, 2026-10-12: not yet)

**Verified**: the `user` message is a Messages API `MessageParam`; a
`{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":…}}`
block beside the text block works over stream-json (haiku read the secret word out of a
one-page PDF; probe in `/tmp/cf-pdf-probe`). PR 1 only builds `image` blocks.

Intent: the composer accepts PDFs and plain-text documents in rendered threads; the
daemon sends them as `document` blocks and keeps the staged-path line. API limits apply
(PDF ≈ 32 MB / 100 pages; pages bill as image tokens every turn they stay in context).
Office formats are not API documents; conversion is a separate feature. Terminal threads
keep today's path-only behaviour. Small: send path + accepted types + an item renderer
for the document chip. Could ride in PR 2 or PR 4 if cheap.

## 2. MCP panel

The `initialize` reply has **no MCP data**. State lives in:

* `system/init` (start of every turn): `mcp_servers [{name, status, source}]`, plus
  `tools`, `skills`, `plugins`, `plugin_errors`, `slash_commands`, `capabilities`.
* `mcp_status` control request (any time): per server `status` (connected | failed |
  needs-auth | pending | disabled), `serverInfo {name, version}`, `error`, `scope`,
  `source`, `tools [{name, description, annotations {readOnly, destructive, openWorld}}]`.
* No push event for status changes; `commands_changed` fires when the command list
  changes (plugin/skill reload). Poll `mcp_status` after each `init` and after our own
  reconnects.

Host → CLI controls (same envelope as `interrupt`): `mcp_reconnect {serverName}`
(also the path for needs-auth after the user logs in out of band), `mcp_toggle
{serverName, enabled}`, `mcp_set_servers {servers}`, `mcp_call {server, tool,
arguments}` (no model turn, no permission check), `mcp_read_resource`,
`reload_plugins`, `reload_skills`, `reload_output_styles`, `list_permission_rules`.

Intent: a panel tab (not a page; see `overview-page-removed`) listing servers with
status, error, tool count; actions reconnect and enable/disable. Daemon: `McpStatus`
+ `McpReconnect` + `McpToggle` on `ThreadService`, status cached on the thread
snapshot, refreshed on `init`.

## 3. Context usage breakdown (Alex: "super cool, def should have")

`get_context_usage` control request, answered locally (no API call). Response:
`totalTokens`, `maxTokens`, `rawMaxTokens`, `percentage`, `autoCompactThreshold`,
`isAutoCompactEnabled`, `categories [{name, tokens, kind: used|free|buffer|deferred}]`,
`systemPromptSections`, `systemTools`, `deferredBuiltinTools`, `mcpTools [{name,
serverName, tokens, isLoaded}]`, `memoryFiles [{path, type, tokens}]`, `agents`,
`slashCommands`, `skills {…, skillFrontmatter}`, `messageBreakdown`, `model`. Same data
as `/context` in the TUI.

Intent: daemon sends `get_context_usage` after every `result`, stores total/max/
threshold on the thread row (cheap), fetches the full breakdown on demand for a panel
tab. UI: breakdown view (stacked bar by category, then per-item tables for MCP tools,
memory files, skills). **No persistent meter** in the thread: Alex notes they stop
reading those. Only an amber one-liner near the auto-compact threshold (~80 %), and the
`compact_boundary` frame already marks compaction in the timeline.

## 4. Cold-cache signal (Alex: yes, with the token count)

Cache refreshes on every hit, so `expires_at = last result time + TTL`. The daemon knows
both (TTL = 1 h on Bedrock; 5 min does not matter here because subagents live inside a
turn). `context_tokens` to re-read = the last response's `input + cache_read +
cache_creation + output` (the CLI's own definition), available from the last
`assistant`/`result` usage; `get_context_usage.totalTokens` is the same number.

Intent: thread snapshot gains `cache_expires_at` (and the context token count). When
`now > cache_expires_at` and the thread is idle, the composer shows a muted note:
"Cache expired · the next message re-reads N tokens" (N formatted like the usage page;
optional cost from our price table in `internal/usage`). Clears on the next send. Also
shown after a reconnect/resume (always cold after a daemon restart older than 1 h).
Confirm by eye on the first turn: `cache_creation_input_tokens` large,
`cache_read_input_tokens` small.

## 5. Smaller items noticed

* `initialize` reply: `commands` (slash commands + skills with descriptions and argument
  hints → composer `/` completion source instead of scanning disk), `agents` (custom
  subagents), `models` (account's model list with display names → could replace the
  hand-kept registry's labels; see `model-registry-decisions`), `account`, output
  styles, `fast_mode_state`.
* `list_models`, `get_session_cost`, `get_settings`/`update_settings`,
  `set_max_thinking_tokens`, `rename_session`, `stop_task`/background controls (Ctrl+B
  equivalent for a running Bash or subagent), `rewind_files`.
* `request_user_dialog` frames exist for host-rendered dialogs; only sent for kinds we
  declare in `initialize.supportedDialogKinds`. Declare none until there is a renderer.

## Suggested order

0. Polish batch (§0).
1. ~~Document attachments~~ (deferred).
2. Cold-cache signal + context totals (daemon fields + composer note; one PR).
3. Context breakdown panel tab.
4. MCP panel tab.
