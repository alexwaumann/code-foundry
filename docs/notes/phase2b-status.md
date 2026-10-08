# Phase 2b: Claude status detection

Status: package done; wiring into the session store is 2a's job. `make check` is green.
The package is `internal/claudestatus`. It is pure Go (no cgo) and has no dependencies
outside the standard library. Every signal below was checked against real captures of
Claude Code 2.1.294 (`internal/claudestatus/testdata`, catalogue in its README).

## Usage (for 2a)

```go
det := claudestatus.New(screenFn) // screenFn: plain text of the terminal's visible screen
// actor observer: det.Output(chunk) | transcript tailer: det.Transcript(line)
// 1 s ticker (NOT on the actor goroutine): det.Tick(now) | Write path: det.Input(data)
st, why := det.Status() // Busy / Idle / NeedsAttention / Unknown + "permission: Do you want to proceed?"
```

* `screenFn` returns the plain-text screen, rows joined by `'\n'` (libghostty
  `FormatterFormatPlain` on the actor; scrollback above it is harmless because only the
  bottom 80 rows are read). It is called only from `Tick`, without the detector's lock
  held, and only when the screen may have changed and the title cannot decide (never
  while the title says busy). Tick must not run on the actor goroutine, or a `screenFn`
  that calls into the actor would deadlock. `TestTickDoesNotHoldLockDuringScreen`
  covers the other direction: `Output` arriving while `screenFn` runs.
* `Input(data)` should be called for user input (the session store's `Write`). It
  acknowledges unseen output, so "finished" clears when the user types. Without it,
  "finished" stays until the next turn starts.
* `Acknowledge()` is for the GUI (2c): call it when the session's terminal is shown.
* `Snapshot()` returns the raw signals (title, screen classification, pending tools,
  turn state, notification, ...). `Snapshot().Screen.Dialog == claudestatus.DialogTrust`
  is how 2a can find the trust dialog if it answers it from the output stream.
* `WithClock` is for tests.

Beyond the agreed `StatusDetector` interface, `*Detector` adds `Input`, `Acknowledge`,
`Snapshot`, and variadic options on `New` (`claudestatus.New(fn)` still compiles).

## Signals (evidence from the fixtures)

| Signal | Source | Observed | Used for |
|---|---|---|---|
| Title glyph | OSC 0 | `✳ <task>` at the prompt; while a request is in flight, `◐ <task>` and `◑ <task>` alternate every ~960 ms, including during tool runs (`long-tool`: 8 s of Bash). Switches to `✳` within one 250 ms screen sample of a dialog being drawn (`permission` 7559 / dialog 7756; `question` 5381 / 5504; `plan` 13474 / 13505) and at turn end. | Primary busy signal. `✳` is treated as authoritative "not busy". |
| Title text | OSC 0 | `Claude Code`, then the AI title (`Multiplying 17 by 23`), then the session name (`add-subtract-function`). | Busy reason only. |
| Title cleared | OSC 0 `""` | On `/exit` (and SIGHUP) Claude clears the title and leaves the alt screen within ~20 ms. | No title + no prompt → Unknown. |
| Body spinner | screen | `✳ Wandering…`, `✻ Thinking…`, `✻ Ruminating… (12s · ↓ 566 tokens)` above the prompt box. Not visible while text streams in fullscreen (`interrupt`). Finished row: `✻ Brewed for 4s · done 1:59 AM`. | Busy fallback when there is no usable title. |
| "esc to interrupt" | screen | Does not appear in 2.1.294. | Legacy fallback only. |
| Prompt box | screen | Rule, `❯ <input>`, rule. Hidden whenever a dialog is up (every dialog fixture). The placeholder (`Try "fix lint errors"`) and prompt suggestions (`commit this`, `which ls`) are plain text, indistinguishable from typed input. | At-prompt evidence; its absence + an open turn means "waiting on the user". |
| Permission dialog | screen | `Bash command` … `Do you want to proceed?` / `❯ 1. Yes` … `4. No` / `Esc to cancel · Tab to amend`. Redrawn (63 B) every 500 ms. | `NeedsAttention "permission: …"` |
| Question (AskUserQuestion) | screen | `☐ Color` / `Which color do you prefer?` / `❯ 1. Red` / `Chat about this` / `Enter to select · ↑/↓ to navigate · Esc to cancel`. No output while waiting. | `"question: …"` |
| Plan approval | screen | `Ready to code?` … `Would you like to proceed?` / `❯ 1. Yes, and use auto mode`. | `"plan: …"` |
| Trust dialog | screen | Primary screen, no title, no transcript: `Quick safety check` … `❯ No, exit` / `Yes, I trust this folder` / `Enter to confirm · Esc to cancel`. Default selection is **No**. | `"trust: …"` |
| Turn start | transcript | `type:user`, string content, 180–200 ms after Enter. | Turn open. |
| Tool calls | transcript | Auto-approved tools: `tool_use` and `tool_result` written in the same ms. Permission prompt: `assistant stop_reason=tool_use` written ~120 ms after the title turns `✳`, no result until approved. Long tool: `tool_use` 9176, `tool_result` 14200. | Busy reason (`running Bash`); "waiting for approval" without a screen. |
| AskUserQuestion / ExitPlanMode | transcript | **Nothing is written while the question/plan is shown**; `tool_use` + `tool_result` land together after the answer. | Only inferable: open turn + `✳` + no prompt box. |
| Turn end | transcript | `assistant stop_reason=end_turn` (or `stop_sequence`) then `system subtype=turn_duration`, 116–150 ms after the title turns `✳`. | Decide right away instead of waiting for a screen read. |
| API error | transcript | `isApiErrorMessage:true, error:"model_not_found", stop_reason:"stop_sequence"`; shown inline above the prompt (no modal). | `"error: model_not_found"` |
| Interrupt | transcript | Ctrl-C while streaming: partial assistant (`stop_reason:null`) + `user "[Request interrupted by user]"` with `interruptedMessageId`. "No" on a permission prompt: `tool_result is_error` + `"[Request interrupted by user for tool use]"` + `turn_duration`. Ctrl-C while thinking (`inline-renderer`): **no record at all**. | Turn end + acknowledge (the user is present). |
| Notifications | OSC 9 / 99 / 777, BEL | None with the daemon's env (`TERM=xterm-256color`, no `TERM_PROGRAM`): Claude's "auto" channel resolves to "no method". With `TERM_PROGRAM=ghostty`: `OSC 777;notify;Claude Code;Claude needs your permission`, 6 s after the dialog appeared. No BEL in any capture. | Attention hint (the 60 s "waiting for your input" reminder is ignored). |
| Progress / program status | OSC 9;4, OSC 7501 | Not emitted in either configuration. | Supported if they appear (busy / blocked / idle). |
| Output rate | stream | Busy: 6–16 chunks/s (the body spinner animates at ~10 Hz). At the prompt: ~0. Permission dialog: 2/s. Question: 0. | Busy fallback: ≥5 chunks/s with an open turn and no usable title. |
| Alt screen | `?1049h/l` | Fullscreen TUI: on ~15 ms after the first title. Inline renderer: never. | Snapshot only. |
| Bracketed paste | `?2004h/l` | Toggled at startup and exit only. | Snapshot only. |
| Synchronized output | `?2026h/l` | Brackets every frame. | Not used. |

## State machine

```
  Idle ───────────┐  busy evidence                 evidence stops, then settle:
  NeedsAttention ─┼─────────────────► Busy ──────► fresh screen read ≥300 ms later,  ──► resting status
  Unknown ────────┘  (spinner title;               or ✳ title + transcript turn end,     (rules below)
                      fallbacks below)             or 2 s
  NeedsAttention finished / error / notification ── Input or Acknowledge ──► Idle
  NeedsAttention <dialog> ── dialog gone from the screen (next Tick) ──► resting status
  any known status ── no prompt and no title for ≥1 s ──► Unknown
```

Busy evidence: a spinner title that changed within 3 s. Without a usable title: OSC
7501 `state=working`, OSC 9;4 progress, the body spinner on a screen read within 2 s, or
an open transcript turn with ≥5 output chunks in the last second.

When not busy (and past the settle step), the resting status is the first match:

1. A dialog on a screen read after the work stopped → `NeedsAttention "<kind>: <question>"`
   (trust, plan, permission, question, continue, menu).
2. OSC 7501 `state=blocked` → `NeedsAttention "blocked: …"`.
3. Transcript turn open and no prompt box visible: hold the current status for 1.5 s
   (grace), then `NeedsAttention "waiting for approval: <Tool>"` if a `tool_use` is
   unresolved, else `"waiting for input"`. Covers dialogs the screen classifier does not
   know, and works without a screen.
4. A notification since the last acknowledgement and since the work stopped (not the
   idle reminder) → `NeedsAttention "notification: …"`; a BEL likewise → `"bell"`.
5. Prompt box visible, or title `✳`, or OSC 7501 idle/done: if Claude produced output
   after the last acknowledgement (a spinner title change, an assistant record, or
   fallback busy evidence more than 1 s after the input) → `NeedsAttention "finished"`
   (or `"error: <code>"`); otherwise `Idle "at prompt"`.
6. Otherwise `Unknown`, but only after it has persisted for 1 s (the blank frame between
   the trust dialog and the UI would otherwise flap).

Hysteresis, all from the fixtures: the title spinner is stale after 3 s without a change
(it changes every ~960 ms); after busy evidence stops, a stale pre-turn screen (which
shows a prompt box) is never used, so a permission dialog is never reported as Idle
first; the open-turn rule waits 1.5 s for the transcript's turn-end record (which trails
the title by ≤150 ms).

## Detection timing (replays, Tick every 1 s)

`fixture_test.go` replays every fixture with Tick offsets 0/250/500/750 ms and asserts
each transition happens no earlier than its evidence and within 200 ms (stream,
transcript, or input driven) or 1.35 s (screen driven). Offset-0 numbers:

| Transition | Evidence → detected | Delay |
|---|---|---|
| Idle → Busy | spinner title (`text` 4384, all fixtures) | 0 ms (on the Output call) |
| Busy → NeedsAttention "finished" | title `✳` → transcript `turn_duration` | 116–150 ms (`text` 117, `permission` 122, `question` 150, `long-tool` 146) |
| Busy → NeedsAttention "error" | title `✳` 3547 → error record 3675 | 128 ms |
| Busy → Idle (Ctrl-C while streaming) | title `✳` 8276 → interrupt record 8413 | 137 ms |
| Busy → Idle (Ctrl-C while thinking, no record) | title `✳` 24591 → next Tick 25000 | 409 ms (≤1.3 s) |
| Busy → NeedsAttention "permission" | dialog drawn 7756 → Tick 8000 | 244 ms (`ghostty-notify` 495, `inline-renderer` 1137) |
| Busy → NeedsAttention "question" | 5504 → 6000 | 496 ms |
| Busy → NeedsAttention "plan" | 13505 → 14000 | 495 ms |
| Unknown → NeedsAttention "trust" | 254 → 1000 | 746 ms (first Tick after startup) |
| NeedsAttention "finished" → Idle | Input | 0 ms |
| NeedsAttention dialog → Busy | spinner title after the answer | 0 ms |
| NeedsAttention dialog → Idle (denied / trust accepted) | dialog gone → next Tick | ≤1 s |
| Idle → Unknown (exit) | title cleared → Tick + 1 s hold | ≤2.35 s |

## Degradation (asserted in `TestFixtureDegraded`)

| Missing | Effect |
|---|---|
| Title (e.g. `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`) | Busy from transcript + output rate (~400 ms later), dialogs and turn ends a Tick later. Same sequences except one: Ctrl-C while thinking without a transcript record reads as "finished". |
| Transcript | Turn ends wait for a screen read (≤1 s later); API errors read as "finished". Everything else unchanged. |
| Screen | Permission → `"waiting for approval: Bash"`, question/plan → `"waiting for input"` (after 1.5 s grace). The trust dialog is invisible (no title, no transcript yet). Ctrl-C while thinking with no transcript record reads as `"waiting for input"`. |
| Input calls | "finished" persists until the next turn. |

## Fixture catalogue

See `internal/claudestatus/testdata/README.md`: `trust`, `text`, `permission`,
`question`, `plan`, `interrupt`, `api-error`, `long-tool`, `ghostty-notify`,
`inline-renderer`. 68 KB gzipped in total.

## Cost (M3 Pro)

| Benchmark | Time |
|---|---|
| `Output`, 64 KiB of real Claude output (dense CUP/SGR/sync, titles) | ~60 µs (~1 GB/s) |
| `Output`, 64 KiB plain text | 1.4 µs |
| `Output`, one spinner frame (~40 B) | 70 ns, 0 allocs |
| `ClassifyScreen`, 120x40 permission dialog | 14 µs |
| `ClassifyScreen`, 10k rows of scrollback | 9 µs (reads only the last 80 rows) |
| `Transcript`, tool_use line | 1.8 µs |
| `Transcript`, 50 KB attachment | 38 µs (skipped without decoding) |

`Output` never renders and never runs a regex: escape sequences are found with
`bytes.IndexByte`, only OSC payloads, DEC private modes, and BELs are looked at, and the
state carries across chunk boundaries (tested by splitting a stream at every pair of
positions).

## Known blind spots

* **Typed input vs placeholder.** Plain text cannot tell the dimmed placeholder or
  prompt suggestion from typed input, so "the user typed" comes from `Input`, not from
  the screen.
* **Questions and plan approvals leave no transcript trace while open.** Without a
  screen they are only inferred ("waiting for input").
* **Ctrl-C while thinking writes nothing to the transcript.** The prompt box on the
  screen resolves it; without a screen it reads as "waiting for input".
* **User-opened menus** (`/model`, `/resume`, `/config` lists with `❯ 1.` options or
  "Esc to cancel") classify as `NeedsAttention "menu: …"`.
* **Not captured:** subagent (Task) permission prompts, auto-compaction, usage-limit
  menus, "Press Enter to continue" screens (login flows), MCP auth prompts. The
  classifier has generic rules for them (`continue`, `menu`, open turn + no prompt), but
  they are untested against real output.
* **Narrow terminals.** A rule needs ≥10 `─`; below ~30 columns detection degrades to
  the title and transcript.
* **Background work** (a background Bash finishing and waking Claude) produces a turn
  without user input; it ends as "finished", which is intended.

## Capture recipe and gotchas

* The recorder was a throwaway program using `terminal.New` + `Create` + `Attach`, which
  replayed the output into its own libghostty terminal to sample the plain screen every
  250 ms, and tailed the transcript (`claude --session-id <uuid>` makes the file name
  known: `~/.claude/projects/-private-tmp-cf2b-scratch/<uuid>.jsonl`; `/tmp` resolves to
  `/private/tmp` in the slug). It had to live inside the module (an uncommitted
  `_capture/` directory, deleted afterwards) because Go's internal-package rule forbids
  importing `internal/store/terminal` from `/tmp`.
* Inherited `CLAUDE*` / `AI_AGENT` variables were removed with bare keys in `Spec.Env`.
* Accepting the trust dialog for `/private/tmp/cf2b-scratch` added a project entry to
  `~/.claude.json` (left in place).
* The user's settings shape the UI: `tui: fullscreen` (alt screen), `editorMode: vim`
  (`-- INSERT --`; Esc leaves insert mode instead of interrupting), status line script,
  `defaultMode: auto` (no permission prompts, so those fixtures pass
  `--permission-mode default`). `--settings '{"tui":"default"}'` gives the inline
  renderer; with `tui` unset, 2.1.294 appears to default to fullscreen (read from the
  bundled JS, not tested).
* To stay clear of paste detection, the driver wrote the prompt text, waited 700 ms,
  then wrote `\r` separately.
