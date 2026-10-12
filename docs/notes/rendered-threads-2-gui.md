# Rendered threads, PR 2: the GUI timeline

Status: done on branch `t3code/rendered-threads-2-gui` (on top of PR 1,
`rendered-threads-1-daemon.md`, merged in after its review). Design: the sketch's variant A
with Alex's decisions (`docs/sketches/rendered-thread/DESIGN.md`, copied from
`/tmp/cf-thread-sketch` with the `a-*` screenshots; its fonts load from
`gui/frontend/public/fonts`). Handoff: `rendered-threads-handoff.md` §3b.

## What landed

| Path | What |
|---|---|
| `src/api/thread.ts` | `ThreadItemView` (a discriminated union per item kind), `ThreadEventView`, `ThreadPendingView`, `watchThread`. Generated types stay here. `api/events.ts` maps the `thread` source; `api/session.ts` maps `render` and adds `readAttachment` |
| `src/stores/thread.ts` | logs per thread (`byId`, `order` by ordinal, `pending`, `seq`), `applyThreadEvent` (snapshot + seq dedupe, deltas), `startThreadWatch` (one Watch, events applied in one store update per ~frame), the EventService pending slice, fold and expand choices, narrow selectors (`useThreadItem`, `useTimelineKeys`, `useThreadPending`) |
| `src/lib/threadTimeline.ts` | turns, rows, explore groups, subagent nesting, fold, `groupLabel`, structural keys |
| `src/lib/diff.ts`, `highlight.ts`, `toolSummary.ts`, `userMessage.ts`, `threadRequest.ts` | pure helpers (all vitest-tested): line diff / structuredPatch / word marks; lowlight to line tokens, shell tokens; tool row labels, meta, chips; the stored user text read back into tags; permission suggestions and AskUserQuestion questions |
| `src/components/thread/*` | `ThreadPane` (lazy), `Timeline` (virtualized), `rows.tsx`, `ToolDetail`, `DiffView`, `Code` (`ThreadMarkdown`, `CodeBlock`), `UserBubble`, `PendingPrompt`, `ThreadComposer`, `thread.css` |
| `src/stores/threadActions.ts`, `stores/attachmentImages.ts` | send / interrupt / model / permission through the `thread.*` commands; staged images as object URLs |
| `components/pr/Markdown.tsx` | `extras` (code and image renderers) instead of a fork |
| `components/compose/CompletionCard.tsx` | `above`: the card opens over its anchor (the thread's composer sits at the pane's bottom) |
| `App.tsx` | `Content` shows the thread pane for `render === "rendered"`, connected or not |
| `stores/context.ts` | `activeSessionRendered` in the UiContext (and its key), so the palette lists `thread.*` |
| `stores/sessions.ts` | `sessionOfTerminal` never matches an empty terminal id |
| daemon | `SessionService.ReadAttachment` (staged images directly in the attachments dir only; NotFound once reaped) |
| `mock/thread.ts` | the sketch's conversation in four states, Watch / ListItems / Send / Interrupt, the `thread.*` commands, the pending-only event source, `/__mock/thread*` controls |
| `e2e/thread.spec.ts` | timeline, fold, streaming, docked permission (dark and light), question pager, send with a skill tag, interrupt, the Watch budget, palette |

## Decisions

* **Libraries.** `@tanstack/react-virtual` (already a dependency, used by the PR surface's
  `VirtualStack`) for the timeline: measured variable-height rows, keyed by row, scroll
  element owned by the pane. `lowlight` 3.3.0 (highlight.js grammars, `common` set) is the
  only new dependency: synchronous, so a streaming fenced block re-highlights on every
  frame without a flash or an async boundary (Shiki is async and needs its engine loaded
  first), and it emits class names, so the colours are the terminal palette as CSS
  variables (the sketch's choice: code looks like the terminal it replaces). The thread
  pane is lazy-loaded (`React.lazy` in `App.tsx`), so the grammars stay out of the main
  bundle. No `diff` package: a 150-line LCS diff with prefix/suffix trimming and a size
  cap covers Edit's old/new strings; Claude's `structuredPatch` is used when present (real
  line numbers).
* **The timeline is built from structure, not text.** `useTimelineKeys` selects one string
  per item (id, kind, tool name, parent, tool_use id, tool status, request state,
  streaming) with `useShallow`; text and input deltas leave it equal, so only the row
  reading that item re-renders. Rows read their own items with `useThreadItem`.
* **Turns.** A user message starts a turn (consecutive ones share it); a turn_end closes
  it. A finished turn folds unless it is the latest; the user's choice per turn wins. Folded:
  the user message, the turn's final text (the trailing text items, thinking between them
  allowed), notes (errors, compactions, command output) and the footer, which says how many
  steps are hidden. The footer ("Worked for 4m 08s · 12 steps · $1.12 · Opus") is the
  toggle. Cost is the difference from the previous turn_end's cumulative cost (or the value
  itself when the process restarted).
* **Rows.** Consecutive Read/Grep/Glob/LS fold into a group ("Read 3 files, searched code 2
  times"), absorbing thinking between them; a read waiting on a permission is never grouped.
  Consecutive thinking merges ("Thought for 9s", "Thought" when haiku streamed nothing).
  AskUserQuestion's tool call is hidden behind its question item; a permission request
  annotates its tool row (amber "waiting for you" while pending, "denied" chip); a
  permission without a tool row (auto-denied) is its own row. Subagent items nest under
  their Agent row (open by default while it runs) with the run's report under them.
* **Tense** follows the call: "Run" while it waits for permission, "Running", "Ran".
  Bash's chip is "ok" or "exit N" (parsed from Claude's "Exit code N"), with the call's
  duration (updated_at − created_at).
* **User messages** are stored as sent (the composer's tokens projected for Claude), so the
  bubble reads them back: `[Image: name; ref=path]` → green image chip with the thumbnail
  (via `ReadAttachment`), `@cf-file://repo/path` → blue file chip, `/name` → purple skill
  chip. Skills are recognised by shape (a one-segment `/word` at a word start, followed by
  whitespace or the end), so a lone `/tmp` would become a chip; a proto field for the
  composer's own tokens would remove the guess if it ever matters. Attachments the text
  does not mention show as thumbnails above the bubble.
* **Sending goes through the registry** (`thread.send`, `thread.interrupt`,
  `thread.set-model`, `thread.set-mode`, with `id` and the thread's context), like the
  new-thread composer's `session.new`. The prompt is projected exactly like the new-thread
  flow (`projectPrompt`); the attachments are staged first. Draft key `thread:<id>` in
  the compose store (no `blankDraft` change needed: thread drafts use the plain empty
  draft and ignore its model/effort/permission fields).
* **Pickers.** Model and permission switch live (`thread.set-model`, `thread.set-mode`);
  "Default" shows for an unset value. Effort is display-only (its menu says changing it is
  not available yet): Claude has no live effort switch, it needs a restart with `--resume`.
* **One Interrupt**, the composer's, shown while the thread is on a turn (busy, or waiting
  on the user mid-turn). The docked prompt has none.
* **Docked prompts render, answering is PR 3.** The permission panel shows the tool chip,
  the command (shell-highlighted) or path, the CLI's description, why it asks
  (`decision_reason`) and what "Allow for session" adds (from `suggestions_json`), with
  Allow / Allow for session / Deny. The question panel has the pager, the header chip,
  radio options and Other. Their buttons are marked `NOT WIRED YET` in
  `PendingPrompt.tsx`: a click toasts the CLI equivalent and sends nothing.
* **Disconnected rendered threads** keep their timeline (items persist and Watch works
  while disconnected); the composer becomes a "Not connected · <cause>" bar with Reconnect.
* **Sticking to the bottom.** The timeline follows new content while the user is at the
  bottom; a scroll event is the user's only when it lands above where the list last
  scrolled itself (content growing after a programmatic scroll would otherwise unpin it).
* **Status plumbing.** Rendered threads' reasons ("permission: Bash git push …",
  "question: …", "finished", "working") go through the existing `statusKind` /
  `statusLine` unchanged: the sidebar says "Needs input · Bash git push …", "Asked a
  question", "Working". The header reuses `SessionTitle` and `HeaderActions` (exported
  from `TerminalPane`).

## Gotchas

* `.cf-markdown` sets `overflow-wrap: anywhere`; inside a table cell that lets a column
  shrink to one letter ("Functio / n", seen live). Thread table cells use `break-word`.
* Virtualization means rows far from the viewport are not in the DOM; the e2e scrolls the
  timeline to reveal them (`reveal` in `thread.spec.ts`).
* react-refresh's lint rule forbids non-component exports from `.tsx` files, so the pure
  request helpers live in `lib/threadRequest.ts` and the markdown extras behind a
  `ThreadMarkdown` component.
* The streaming caret is CSS (`.cf-streaming > :last-child::after`, and inside the last
  fenced block's `code`), so the markdown is never re-parsed to insert it.
* The context now carries `activeSessionRendered`; `e2e/app.spec.ts`'s exact context
  objects gained the field.

## What PR 3 must do

* Wire `PendingPrompt.tsx`: `thread.respond` with allow / allow-session / deny (deny with a
  message; Interrupt stays the composer's), the question's answers (labels, multi-select
  joined with ", ", Other's text), Skip; keyboard 1/2/3 (and per option) while a prompt is
  docked; focus handling between the prompt and the editor.
* Effort changes (restart with `--resume`), and whether the effort picker becomes live.
* Optionally: a "jump to the prompt" in the timeline is not needed (the prompt is docked).

## Verification

* `make check` green (gofmt, vet, staticcheck, `go test -race ./...`, frontend typecheck,
  lint, vitest).
* `make gui-e2e` (WebKit + Chromium) green, including `e2e/thread.spec.ts` (22 runs).
* Live: scratch daemon from this worktree (`CODE_FOUNDRY_HOME=/tmp/cf-rt2-home
  bin/code-foundry daemon --dev`), scratch repo `~/cf-rt2-scratch` (one `stats.py` with an
  off-by-one in `spread()`), `session new --model haiku --effort low --permission
  accept-edits --render rendered --prompt "Read stats.py … use the Edit tool to fix it …
  reply with a markdown table … and a fenced python code block"`. Viewed through Vite
  (`?daemon=&token=`) in Playwright WebKit: the timeline showed Thought, the Bash `find`
  (ok, 0.7s), Read stats.py (15 lines), the Edit with Claude's structuredPatch
  (`@@ -11,4 +11,4 @@`, the `+ 1` word-marked), the table and highlighted Python; a
  follow-up typed in the GUI composer went through `thread.send`, streamed, and ended with
  its own footer while turn 1 folded. Screenshots: `/tmp/cf-rt2-shots/live-{dark,light}.png`
  and the mock states `mock-{permission,question,streaming,full}-{dark,light}.png`.

## Daemon restart

Needed: the GUI calls `SessionService.ReadAttachment` (new here) for user message images,
and everything else needs PR 1's ThreadService. An older daemon shows the thread without
image thumbnails (dashed chips).
