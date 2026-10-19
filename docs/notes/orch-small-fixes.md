# Orchestration small fixes (2026-10-19)

Four small fixes from the 2026-10-18 Haiku 5.5 orchestration experiment (report
REPORT.md B4, B9, C8, C11; e4 F4; w2d friction 7). Skill text is left to its own PR.

## What shipped

| Part | Where |
|---|---|
| The daemon puts `dirname($CODE_FOUNDRY_BIN)` in front of its own PATH (when set and not already an entry), after the env scrubbing; every Claude process, terminal, action run and plugin inherits it | `internal/daemon/env.go` (`addCLIToPath`, `pathWithCLIDir`), `daemon.go`; `paths.EnvBin` |
| `thread new --prompt` and `thread send <text>` take `@file` and `-` (stdin), like `thread report --data` | `internal/command/commands_thread{,_lifecycle}.go` (`FileOrStdin`), `cmd/code-foundry/argsource.go` |
| A thread whose busy turn (or pending request) an archive cuts off is IDLE `archived`, not ERROR `interrupted` | `internal/store/thread/archive.go`, `thread.go` (`ReasonArchived`), proto comment |
| The budget stop's note now reads "Code Foundry stopped this turn: the spending limit of $X was reached; nothing was rejected by the user. Raise it with `code-foundry thread budget`, then send a message to continue." | `internal/store/thread/budget.go` |

## Decisions

* **PATH via the daemon's own environment**, not `threadEnv`: thread spawns
  (`prependPath(..., os.Getenv("PATH"))`), terminals (`os.Environ()`), action runs and
  plugins all start from it, so one `os.Setenv` covers them all. Same place as the
  scrubbing, before any store starts a process. A relative `CODE_FOUNDRY_BIN` (the GUI's
  `../bin/code-foundry` fallback) is made absolute; symlinks are not resolved (the link's
  directory is what PATH lookup needs).
* **`@file` with spaces**: a prompt may begin with a Claude Code file mention
  (`"@main.go explain this"`). readArgSource now takes a value with whitespace that names
  no file as given; a value without whitespace still errors when the file is missing (a
  typo in `--prompt @/tmp/p.md` must not send the path as the prompt). `@README.md`
  alone sends the file's contents; that is the documented meaning.
* **Guide is at its cap.** Main's guide was 28,996 bytes of the 29,000 cap
  (`internal/guide/guide_test.go`). The arg descriptions carry the `@file` / `-` wording
  ("(@file: from a file, -: stdin)", the guide prints Thread args in full), paid for by
  shortening `--prompt` ("The first message") and `--data`; no Conventions line. The
  guide is now 28,999 bytes: the next addition needs a trim or a cap decision.
* **Archive status**: Archive reads whether the thread was already ERROR `interrupted`
  before its Close; only a status the close itself produced becomes IDLE `archived`
  (`thread list` prints `idle` plus the `[archived]` mark; `thread wait`/`get` print
  `idle (archived)`). Snooze and remove close the same way and still show `interrupted`;
  snooze could reuse this if it matters.

## Budget stop: what Claude sees (C8 / F4) — investigated, not fixable cleanly

The child reads the budget interrupt as a user rejection because that text is Claude
Code's own, not ours. Probed against Claude Code 2.1.302 in stream-json mode (Haiku 5.5,
scripts outside the repo):

* Plain `{"subtype":"interrupt"}` during a running Bash call: the tool_result is
  `The user doesn't want to proceed with this tool use. The tool use was rejected … STOP
  what you are doing and wait for the user to tell you how to proceed.` plus "[Request
  interrupted by user for tool use]". Reproduces F4.
* The interrupt request has an `@internal` `reason` field ("forwarded to the turn's
  AbortSignal.reason"), and the tool runner picks a neutral text for reason `turn-abort`
  ("[Tool call did not complete … Nothing refused it; re-run it if still needed.]"). Sent
  with `reason: "turn-abort"`, the transcript still got the rejection text: this path
  does not forward it. Not usable (and internal).
* A pending `can_use_tool` (supervised threads) answered with `deny` + our message +
  `interrupt: true`: Claude Code replaces the message with the same rejection text.
  Deny without `interrupt` followed by an interrupt: same. So a synthetic deny does not
  help either, and auto-mode threads have no pending request to deny anyway.
* Daemon notes (`KindNote`) live in Code Foundry's timeline only; Claude never sees them.
  The only way to put words in Claude's context is a user message, which costs a turn
  (or rides on the next message). Per the brief, none is sent; the note now says what
  happened for the user, the GUI and orchestrators reading `thread read`.

If it matters later: prefixing the *next* user message after a budget stop with one line
("Code Foundry stopped your last turn at the spending limit; nothing was rejected") would
cost no extra turn. Deliberately not done here.

## End to end (2026-10-19)

Daemon run as `/tmp/orchfix-bin/code-foundry daemon` with `CODE_FOUNDRY_HOME=/tmp/orchfix-home`
and the normal PATH (no `code-foundry` on it: `which -a code-foundry` → not found);
Haiku 5.5 medium; scratch project `~/cf-exp-scratch/orchfix-todo`.

```
daemon.log: "msg":"put the CLI's directory on PATH","dir":"/tmp/orchfix-bin"

$ code-foundry thread new --project orchfix-todo --name "PATH smoke" --created-by= --prompt @/tmp/orchfix-scripts/prompt.md
created thread PATH smoke (s-23c2b20d927b) in /Users/alex/cf-exp-scratch/orchfix-todo
$ code-foundry thread read s-23c2b20d927b
#1 you: This is a smoke test of the "code-foundry" CLI from inside a thread. Do NOT edit any files. …
#3 tool Bash [done] {"command":"command -v code-foundry", …}
    → /tmp/orchfix-bin/code-foundry
#4 tool Bash [done] {"command":"code-foundry thread get \"$CODE_FOUNDRY_THREAD\"", …}
    → thread PATH smoke (s-23c2b20d927b) …
#5 claude: - `command -v code-foundry` — exit 0 — `/tmp/orchfix-bin/code-foundry` …
```

The prompt file (double quotes, `$(subshell)`, single quotes, several lines) arrived
byte for byte in item #1 (`thread read --json`).

```
$ echo "Run exactly this Bash command in the foreground … perl -e '…60)'" | code-foundry thread send --id s-23c2b20d927b -
sent to thread s-23c2b20d927b
#8 tool Bash [running] {"command":"perl -e 'select(undef,undef,undef,60)'", …}
$ code-foundry thread archive --id s-23c2b20d927b --yes
$ code-foundry thread list --all
s-23c2b20d927b  idle  PATH smoke  orchfix-todo@main  2s  [archived]
$ code-foundry thread wait s-23c2b20d927b --for 5s
thread s-23c2b20d927b PATH smoke: idle (archived), disconnected

$ code-foundry thread new … --budget 0.001 --prompt @/tmp/orchfix-scripts/budget-prompt.md
$ code-foundry thread wait s-fb87f679d009 --for 2m
thread s-fb87f679d009 Budget stop: needs attention (budget reached)
#2 tool Bash: output "The user doesn't want to proceed with this tool use. …"   (Claude Code's text, see above)
#3 note: Code Foundry stopped this turn: the spending limit of $0.001 was reached; nothing was rejected by the user. …
```

## Gotchas

* Claude Code blocks a foreground `sleep N; …` in Bash ("use Monitor"); probes that need
  a long-running tool use `perl -e 'select(undef,undef,undef,N)'`.
