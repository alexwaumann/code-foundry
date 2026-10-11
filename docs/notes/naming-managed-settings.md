# Auto-naming under managed settings

Status: done on branch. `make check` is green. Exercised end to end against Claude Code
2.1.296 with an isolated daemon (`CODE_FOUNDRY_HOME=/tmp/naming-pr`), haiku threads in a
scratch repo, once with the real `claude` and once with a wrapper that refuses the
hardened flags the way a managed machine does.

## Root cause

The naming call was
`claude -p --model haiku --no-session-persistence --tools "" --strict-mcp-config <prompt>`.
On Alex's work laptop every call failed, so no thread was ever auto-named. Claude refuses
`--strict-mcp-config` outright when an enterprise MCP config (`managed-mcp.json` in
`/Library/Application Support/ClaudeCode`) is present. It writes this to stderr and exits 1:

    You cannot use --strict-mcp-config when an enterprise MCP config is present

The wording comes from the 2.1.296 binary (`strings`). I could not reproduce it locally:
the managed directory is root-owned and is read by every Claude session on the machine,
and `CLAUDE_CODE_MANAGED_SETTINGS_PATH` and the hidden `--managed-settings` flag had no
effect from the CLI. Other flag refusals in the same binary:

* `You cannot dynamically configure MCP servers when an enterprise MCP config is present`
  (a non-empty `--mcp-config`)
* `--mcp-config is disabled by your organization's managed settings (disableSideloadFlags). …`
  (also `--plugin-dir`, `--plugin-url`, `--agents`)
* `error: unknown option '--x'` (commander's message, for a Claude too old for a flag)

## Decisions

**`--safe-mode` replaces `--strict-mcp-config`.** Measured: with `--tools ""` alone, the
naming call still listed eight `mcp__claude_ai_*` connector tools. So "no tools in /tmp"
was not enough, and MCP isolation still matters. `--safe-mode` starts with no user
customizations: no MCP servers (user, project, claude.ai connectors), hooks, CLAUDE.md,
skills or plugins. Admin-managed settings still apply, so an organization's managed MCP
servers stay, and that is their call. With `--safe-mode --tools ""` the model reported
no tools, in 1.8 s. No managed setting gates `--safe-mode` (no `disableSafeMode` or
similar in the binary). An empty `--mcp-config` would not help: without
`--strict-mcp-config` the user's servers still load.

**`--tools ""` stays.** It is the important hardening (no built-in tools, so a first
message cannot make the call act), and no managed setting refuses it.

**The prompt now follows `--`.** `--tools` is variadic. Without `--strict-mcp-config`
after it, `--tools "" <prompt>` swallowed the prompt as a tool name ("Input must be
provided either through stdin or as a prompt argument when using --print"). Removing
the flag without adding `--` would have broken naming everywhere.

**Fallback.** When the hardened call fails with an error `isFlagRefused` recognises,
the namer retries once with
`claude -p --model haiku --no-session-persistence -- <prompt>`.
After that, every later call in the daemon run uses the minimal command directly (an
`atomic.Bool`), so a managed machine does not pay a refused spawn per thread. Detection
is a substring match on claude's stderr+stdout:

* always: `unknown option`, `enterprise mcp config`, `disablesideloadflags`
* only when the message also names a long option (`--x`): `by your organization`,
  `managed settings`, `not allowed`, `not permitted`, `disabled by`, `cannot use`

The flag requirement keeps an API error such as `403 Request not allowed` from dropping
the hardening for the rest of the run. Rate limits keep their own retry (`startSlug`); a
429 from the fallback still reads as a rate limit, because the final error wraps both
attempts. The minimal command has read-only tools and the user's MCP servers. `-p`
cannot ask for permission, so anything that needs approval is denied. This is the
accepted cost of naming at all on such machines.

**Logging.** The namer now takes the session store's logger, and the session id rides
in the context (`withNamingSession`). Every finished call is logged at info as
`naming command finished` with session, the command (prompt elided), ok and duration.
A refusal is logged at warn with claude's full message. The existing
`auto-naming failed` warn lines already carried the session id. The error detail cap
went from 500 bytes to 4 KiB, because the disableSideloadFlags message alone is about
400 bytes.

## Main session launch flags (claude.go), checked, unchanged

`--session-id`, `--resume`, `--fork-session`, `--model`, `--effort`,
`--permission-mode`, `--add-dir`, `--append-system-prompt`, `--` and the prompt. The
binary has no managed setting that refuses any of them at startup.
`availableModels` restricts `--model`: Claude falls back ("Model X is restricted by your
organization's settings. Using Y instead.") rather than exiting. `disableAutoMode` and
`disableBypassPermissionsMode` turn those modes off (the store never sends
bypassPermissions). So `--permission-mode auto` on such a machine runs without auto mode
rather than failing.

## End-to-end

* Real claude: the thread was named `add-react-dark-mode-toggle` 2.0 s after the
  transcript appeared. Log:
  `naming command finished … cmd="claude -p --model haiku --no-session-persistence --safe-mode --tools \"\" -- <prompt>" ok=true took=1.993s`.
* `advanced.claude_path` pointing at a wrapper that exits 1 with the enterprise MCP
  message when it sees `--safe-mode`: the first thread logged the warn with the full
  message, retried minimally, and was named `explain-git-rebase` (2.0 s). The second
  thread went straight to the minimal command and was named `postgres-query-pagination`.

## Gotchas

* Projects must live under `$HOME` (`fsx` boundary), so the scratch repo for the e2e run
  was `~/cf-naming-scratch` (removed afterwards), not `/tmp`.
* `daemon.restart` leaves the next client to start the *installed* daemon. For a branch
  build, start `./bin/code-foundry daemon` again yourself.
