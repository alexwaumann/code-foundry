# Slash commands in the composer, PR 1 of 2: the daemon

Update 2026-10-15 (`thread-lifecycle.md`): the list is kept and persisted while the thread is
stopped (migration 0021), and the next handshake replaces it.

Status: built on branch `t3code/composer-slash-command-shortlist`. `make check` green;
exercised end to end with an isolated daemon, the CLI and a haiku thread (below). PR 2
(the GUI's "/" card reading this instead of `FilesystemService.ListSkills` for a running
thread) follows. Background: `rendered-threads-followups.md` §5,
`rendered-threads-handoff.md` §2.

## What was built

* **`internal/claudestream`** (`commands.go`): `SlashCommand {Name, Description,
  ArgumentHint, Aliases, Builtin}`; `InitializeResponse.Commands` decodes the handshake's
  list; `*CommandsChanged` is `system/commands_changed` (the whole new list).
  Fixture `testdata/commands.jsonl`.
* **Session store.** `slashdeny.go`: the deny table (below), `DeniedSlashCommand(name,
  description) (SlashDenial, bool)`, and the send guard (`refusedSlashCommand`,
  `SlashRefusal`). `slashcommands.go`: the filtered list is cached in memory on the
  thread's log (`threadLog.commands`), never persisted:
  * set from the initialize reply (`onInitialized`, also after an effort restart's
    handshake), replaced by every `commands_changed` push, dropped (nil) in `runner.finish`
    (exit, crash, close, daemon stop, a failed restart);
  * `ItemsSnapshot.Commands` carries it; a change is a `SlashCommandsChanged{SessionID,
    Seq, Commands}` thread event in the log's seq order, published only when the list
    differs (an effort restart's identical list publishes nothing);
  * the handshake's answer and the event stream reach the runner on different channels,
    so a push can be handled before the reply that preceded it on stdout: once a process
    pushed (`streamState.commandsPushed`, reset on respawn), its handshake list is
    ignored;
  * `Store.SlashCommands(id)`: the cache; nil when not running; ErrNotFound for an
    unknown thread.
  * `visibleSlashCommands`: one row per name (when rows share a name, the built-in one,
    since `/name` runs it; else the first), minus the denied built-ins, in Claude's order.
* **Proto** (`thread.proto`): `SlashCommand {name, description, argument_hint, aliases,
  builtin}`; `ThreadItemsSnapshot.commands = 6`; `ThreadEvent.commands = 8`
  (`ThreadSlashCommandsChange {session_id, seq, commands}`, Watch only, empty when the
  process ended); `ThreadService.SlashCommands(SlashCommandsRequest{session_id}) →
  SlashCommandsResponse{commands}` (empty when not running). `Send`'s comment documents
  the refusal. Handlers: `internal/api/thread_commands.go`.
* **Command** `thread.commands --id` (`commands_slash.go`, `SlashBackend` embedded in
  `ThreadBackend`, `hasSession` like `thread.mcp`): "N slash commands", then a NAME, ARGS,
  DESCRIPTION table (description's first line, 100 runes); `--json` is the list
  (`[{name, description, argumentHint, aliases?, builtin}]`, `[]` when not running).

## The deny table (Alex, 2026-10-13)

A deny list, not an allow list: everything Claude reports shows unless denied. Only rows
Claude marks `builtin` are checked: skills and user, project and plugin commands are never
denied, even with a name in the table.

| Reason | Commands | Send guard |
| --- | --- | --- |
| replaced by the app's UI (`SlashReplaced`) | model, effort, fast, mcp, rename, clear | refused |
| terminal-only / meaningless over stream-json (`SlashTerminalOnly`) | color, focus, heapdump, config, output-style, debug, doctor, import, autocompact, reload-plugins, reload-skills, `__remote-workflow`, workflow-launch-exec, auto-mode-setup, design-consent, design-revoke, usage-credits, team-onboarding | no |
| retired (`SlashRetired`) | agents, extra-usage, and any description starting "(removed)" or "Renamed to" | no |

Of Claude Code 2.1.296's 68 commands on Alex's machine, 26 are denied (6 + 18 + 2) and 42
offered (skills, compact, context, usage, code-review, ultrareview, simplify,
security-review, verify, batch, goal, advisor, loop, schedule, skill-doctor, list-agents,
insights, recap, init, design, design-sync, the bundled and `anthropic-skills:` skills).
Kept but worth knowing: `design` (consent | revoke) is not denied although design-consent
and design-revoke are.

## Send guard (Alex via the coordinator, 2026-10-13)

`Manager.Send` (ThreadService.Send: the composer and `thread.send`) refuses a message whose
first non-blank line's first word is `/` + a replaced command: case-sensitive, the name
ends at whitespace or the line's end (`/clearly`, `/model-review`, `/Clear`, a `/clear`
on a later line all go through). Nothing is sent to Claude and no item is recorded. The
error is `*SlashRefusal` (an `ErrInvalidArgument`) whose text is only the table entry's
`Refusal`, so the Connect error is INVALID_ARGUMENT with exactly this message:

| Typed | Error message |
| --- | --- |
| `/clear`, `/reset`, `/new` | Start a new thread instead of clearing this one. |
| `/model` | Change the model with the composer's model selector (or `thread.set-model`), not /model. |
| `/effort` | Change the effort with the composer's effort selector (or `thread.set-effort`), not /effort. |
| `/fast` | Pick the model with the composer's model selector (or `thread.set-model`), not /fast. |
| `/mcp` | Manage MCP servers in the MCP panel (or `thread.mcp`), not /mcp. |
| `/rename`, `/name` | Rename the thread with Rename Thread (or `session.rename`), not /rename. |

Aliases: Claude 2.1.296 runs `/reset` and `/new` as clear and `/name` as rename
(`slashReplacedAliases`, kept by hand next to the table). An alias is guarded unless the
thread offers a command by that name (a user skill called `new` runs before the alias).
The first prompt of `session.new --prompt` does not go through Send and is not guarded.
Terminal-only and retired commands are not guarded: Claude answers them itself.

## commands_changed (probed 2026-10-13, Claude Code 2.1.296, haiku)

* The push carries the **whole new list** (`{"type":"system","subtype":"commands_changed",
  "commands":[…],"uuid","session_id"}`): the daemon replaces its copy; nothing to re-ask.
  The SDK's types say the same ("Clients should REPLACE their cached command list").
* It fired for (a) a skill written to the repo's `.claude/skills` while idle, about 2 s
  later with no request (Claude watches the skill directories), (b) a skill in
  `sub/.claude/skills` discovered mid-turn when the agent read a file under `sub/`, and
  (c) `reload_skills` (whose own reply is `{"skills": […]}`, skills only).
* A second `initialize` on a live process is accepted and returns the current list (also
  70 after the pushes), so a re-ask exists if ever needed; the daemon does not use it.
* An effort restart re-initializes: the new process's list replaces the cache.
* Project skills' descriptions get " (project)" appended by Claude.

## Gotchas

* Rows can share a name (SDK: "/name runs the built-in row"); `deep-research` (built-in)
  and `anthropic-skills:deep-research` (plugin) are different names and both show. The
  daemon dedupes by name so the GUI can key rows by name.
* A skill shadowed by a denied built-in disappears with it: `/debug` would run Claude's
  debug, not the skill.
* An unknown slash command (`/clearly`) is sent to the model like any text (haiku answered
  "`/clearly` isn't installed in this session" and spent a turn).
* `make check` and `make build` started together race on building libghostty-vt; run one
  at a time.

## For the GUI PR

* Field names (TS): `ThreadItemsSnapshot.commands`, `ThreadEvent.event.case ===
  "commands"` with `value: ThreadSlashCommandsChange {sessionId, seq, commands}`, and
  `SlashCommand {name, description, argumentHint, aliases, builtin}`; the cold read is
  `ThreadService.SlashCommands({sessionId})`.
* Order is Claude's: skills from `.claude/skills` first (the project's, seen live), then
  its built-ins and bundled skills, then plugin skills. Not sorted; the GUI's fuzzy filter ranks.
* Empty means not running (or no handshake yet): fall back to ListSkills.
* `description` can be a skill's whole multi-sentence description: truncate in the card.
* A refused send is INVALID_ARGUMENT with the sentence above as the message: show it inline
  under the composer and keep the text.

## Verification

* `make check` green. Tests: `claudestream/commands_test.go` (fixture: 68-entry reply, two
  pushes; parse table), `session/slashcommands_test.go` (deny table, visible filter table,
  fixture counts 42 and 44, log publish-on-change incl. nil vs empty, push-before-handshake
  ordering, refusal matcher table: leading whitespace and blank lines, tab, CRLF,
  multi-line, `/clearly`, `/model-review`, case, paths, aliases and an offered alias;
  through the fake Claude: handshake list + event seq, refused `/clear` writes nothing and
  records no item, a turn's push, effort restart, close drops it, unknown thread),
  `api/thread_commands_test.go` (mapping, RPC, Watch snapshot + push + drop events, the
  refusal's code and bare message), `command/commands_slash_test.go`. The fake Claude
  answers initialize with `CF_FAKE_CLAUDE_COMMANDS`'s list.
* **Live**: `CODE_FOUNDRY_HOME=/tmp/cf-slash-home ./bin/code-foundry daemon --dev`, repo
  `~/.cf-probe/slash` (has an `alpha-probe` project skill), `session new --model haiku
  --effort medium --permission supervised --name slash-probe` (no prompt). `thread
  commands` listed 43 (the 42 plus `/alpha-probe` first); writing
  `.claude/skills/gamma-probe/SKILL.md` made it 44 about 2 s later with no turn; `--json`
  is a list (`usage` with `aliases: ["cost","stats"]`, `builtin: true`); `thread send`
  of `/clear`, `/model opus`, `  /effort high`, `/rename x`, `/mcp`, `/fast`, `/reset`
  printed the refusals above and recorded nothing, `/clearly` went to Claude; after
  `thread set-effort low` (restart) still 44; after `session close` "no slash commands:
  the thread is not running (reconnect it first)" and `[]`; unknown id → NotFound.
