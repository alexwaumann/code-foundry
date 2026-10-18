# Plugins 4: the code-foundry-plugin skill (2026-10-18)

The fourth PR of the plugin stack (`docs/sketches/plugins/DECISIONS.md`, build order row
4), on `cf/plugins-3-events-flags-env`. A third daemon-written skill teaches an agent to
build, debug and publish a plugin; agents will write most plugins, starting with the two
example repositories (GitHub Actions tracker, test watcher), which are built with it next.
Also `docs/ARCHITECTURE.md` §10 Plugins.

## What is here

| Piece | Where |
|---|---|
| The skill: SKILL.md + six hand-written references | `internal/skills/files/code-foundry-plugin/` (`reference/manifest.md`, `protocol.md`, `primitives.md`, `host-api.md`, `testing.md`, `publishing.md`) |
| Rendered references, placeholders, the example | `internal/skills/plugin.go` (`cli.md`, `host-commands.md`, `{{cf.<name>}}` values, `example/`) |
| The template plugin | `plugins/examples/minimal` (plugin.json, main.go, main_test.go, Makefile, .gitignore, .github/workflows/release.yml), embedded by `plugins/embed.go` |
| `guide.WriteHelp` (the CLI's `help <command>`, moved from `cmd/code-foundry`) | `internal/guide/help.go` |
| The build's commit for worktree builds | `version.Commit` (`-ldflags` from `make build`) |
| Prompt line names the third skill | `thread.ThreadPrompt` |
| SDK | `pluginsdk/go.mod` at `go 1.24`; package doc points at the skill |

Installed layout (every thread's first `--add-dir`):

```
<home>/claude/.claude/skills/code-foundry-plugin/
  SKILL.md                     static, placeholders filled (SDK pin, example path, version)
  reference/manifest.md        static + host facts, reserved names, event sources, reserved args
  reference/protocol.md        static
  reference/primitives.md      static + the view limits table (pluginsdk/ui constants)
  reference/host-api.md        static
  reference/testing.md         static
  reference/publishing.md      static
  reference/cli.md             rendered: every plugin.* verb's help, thread.flags, thread.flag.clear, pr.checks
  reference/host-commands.md   rendered: every command outside plugin.*, one line each, by category
  example/                     plugins/examples/minimal, byte for byte
```

## Decisions

* **Rendered vs written by hand.** What the code knows is rendered, so it cannot drift:
  the plugin verbs' help text (the same `guide.WriteHelp` the CLI's `help` uses, common
  flags stated once), the commands a plugin may invoke, the host fact names
  (`plugin.HostFactNames`), `pluginsdk.ReservedNames`, `ReservedArgNames`,
  `EventSources`, the `pluginsdk/ui` limits, the SDK pin and the example's installed
  path. Prose (what things mean, rules, patterns, the design rules) is written by hand.
  The guide could not take the plugin verbs (19 bytes left of 29,000), so `cli.md` is a
  separate plugin-only reference.
* **Placeholders in static files**: `{{cf.<name>}}`, filled by `Render` from `Sources`; an
  unknown name is an error and the test fails on any left over. `{{` alone is not
  special (Go composite literals in the references use it).
* **The SDK pin is this build's commit** (`version.Info.Commit`), so the SDK an agent
  fetches speaks the daemon's protocol exactly; a dirty or unknown commit pins `main`.
  Go stamps `vcs.revision` only when the module's `.git` is a directory, so builds in a git
  worktree (every agent's) had no commit: `make build` now passes
  `-X version.Commit=<sha>[-dirty]`, used when the stamp is missing. Release builds (a
  CI checkout) have the stamp anyway.
* **The template is a real package** (`plugins/examples/minimal`), built, vetted and
  tested by `make check`, embedded through a `plugins` package (`go:embed` cannot reach a
  parent directory, and a `main` package cannot be imported). It has no `go.mod` (it lives
  in the main module): the skill's step 3 makes one. Its Makefile reads NAME and VERSION
  from `plugin.json`'s top-level lines; `make dist` builds both macOS architectures with
  `CGO_ENABLED=0`, tars `plugin.json` + `bin/<name>` at the root (`COPYFILE_DISABLE=1`, no
  AppleDouble files) and writes `SHA256SUMS`. The release workflow runs on `v*` tags on
  ubuntu (cross-compiling), checks the tag against `plugin.json`, and attaches the
  tarballs with `gh release create`.
* **`exec` is `bin/<name>`**, not a bare name at the tarball root: a bare `exec[0]` is
  looked up on PATH.
* **`pluginsdk` declares `go 1.24`** (it builds there; it uses nothing newer). With `go
  1.26.0` a plugin repository on Go 1.25 (Alex's Homebrew Go) downloaded a toolchain on
  `go get` (70 s, and impossible offline or where toolchain downloads are blocked).
* **Description** 509 characters (cap 600 in the test, vs 400 for the other two): it names
  the trigger words (build/create/write a Code Foundry plugin, plugin.json, pluginsdk,
  plugintest, plugin dev/logs/surface/act, the registry). Model- and user-invocable (no
  invocation keys). Body 117 lines.
* **Consent stays the user's**: the skill tells the agent to show `plugin dev`'s consent
  text and pass `--yes` once the user agrees, and to ask before publishing steps.
* **The prompt line** now names three skills ("…, code-foundry-plugin) say how to
  delegate work to other threads, how to answer questions about the app and how to build
  plugins for it."). Existing conversations keep their recorded prompt (see agent-skills).
* Every plugin skill file is under 32 KB (test); the largest is primitives.md (24 KB).

## Regenerating

Nothing to run: the daemon renders the skill at every start (`installSkills`). To see
the output without a daemon, render it in a test (`skills.Render(realSources(t))`) or
start an isolated daemon and read `$CODE_FOUNDRY_HOME/claude/.claude/skills/code-foundry-plugin`.
A change to a plugin verb's args or description, a new host fact, reserved name, event
source or view limit, or the template appears at the next start. A change to the
protocol or the view model's rules needs the hand-written references edited.

## Dry run

Three runs against an isolated daemon (`CODE_FOUNDRY_HOME=/tmp/cfp4`, `code-foundry` a
wrapper for the branch binary with that home, started without the session's `CLAUDE*`
variables), each following only the installed skill, in a folder under `~` (`plugin dev`
refuses folders outside the home directory).

**The incantation.** Plugin repositories get the SDK with

```
go get github.com/alexwaumann/code-foundry/pluginsdk@<commit>
```

against GitHub through the module proxy: it fetches the nested module from the
`pluginsdk/` directory of that commit (a pseudo-version
`v0.0.0-20261018115226-b82c394eb42c`; it also downloads the parent module once to check
the path, about 40 s the first time). It works for any pushed commit, on a branch or not.
Before the stack merges `@main` has no `pluginsdk` and `@latest` fails; after it,
`@main` works, and `@v0.1.0` once `pluginsdk/v0.1.0` is tagged.

**Run 1 (me, plugin `tally`).** Copied `example/`, renamed, added an `add <n>` command
with a thread context arg and the `threadStatus` permission, `go mod init` + `go get` at
the pin, `make build`, `plugin dev "$PWD" --follow=false` (exit 2 with the consent text,
then `--yes`), `plugin list` (`running (dev)`), `plugin tally hello Ada`, `plugin tally
add 4 --context-thread <id>`, `thread flags <id>` (the flag at 11), `plugin surface tally
status`, `plugin act tally status count`, an invalid view on purpose (the error names
`nodes[1].actions.buttons[1].label: required` and the filled-button rule), a permission
added to the manifest (`plugin restart` → disabled, "its permissions changed"; `plugin
enable --yes`), `make dist`, and the registry's own `scripts/validate.py` against an entry
with `file://` artifact URLs: `ok tally 0.1.0`. Stumbles fixed:
* The pin was `main`: a worktree build had no commit (`version.Commit`, above).
* `pluginsdk`'s `go 1.26.0` made `go get` download a toolchain on Go 1.25 (now `go 1.24`).
* "Scaffold in `~/code`" assumed a folder the user may not have: now "where the user keeps
  code; ask if unsure".

**Run 2 (a fresh agent, plugin `notes`)**: commands with dotted names, a tabbed thread
surface with a list, a form and per-row delete, a `when` clause over a `SetContext` fact,
a `threads` subscription logging removals, a flag at the fifth note, plugintest tests,
`make dist`. It worked end to end. Its stumbles, all fixed:
* Thread-removed events were not documented: host-api.md now has a table of every source's
  changes, rendered from the proto descriptors (`snapshot`, `updated`, `removedId`, …;
  for `thread` only the two the event stream carries).
* `code-foundry events` never returns and macOS has no `timeout`: a capture recipe
  (`& pid=$!; sleep 5; kill $pid`; `kill $!` followed by a backtick would trip the
  no-dynamic-command test).
* **A thread id suffix in a plugin command's context arg reached the plugin verbatim**
  (`--thread c820` → `"c820"`): plugin args with `context: thread|terminal` now carry the
  registry's id kind, so suffixes resolve (and the context they set), like built-in id args
  (`TestContextArgsResolveIDs`). A bare `--context-thread` suffix without such an arg is
  still passed as typed; manifest.md says to declare the arg.
* Dotted command names take spaces on the CLI; positionals are one word each; `plugin <name>
  show <surface>` does nothing without a GUI; unavailable commands say why only when run;
  the data dir follows the Code Foundry home: all now said.
* The rule for destructive actions was ambiguous for a per-row delete: now "what cannot be
  undone or reaches outside the plugin is a command with confirm; small reversible edits
  in the view can be events".
* SDK: `ui.EventButton` could not carry data (new `Button.WithData`); go doc mentioned
  "protocol PR 2/3" and internal design files (rewritten); plugintest's doc undersold what
  it enforces; tab acts' `Value` is `any` (the skill says to use `Key`); `SetContext` takes
  no context (host-api.md now says which calls are notifications).
* Tarballs shipped `plugin.json` 0600 (the skill's files are 0600): `make dist` sets 0644.

**Run 3 (a fresh agent on the fixed skill, plugin `deploybot`)**: a global setup surface
with a form (https URL, a stored token), a `SetContext` fact gating a tabbed thread
surface (stage chips with durations, a destructive `deploy` command streaming into a log
node, a `stale` section while a fake backend is down), a session environment
(`DEPLOYBOT_URL`), `thread.send` tested in plugintest only. It worked end to end
(`go test -race -count=20` green, `plugin env`, availability flipping with configuration,
appends with no duplicate lines, `make dist`). Its stumbles, fixed:
* **Wrapping an SDK error dropped the wrap's text**: the JSON-RPC answer used the inner
  `*Error`'s message. A wrapped `*Error` now keeps its code and sends the whole text
  (`TestConnCall`).
* **`plugintest.Start` returned before `Init` finished**, so a test's setup raced Init.
  Start now waits for Init (5 s, `NoInitWait` to skip); `Options.Secrets` presets secrets
  Init can read; `Host.DataDir()`.
* A stored secret arrives in `act.Values` as a map, never as `StoredSecret`: new
  `SurfaceAct.Stored(name)`.
* `required` / `pattern` / `maxLength` are the GUI's checks (`plugin act --values` skips
  them) and the host stores a form's secret before the plugin sees the submit: said, with
  "validate every value again".
* Keys share one namespace across kinds (a chip and a button both `deploy`): an example of
  prefixing by role. Streaming logs without duplicates: render the node with empty `text`
  and append each chunk once. Environment scope: nil leaves out threads without a project;
  `{NoProject: true}` is everywhere. A secret deleted from the CLI is not announced to the
  plugin. Go 1.24 or newer. How plugin errors print (`… (unknown)`), that `plugin act`
  prints only the version, and that `plugin surface --json` nests the view as a string.

## Not fixed here (for the SDK or the host)

* A plugin's own command error reaches the CLI as Connect `Unknown` ("… (unknown)"); a
  dedicated code (or none shown) would read better.
* `plugin act` could print the resulting view (or `--show`), saving a `plugin surface`.
* Form field builders have no `With…` helpers (`ui.TextField` then four assignments);
  `SetContext` values are `any`.
* No event tells a plugin that the user deleted one of its secrets or that consent changed.
* `pluginsdk` is not tagged yet: plugin repositories pin a commit until
  `pluginsdk/v0.1.0` (DECISIONS: after the stack merges).
