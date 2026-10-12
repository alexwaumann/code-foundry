# Rendered threads — handoff

Status: **design agreed with Alex on 2026-10-11**, building. Read `ARCHITECTURE.md` and
`PLAN.md` first, then `new-thread-composer.md`, `composer-tags-*.md` (the composer this
reuses) and `thread-status-persistence.md`.

## 1. Problem

Today every thread is `claude` running interactively in a PTY, shown through xterm.js.
That is faithful but a terminal: no proper markdown, tables, images, clickable file tags,
no selectable tool output. T3 Code drives the Claude Code harness headlessly and renders
the conversation itself. We add that as an **opt-in render mode** ("rendered"); the
terminal mode stays the default and keeps working unchanged.

## 2. Verified facts (Claude Code 2.1.296, probed 2026-10-11)

The daemon drives Claude Code itself over stdio. No Node sidecar, no Agent SDK: the SDK
is a thin client of this same protocol (its wire types are in
`/tmp/cf-sdk-ref/package/sdk.d.ts`, `npm pack @anthropic-ai/claude-agent-sdk`;
re-download if missing).

* Spawn: `claude -p --input-format stream-json --output-format stream-json --verbose
  --include-partial-messages --permission-prompt-tool stdio [--session-id | --resume
  [--fork-session]] --model --effort --permission-mode --add-dir ... --append-system-prompt`.
  No positional prompt: the first prompt is the first stdin message. Transcript is still
  written to `~/.claude/projects/<slug>/<id>.jsonl` (do NOT pass `--no-session-persistence`),
  so naming, usage, PR links and `/clear` tracking keep reading it.
* `--permission-prompts host` alone does **not** route prompts to stdout;
  `--permission-prompt-tool stdio` does. Without the handshake below every prompt is
  auto-denied (`system/permission_denied`).
* Handshake: first stdin line `{"type":"control_request","request_id":"<id>","request":{"subtype":"initialize"}}`.
  The reply (`control_response`, `response.subtype == "success"`) lists `commands`
  (slash commands/skills), models, account info. Then `system/init` arrives (tools, mcp
  servers, model, permissionMode, cwd, session_id).
* Input: `{"type":"user","message":{"role":"user","content":[{"type":"text","text":...},{"type":"image","source":{"type":"base64","media_type":"image/png","data":...}}]}}`
  one JSON per line. Optional `uuid` on the wrapper is echoed back (see sdk.d.ts
  SDKUserMessage). Images: png, jpeg, gif, webp.
* Output lines (`type`): `system` (subtypes init, status, permission_denied,
  thinking_tokens, compact_boundary, ...), `assistant` (full message after each content
  block completes; `parent_tool_use_id` set for subagent frames), `user` (tool_result
  frames), `stream_event` (Anthropic streaming events: message_start,
  content_block_start/delta/stop with text_delta, thinking_delta, input_json_delta),
  `result` (end of turn: subtype success|error_*, is_error, usage, total_cost_usd,
  duration_ms), `rate_limit_event`, `control_request`, `control_response`.
* Permission: `{"type":"control_request","request_id":R,"request":{"subtype":"can_use_tool","tool_name","display_name","input","description","permission_suggestions":[...],"tool_use_id","title"?,"decision_reason"?,"blocked_path"?}}`.
  Answer `{"type":"control_response","response":{"subtype":"success","request_id":R,"response":{"behavior":"allow","updatedInput":<input>,"updatedPermissions":<suggestions>?}}}`
  or `{"behavior":"deny","message":"...","interrupt":true?}`. "Allow for session" =
  allow with `updatedPermissions` set to the `permission_suggestions` (T3 does exactly
  this). AskUserQuestion arrives as `can_use_tool` with `tool_name == "AskUserQuestion"`;
  answer allow with `updatedInput: {questions, answers}`.
* Host → CLI control requests (same envelope, CLI answers with control_response):
  `interrupt`, `set_permission_mode {mode}`, `set_model {model}`, `set_cwd {path}`
  (RunIn without typing `/cd`), `rename_session`. There is no set_effort: an effort
  change restarts the process with `--resume` between turns.
* Sending a `user` message while a turn runs is accepted; the CLI applies its own
  steer/queue behaviour (same as typing while busy in the TUI).
* Close: `interrupt` if busy, close stdin, wait, SIGTERM, then SIGKILL after the timeout.

## 3. Decisions (Alex, 2026-10-11)

1. Pure Go driver in the daemon (`internal/claudestream`), no Node.
2. Opt-in: setting `sessions.render` = `terminal` (default) | `rendered` is the composer's
   default for **new threads only**, with a per-thread toggle in the composer. The mode is
   a field on the session row, fixed for the thread's life: **a thread is never switched**
   between modes (Alex, 2026-10-11). Reconnect and fork keep the row's mode.
3. **History lives in our own SQLite `thread_items` table**, appended from the stream
   (the transcript is a parent-uuid tree with sidechain/meta records, huge lines, and the
   projected prompt instead of the composer's tags; not a render source).
4. Images are sent as real base64 image blocks plus the staged path line (today's
   terminal threads only pass paths).
5. Tool rendering: T3-style compact grouped rows that expand, inline diffs for Edit/Write
   built from `old_string`/`new_string` (or the tool result's `structuredPatch`).
   Confirmed on an HTML sketch before building.
6. Send while busy goes straight to the CLI; a separate Interrupt button. No server-side
   queue UI (deferred).
7. **No plan mode.** Only the existing permission modes (supervised = `manual`, accept
   edits, auto; default = Claude's default). `ExitPlanMode`/plan never appear in the UI.
8. Status from the stream, no screen detector: busy from send until `result`;
   needs-attention while a `can_use_tool` is pending; idle after `result`; error when the
   process exits mid-turn. Same `Status`/`StatusReason` fields as today.

## 4. Build order

* **PR 1 (daemon)** branch `t3code/rendered-threads-1-daemon`: `internal/claudestream`
  (types, line parser, control client, fixtures captured from haiku runs), stdio runner
  beside the PTY runner, `thread_items` table + migration, `ThreadService` (Items
  snapshot + Watch stream, Send, Respond, Interrupt, SetModel, SetPermissionMode), `thread`
  event source, `sessions.render` setting, `--render` on `session.new`, CLI verbs
  (`thread items|send|respond|interrupt`), sessiontest fake. Fable 5.1 reviews.
* **Sketch**: static HTML of the rendered thread (timeline + follow-up composer), dark and
  light, Playwright screenshots, Alex picks.
* **PR 2 (GUI timeline)**: items store, virtualized timeline, streaming markdown (tables,
  code highlighting), work-log rows with inline diffs, thinking rows, subagents nested,
  images, file tag chips in user messages, follow-up composer reusing PromptEditor /
  tags / attachments / pickers, mock daemon.
* **PR 3 (interaction)**: permission prompts (allow, allow for session, deny, interrupt),
  AskUserQuestion panel, live model and mode switching, effort restart.
* **PR 4 (opt-in + polish)**: composer toggle + setting, Playwright specs, screenshots,
  docs.

## 5. T3 Code reference (MIT, checkout `/tmp/t3code-ref/t3code`)

* Item model: `packages/contracts/src/orchestrationV2.ts` 1407-1669 (`OrchestrationV2TurnItem`).
* Claude adapter (read for edge cases, not portable): `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`
  (query options 948-1068, canUseTool 7854-8081, AskUserQuestion 7917-7981, decisions
  2411-2464, tool classification 1814-1839, images 1479-1576, interrupt 8689-8724).
* Pure presentation logic (liftable): `packages/client-runtime/src/work-log/*.ts`,
  `apps/web/src/components/chat/MessagesTimeline.logic.ts`, `apps/web/src/session-logic.ts`.
* Components (reference; coupled to Effect atoms and base-ui): `MessagesTimeline.tsx`,
  `WorkLog.tsx`, `ShellCommandBlock.tsx`, `V2ItemInspector.tsx`, `ChatMarkdown.tsx`,
  `ComposerPendingApprovalActions.tsx`, `ComposerPendingUserInputPanel.tsx`,
  `apps/web/src/markdown-incremental.ts`, `packages/shared/src/markdownPipeline.ts`.
