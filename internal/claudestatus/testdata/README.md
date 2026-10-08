# Status-detection fixtures

Real Claude Code sessions (2.1.294, macOS, 2026-10-08), recorded through
`internal/store/terminal` at 120x40 with a throwaway driver (not committed; the recipe is
in `docs/notes/phase2b-status.md`). Claude ran in a scratch git repo
(`/private/tmp/cf2b-scratch`, two tiny files) with the user's own settings: fullscreen
TUI, vim editor mode, model "Fable 5.1", default permission mode "auto" unless noted.

Each file is gzipped JSON Lines (`gzip -dc text.jsonl.gz | jq -c .`). One record per
line, in capture order:

| `k` | `d` |
|---|---|
| `out` | One PTY output chunk as delivered by `Attach`. Stored as a JSON string, so bytes of a UTF-8 sequence split across two chunks became U+FFFD at capture time. |
| `in` | Bytes the driver wrote to the PTY (the user's keystrokes). |
| `jsonl` | One new line of `~/.claude/projects/<slug>/<session>.jsonl`, as soon as it appeared (polled every 50 ms). |
| `screen` | The plain-text screen (libghostty formatter, `FormatterFormatPlain`), sampled every 250 ms and recorded when it changed. |
| `note` | The driver step that ran at this time (`write "..."`, `wait ...`). Informational. |
| `exit` | The process exited with this code. |

`t` is milliseconds since the terminal was created.

Sanitization and trimming:

* Transcript records keep only what the detector reads: `type`, `subtype`, `isSidechain`,
  `isMeta`, `isApiErrorMessage`, `error`, `interruptedMessageId`, `origin`,
  `promptSource`, `durationMs`, and `message.{role, stop_reason, content}`, with content
  reduced to block types, tool names/ids, and text truncated to 120 characters. Other
  record types (`attachment`, `mode`, `permission-mode`, `atis-latch`,
  `file-history-snapshot`, `file-history-delta`, `last-prompt`, `ai-title`,
  `agent-name`, `cost-state`) are kept as `{"type": ...}` stubs, in place.
* Screens: trailing spaces stripped, runs of blank lines collapsed to one.
* `/Users/<name>` replaced with `/Users/user`.
* Gaps longer than 4 s between records were shortened to 4 s (idle waits only).

## Catalogue

| Fixture | Flags / env | What happens (ms are fixture times) |
|---|---|---|
| `trust` | first run in an untrusted dir | Trust dialog on the primary screen ("Quick safety check ... ❯ No, exit / Yes, I trust this folder", default **No**) at 254; driver presses ↓ then Enter at 2358; fullscreen UI and title `✳ Claude Code` at 2703; `/exit`. No transcript (it starts with the first prompt). |
| `text` | | Idle at the prompt; "What is 17*23? ..." submitted at 4317; title spinner `◐/◑` from 4384; body spinner `✳ Wandering…`; answer; title `✳` at 8928, `end_turn` + `turn_duration` at 9045; `/exit`. |
| `permission` | `--permission-mode default` | `touch hello.txt` via Bash. Title `✳` at 7559, permission dialog ("Bash command ... Do you want to proceed? ❯ 1. Yes / 2. ... / 4. No · Esc to cancel · Tab to amend") drawn at 7756, `assistant stop_reason=tool_use` written at 7681 (no `tool_result`). A 63-byte redraw every 500 ms while the dialog is open. Enter at 13579; `tool_result`; done at 15004. |
| `question` | | AskUserQuestion red/blue. Title `✳` at 5381, question UI ("☐ Color / Which color do you prefer? / ❯ 1. Red ... / Enter to select · ↑/↓ to navigate · Esc to cancel") at 5504. **Nothing in the transcript** until the answer at 13424, when `tool_use` and `tool_result` land together. Silent (no output) while waiting. |
| `plan` | `--permission-mode plan` | Plan for `subtract()`; three auto-approved tools (tool_use + tool_result written together); ExitPlanMode approval ("Ready to code? ... Would you like to proceed? ❯ 1. Yes, and use auto mode") at 13505, again with nothing in the transcript until approved at 17559; then implementation in auto mode; done at 26673. Title changes from the AI title to the session name (`add-subtract-function`) mid-turn. |
| `interrupt` | | 60-line poem; Ctrl-C at 8266 while streaming; title `✳` at 8276; partial `assistant` (stop_reason null) + `user "[Request interrupted by user]"` with `interruptedMessageId` at 8413; screen shows "⎿ Interrupted · What should Claude do instead?". |
| `api-error` | `--model claude-bogus-9-9` | Synthetic `assistant` with `isApiErrorMessage: true`, `error: "model_not_found"`, `stop_reason: "stop_sequence"`, then `turn_duration`. Shown inline above the prompt; no modal. |
| `long-tool` | | `sleep 8 && echo finished` via Bash in auto mode. `tool_use` written at 9176, `tool_result` at 14200; the title keeps spinning (and output keeps flowing at ~13 chunks/s) for the whole tool run. |
| `ghostty-notify` | `TERM_PROGRAM=ghostty`, `--permission-mode default` | Same permission flow; Claude emits `OSC 777;notify;Claude Code;Claude needs your permission` at 11256, **6 s after** the dialog appeared. Then a 12-line poem; Esc at 23292 only leaves vim insert mode (`-- INSERT --` disappears), it does not interrupt. Trimmed before a `/exit` typed in vim normal mode. |
| `inline-renderer` | `--settings '{"tui":"default"}'`, `--permission-mode default` | Non-fullscreen (inline) renderer on the primary screen; the plain text includes scrollback. Text turn; Bash permission denied with `4` (`tool_result is_error`, `"[Request interrupted by user for tool use]"`, `turn_duration`); a poem interrupted with Ctrl-C **while thinking**: no transcript record at all, the prompt text is restored into the input box. Trimmed before the driver's `/exit` got appended to that restored text. |

The expected status timeline for each fixture is in `fixture_test.go`.
