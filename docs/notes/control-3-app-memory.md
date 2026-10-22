# App memory (2026-10-22)

Standing preferences the user states about Code Foundry and how the model inside it
behaves ("don't open the side panel on your own", "always open PRs as drafts", "explain
git terms when you use them"). Claude Code's own memory is keyed by directory, so it
fragments across worktrees and does not cover the app; a user asked for preferences that
reach every thread in every project before its first action. Daemon, CLI and the help
skill; no GUI.

## Shape

* **Storage**: `<CODE_FOUNDRY_HOME>/memory.md` (`paths.Memory()`), plain markdown, one
  `- <text>` line per entry and nothing else. At most 40 entries and 4096 bytes (the
  rendered file); an add past either fails with FailedPrecondition naming the cap ("it
  holds at most 40 entries and has 40; remove one first", "... at most 4096 bytes (4 KiB)
  and would have N with this entry ..."). A missing file is an empty memory; removing the
  last entry or `memory clear` deletes the file.
* **Store**: `internal/store/memory`, a mutex and the file. Writes go to a temp file
  beside it (0600), then a rename, so a spawn reading it sees the old or the new file.
  No snapshot or bus events: nothing in the GUI shows it yet.
* **Verbs** (`internal/command/commands_memory.go`, category Settings, so the help skill's
  `reference/commands.md` lists them in full; all `NoKeybinding`):
  * `memory show`: numbered lines; `--json` `{"entries":[{"index":1,"text":"..."}]}`
    (an empty list, not null).
  * `memory add <text>`: trims; empty, a lone `-` and multi-line text are argument
    errors. Text already there (case-insensitive) is a no-op: "already remembered as #2:
    ... (nothing changed)", `{"entry":{...},"added":false}`.
  * `memory remove <entry>`: digits are a 1-based index (out of range: an argument error
    naming the range); anything else is a case-insensitive substring that must match one
    entry. Several matches: an argument error listing them with their numbers; none:
    NotFound. No confirmation.
  * `memory clear`: Confirm, so `--yes` from the CLI.
  * add, remove and clear end with "(applies to threads started from now on)".
* **Injection**: `thread.Options.Memory` (the daemon passes `memory.Store.Texts`) is read
  in `claudeCommand`, so at every spawn: create, start on send, fork, effort restart,
  reseed. `systemPrompt(workspaceLine, memory, threadAppend)` puts the block after
  ThreadPrompt and the workspace line, before the thread's own append (a reseed's or
  Ember's seed), separated by a blank line:

  ```
  The user's standing preferences for code-foundry, kept with `code-foundry memory.*` (they apply here before any other instruction about the app):
  - Never open the side panel on your own
  - Always open PRs as drafts
  ```

  No entries: the prompt is byte-for-byte what it was. A read error is logged (WARN) and
  the thread starts without the block.
* **Help skill**: a "Remembering preferences" section (15 lines; SKILL.md 109 of its 120
  lines): check `reference/settings.md` first and offer a setting when one covers it;
  otherwise `memory add` in the user's words without asking, confirm in one line, say it
  applies to threads started from now on (and follow it in this thread); remove a
  contradicted entry first; `memory show` for "what do you remember". The description
  (387 of 400 characters) now names standing preferences, so the skill fires on one: a
  preference is not a how-to question.

## Decisions

* **The store is a file, not a table.** The brief asked for a plain file; it also lets a
  user read it at a glance. Hand edits are tolerated on read (any non-blank line is an
  entry, a leading `- ` stripped) but the CLI is the supported path.
* **The thread store does not import the memory store**: it takes a function, like
  `BranchNaming`, so stores stay independent and tests pass a closure.
* **Duplicates compare case-insensitively** after trimming; the first spelling is kept.
* **The remove arg is named `entry`**, not `n`: it takes a number or text, and the usage
  line `memory.remove <entry>` says so.
* **Ember gets the memory too**: its resident thread spawns through the same path. The
  block sits before its seed, so the seed still comes last.

## Gotchas

* Claude records the append prompt on a conversation's first request and reuses it until
  compaction (agent-skills.md), so an existing thread keeps the preferences it started
  with even across its own restarts; hence "threads started from now on". The help skill
  tells the agent to follow a new preference in its own thread by hand.
* In the e2e, Haiku 5.5 saved the preference without reading `reference/settings.md`
  first (no setting covered it, so the outcome was right); whether smaller models skip
  the settings check when one does apply was not tested.

## End to end (2026-10-22, isolated home)

`make build`; `CODE_FOUNDRY_HOME=/tmp/cf-mem bin/code-foundry daemon --dev` with the
branch's `bin` first on `PATH` and no `CLAUDE*`/`CODE_FOUNDRY_*` variables.

```
$ code-foundry memory show
No preferences remembered. Add one with: code-foundry memory add "<preference>"
$ code-foundry memory add "Never open the side panel on your own"
remembered #1: Never open the side panel on your own; applies to threads started from now on
$ code-foundry memory add "always open prs as drafts"        (after adding "Always open PRs as drafts")
already remembered as #2: Always open PRs as drafts (nothing changed)
$ code-foundry memory remove o
code-foundry memory.remove: "o" is in 3 entries; give the number of one:
  1. Never open the side panel on your own
  2. Always open PRs as drafts
  3. Begin every reply with the word Ahoy
exit 2
$ code-foundry memory remove 9
code-foundry memory.remove: there is no entry 9: the entries are 1 to 3          exit 2
$ code-foundry memory clear
code-foundry memory.clear: Forget every remembered preference? Threads started from now on get none.
Re-run with --yes to confirm.                                                     exit 2
$ code-foundry memory show --json
{"entries":[{"index":1,"text":"Never open the side panel on your own"},{"index":2,"text":"Always open PRs as drafts"},{"index":3,"text":"Begin every reply with the word Ahoy"}]}
$ ls -l /tmp/cf-mem/memory.md
.rw------- 107 /tmp/cf-mem/memory.md
```

(The applies note was then moved into parentheses: "remembered #1: ... (applies to
threads started from now on)", which reads better after an entry ending in a period.)

A thread (no project, `claude-haiku-5-5[1m]`, medium):

```
$ code-foundry thread new --no-project --model 'claude-haiku-5-5[1m]' --effort medium --name "memory e2e" \
    --prompt "In one sentence: what standing preferences about code-foundry do you have in your instructions?"
# daemon log, "thread spawned" argv:
… --append-system-prompt This thread runs inside code-foundry. … for read-only research.\n\nThe user's standing preferences for code-foundry, kept with `code-foundry memory.*` (they apply here before any other instruction about the app):\n- Never open the side panel on your own\n- Always open PRs as drafts\n- Begin every reply with the word Ahoy
#3 claude: Ahoy! My instructions list three standing code-foundry preferences: never open the side panel on my own, always open PRs as drafts, and begin every reply with t…
$ code-foundry thread send --id s-be3dc4083aa3 "From now on, whenever you mention a pull request, also give its number." --wait
#7 tool Skill [done] {"skill":"code-foundry-help","args":"Remember this standing preference: …"}
#9 tool Bash [done] {"command":"code-foundry memory add \"Whenever you mention a pull request, also give its number.\""}
#10 claude: Ahoy! I saved that preference to code-foundry memory (#4): … It applies to threads started from now …
```

No WARN or ERROR lines in the daemon log. The daemon was stopped, and the thread, its
transcript and `/tmp/cf-mem` deleted.

## Follow-ups

* A Settings section in the GUI showing the memory (list, remove, clear) is wanted later.

## Daemon restart

Needed: new commands, and the spawn path reads the memory.
