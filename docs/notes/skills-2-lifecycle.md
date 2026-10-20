# Skills 2: install, enable, disable, update, uninstall, setup; skill.* commands (2026-10-20)

The second of four PRs for Settings → Skills (`skills-1-registry.md` is the store this
builds on). The store gets the lifecycle, the command registry gets `skill.*`, the
daemon records setup scripts that exit 0. No proto and no page yet: PR 3 adds
`SkillService`, PR 4 the page.

## What is here

| Piece | Where |
|---|---|
| Plugin operations: `claude plugin <op> <name>@<marketplace> ... --json`, the result line, `PluginError` | `internal/store/skill/plugin_ops.go` |
| Install, enable, disable, update, uninstall, remove, setup, `SetupExited`; name resolution | `internal/store/skill/lifecycle.go` |
| Copy a skill (staged beside, renamed in; regular files and dirs only) | `internal/store/skill/copy.go` |
| `Refusal` (refusals whose message is the user's), `ErrCollision`, `ErrLocal`, `ErrNoSetup`, `ErrInvalidName` | `internal/store/skill/store.go` |
| The fake's plugin operations (Claude Code 2.1.304's result lines and exit codes) | `internal/store/skill/skilltest/claude.go` |
| `skill.browse/install/enable/disable/update/uninstall/remove/setup/refresh` | `internal/command/commands_skill.go` (registered in `command/all`) |
| `kind=setup` terminals: `skill`, `title` labels, in the bottom panel | `internal/termlabel`, `gui/frontend/src/lib/termlabel.ts`, `stores/bottomPanel.ts`, `terminal.proto` comment |
| Setup exit watcher → `SetupExited` | `internal/daemon/skill_setup_exits.go` |

## The lifecycle

* **Plugins** (marketplace-listed) are Claude Code's. Install `claude plugin install
  <id> -y --json`, enable/disable `claude plugin enable|disable <id> --json`, update
  `claude plugin update <id> -y --json`, uninstall `claude plugin uninstall <id> -y
  --scope <scope> --json` (the scope `plugin list` reported: uninstall defaults to
  `user`, unlike the others which auto-detect). Claude Code prints one JSON line on
  stdout on success **and on failure** (exit 1, plus a `✘ Failed …` line on stderr), so
  `ClaudeError` now carries `Stdout` and the store reads `outcome`, `message`,
  `failureCode`, `alreadyInGoalState`, `updateOutcome`, `oldVersion`/`newVersion`.
  A failure is a `*PluginError` whose message is Claude Code's (`Plugin "nope" not found
  in marketplace "m"`), wrapping the `ClaudeError`; `not_found` and `not_installed` are
  `ErrNotFound`. After every operation the store `Load`s (and so publishes).
* **Skills** are the daemon's. Install copies the entry's directory from the checkout to
  `<SkillsDir>/<name>` (`$CLAUDE_CONFIG_DIR/skills`, else `~/.claude/skills`): into a
  hidden `.cf-stage-<name>-*` beside it, then a rename. Directories 0755, files 0755
  when the source has an execute bit else 0644; symlinks, sockets and devices are
  skipped, never followed. The record has the commit sha/time, the setup script
  (relative to the skill dir) and its sha256, `setup_done_at` null. Disable renames the
  dir into `<home>/skills/disabled/<name>`, enable renames it back. Update re-copies in
  place wherever the skill lives (the old dir moves aside to `.cf-old-<name>-*`, the
  staged copy renames in, the old one is deleted; put back if the rename fails).
  Uninstall deletes the dir from both places and the row. A recorded skill whose
  directory is gone (Missing) is reinstalled into the skills dir by update; enable and
  disable refuse it.
* **Setup**: `Setup(name)` records nothing; it returns `{Dir, Script, Argv: ["/bin/sh",
  script]}` and remembers the script's sha256 as handed out. `SetupExited(name, code)`:
  exit 0 sets `setup_done_at` and that sha256 (so a script edited while it ran still
  needs setup); any other code records nothing. An exit nobody handed out (the daemon
  restarted in between) hashes the script on disk.

## Commands

| Command | Args | Confirm |
|---|---|---|
| `skill.browse` | `[<query>] [--tier enterprise\|community] [--kind plugin\|skill] [--limit 50] [--refresh]` | |
| `skill.install` | `<name> [--kind]` | |
| `skill.enable` | `<name> [--kind]` | |
| `skill.disable` | `<name> [--kind]` | "Disable {name}? Threads that are running keep it until they restart. New threads pick this up at once." |
| `skill.update` | `[<name>] [--kind] [--check]` | |
| `skill.uninstall` | `<name> [--kind]` | "Uninstall {name}? " + the same warning |
| `skill.remove` | `<name>` (a local skill) | "Remove the local skill {name}? This deletes <dir>. " + the warning |
| `skill.setup` | `<name>` | |
| `skill.refresh` | | |

`<name>` may be `<name>@<marketplace>` for a plugin. `--json` answers `skill.Change`
(camelCase tags), `[]skill.Change` for update, `SkillBrowseView` for browse,
`[]SkillInstalledView` for `update --check`, the registries for refresh, the terminal
for setup. Refusals (not found, ambiguous, collision, local, no setup script, a bad
name) are `ErrInvalidArgs` (exit 2); Claude Code's own failures and disk errors are the
command's failure (exit 1, the message as is).

## Decisions

* **`skill.remove` is separate from `skill.uninstall`.** Uninstall on a local skill
  refuses ("skill x is local (Code Foundry did not install it), so it cannot be
  uninstalled; remove deletes it") and remove on a recorded one refuses ("uninstall it
  instead"). A script's `skill uninstall x --yes` can never delete a skill someone wrote
  by hand; the GUI's Local row calls remove. Remove deletes a symlinked skill's link,
  not its target.
* **Name resolution for installed things reads the disk and the table, not only the
  snapshot.** A plugin comes from the last `plugin list`; a skill is its record plus an
  `Lstat` of both places, read under `opMu` at the time of the operation. A bare name
  an installed plugin and an installed (or local) skill share is the
  `*AmbiguousError` (`choose one with --kind plugin or --kind skill`); a plugin name
  installed from two marketplaces asks for `<name>@<marketplace>`. Install resolves
  through `Entry` (PR 1), so the same rule holds for the catalogue.
* **Collision**: install refuses when `<SkillsDir>/<name>` or `<disabled>/<name>`
  exists (anything at all, SKILL.md or not) and the record is not this registry and
  path; the error names the directory, and the record's source when another entry has
  the name. Same entry already there: `Unchanged` ("is installed already"). A stale
  record of another source with no directory is overwritten. Disable onto a leftover in
  the disabled dir (or enable onto one in the skills dir) is a collision naming it.
* **Idempotent**: install of an installed plugin or skill, enable of an enabled one,
  disable of a disabled one, and update of an up-to-date one succeed with `Unchanged`
  (Claude Code's `already_in_goal_state` failure is read as that). Uninstall of
  something not installed is not found.
* **Update with no name** updates `Updates()` (the snapshot's offers) one by one; a
  failure is that `Change.Error`, the others still run. With a name a plugin always
  runs `claude plugin update` (Claude Code decides; `up_to_date` is `Unchanged`); a
  skill re-copies only when the registry commit is newer than `commit_at` (or the dir
  is gone). `setup_done_at` survives an update only when the script path and its
  sha256 are unchanged.
* **`skill.setup`'s owner** is the context's thread, else its worktree, else its
  project's main worktree (so the GUI's selected project works); none is
  `ErrInvalidArgs` "select a thread or project first". The CLI has no `--here`
  fallback on purpose: pass `--context-project`/`--context-thread` (inside a thread,
  `$CODE_FOUNDRY_THREAD` is the context). No confirm: the script runs in a terminal the
  user sees, which is the brief's "never silently".
* **`kind=setup` is a new terminal kind**, a panel terminal (`IsPanel`) like an action
  run: it stays EXITED so the output can be read (the shell reaper only removes exited
  shells), closes with `terminal.close`, and goes with its thread, worktree or project.
  Labels: the shell's owner labels plus `skill` and `title` ("Setup <name>"), which is
  the tab's title. It does not get the plugins' shell environment (only shells do).
* **The guide leaves `skill.*` out** (`guide.LeftOut`, like `plugin.*`): it is the
  user's settings, not an agent's work, and the guide is at its size cap.
  `code-foundry commands` and `help skill.<verb>` list them.
* **Backend is the store, not a proto service.** `command.SkillBackend` is satisfied by
  `*skill.Store`; commands run in the daemon so nothing goes over the wire. A nil store
  registers the commands failing Unimplemented (tests, `all.Register` without it).
* Plugin install passes `-y` as the brief says. Claude Code's `-y` accepts a
  marketplace-declared install command (a command-source plugin or a headersHelper);
  without it a non-TTY install of such a plugin fails. Worth knowing: install trusts the
  marketplace the user added.

## Gotchas

* Claude Code reports a plugin's version from its `plugin.json`, not the index:
  `enterprise-data` in the scratch marketplace is 1.4.0 in `marketplace.json` and 1.3.9
  in `plugin.json`, so it installs as 1.3.9 and PR 1's semver offer (index newer than
  installed) would stay "Update to 1.4.0" after every `claude plugin update` (which says
  up to date). A marketplace whose two versions agree never shows it. PR 3/4 may want to
  prefer `plugin.json`'s version for the offer; left as PR 1 has it.
* `claude plugin uninstall` defaults to `--scope user`; a project-scoped plugin needs
  its scope passed (we pass the listed one). `plugin list` run by the daemon (cwd `/`)
  shows no project-scoped plugins anyway.
* `os.MkdirTemp` makes the staging dir 0700; it is chmodded to 0755 before the rename.

## For PRs 3 and 4

Store methods (all serialized; each re-reads and publishes `skill.Changed{Epoch}`):

```go
func (s *Store) Install(ctx, name string, kind marketplace.Kind) (skill.Change, error)
func (s *Store) Enable(ctx, name string, kind marketplace.Kind) (skill.Change, error)
func (s *Store) Disable(ctx, name string, kind marketplace.Kind) (skill.Change, error)
func (s *Store) Update(ctx, name string, kind marketplace.Kind) ([]skill.Change, error) // name "": every offer
func (s *Store) Updates(kind marketplace.Kind) []skill.Installed                        // offers, no I/O
func (s *Store) Uninstall(ctx, name string, kind marketplace.Kind) (skill.Change, error)
func (s *Store) Remove(ctx, name string) (skill.Change, error)                         // local skills only
func (s *Store) Setup(ctx, name string) (skill.SetupPlan, error)                       // what to run; records nothing
func (s *Store) SetupExited(ctx, name string, code int) error                          // the daemon calls it
```

`name` is the entry or installed name, or `<name>@<marketplace>` for a plugin; `kind`
"" | plugin | skill. Errors: `errors.Is` `ErrNotFound`, `ErrAmbiguous`
(`*AmbiguousError`), `ErrCollision` (`*CollisionError`, `.Dir`), `ErrLocal`,
`ErrNoSetup`, `ErrInvalidName`; Claude Code's failures are `*PluginError` (`.Code`,
`.Msg`). The GUI's actions map to the commands one to one: Install → `skill.install
<name> --kind <kind>` (always pass the kind, so a shared name never asks), Enable/Disable,
Update (`skill.update <name> --kind`), Run setup (`skill.setup <name>`; disabled with
"select a thread or project first" when the context has neither; the terminal opens in
that thread's or worktree's bottom panel, so the page may want to navigate there),
Uninstall (`skill.uninstall`, confirm text from the command), Local → Remove
(`skill.remove`).

## Verification

* `go test ./internal/store/skill/...` (install with modes, symlink skipped, staging
  cleaned; every refusal; enable/disable round trip and leftovers; update enabled,
  disabled, not offered, script changed or not, setup never ran; update every offer
  with one failing; uninstall both places, local refused; remove local, disabled local,
  symlinked local; plugin install/disable/enable/update/uninstall argv and results,
  `already_in_goal_state`, Claude's not-found, a failure without a result line, claude
  missing, two marketplaces, plugin vs skill; setup plan, exit 1, exit 0 with the
  handed-out hash, an exit nobody handed out; `runPluginOp` table).
* `go test ./internal/command/` (every `skill.*` against a real store over the fixture
  checkout and the fake claude; refusals map to `ErrInvalidArgs`, claude failures to
  `Failed`; setup owner from thread, worktree and project; no store),
  `./internal/daemon/` (the exit watcher tells each setup exit once, not a shell's),
  bottom panel title tests.
* `make check` green.
* End to end on a dev daemon with `CODE_FOUNDRY_HOME=/tmp/cf-s2/home` and
  `CLAUDE_CONFIG_DIR=/tmp/cf-s2/cfg` holding `anthropics/skills` (`claude plugin
  marketplace add anthropics/skills`) and a scratch directory marketplace named
  `ai-marketplace` (the test fixture, committed; `anthropics/skills` has no tiered
  standalone skills, so the skill half needs one), and a scratch project registered for
  the setup terminal. Everything was deleted afterwards. Transcript:

```
$ code-foundry skill browse
NAME               KIND                TIER        VERSION   INSTALLED  BY                  DESCRIPTION
academy-guide      plugin (1 skill)    -           -         -          -                   Recommends relevant Claude Academy courses, tutorials, an...
claude-api         plugin (1 skill)    -           -         -          -                   Claude API and SDK documentation skill for building LLM-p...
discernment-nudge  plugin (1 skill)    -           -         -          -                   Appends two or three short follow-up questions after a su...
document-skills    plugin (4 skills)   -           -         -          -                   Collection of document processing suite including Excel, ...
enterprise-data    plugin (2 skills)   enterprise  1.4.0     -          Data Platform       Query the data warehouse and its catalog.
example-skills     plugin (12 skills)  -           -         -          -                   Collection of example skills demonstrating various capabi...
haiku-writer       skill               community   20261020  -          -
pr-review          skill               enterprise  20261021  -          Code Quality Guild  Review a pull request against the team's checklist.
sql-helper         skill               enterprise  20261020  -          Jane Doe            Write SQL for the warehouse.
marketplace ai-marketplace: 1 plugin(s), 3 skill(s), read 2026-10-20 01:50
marketplace anthropic-agent-skills (anthropics/skills): 5 plugin(s), 0 skill(s), read 2026-10-20 01:50
$ code-foundry skill browse review --tier enterprise
NAME       KIND   TIER        VERSION   INSTALLED  BY                  DESCRIPTION
pr-review  skill  enterprise  20261021  -          Code Quality Guild  Review a pull request against the team's checklist.
marketplace ai-marketplace: 1 plugin(s), 3 skill(s), read 2026-10-20 01:50
marketplace anthropic-agent-skills (anthropics/skills): 5 plugin(s), 0 skill(s), read 2026-10-20 01:50
$ code-foundry skill install pr-review
installed skill pr-review 20261021 from ai-marketplace (/tmp/cf-s2/cfg/skills/pr-review)
it has a setup script (install.sh); run it in a terminal with: code-foundry skill setup pr-review
$ code-foundry skill setup pr-review
code-foundry skill.setup: select a thread or project first
Run `code-foundry help skill.setup` for usage.
[exit 2]
$ code-foundry skill setup pr-review --context-project 15e305383943
running pr-review's setup (install.sh) in terminal t-8cf049382ee2
$ code-foundry terminal list
ID              STATE     CWD                              LABELS
t-8cf049382ee2  exited 0  /tmp/cf-s2/cfg/skills/pr-review  kind=setup project=15e305383943 skill=pr-review title=Setup pr-review worktree=/Users/alex/cf-skills2-scratch-proj
$ sqlite3 db.sqlite "select name, setup_script, setup_done_at is not null from skill_installs"
pr-review|install.sh|1
$ code-foundry skill disable pr-review
code-foundry skill.disable: Disable pr-review? Threads that are running keep it until they restart. New threads pick this up at once.
Re-run with --yes to confirm.
[exit 2]
$ code-foundry skill disable pr-review --yes
disabled skill pr-review (/tmp/cf-s2/home/skills/disabled/pr-review)
   (the marketplace commits a change to pr-review's install.sh)
$ code-foundry skill refresh
marketplace ai-marketplace: 1 plugin(s), 3 skill(s), read 2026-10-20 01:50
marketplace anthropic-agent-skills (anthropics/skills): 5 plugin(s), 0 skill(s), read 2026-10-20 01:50
$ code-foundry skill update --check
NAME       KIND   INSTALLED  AVAILABLE  MARKETPLACE
pr-review  skill  20261021   20261022   ai-marketplace
install with: code-foundry skill update [<name>]
$ code-foundry skill update
updated skill pr-review 20261021 → 20261022 (/tmp/cf-s2/home/skills/disabled/pr-review)
it has a setup script (install.sh); run it in a terminal with: code-foundry skill setup pr-review
$ sqlite3 db.sqlite "select name, commit_at, setup_done_at is not null from skill_installs"
pr-review|2026-10-22 09:00:00|0
$ code-foundry skill.enable pr-review
enabled skill pr-review (/tmp/cf-s2/cfg/skills/pr-review)
it has a setup script (install.sh); run it in a terminal with: code-foundry skill setup pr-review
$ code-foundry skill uninstall pr-review --yes
uninstalled skill pr-review
$ code-foundry skill install claude-api
installed plugin claude-api@anthropic-agent-skills dbd4588f9e10 from anthropic-agent-skills
$ code-foundry skill disable claude-api --yes
disabled plugin claude-api@anthropic-agent-skills
$ code-foundry skill disable claude-api --yes
plugin claude-api@anthropic-agent-skills is disabled already
$ code-foundry skill update claude-api
plugin claude-api@anthropic-agent-skills dbd4588f9e10 is up to date
$ code-foundry skill uninstall claude-api --yes
uninstalled plugin claude-api@anthropic-agent-skills
$ code-foundry skill uninstall claude-api --yes
code-foundry skill.uninstall: no installed plugin or skill named "claude-api"
Run `code-foundry help skill.uninstall` for usage.
[exit 2]
$ code-foundry skill install enterprise-data
installed plugin enterprise-data@ai-marketplace 1.3.9 from ai-marketplace
$ code-foundry skill disable enterprise-data --yes   # a local skill of that name exists too
code-foundry skill.disable: "enterprise-data" is both a plugin and a skill; choose one with --kind plugin or --kind skill
Run `code-foundry help skill.disable` for usage.
[exit 2]
$ code-foundry skill uninstall enterprise-data --kind skill --yes
code-foundry skill.uninstall: skill enterprise-data is local (Code Foundry did not install it), so it cannot be uninstalled; remove deletes it
Run `code-foundry help skill.uninstall` for usage.
[exit 2]
$ code-foundry skill remove enterprise-data
code-foundry skill.remove: Remove the local skill enterprise-data? This deletes /tmp/cf-s2/cfg/skills/enterprise-data. Threads that are running keep it until they restart. New threads pick this up at once.
Re-run with --yes to confirm.
[exit 2]
$ code-foundry skill remove enterprise-data --yes
removed local skill enterprise-data
$ code-foundry skill uninstall enterprise-data --yes
uninstalled plugin enterprise-data@ai-marketplace
$ claude plugin list --json
[]
```

The daemon log for the setup: `terminal started … argv="[/bin/sh install.sh]"
cwd=/tmp/cf-s2/cfg/skills/pr-review`, then `skill setup done skill=pr-review`; each
operation is followed by `marketplaces read … epoch=N`.
