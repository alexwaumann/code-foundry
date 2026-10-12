# Rendered threads, PR 3: interaction

Status: done on branch `t3code/rendered-threads-3-interaction` (on top of PR 2, merged to
main as #63; main merged in). Design: `rendered-threads-handoff.md` §3b and
`docs/sketches/rendered-thread/DESIGN.md` (variant A: prompts dock into the composer card,
numbered 1/2/3, one Interrupt, the composer's). Earlier PRs: `rendered-threads-1-daemon.md`,
`rendered-threads-2-gui.md`.

## What landed

### Daemon

* **`ThreadService.SetEffort` / `thread.set-effort <effort>`** (`internal/store/session/effort.go`).
  Claude has no `set_effort`, so the runner restarts the process with `--resume` and the
  new `--effort`. The thread stays **connected** throughout: the same runner closes the old
  process's stdin (it exits once idle; SIGTERM/SIGKILL after `CloseTimeout` via the close
  timers), starts the new one with the row's current launch (model, permission mode,
  workspace members, attachments dir), and handshakes again. Items, viewers, transcript
  tailing and usage carry on. When it is up, the timeline gets a `command_output` item
  "Set effort to <level>" (like Claude's own "Set model to …").
  * When: at once if idle; otherwise after the running turn, once nothing would be lost
    (idle at the prompt, nothing pending, streaming or running: a background agent's tool
    call keeps running across turns and holds the restart off, no RunIn move in flight).
  * `Session.effort_pending` (proto 32, not persisted, cleared on any disconnect) is true
    until the new process answered the handshake; `effort` is the new level at once, so a
    later Reconnect uses it either way. Setting the running effort back while busy cancels.
  * A send during a restart is **held** and goes to the new process once it is up (the
    reply waits for it). A close during a restart cancels it; a held send then fails.
  * Resumes the conversation Claude is on (the tailer's id, which follows `/clear`); before
    any message there is no transcript, so the original launch is reused.
  * `Interrupt` / `SetModel` / `SetPermissionMode` read the current Conn under
    `streamState.connMu` (a restart replaces it on the runner goroutine).
* **Deny messages read like Claude Code's own** (`project.go denyMessage`). The CLI passes a
  deny's `message` through as the tool result verbatim, so: no reason → "The user doesn't
  want to proceed with this tool use. The tool use was rejected (…). STOP what you are
  doing and wait for the user to tell you how to proceed."; with a reason → "… To tell you
  how to proceed, the user said:\n<reason>"; a question → "The user declined to answer the
  questions." (+ " They said:\n<reason>"). The texts are the 2.1.296 binary's. The item keeps
  the user's reason as typed. No `interrupt` on a deny: the composer's Interrupt is the one
  stop (§3b); Claude stops on its own after the plain rejection and carries on after a reason.
* **Skip (AskUserQuestion)** is a deny: Claude Code's TUI renders its own Esc on the
  question as "User declined to answer questions". Live, haiku carried on without asking again.
  (Review: the question text above was not the binary's; a skip now sends the plain
  rejection. See "Review" below.)
* **Claude's own mode switches are recorded** (`stream.go onModeChange`): `system/status`
  with `permissionMode` updates the row's mode. Seen live: "Allow for session" on a Write
  applies Claude's `setMode acceptEdits` suggestion, and the picker now says Accept edits.
* `thread.interrupt` binds **Escape** (Claude Code's key). The GUI gates it (below).

### GUI

| Path | What |
|---|---|
| `components/thread/PendingPrompt.tsx` | `PendingPrompts`: every pending request, oldest first, stacked in the composer card (scrolls past ~520px). Permission: the CLI's `title` or our question, tool chip, subagent chip, the mode hint (right), command/path box, an Edit/Write's `+N −M` with the diff on demand, the description, what "Allow for session" adds (rules, or "switches the thread to Accept edits" for a `setMode` suggestion), `decision_reason` / `blocked_path` when they say more than the hint. Deny opens an inline reason field (Enter denies, Esc cancels, empty allowed). Question: pager, header chip, radios or checkboxes (multi-select), Other with its own text, Back / Next / Submit, Skip |
| `lib/threadRequest.ts` | pure: `pickOption`, `answerOf` / `answersOf` (labels; multi-select in option order then Other, joined ", "; Other's text as the label), `permissionChoices`, `promptKey` (keyboard routing), `modeHint`, `suggestedMode`, `suggestionCount`. Vitest |
| `stores/threadActions.ts` | `respondThread` (thread.respond with `request`, `decision`, `answer` JSON, `message`; quiet), `setThreadEffort`, `interruptThread` now quiet (the footer says "Interrupted") |
| `stores/thread.ts` | `answering` + `useOpenRequests`: an answered prompt leaves at once and comes back when the answer fails (the failure toasts) |
| `ThreadComposer.tsx` | the stack, the editor's keys to the oldest prompt, Escape interrupts, the live effort picker and its hint |
| `keys/bindings.ts` | `chordFires`: a command chord without cmd/ctrl/alt (Escape) fires only inside `[data-region="content"]` and outside `[data-keys-local]`; `chordGuards` (thread.interrupt: the active thread is rendered, connected, busy and nothing pending) |

Keyboard (`promptKey`, table-tested):

* Permission: **1** Allow, **2** Allow for session (or Deny when Claude suggested nothing),
  **3** Deny (opens the reason; Enter sends). Esc in the prompt returns focus to the editor.
* Question: digits pick (single-select replaces, multi-select toggles; the last number is
  Other and focuses its field), **Enter** goes to the next question / submits (nothing until
  the current one has an answer), **Esc** skips.
* From the editor: only while it is **empty** (text or images), digits and Enter go to the
  oldest prompt; never Escape. A digit typed into a message stays in it.
* **Escape interrupts** a running turn from the empty editor (ThreadComposer's `onEscape`)
  or anywhere else in the thread pane (the global `thread.interrupt` binding; the pane is
  focusable now, `tabIndex=-1`), only when nothing is pending and there is no text to lose.
  It lists as "Esc" in the palette / Shortcuts like any binding.
* Focus: answering returns focus to the editor; a clicked prompt keeps keys while focused
  (an amber left edge shows it).

Effort picker: live (Low … Max). While busy: "Effort changes to Max after this turn" under
the editor; idle: "Restarting Claude with Max effort…" for the second the restart takes.

Sidebar and bell: unchanged code. The daemon's status ("permission: Write notes.txt",
"question: …") already drives "Needs input · Write notes.txt" / "Asked a question" and the
bell's count; answering acknowledges, and an open Watch makes "finished" seen at once
(checked live and in the mock e2e).

### Mock daemon

`mock/thread.ts`: `thread.respond` and `ThreadService.Respond` resolve like the daemon
(once nothing is pending: an allowed tool finishes and Claude streams a reply, a denied one
makes Claude answer the reason, answers are echoed, a skipped question gets "No problem…");
`thread.set-effort` / `SetEffort` (at once after 300 ms when idle, else at the turn's end,
`effortPending` meanwhile). New states `parallel` (an Edit and a Bash permission at once)
and `multi` (a multi-select question); `POST /__mock/thread/fail-respond` fails the next
answer. The mock's `thread.*` args now default `id` from the context like the daemon's
(an arg with a context default is listed as not required), so chords invoke them without
prompting.

## Gotchas

* **A bare-key binding must not fire everywhere.** The window's capture-phase handler runs
  before any element's own handler, so a global Escape would have stolen Escape from
  popovers, lists and the docked prompts. Hence `chordFires` (content pane only, not in
  `[data-keys-local]`) and the guard. `ValidateBinding` still refuses bare keys for user
  overrides; built-in bindings are only normalized.
* The mock listed `id` as required, so a chord opened the palette to prompt for it (the
  daemon lists context-defaulted args as optional). Fixed in the mock.
* A question's Other is a radio/checkbox too (accessibility), so PR 2's "3 radios" became 4.
* `load()` in the mock now bumps the generation: a scripted reply from a previous load
  otherwise finished the new conversation's turn (and cancelled its prompt).
* The live Write's `permission_suggestions` is `setMode acceptEdits`, not a rule: "Allow
  for session" switches the thread's mode. The description Claude sends for a Write is the
  file name (hidden when it repeats the path box); option descriptions equal to the label
  are hidden.
* The claudestream API changed under this branch (PR 2's review: `can_use_tool` arrives as
  an event, answered with `req.Answer`); the restart only swaps the Conn and its event
  channel, so nothing else changed.

## Verification

* `make check` green. New Go tests: `effort_test.go` (idle restart with `--resume`, the
  rest of the launch kept, a send held across it, the note before it, the row after close;
  busy deferral, cancel by setting it back, restart after the allow; refusals; `denyMessage`
  table; Claude's mode switch), the deny wire message in `TestRenderedDenyAndSubagent`, API
  `SetEffort`, `thread.set-effort` command. Vitest: `lib/threadRequest.test.ts`,
  `keys/bindings.test.ts` (bare-key routing).
* `make gui-e2e` green, including `e2e/thread-prompts.spec.ts` (deny with reason and the
  question panels in dark and light; allow + sidebar + bell; keyboard 1/2/3 and Esc; a failed
  answer; parallel prompts with the Edit's diff; question keyboard and skip; Escape
  interrupt from the editor and the timeline, not with text; the Esc binding in the palette;
  effort while busy and idle), 3 repeats on both engines.
* Live (scratch daemon `CODE_FOUNDRY_HOME=/tmp/cf-rt3-home` from this worktree, repo
  `~/cf-rt3-scratch`, `session new --model haiku --effort low --permission supervised
  --render rendered`, GUI through Vite + Playwright WebKit):
  * Write notes.txt → Allow clicked → file written, "Created notes.txt …", footer.
  * Bash `mkdir -p build && touch build/out.txt` → Deny from the empty editor's 3 with the
    reason "Don't create directories here. Just tell me in one sentence what the command
    would have done." → no `build/`, the tool result is Claude Code's rejection text with the
    reason, Claude answered with the sentence.
  * AskUserQuestion with a single-select (Color) and a multi-select (Fruits): 3, Enter, 1, 3,
    Other "Mango", Enter → answers `Blue` / `Apple, Cherry, Mango`; Claude: "You prefer Blue,
    and you like Apple and Cherry, plus Mango, which wasn't one of the listed options."
  * Effort → Medium while streaming 300 numbers: "Effort changes to Medium after this turn";
    Escape in the empty editor interrupted the turn ("Interrupted after 2.8s"); the daemon log
    shows `restarting claude for an effort change from=low to=medium` then `claude restarted
    … argv=[claude -p … --resume 01cad62f-… --model haiku --effort medium --permission-mode
    manual …]`; "Set effort to medium" in the timeline; the next turn ("Blue.") recorded
    `"effort":"medium"` in the transcript. `thread set-effort high` while idle restarted at once.
  * Unwatched "finished" became "at prompt" when the GUI opened the thread.
  * Allow for session on a Write switched the row to accept edits (daemon log "claude
    switched the permission mode").
  * Screenshots in `/tmp/cf-rt3-shots/`: `live-permission-{dark,light}` (Write with its diff
    open), `live-bash-permission-dark`, `live-deny-reason-dark`, `live-denied-dark`,
    `live-question-single-{dark,light}`, `live-question-multi-{dark,light}`,
    `live-answered-dark`, `live-effort-pending-dark`, `live-effort-applied-dark` (each with a
    `-card` crop), and the mock panels in `mock/` (`permission`, `deny-reason`, `question`,
    `question-multi`, dark and light).

## Daemon restart

Needed: `SetEffort`, `effort_pending`, the deny texts and the mode following are daemon
changes. An older daemon refuses `thread.set-effort` (unknown command) and the picker's
change fails with a toast.

## Left for PR 4

* The composer's render-mode toggle and the `sessions.render` setting UI (opt-in), polish.
* The footer's per-turn cost after a restart (Reconnect or effort): Claude's cumulative
  cost may or may not restart with the process (seen growing across an effort restart),
  the PR 2 subtraction caveat still applies.
* A prompt from a subagent shows a "subagent" chip only; which Agent asked is not linked.
* No queue UI for sends during a busy turn (decision 6), unchanged.

## Review (independent, 2026-10-12)

Read the diff against main, the handoff, PR 1/2 notes and the 2.1.296 binary's strings;
fixed what follows (commits `a31136c`, `1cc5ce3`, the set-effort message, this note).

### Fixed

* **The question deny text was not Claude Code's.** "The user declined to answer the
  questions." is not in the 2.1.296 binary. "User declined to answer questions" is only
  the TUI's *rendering* of a rejected AskUserQuestion (its rejected-message component);
  the TUI's Esc rejects the tool use like any other, so Claude reads the generic
  rejection. `denyMessage(reason)` now uses the same two texts for permissions and
  questions (`rejectStop`, or `rejectWithReason` + the reason; both verified verbatim in
  the binary). Consequence: a skipped question makes Claude STOP and wait, as in the TUI
  (the builder saw haiku carry on with the invented text). The other binary string,
  "The user did not answer the questions.", is the tool result of an *allow* with no
  answers, not of a skip.
* **Allow-for-session grants were lost by an effort restart.** Claude keeps session
  rules and directories in process memory; `--resume` does not bring them back, so after
  an effort change the same command prompted again. The runner now records the
  suggestions of every allow-for-session answer (`grants`: `addRules`/`replaceRules`
  allow → `--allowedTools`, deny → `--disallowedTools`, `addDirectories` → `--add-dir`;
  `setMode` needs nothing, the row follows the mode) and the respawn passes them. One
  `--allowedTools` followed by the rules (the CLI's variadic form). Checked with the real
  CLI: `claude -p --permission-mode manual --allowedTools "Bash(mkdir -p sub)" "Bash(touch
  sub/a.txt)"` ran both commands without a denial (without the flag: 1 denial), so a
  rule with spaces in its parentheses parses. Live through the daemon: allow for session
  on `mkdir -p rvw/a`, set-effort medium, respawn argv `… --permission-mode acceptEdits
  --add-dir …/rvw --allowedTools Bash(mkdir -p rvw/a)`, the repeat ran without a prompt
  (that suggestion's rule was `localSettings`, which Claude also writes to disk, so the
  live repeat alone does not prove the flag; the CLI check above does).
* **Interrupt / SetModel / SetPermissionMode during the restart gap** went to the old
  Conn (stdin closed: an opaque write error) or to the new one before its handshake (a
  model or mode change could be lost). `streamState.connection()` now refuses them with
  FailedPrecondition "Claude is restarting for an effort change; try again in a moment"
  while `swapping` (set under `connMu` from the restart's start to the handshake, cleared
  on close/failure). Respond in the gap finds nothing (NotFound), as before.
* **A held send whose caller gave up** (its ctx done: the RPC timed out or the client
  went away) was still delivered after the restart, so a GUI retry would duplicate it.
  `threadCmd.ctx` is now carried and checked when the held sends go out.
* **Answering a request Claude withdrew.** If the respond won the race with the cancel
  event, the item was marked allowed/denied though Claude had withdrawn it. `respond` now
  checks `req.Answer`'s `ErrCancelled`: the item becomes "withdrawn by Claude" and the
  call is NotFound. GUI: `respondThread` treats NotFound as expected (`runCommandForResult`
  `expected`): no error toast, a plain "Claude no longer needs that answer" notice (one
  per request id), and the prompt stays gone instead of coming back.
* **`onInitialized` after a close** (the handshake answered while closing) set
  `r.state = StateConnected`; it now returns early.
* **The respawn** dropped stale `st.pending` / `sd.pending` from the old process.
* **Keyboard.** While the deny reason is open, 1/2 from the empty editor (or the prompt)
  no longer allow; 3 returns to the field; Escape on the prompt cancels the reason.
  Enter/Space on a focused action button (Back, Skip, Cancel, Show the change) is the
  button's own: before, Enter on a focused Skip submitted the question (or did nothing,
  its click prevented). Prompts are `role="group"` with an aria-label.
* **`thread.set-effort`'s message** said "after this turn" for a finished-but-unseen
  thread (needs attention "finished"), which restarts at once. `onTurn` (table test):
  busy, or needs attention for a permission or question.
* Mock: `CommandError` moved to `mock/errors.ts` (thread.ts throws it without an import
  cycle); a missing request is NotFound like the daemon's; `fail-respond?withdrawn=1`;
  `POST /__mock/thread/stream?text=` starts a streaming text item (re-renders while a
  prompt is open).

### Checked, no change

* **Restart races** (table test `TestRenderedSetEffortGap`, the fake lingering 400 ms
  after stdin closes so every call lands in the gap): a held send reaches the new process
  exactly once and never the old one (per-pid stdin logs, `CF_FAKE_CLAUDE_LOG.<pid>`);
  a send given up on is not delivered nor in the timeline; interrupt/model/mode refused,
  respond NotFound, nothing recorded; close fails the held send, row closed with the new
  effort; daemon shutdown fails the held send, the reopened daemon shows daemon-stopped
  with `effort` new and `effort_pending` false, Reconnect spawns `--resume … --effort
  high`; the new process crashing (`CF_FAKE_CLAUDE_RESUME_EXIT=3`) fails the held send,
  disconnects "crashed" with exit 3, its stderr as `LastError`, an error item "…before
  answering the initialize handshake", no "Set effort" note.
* **Persistence across a daemon restart** is deterministic: `Effort` is written at
  SetEffort, `EffortPending` is never persisted and `finish` clears it, so a change that
  had not restarted Claude yet is applied by the next spawn (Reconnect or fork; Fork
  builds a fresh row from the parent's `Effort`). Documented in `effort.go`.
* **Respawn argv** (`TestRenderedSetEffortRespawnArgv`): identical to the first spawn's
  except `--session-id` → `--resume <same id>`, `--effort`, and the grants; no `--`, no
  positional prompt. Model and mode come from the row, which follows SetModel /
  SetPermissionMode / Claude's own mode switches.
* **Transcript and `/clear` tracking** follow the new process: `r.pid()` reads
  `st.proc` (replaced on the run goroutine), the tailer keeps the resumed id (and
  `pidSessionID` would follow a changed one).
* **Mode tracking**: `system/status` frames carry `permissionMode` only on a change (none
  in the fixtures' status frames), so a "Claude's default" row is not rewritten by routine
  frames. SetPermissionMode still refuses anything but supervised/accept-edits/auto.
* **Answers format**: question text → label, multi-select labels in option order then
  Other's trimmed text, joined ", " (sdk-tools.d.ts `answers: {[question]: string}`);
  the daemon only checks each question has a non-blank answer and passes the map as
  `updatedInput.answers`. Empty submit is disabled (and Enter is a no-op) until each page
  has an answer; Other alone with blank text is no answer.
* **Keyboard routing**: the global handler skips editable targets and the palette, and a
  bare-key chord only fires inside `[data-region="content"]` outside `[data-keys-local]`
  (popovers are portaled out of the pane), so Escape is never handled twice; the editor's
  capture handler only takes keys whose target is the contenteditable while it is empty.
  Terminal threads: the guard is false (not rendered) and xterm's own branch never yields
  a bare Escape, so nothing changed for them; the sidebar/bell e2e still passes.
* **Paging state** lives in `QuestionPrompt` keyed by request id; e2e streams a reply into
  the timeline while page 2 is open and checks the page and both picks survive.

### Not fixed

* A failed answer brings the prompt back with fresh state (a question's picks are lost);
  rare, and the remount is the simple way to show the restored prompt.
* `answering` keeps answered request ids for the window's life (a few strings per answer;
  ids are unique UUIDs, so nothing reappears hidden).
* The ErrCancelled branch of `respond` (the respond handled before the cancel event) is
  not reachable deterministically with the fake; the outward behaviour (NotFound, item
  withdrawn) is tested through an interrupt (`TestRenderedRespondToWithdrawnRequest`; the
  fake now withdraws on `interrupt` like Claude).
* A background Agent that keeps running holds an effort change off until it ends
  (documented by the builder); no timeout.

### Verification

`make check` green (Go `-race`, vitest 1824 including the new `threadActions.test.ts`), `make
gui-e2e` green (582 passed, 24 skipped), `e2e/thread-prompts.spec.ts` 2 repeats on both engines with three new
tests (withdrawn answer, fields keep their keys + Enter on Skip + open reason ignores
1/2, paging across streaming). Screenshots (mock, WebKit) in `/tmp/cf-rt3-shots/review-*`
(`permission`, `deny-reason`, `question`, `question-multi`, dark and light, each with a
`-card` crop). Daemon restart needed (respond, restart and command changes).
