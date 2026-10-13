# Rendered threads, PR 1: the daemon

Status: done on branch `t3code/rendered-threads-1-daemon`. `make check` green; exercised
end to end with a scratch daemon, the CLI and real haiku sessions (below). Design record:
`rendered-threads-handoff.md` (§2 holds every protocol fact, including the ones probed
while building this). No GUI work: the GUI PR maps the new proto in `src/api`.

## What was built

* **`internal/claudestream`** (pure, no store imports). `Parse(line) Event` decodes
  every stdout line into a concrete type (`*Init`, `*Status`, `*PermissionDenied`,
  `*CompactBoundary`, `*ThinkingTokens`, `*ConversationReset`, `*Assistant`, `*User`,
  `*StreamEvent`, `*Result`, `*RateLimit`, `*CommandLifecycle`, `*Task`,
  `*ControlCancel`) keeping the raw JSON; anything else, or a line that is not JSON, is
  `*Unknown` (never fatal). `Splitter`/`ReadLines` split stdout like the transcript
  tailer, up to 64 MiB a line. `Conn` owns stdin/stdout: `Initialize`, `Send`,
  `Request` (request_id correlation; an error response is a `*ControlError`),
  `Interrupt`, `SetModel`, `SetPermissionMode`, `SetCwd`, `CloseStdin`, and `Events()`
  for everything else, fed by an unbounded queue so the reader never waits on the
  consumer. Inbound `can_use_tool` (AskUserQuestion included) is a `*PermissionRequest`
  on the same ordered `Events()`, pending as long as a person takes until its
  `Answer(result)`; after `control_cancel_request` (also on `Events()`, after the
  request) `Answer` sends nothing and returns `ErrCancelled`, after the end of stdout
  `ErrClosed`, a second time `ErrAnswered`. The reply is written on its own goroutine.
  (See "Ordering" below.) Other inbound control requests
  get an error response. `Process` (`Start(Spec)`) runs the CLI in its own process
  group with its own `os.Pipe`s (so `Wait` is not held by a grandchild keeping a pipe
  open), keeps a 16 KiB stderr tail for `LastError`, and signals the group.
* **Session store: a second runner over stdio.** `Session.Render` (`RenderTerminal` |
  `RenderRendered`; `RenderDefault` only in `CreateOptions`, resolved through
  `Options.DefaultRender`), migration `0014_rendered_threads.sql` (`sessions.render`,
  default 1 = terminal, and `thread_items`). The mode is fixed for a thread's life: Fork
  and Reconnect copy it, nothing switches it (Alex, 2026-10-11).
  * The rendered runner is the **same `runner` type** with a `streamState` (`stream.go`);
    `run()` hands over to `runStream()` and the terminal path is untouched except two
    guarded lines in `onTick` (`r.pid()` instead of `r.term.Pid`, no trust-screen check)
    and one in `tryCd`. Status debounce and persistence, `finish` and
    `disconnectedStatus`, transcript tailing (naming, usage, PR links, `/clear` via the
    process pid), `RunIn` queuing and `Close`/`Shutdown`/`Remove` all reuse the terminal
    runner's code. `TerminalID` stays empty.
  * argv: `launch.argv` with `spawnArgs.rendered` prepends `-p --input-format stream-json
    --output-format stream-json --verbose --include-partial-messages
    --permission-prompt-tool stdio` and never appends the prompt. Same env, `--add-dir`
    (attachments, workspace members), `--append-system-prompt`, trust pre-set.
  * The first prompt is the first user message after the handshake: the text block is
    what `buildPrompt` + `rewriteFileRefs` produce (the terminal's positional prompt),
    plus one base64 image block per attachment, media type sniffed from the content. The
    user_message item keeps the text as typed (cf-file tokens) and the attachment paths.
  * **Status** (`stream_status.go`, `streamStatus` is the runner's `StatusDetector`):
    unknown "starting" until the handshake; busy "working" from a send (or `status
    requesting` / `command_lifecycle started`) until a result with no queued turn;
    "compacting"; needs-attention "permission: <Tool> <what>" / "question:
    <question>" while a request is pending (oldest first); after a result "finished"
    (or "error: <code>") until seen, then idle "at prompt". An interrupted turn counts
    as seen. Same strings as `internal/claudestatus`, so the GUI's `statusKind`
    classifies them already.
  * **Seen**: `WatchItems(ctx)` counts a viewer until ctx ends; the runner treats viewers
    like Attach subscribers (acknowledge when one arrives and after each result while
    one is there). Answering a request also acknowledges.
  * **Close**: pending requests are denied (with interrupt) and cancelled, `interrupt`
    if busy, stdin closed; SIGTERM to the process group after `CloseTimeout`, SIGKILL
    2 s later. Daemon shutdown terminates the process (it cannot outlive the pipes) and
    records "daemon stopped". A close captures the status first with pending requests
    dropped, so a thread closed mid-turn ends `error (interrupted)` like a terminal one.
  * **RunIn** for a rendered thread: once idle, the member is pre-trusted and
    `set_cwd` sent (instead of typing `/cd`); the row moves on `status: ok`, otherwise
    `LastError` says why. A disconnected thread's row changes at once, as before.
* **Thread items** (`items.go`, `project.go`, `items_db.go`). Kinds: `user_message`,
  `assistant_text`, `thinking`, `tool_call` (name, input JSON, output, is_error,
  status running|done|error, structured `tool_use_result` up to 256 KiB, parent
  tool_use for subagents), `permission_request` and `question` (one `Request` payload:
  request id, tool, title/description, input, suggestions, state
  pending|allowed|denied|cancelled, decision allow|allow_session|deny|auto_denied,
  message, answers), `turn_end` (subtype, is_error, interrupted, stop/terminal reason,
  duration, num turns, cumulative cost, tokens, errors), `error` (start failure, exit
  mid-turn), `compaction` (trigger, pre/post tokens; the summary as text), and
  `command_output` (local slash command output, e.g. "Compacted", "Set model to …").
  No divider: modes never switch.
  * Ordinals are assigned on first sight and only grow. Streaming items live in memory
    (`Streaming`), deltas are published, the row is written when the block completes
    (the `assistant` frame, which comes before `content_block_stop`), and rewritten on
    later changes (tool result, decision). A thread's items load lazily on first use,
    so a restart rehydrates them; a run that died with items open (crash) has them
    closed on load (running tools become errors, pending requests cancelled).
  * Bus: `session.ThreadEvent` = `ItemAppended`, `ItemUpdated`, `ItemDelta` (field
    text or input, the appended text), `PendingChanged` (the whole list). Each carries
    the thread's `Seq`; `ItemsSnapshot.Seq` says which events a snapshot includes.
  * Store: `Items`, `WatchItems`, `Send(Message)`, `Respond(requestID, Decision)`,
    `Interrupt`, `SetModel` (records the row's model), `SetPermissionMode` (supervised →
    wire `default`, accept-edits, auto; `PermissionDefault` is refused because the
    user's `defaultMode` cannot be selected live). All refuse a terminal thread with
    `ErrFailedPrecondition`. `sessiontest.Fake` implements them (`PutItems`,
    `Watchers`).
* **API**: `proto/codefoundry/v1/thread.proto`, `ThreadService` (`ListItems`, `Watch`,
  `Send`, `Respond`, `Interrupt`, `SetModel`, `SetPermissionMode`); EventService source
  `EVENT_SOURCE_THREAD = 12` / `Event.thread = 12` after `session`;
  `Session.render = 31`, `CreateSessionRequest.render = 12` (`SessionRender`
  UNSPECIFIED/TERMINAL/RENDERED); `UiContext.active_session_rendered = 7`. Handlers are
  thin (`internal/api/thread.go`).
* **Setting** `sessions.render` (`terminal` default | `rendered`, labels Terminal /
  Rendered, title "Thread view", right after the naming model, live): the mode of a
  Create without one (`settingsRender`, read per call). Mirrored in
  `gui/frontend/mock/settings.ts`.
* **Commands**: `session.new --render terminal|rendered`; `thread.send <text>
  [--attachments]`, `thread.respond [allow|allow-session|deny] [--request] [--answer]
  [--message] [--interrupt]` (default: the oldest pending request; a question's answer
  is a label or a JSON object of question to label), `thread.interrupt`, `thread.items
  [--full]` (readable log), `thread.set-model <model>`, `thread.set-mode
  <supervised|accept-edits|auto>`. Available when the GUI says the active thread is
  rendered (`Context.ActiveSessionRendered`), or from the CLI (the daemon refuses a
  terminal thread).

## For the GUI PR

* Map in `src/api`: `ThreadItem` is a oneof (`user_message`, `assistant_text`,
  `thinking`, `tool_call`, `permission`, `question`, `turn_end`, `error`, `compaction`,
  `command_output`) plus `id`, `ordinal`, `parent_tool_use_id` (nest subagent items
  under the Agent tool call with that id), `created_at`, `updated_at`, `streaming`.
* Sync: `ThreadService.Watch(session_id)` for the visible rendered thread (it takes the
  slot a terminal's `Attach` would; it is also what marks turns seen). First event
  `snapshot` (items, pending, `seq`), then `appended` / `updated` (full item, replace by
  id) / `delta` (append `text` to `assistant_text.text`/`thinking.text` for
  `FIELD_TEXT`, to `tool_call.input_json` for `FIELD_INPUT`) / `pending`. Drop events
  with `seq <= snapshot.seq`; a second `snapshot` means the stream resynced after
  drops. The EventService `thread` source carries **only pending requests**: a
  `pending_snapshot` (the live rendered threads' pending requests) and a `pending`
  event per change, for badges without a Watch. It never carries items or deltas
  (review, below): build item state from `Watch` alone.
* A permission item and its tool call share `tool_use_id`. AskUserQuestion shows up
  twice: a `tool_call` named AskUserQuestion and a `question` item (render the
  question, hide or fold the call). `Respond(request_id, ALLOW | ALLOW_FOR_SESSION |
  DENY, answers{question: label}, message, interrupt)`; multi-select answers are labels
  joined with ", " (what Claude's own UI sends).
* `turn_end.cost_usd` is Claude's cumulative estimate for the process, not per turn;
  the thread's usage stays `Session.usage` from the transcript fold.
* `tool_call.output` is cut at 512 KiB with a trailing `… [output truncated: N more
  bytes]` line; `result_json` is empty over 256 KiB. An `error` item's text is
  "Claude exited mid-turn (code N): <last stderr line>", "Claude exited (code N)
  before answering the initialize handshake: …" or "claude did not start: …".
* A fork of a rendered thread starts with **no items**: the history is in Claude's
  transcript (`--resume --fork-session`), not copied into `thread_items`. Show an
  empty timeline with the parent's name, or ask for copying in a later PR. (Superseded:
  a fork now starts with a copy of its parent's items and a note,
  `docs/notes/fork-copies-history.md`.)
* Thinking items usually have empty text (haiku streams none): render a "thinking"
  row, not an empty bubble.
* Status reasons for rendered threads: "starting", "working", "compacting",
  "permission: Write hello.txt", "question: …", "finished", "error: <code>",
  "at prompt"; disconnected rows follow the persistence rules unchanged.

## Verification

* `make check` green. New tests: `internal/claudestream` (parse table over every
  fixture, tolerant parsing, splitter incl. a 5 MiB line, permission result wire
  shapes, Conn correlation/close/cancel/exit/unsupported, fixture replay through the
  handler; `TestRealClaudeStream` with `CF_REAL_CLAUDE=1`, passed against 2.1.296),
  `internal/store/session` (`stream_test.go`: the test binary re-executes itself as a
  fake `claude -p` replaying the fixtures (`fakeclaude_test.go`), covering argv, the
  handshake, file refs, permission → allow → items → restart → rehydrate → reconnect
  appends → close; Watch replay by seq; questions; deny; subagent + allow-for-session;
  controls; default render; RunIn via set_cwd; the image block. `TestProjectFixtures`
  (projector alone over each fixture), `TestStreamStatus` (table)), API Watch/Send/
  Respond and item mapping, thread commands and availability, settings field, events
  snapshot order.
* Fixtures: captured with `/tmp/cf-stream-probe/probe.py` (haiku, low effort) in
  `/tmp/cf-stream-fixtures/w-*` scratch repos, trimmed by `trim.py` (initialize
  command list, init lists, thinking signatures, image data):
  `text-table`, `write-allow`, `write-deny`, `ask`, `bash`, `task`, `interrupt`,
  `interrupt-pending`, `compact`, `image` (`.in.jsonl` is what was sent).
* Live, scratch daemon and repo:

      make build
      CODE_FOUNDRY_HOME=/tmp/cf-rt1-home ./bin/code-foundry daemon --dev &
      export CODE_FOUNDRY_HOME=/tmp/cf-rt1-home
      ./bin/code-foundry repo add ~/cf-rt1-scratch            # a fresh git init under home
      ./bin/code-foundry session new --worktree ~/cf-rt1-scratch --model haiku --effort medium \
        --permission supervised --render rendered \
        --prompt "Create a file named hello.txt containing exactly the word hi, using the Write tool. Then reply with one short sentence."
      ./bin/code-foundry session list      # needs_attention  permission: Write hello.txt (auto-named create-hello-text-file)
      ./bin/code-foundry thread items --id <id>      # you / thinking / tool Write [running] / permission … pending
      ./bin/code-foundry thread respond --id <id> allow
      cat ~/cf-rt1-scratch/hello.txt       # hi
      ./bin/code-foundry thread items --id <id>      # tool Write [done] → File created…, claude: …, turn end
      ./bin/code-foundry thread send --id <id> "Use the AskUserQuestion tool … then reply with a two-row markdown table …"
      ./bin/code-foundry thread respond --id <id> --answer Blue   # question: allowed: Which color do you prefer? = Blue
      ./bin/code-foundry thread set-mode --id <id> accept-edits; ./bin/code-foundry thread set-model --id <id> sonnet
      ./bin/code-foundry thread send --id <id> "Write the numbers from one to three hundred in words …"
      ./bin/code-foundry thread interrupt --id <id>   # turn end: error_during_execution (interrupted); idle at prompt
      kill -TERM <daemon pid>              # the claude child exits with it
      CODE_FOUNDRY_HOME=/tmp/cf-rt1-home ./bin/code-foundry daemon --dev &
      ./bin/code-foundry thread items --id <id>      # identical to before (diffed): rehydrated
      ./bin/code-foundry session reconnect --id <id>  # --resume <claude id>, rendered again
      ./bin/code-foundry thread send --id <id> "In five words or fewer: what color did I pick?"   # "Blue." appended as #19-#21
      ./bin/code-foundry session close --id <id>     # disconnected (closed) in 0.2 s, exit 0

  Also closed with a Write prompt pending (supervised): the permission item became
  `cancelled: the thread was closed`, the tool call an error, the turn ended
  interrupted, the row `disconnected (closed)  error (interrupted)`; the file was not
  written. Usage (`Session.usage`, cost) and the auto name came from the transcript as
  for a terminal thread; no spurious "switched session id" (the pid file matches
  `--session-id`).

## Decisions and gotchas

* **One runner type, two loops** rather than a parallel runner: everything that is not
  "how bytes reach Claude" is shared, and the terminal path keeps its code byte for
  byte apart from three guarded lines.
* **Connected = handshake answered**, since `system/init` only comes with a turn.
* **Pending requests do not survive their process**, so they are cancelled whenever it
  ends (close, exit, daemon stop, and on load after a crash); the EventService thread
  snapshot only asks live rendered threads.
* **Daemon stop kills the claude child** (SIGTERM to its process group, SIGKILL 2 s
  later) and records "daemon stopped": it talks to the daemon over pipes and cannot
  outlive it, the same as a terminal thread's PTY (ARCHITECTURE §11: processes do not
  survive a restart). Reconnect resumes the transcript.
* **`SetPermissionMode` refuses `PermissionDefault`**: "no flag" means the user's
  `defaultMode` setting, which the control protocol cannot select (`default` on the wire
  is supervised).
* Lock order: `Manager.mu` before `Manager.tmu` (the thread logs); `thread()` reads the
  record under `mu`, releases it, then takes `tmu` (Remove holds `mu` while dropping a
  log). `thread()` reads the record, not the snapshot: Create's spawn needs the log
  before the first publish.
* **Ordering: permission requests travel with the other lines.** The CLI writes a
  tool's `assistant` frame (and its stream events) before the `can_use_tool` asking
  about it, on the same stdout. The Conn first ran a `PermissionHandler` callback on a
  goroutine per request while every other line went through the ordered `Events()`
  queue, so the runner appended the `permission_request` item and the `tool_call`
  item from two goroutines and their ordinals raced (CI: `[user_message
  permission_request tool_call …]`). Now the request is an event in stdout order and
  the runner's loop appends it, registers it as pending, and answers it from
  `Respond`, a close, or a request arriving while closing; withdrawal is the
  `*ControlCancel` event in the same loop. No callback, no per-request goroutine (the
  answer's write still goes out off the caller's goroutine).
  `TestRenderedPermissionFollowsItsToolCall` (ten tool_use + can_use_tool pairs back
  to back, failed every run before) and `TestConnPermissionOrder` guard it.
* The test fake is the test binary itself (`TestMain` + `CF_FAKE_CLAUDE`), so no
  script or Node is needed; fixture paths must be absolute (the fake's cwd is the
  thread's worktree).
* `make check` in a fresh worktree builds libghostty-vt first (`make ghostty-vt`, a few
  minutes); `go test -race` alone needs `PKG_CONFIG_PATH` pointing at it.

## Left out (later PRs)

* Everything in the GUI (PR 2/3/4): the timeline, the composer toggle, prompts.
* Effort changes (no `set_effort`: a restart with `--resume`), `rename_session`,
  `stop_task` for background agents, `request_user_dialog` (answered with an error),
  MCP elicitation.
* No per-thread queue UI: Send while busy goes straight to Claude (decision 6).
* A thread's items are not pruned; `thread_items` grows with the conversation (rows
  are small; tool output is cut at 512 KiB, structured results over 256 KiB dropped).
  Loaded logs stay in memory (`Manager.threads`) until the thread is removed.

## Review (Fable 5.1, 2026-10-11)

Independent review of the branch; each fix is its own commit, with a test.

Fixed:

* A claude that died before answering `initialize` (bad flag, not logged in, a
  missing binary's wrapper) ended `disconnected (closed)` with no exit code of note:
  `onInitialized` began a close on `ErrClosed`. Now `maybeExited` records it:
  `crashed`, the last stderr line as `LastError`, an error item even on exit 0
  (`TestRenderedStartCrash`).
* `stopStream` (daemon shutdown) never closed the stdout read end, so a grandchild
  holding the pipe kept the reader goroutine and its permission handlers alive; and a
  permission handler waited on its answer even after the runner was gone. Both end now.
* The Conn answered unsupported control requests from the reader goroutine: a write
  that waits for the CLI to drain stdin would stop stdout being drained (both pipes
  wedged). Replies go out on their own goroutine.
* `tool_call.output` was unbounded (every update travels whole over the bus, each
  Watch and the EventService); cut at 512 KiB with a marker (`TestProjectToolOutputCap`).
* The EventService `thread` source forwarded every thread's items and deltas to every
  client (a second copy of the visible thread's Watch for everyone), while its resync
  after dropped events restored pending requests only, so items built from it would
  diverge silently. It now carries pending requests only; proto comments updated.
* `compacting` was cleared only by a `status: null` carrying `compact_result`; the
  status type is `compacting | requesting | null`, so any null now ends it.
* Create's spawn failure left the thread's log in `Manager.threads`.

Checked and left as is:

* `Conn.Send`/`Request` writes to stdin block without a deadline (the ctx is for the
  reply). A wedged claude that stops reading stdin with 64 KiB queued would hold the
  runner goroutine until the daemon's shutdown deadline. A write deadline would need a
  pipe we own and a "connection broken" state after a partial write; not worth it until
  seen in practice.
* A stdout line over 64 MiB is skipped whole; if it was a tool_result its tool call
  stays "running" until the process ends (background agents legitimately stay running
  across turns, so the turn end cannot close them).
* `saveItem` runs on the runner goroutine, one autocommit upsert per completed block or
  update: a handful per turn, fine for SQLite in WAL mode.
* `StartTimeout` (15 s) bounds the handshake; a big `--resume` answers `initialize`
  before loading its transcript in the runs seen, so it has not bitten.
* Lock order, seq/snapshot semantics of Watch, request-id correlation (the CLI's ids
  are UUIDs, ours `cf-N`), rehydration, interrupt with a pending request, close with
  pending requests, Send while busy: reviewed, no change.

Live (haiku, low, scratch daemon in `/tmp/cf-rv-home`, repo `~/cf-rv-scratch`):
Write permission → allow → file written → finished; `kill -9` of claude mid-turn →
`disconnected (crashed)`, `error (interrupted)`, the streaming text item closed, error
item "Claude exited mid-turn (code -1)"; reconnect → answer in five words; SIGTERM
to the daemon → the child gone in 200 ms, "daemon stopped"; restart → items identical;
reconnect → close → `disconnected (closed)`.
