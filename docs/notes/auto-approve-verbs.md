# The daemon answers Claude's ask for Code Foundry verbs

A user on a managed machine was asked for permission in an auto thread when the agent ran
`code-foundry` commands. Every thread gets six verbs as `--allowedTools`, but a managed
settings file with `allowManagedPermissionRulesOnly` makes Claude ignore them, so a rule
cannot help there. The daemon already receives each ask (`runner.onAsk`), so it answers.

## What was built

- `Command.AgentSafe`, `ArgSpec.AgentAsk` and `ArgSpec.AgentOK` classify every verb in the
  registry. A read-only verb counts too. A new verb asks until it is classified:
  `agent_test.go` pins the list, and `validate` refuses `AgentSafe` with `Confirm`.
- `Registry.ApprovedVerb` is the matcher. `shellWords` is its tokenizer, and it lists what
  is safe rather than what is dangerous. The CLI resolves verbs with the same
  `ResolveVerb`, so what is approved is what runs. `command.LocalVerbs` covers the CLI's
  own verbs, and a test in `cmd/code-foundry` keeps it equal to the CLI's table.
- `thread.Options.ApprovedVerb` carries it into the store: `command` imports `thread`, so
  the store cannot import the registry. The daemon makes the registry before the stores.
  It is empty until `all.Register`, and an empty registry approves nothing.
- `runner.approvedVerb` decides who gets it, on the mode at the request: an auto thread the
  whole list, every other mode the six `ProtocolVerbs`. Nothing wider goes in
  `--allowedTools`: a spawn flag outlives a mode switch.

## Decisions beyond the brief

- **A request something decided stays with the user** (`PermissionRequest.AskedOnPurpose`).
  The matcher sees only the command, but the request says why Claude asks. Only
  `decision_reason_type` "other" or none goes on. `rule`, `classifier`, `safetyCheck`,
  `hook`, `subcommandResults`, an unknown type, any `decision_reason_code`, a
  `matched_ask_rule`, `server_policy_ask_only`, `classifier_approvable: false`, a blocked
  path and `requires_user_interaction` all ask. Without this the daemon would overrule an
  administrator's explicit ask rule.
- **Bash input fields are a list** (`bashInputs`): `dangerouslyDisableSandbox` asks, and so
  does a field a later Claude adds.
- **`@path` and `-` values ask**, on any word. The CLI reads the file or stdin into the
  value, past Claude's own checks on reading a file. No guide or skill recommends it.
- **`terminal.new --run` asks** beside `--argv`: it types a command into the shell.
- **`thread.new --no-project` asks**: an auto thread with its cwd in `$HOME`.
- **`--permission` stays approved for `supervised` and `auto` only.** No value is broader
  than auto in scope, but accept edits runs edits and file commands with no classifier.
  `--like` and `thread.fork` copy a mode the user already gave a thread, so they do not ask.
- **Double quotes hold plain text only** (letters, digits, `_-./:,+=@%`, spaces). `$`, `` ` ``
  and `\` are live there, and the rest is kept out so one rule covers a double quote. So
  `"Fix it; then report"` asks and `'Fix it; then report'` does not. The guide says so.
- **Verb words must be bare**: `code-foundry 'thread' list` would run the same verb, but
  nothing writes it that way.
- **`--context-*` flags ask**: an agent's thread comes from its environment.
- **Global flags before the verb ask** rather than resolve: the CLI has only `--version`,
  `--help` and `--update` there.

## What Claude does (2.1.316)

Measured with real sessions on Sonnet 5.5 medium:

- **The classifier can deny outright, with no `can_use_tool`.** A hard deny rule produced
  `system/permission_denied` (`decision_reason_type: classifier`) and no request. The daemon
  sees it after the fact and cannot overrule it. This was already rendered as an auto-denied
  item. With a working classifier, an allow makes no request either: on first-party auto
  mode every command ran with no ask at all, `action add` included. So on such a machine
  `action add` is not asked about, by Claude's decision, whatever this list says.
- An ordinary ask reads `decision_reason: "This command requires approval"`, type `other`.
- An ask rule reads `decision_reason_type: rule` with `decision_reason_rule_source`.
- A pipe reads `subcommandResults`.
- With auto mode disabled by policy, Claude starts in auto, then reports `default` in a
  status frame, and the row turns supervised. So only the six verbs apply, which is right.

From the binary, not measured: on a third-party provider such as Bedrock the server
classifier is off (`third_party_switch_off`), and an interactive session then falls back to
an ask marked `personOnly`, `hooksMayAllow: false`, `defaultToNo`, with type `other` and the
reason "Auto mode can't check actions in this session, so this one needs your approval".
That may be what the report was, more than the ignored rules. `personOnly` is not on the
wire, so the daemon cannot tell it from an ordinary ask, and it answers it. Claude means a
person to take that decision; here the user's list takes it. `claude asks` now logs the
reason type and code, so `daemon.log` on such a machine will show what really arrives.

## How it was verified

`CLAUDE_CODE_MANAGED_SETTINGS_PATH` is compiled out of the release binary, so a scratch
managed file is not read (a managed deny rule had no effect), and the system path needs
root. The real flag was not tested. Instead a throwaway `claude` wrapper did what the flag
does: it dropped `--allowedTools`. To get a real ask on an auto row it started Claude in
`manual` while the daemon believed auto. Real Claude, real frames, a scratch
`CODE_FOUNDRY_HOME`:

- Auto: `thread list` and `action run build --wait` answered by the daemon with no request
  item; `action add` and `thread list | head -1` asked.
- Supervised: `thread list` answered, `action list` asked.
- A real auto session with an ask rule on `code-foundry action:*`: `action run` asked.
- A live switch from auto to supervised: `action run` went from answered to asking.

## Gotchas

- The daemon scrubs `CLAUDE_CODE_*` from its environment, so a test harness cannot pass
  those through it: use a wrapper on `PATH`.
- A mutation that leaves a variable unused fails the build, which prints no `--- FAIL`.
