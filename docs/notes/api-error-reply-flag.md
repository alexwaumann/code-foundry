# API-error reply flag (2026-10-28)

Follow-up to PR #390 (docs/notes/composer-failed-notice.md). A user cited "auth issue,
timeout, etc. where it doesn't run" as a reason to resend a prompt. In that case Claude Code
does not fail the turn as such: it writes a synthetic assistant message with the error wording.
The daemon stored that as an ordinary text item, so the GUI took it for a reply and the
failed-prompt notice never showed. The daemon now flags that text, and the GUI treats it as a
failure. Daemon and GUI change: a daemon restart is needed.

## What Claude Code emits

Captured from Claude Code 2.1.312 with `ANTHROPIC_API_KEY` set to an invalid key (now
`internal/claudestream/testdata/api-error.jsonl`; status, assistant and result lines, without
the init line):

- an `assistant` frame, never streamed (no stream_event before it), with model `<synthetic>`,
  one text block `"Invalid API key · Fix external API key"`, and on the frame:
  `"error":"authentication_failed"`, `"is_api_error_message":true`, `"api_error_status":401`;
- then a `result` with `is_error:true`, subtype `success`, `terminal_reason:"api_error"`,
  `result` holding the same text, `errors` empty.

Other failures use the same shape with another `error` (rate_limit, server_error, billing_error,
invalid_request, unknown) and wording ("API Error: Request timed out.", "Credit balance is too
low", "API Error: 529 {…overloaded…}"). Claude Code also writes `<synthetic>` messages that are
not errors ("No response requested."), so the model alone does not mark an error: the frame's
`error` or `is_api_error_message` does.

## Daemon

- `claudestream.Assistant` reads `is_api_error_message`; `Assistant.APIError()` is that or a
  non-empty `error`.
- `projector.assistant` (internal/store/thread/project.go) sets `Item.APIError` on the frame's
  text items. It does this on the not-streamed path, which is the one these frames take, and
  also on the streamed path in case a future version streams them.
- Stored as `"api_error":true` in thread_items.data (omitempty, no migration). Older rows
  read as false.
- The turn end needed nothing new: it already records `is_error` and `terminal_reason`.
- Proto: `AssistantTextItem.api_error` (bool, field 2), so it reaches the GUI through
  WatchThread and ListItems.
- `thread read` prints such an item as `claude (API error): <text>`, so agents reading a
  thread do not take it for a reply. Other consumers (wake reports, Ember's chat log) still
  see the text, which tells them what went wrong.

## GUI

- `api/thread.ts`: `{ kind: "text", text, apiError: true }` (the field only when set).
- `stores/thread.ts structOf` gives such an item the timeline kind `"error"`, so the thread
  timeline, Ember's chat rows and the subagent view all treat it as an error note: it is never
  a final text, it never carries Copy answer, it is never Ember's reply, and it stays visible
  when the turn folds. `NoteRow` renders it in the existing red error row
  (`data-testid="thread-error"`). `CopyAnswer` also skips api-error texts, as a fallback.
- `lib/failedPrompt.ts`: an api-error text after the prompt is not a reply. The reason is
  "The request failed (<detail>)", ranked after "did not start" and "stopped" and before the
  turn end's subtype. `apiErrorDetail` builds the detail: the first line; Claude Code's hint
  after " · " dropped; an "API Error:" prefix dropped; an Anthropic error body
  (`529 {"error":{"message":"Overloaded"}}`) replaced by its message; trailing period dropped;
  a sentence-case first word lowered (not Claude/Anthropic/OAuth/…); at most 60 characters with
  an ellipsis. Example: "The request failed (invalid API key), so your message was not sent."
- Turn header: a failed turn with subtype success now reads "Failed after 0.1s" instead of
  "Failed (success) after 0.1s".

## Mock and e2e

- `POST /__mock/thread/api-error[?text=…]`: the next message's turn is the synthetic text
  (api_error set; default the captured invalid-key wording) and an is_error turn end with
  subtype success and terminal_reason api_error. Like the real stream, nothing comes before it
  (no thinking).
- `e2e/composer-failed-notice.spec.ts`: the notice's wording, the red row, no new text row and
  no new Copy answer, Send again then the reply clearing it; a custom text's detail; and the
  screenshots (`api error screenshots`, SHOTS=<dir>).

## Real daemon check

Built, ran `code-foundry daemon` with `CODE_FOUNDRY_HOME=/tmp/pr-e-home` and an invalid
`ANTHROPIC_API_KEY` in its environment, and started a thread in a scratch repo under home.
`thread read --json` showed `assistantText {text: "Invalid API key · Fix external API key",
apiError: true}` followed by `turnEnd {subtype: success, isError: true, terminalReason:
api_error}`, and the stored row's data was `{"text":"…","api_error":true}`. The scratch repo
and home were then deleted.

## Gotchas

- Setting `ANTHROPIC_API_KEY` takes precedence over a claude.ai login, so it is a cheap way to
  force an auth failure. Claude Code warns that claude.ai connectors are disabled.
- Unit tests use captured lines only, with no drift guard for Claude Code's wording. If a
  future version drops both `error` and `is_api_error_message`, the text shows as a reply
  again, as it did before this change.
