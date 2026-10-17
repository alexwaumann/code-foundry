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
  allowed), notes (errors, compactions, command output) and the footer. Every finished
  turn has the footer, the latest one too ("Worked for 4m 08s · 12 steps · $1.12 · Opus",
  steps = the turn's work rows, a group or Agent counting as one); it is the toggle. Cost is the difference from the previous turn_end's cumulative cost (or the value
  itself when the process restarted). (Since `thread-fold-3-header.md` that line is a header
  under the user message, at the top of the turn's work, and the copy sits on the answer.)
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
* **User messages** carry the composer's own text (`UserMessageItem.composer_text`, added
  in the review below): the bubble draws chips from its tokens only (green image chip with
  the thumbnail via `ReadAttachment`, blue file chip, purple skill chip); a message without
  it (no tags, or sent from the CLI) is plain text. Attachments the text does not mention
  show as thumbnails above the bubble.
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
  bottom; only the user unpins it (a scroll away from the bottom within 400 ms of a wheel,
  touch or scroll key, or during a scrollbar drag). Any other scroll away (the
  virtualizer adjusting for rows measured above) is followed back (review, below).
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

## Review (Fable 5.1, 2026-10-11)

Independent review of the branch after merging main (PR 1 as #62). Each fix is its own
commit with tests.

Fixed:

* **Skill chips were guessed from the projected text** (a lone `/tmp` became a purple
  chip, a skill followed by "." showed " ."). `UserMessageItem.composer_text` (stored in
  `thread_items.data` as `composer`, no migration) carries the composer's tokens; images
  point at their attachment index (`![name](cf-attachment://0)`, "x" when the chip lost its
  image). It arrives through `SendThreadMessageRequest.composer_text` (`thread.send
  --composer-text`) and, for a Create's first message, `CreateSessionRequest.
  composer_prompt` (`session.new --composer-prompt`). The GUI sends it only when it
  differs from the text (i.e. has tags); `lib/userMessage.ts` draws chips from it alone,
  and a message without it is plain text. Older items (none outside test homes) lose
  their chips.
* **The latest finished turn's footer was missing live** (`live-dark.png`). The daemon had
  emitted the turn_end (item 8 of the live thread); the row was there but under the
  composer: a scroll the virtualizer made while measuring rows above (scrollTop moved up
  by the size delta) counted as the user's and unpinned the list. Now only a scroll
  within 400 ms of wheel/touch/scroll keys, or during a scrollbar drag, unpins; any other
  scroll away from the bottom is followed back. The e2e reproduces it with a scripted
  `scrollTop -= 160` (failed before). Every finished turn's footer shows the step count
  (not only when folded); the cost delta reads the previous turn_end id carried on the
  footer row (was an O(n) `indexOf` per store update per footer).
* **A thread's markdown ate text in angle brackets**: with rehype-raw, "returns
  Result<T, E> and <Option> values" parsed `<Option>` as a tag and sanitize dropped it.
  The thread now shows HTML as text, like Claude Code's UI (raw nodes become text, then
  sanitize as before); PR bodies keep GitHub HTML. Links still go through `openUrl`.
* **Diffs**: an Edit without a structuredPatch (always the case while it waits for
  permission) showed made-up line numbers from 1; it now has none and a bare `@@`. A Write
  update with an empty patch (nothing changed) no longer shows the whole file as added.
  `replace_all` says "every occurrence" (the diff shows one). Tests for CRLF, a missing
  final newline, an empty old_string, the size cap.
* **A file edit waiting for permission** could not be expanded and the docked prompt
  shows only the path: its diff now shows, open by default.
* **Streaming cost**: a frame of N deltas copied the item map N times; now once per
  batch (`applyThreadEvents`, tested equal to one-by-one application across a resync
  snapshot). Timeline keys are cached per item object (items keep identity).
* **Memory**: every rendered thread ever opened kept all its items; only the last four
  watched threads' logs are kept.
* **Attachment thumbnails**: any fetch error was cached as "missing" for the window's
  life (a daemon restart lost every thumbnail). `readAttachment` returns null only for
  NotFound/InvalidArgument; other errors are retried on the next mount. `ReadAttachment`
  refuses files over the staging limit.
* **Light theme**: status text (waiting for you, ok/exit chips, +N, sky) used the -600
  tones, about 3:1 for amber; now -700 (≥ 4.5:1).
* Stale comment in `api/thread.ts` (the EventService thread source carries pending
  requests only); the lazy `ThreadPane` sat between imports in `App.tsx`; the mock's
  Send RPC and `thread.send` keep `composer_text`.

Checked, no change:

* Selectors are narrow (rows read their own item; the timeline reads structural keys with
  `useShallow`; the composer reads draft fields one by one). No whole-slice subscriptions.
* Watch lifecycle: one Watch for the visible rendered thread (`ThreadPane`'s effect keyed
  by session id; e2e counts streams), torn down on switch/unmount; `runStream` reconnects
  with backoff, the new snapshot replaces the log (seq dedupe after it), no duplicates
  (tested with a daemon-restart snapshot whose seq is lower).
* Rows are measured by TanStack's ResizeObserver, so growing text re-lays the list.
* Grouping: a subagent's items arriving before their Agent call show at top level and
  move under it when it arrives; nested Agents recurse.
* Draft key `thread:<id>` never collides with project (repo id) or workspace (`ws:`)
  keys and no code iterates drafts by prefix; thread drafts are not removed with their
  thread (a few bytes, object URLs of unsent images).
* `ReadAttachment`: only regular files directly in the attachments dir (Lstat), behind
  the daemon's token like every RPC.
* `activeSessionRendered` in the context key; `sessionOfTerminal` / `focusTerminal` with
  an empty terminal id; sidebar statuses ("Needs input · Bash …", "Asked a question").
* Bundle: `ThreadPane` chunk 215 kB (69 kB gzip), lowlight entirely in it; the main
  bundle has no highlight.js.
* `panel.spec.ts` drag-resize on WebKit: see Verification below.

Not fixed (and why):

* The footer's cost subtracts the previous turn_end's cumulative cost. After a Reconnect
  (a new process, its total restarting from 0) the first turn's cost is right only while
  its total is below the old process's; above it, it is understated. The items show no
  process boundary; a per-turn cost computed by the daemon (it knows the process) would
  fix it. PR 3/4.
* The footer's model is the thread's current model, not the turn's (turn_end has no
  model; Claude's result has `modelUsage`). Same follow-up.
* A streaming answer re-parses its whole markdown every frame (fine for answers of a few
  tens of kB; T3's `markdown-incremental.ts` is the reference if it shows up).
* Grep detail compiles Claude's pattern as a JS RegExp over at most 100 lines; a
  pathological pattern could stall a frame. Not seen.

What PR 3 must know:

* Wire `PendingPrompt.tsx` (NOT WIRED YET markers). A waiting Edit/Write row now shows its
  diff in the timeline; the prompt itself still shows only the path.
* Thread composers send `composer-text` / `composer-prompt` only when they differ from the
  text; anything new that sends a user message (an "edit and resend", a queue) must do the
  same through `lib/userMessage.ts sentComposerText`.
* Interrupt has no keybinding yet (Claude's TUI uses Esc); the 1/2/3 hints in the prompt
  are labels only.
* `money()` prints "<$0.01" for tiny turns; the cost per turn is a GUI subtraction (above).

Review verification:

* `make check` green. `make gui-e2e` (WebKit + Chromium, 576 tests): green apart from one
  Chromium failure in `workspaces.spec.ts` ("a single-project thread sends exactly what it
  did before": Enter before the project's refs loaded, so no `base`), unrelated to this
  branch; the test now waits for "From origin/main" (10 repeats green). The new thread
  e2e ("the latest finished turn keeps its footer in view; only the user's scroll unpins
  the list") failed before the Timeline fix and passed 32 repeats after.
* `panel.spec.ts` drag-resize (the builder's WebKit failure): not caused by this branch
  and not reproduced (full suite twice, the six drag tests 15 times each on WebKit);
  recorded in `flaky-tests.md`.
* Screenshots (mock, WebKit @2x): `/tmp/cf-rt2-shots/review-permission-{dark,light}.png`
  and `review-full-{dark,light}.png` (turn 1 unfolded, Bash / Edit / Agent rows open).
* Daemon restart needed: `composer_text` / `composer_prompt` are new fields (an older
  daemon drops them: bubbles then show plain text), and the `ReadAttachment` size cap.
