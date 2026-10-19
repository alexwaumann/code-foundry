---
name: code-foundry-plugin
description: "Build, debug and publish a Code Foundry plugin: a Go executable using pluginsdk with a plugin.json manifest that adds commands, side-panel surfaces, thread flags, event subscriptions, session environment or its own Claude threads and terminals to Code Foundry. Use when asked to build, create, write, fix, test or release a plugin for Code Foundry, to edit a plugin.json, to use pluginsdk, pluginsdk/ui or plugintest, to debug a plugin with code-foundry plugin dev, logs, surface or act, or to add a plugin to a Code Foundry plugin registry."
---

# Building a Code Foundry plugin

A plugin is an executable the Code Foundry daemon starts and talks to over its stdin and
stdout (newline-delimited JSON-RPC 2.0). Its `plugin.json` declares everything up front:
**commands** (`code-foundry plugin <name> <command>`, also in the app's command palette),
**surfaces** (side-panel tabs the app draws from a JSON view model the plugin sends; no
HTML), **wake sources** agents subscribe to instead of polling, and **permissions** the
user consents to (host commands, events, flags, env, secrets, threads, terminals). Write
plugins in Go with the SDK `github.com/alexwaumann/code-foundry/pluginsdk` (standard library only;
`/ui` builds views, `/plugintest` a fake host for tests). This Code Foundry is {{cf.version}}.

## The loop

1. **Scaffold** from the example: one command, one surface, tests, a Makefile, CI and
   release workflows in `.github/workflows/`, a README template to fill in. Work in a
   folder under the home directory (`plugin dev` refuses others; ask the user where they
   keep code) named after the repository it becomes (an existing clone: copy into it):
   ```
   mkdir -p <dir>/code-foundry-plugin-<name> && cd <dir>/code-foundry-plugin-<name>
   cp -R {{cf.example}}/. .
   ```
   Replace `minimal` and `Minimal` with the plugin's name everywhere (`grep -rni minimal .`),
   kebab case starting with a letter (`gh-actions`); fill in the README.
2. **Manifest**: edit `plugin.json` (`reference/manifest.md`): commands and their args,
   surfaces with a scope and a `when` clause, and the fewest permissions that work.
3. **Module** (Go 1.24 or newer; keep the `go` line `go mod init` writes, CI installs it):
   ```
   go mod init github.com/<owner>/code-foundry-plugin-<name>
   go get github.com/alexwaumann/code-foundry/pluginsdk@{{cf.sdkPin}}
   go mod tidy
   ```
   The pin is this build's SDK (first fetch: up to a minute; not on GitHub: `@main`).
   `go doc github.com/alexwaumann/code-foundry/pluginsdk` (`/ui`, `/plugintest`) has every type.
4. **Serve**: in `main.go`, `pluginsdk.Serve(pluginsdk.Plugin{...})` with a handler for
   every manifest command (`Commands`, by name) and surface (`Surfaces`, by id), plus
   `Init`, `OnEvent` and `Shutdown` as needed (`reference/protocol.md`, `host-api.md`,
   `primitives.md`). Build with `make build`, not `go build ./...`.
5. **Run it**: `make build && code-foundry plugin dev "$PWD" --follow=false` links the
   folder and enables it. The first time (and when permissions grow) it prints the consent
   text and exits 2: tell the user what the plugin may do, re-run with `--yes` once they
   agree. `code-foundry plugin list` must say `running (dev)` (NOTE: manifest problems).
6. **Read its log**: `code-foundry plugin logs <name> --lines 50` (its stderr, `h.Log()`,
   and the host's lines: starts, exits, refused calls, rejected views). Never `--follow`
   from your Bash tool: it does not return.
7. **Drive it without the GUI** (`reference/testing.md`, "Against the daemon"):
   `code-foundry plugin <name> <command> [args] --thread <id>` runs a command; `plugin
   surface <name> <surface> --thread <id> [--settle 2s]` prints the view and its elements
   (`--settle` waits out "Loading"); `plugin act <name> <surface> <event> [--key k]
   [--values '{...}']` clicks (an event or a command button) and prints the view after.
   After every rebuild or `plugin.json` edit: `make build && code-foundry plugin restart
   <name>` (nothing watches the folder).
8. **Test** with plugintest: `go test ./...` (`reference/testing.md`). Test every command,
   every act, and that every view passes `ui.View.Validate`.
9. **Release**: push to GitHub (`ci.yml` runs vet and race tests), bump `version` in
   `plugin.json` and `main.go` (a test checks they agree), tag `v<version>` and push the
   tag; `release.yml` publishes the tarballs (`reference/publishing.md`).
10. **Registry**: `make registry-entry` writes `dist/<name>.json`. Only a registry the user
    configured lists it, never a default: `code-foundry settings get plugins.registries`
    (comma-separated). One: a pull request to it; several: ask which; none: stop and tell
    the user what is left (`reference/publishing.md`, "Which registry").

Ask the user before steps 9 and 10: they publish under the user's name. Larger examples:
`alexwaumann/code-foundry-plugin-gh-actions` and `alexwaumann/code-foundry-plugin-test-watcher`.
**Showcase.** `alexwaumann/code-foundry-plugin-showcase` is the living gallery of every
component, a tab per family with its Go in `tab_*.go`: `code-foundry plugin install
alexwaumann/code-foundry-plugin-showcase` and read the matching file.

## Design rules for surfaces

- The panel is 400 px wide and may be 280 px: short labels (pills of one or two words),
  no tables, no side-by-side layouts. Rows, pairs and chips wrap or truncate; titles get
  one line and the header sub-line two, then are cut for good: guidance is a `text` node.
  At most two `thread` or `terminal` nodes in a view (each is a live stream).
- **No filled buttons.** The one thing that needs the user next is `attention` (amber
  outline); everything else is the default `muted`, `outline` for a little weight, or
  `link`. The `primary` style does not exist; the host refuses it.
- Colour means status: `attention` (amber) needs the user, `error` (red) failed, `ok`
  (emerald) only in pills and glyphs. Choose a status or tone, never a colour (no identity colour).
- **Actions as commands first.** Whatever a user can do is a manifest command (palette,
  CLI, agents); the view's button runs it (`ui.CommandButton`). Events (`ui.EventButton`)
  are for what only makes sense in the view: tabs, form submits, selecting a row.
- Remote or side-effecting runs (cancel or rerun CI, deploy, delete what the user cannot
  get back, sign out) are commands with `confirm` text: the host asks. Local work that is
  cheap to redo (stop or rerun a local test run, hide a row) needs no confirm; give a
  stop button the `destructive` style anyway. Icons: `reference/manifest.md`.
- **Flags**: until-seen for one-off events; sticky for conditions the plugin clears, with a
  visible way out, never re-raised after a user's clear (`reference/host-api.md`).
- **Secrets** never appear in a view, a log line, a command arg or argv: a form's secret
  input with `store` puts one in the Keychain, `h.Secrets().Get` reads it, views show `hasValue`.
- Nothing is revealed on hover; tooltips exist only on icon-only buttons. Let the host
  tick times (`ui.At`, `ui.For` spans), not re-send views each second; stream output
  into a log node with `h.AppendLog`; mark last-known data `stale` when the backend is down.

## Good to know

- The plugin runs in its package folder with a minimal environment (PATH, HOME, …);
  `h.DataDir()` is its state folder. Run the user's own tools (`go test`, `npm test`)
  through their login shell (`$SHELL -lc "<cmd>"`), as project actions do. stdout is
  the protocol: the SDK sends a stray `fmt.Println` to the log instead.
- Requests run concurrently (guard state with a mutex); notifications in order on one
  goroutine (`OnEvent` returns quickly); none of them before `Init` has returned.
- **Wake sources** (`manifest.md` "Wakes", `host-api.md` "FireWake"): arm in `OnWakeSubscribed`
  (replayed with `Rearm` after each start, then `OnWakeArmed`); fire with `h.FireWake`; end
  messages, notices, timeline text (never a flag reason: 80 chars) with `h.WakeHint(source, args)`.

## References (next to this file)

- `reference/manifest.md`: every `plugin.json` field, permissions, scopes, `when` clauses.
- `reference/protocol.md`: methods both ways, errors, lifecycle, timeouts, crashes.
- `reference/primitives.md`: every view node and value type, limits; `reference/ui-layout.md`: columns, panes, grids, inline.
- `reference/host-api.md`: Invoke, flags, context facts, session env, events, secrets, toasts.
- `reference/testing.md`: plugintest patterns; driving the plugin in the daemon.
- `reference/publishing.md`: release workflow, tarballs, the registry entry.
- `reference/cli.md`: the `plugin` commands' help; `reference/host-commands.md`: what it may run.
- `example/`: the minimal plugin to copy.
