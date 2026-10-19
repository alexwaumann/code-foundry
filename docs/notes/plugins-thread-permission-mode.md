# Plugins: thread/create permissionMode (pluginsdk v0.2.2)

A plugin can now pick the permission mode of a thread it creates. Additive: a v0.2.1
plugin runs unchanged (its threads keep Claude's default); a v0.2.2 plugin against an
older host has the field ignored (the host decodes params leniently), so its threads get
Claude's default too. Tag after merge: `pluginsdk/v0.2.2` (not cut here).

## What changed

* `pluginsdk.ThreadCreateParams.PermissionMode` (`permissionMode`), with constants
  `PermissionModeSupervised` / `PermissionModeAcceptEdits` / `PermissionModeAuto`
  (`supervised`, `accept-edits`, `auto`: the SDK's pattern for enumerated strings, like
  `ConfirmAsk` and the `Flag*` levels).
* The plugin store trims it and refuses anything else with -32602
  (`permissionMode "acceptEdits" (want one of supervised, accept-edits, auto)`), before the
  env and cwd checks; `ThreadSpec.PermissionMode` carries it.
* The daemon adapter's options are now a pure `pluginCreateOptions` (table-tested): a map
  from the SDK values to `thread.PermissionMode`, `""` is `PermissionDefault` (no flag), an
  unknown value is `ErrInvalidArgument` (unreachable through the store; defensive).
* `plugintest`'s fake host refuses an unknown mode the same way.
* `host-api.md` (one sentence; a repeated "a send unarchives" dropped to stay under the
  32 KiB rendered cap) and `protocol.md`'s method row list the field.

## Decisions

* **Vocabulary is the CLI's**, `thread.new --permission` / `thread.permission`
  (`supervised`, `accept-edits`, `auto`), not Claude's flag values (`manual`,
  `acceptEdits`): a plugin author reads `code-foundry help thread.new`, and Claude's names
  are refused so the two spellings never both work. Full access is not offered, as in the
  CLI and the thread store.
* **Default is Claude's own** (no `--permission-mode`, which asks like supervised). There
  is no `threads.default_permission_mode` setting to follow, and `thread.new`'s `auto`
  default is a CLI arg default, not a user setting; a plugin thread asking by default is
  the safer choice and matches what plugin threads did before.
* `PluginThread` (thread/list's rows) does not report the mode: nothing needs it yet.

## End to end (2026-10-18, isolated `CODE_FOUNDRY_HOME=~/.cfpm-e2e`)

`make build`, `daemon --dev` (CLAUDE* unset), Haiku 5.5 low as defaults, and a scratch
plugin outside the repo (`permplug`, permission `threads`, a `create <mode>` command that
calls `CreateThread` with `PermissionMode` set, `default` sending none):

```
$ code-foundry plugin dev ~/.cfpm-src/permplug --yes --follow=false
linked /Users/alex/.cfpm-src/permplug as dev plugin permplug; enabled permplug 0.0.1 (starting)
$ code-foundry plugin permplug create default        → s-0d44042bc8fc
$ code-foundry plugin permplug create supervised     → s-3dd6b18e923f
$ code-foundry plugin permplug create accept-edits   → s-957b17bc975a
$ code-foundry plugin permplug create auto           → s-65bde58441f7
$ code-foundry plugin permplug create acceptEdits
code-foundry plugin.permplug.create: thread/create: permissionMode "acceptEdits" (want one of supervised, accept-edits, auto)
(exit 1)
$ code-foundry plugin permplug create bypassPermissions
code-foundry plugin.permplug.create: thread/create: permissionMode "bypassPermissions" (want one of supervised, accept-edits, auto)
(exit 1)
$ code-foundry thread list --plugin permplug --json   # permissionMode per thread
s-65bde58441f7 Perm auto          PERMISSION_MODE_AUTO
s-957b17bc975a Perm accept-edits  PERMISSION_MODE_ACCEPT_EDITS
s-0d44042bc8fc Perm default       (unset: PERMISSION_MODE_DEFAULT)
s-3dd6b18e923f Perm supervised    PERMISSION_MODE_SUPERVISED
$ sqlite3 db.sqlite "select name, permission_mode from threads where owner='plugin:permplug'"
Perm accept-edits|2
Perm auto|3
Perm default|0
Perm supervised|1
```

The four spawned `claude -p` processes (children of the daemon, in creation order): no
`--permission-mode` for the default one, then `--permission-mode manual`, `acceptEdits`
and `auto`. The scratch plugin, the home and the threads were removed afterwards.
