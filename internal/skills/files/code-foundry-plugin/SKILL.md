---
name: code-foundry-plugin
description: "Build, debug and publish a Code Foundry plugin: a Go executable using pluginsdk with a plugin.json manifest that adds commands, side-panel surfaces, thread flags, event subscriptions or session environment to Code Foundry. Use when asked to build, create, write, fix, test or release a plugin for Code Foundry, to edit a plugin.json, to use pluginsdk, pluginsdk/ui or plugintest, to debug a plugin with code-foundry plugin dev, logs, surface or act, or to add a plugin to the Code Foundry plugin registry."
---

# Building a Code Foundry plugin

A plugin is an executable the Code Foundry daemon starts and talks to over its stdin and
stdout (newline-delimited JSON-RPC 2.0). Its `plugin.json` declares everything up front:
**commands** (`code-foundry plugin <name> <command>`, also in the app's command palette),
**surfaces** (side-panel tabs the app draws from a JSON view model the plugin sends; no
HTML) and **permissions** the user consents to before it runs (running host commands,
reading events, flagging threads, adding env to new Claude threads, Keychain secrets).
Write plugins in Go with the SDK `github.com/alexwaumann/code-foundry/pluginsdk`
(standard library only; `pluginsdk/ui` builds views, `pluginsdk/plugintest` is a fake host
for tests). This Code Foundry is {{cf.version}}.

## The loop

1. **Scaffold** from the example: a complete plugin with one command, one surface, tests,
   a Makefile and a release workflow. The folder must be under your home directory.
   ```
   mkdir -p ~/code/code-foundry-plugin-<name> && cd ~/code/code-foundry-plugin-<name>
   cp -R {{cf.example}}/. .
   ```
   Then replace `minimal` (and `Minimal`) with your plugin's name everywhere:
   `grep -rn -i minimal .`. The name is lower-case kebab case starting with a letter
   (`gh-actions`); it names the folder in `~/.code-foundry/plugins`, the commands
   (`plugin.<name>.<command>`), the executable (`bin/<name>`) and the release tarballs.
2. **Manifest**: edit `plugin.json` (`reference/manifest.md`): commands and their args,
   surfaces with a scope and a `when` clause, and the fewest permissions that work.
3. **Module**:
   ```
   go mod init github.com/<owner>/code-foundry-plugin-<name>
   go get github.com/alexwaumann/code-foundry/pluginsdk@{{cf.sdkPin}}
   go mod tidy
   ```
   The pin is the SDK of this Code Foundry build. If `go get` cannot find it (a local
   build not on GitHub), use `@main`. `go doc github.com/alexwaumann/code-foundry/pluginsdk`
   (also `.../pluginsdk/ui`, `.../pluginsdk/plugintest`) documents every type and method.
4. **Serve**: in `main.go`, `pluginsdk.Serve(pluginsdk.Plugin{...})` with a handler for
   every manifest command (`Commands`, by name) and surface (`Surfaces`, by id), plus
   `Init`, `OnEvent` and `Shutdown` as needed (`reference/protocol.md`,
   `reference/host-api.md`, `reference/primitives.md`).
5. **Run it** in the daemon: `make build && code-foundry plugin dev "$PWD" --follow=false`
   links the folder as a dev plugin and enables it. If the manifest asks for permissions
   it prints the consent text and exits 2: tell the user what the plugin may do and
   re-run with `--yes` once they agree. `code-foundry plugin list` must say
   `running (dev)`; a NOTE column names manifest problems.
6. **Read its log**: `code-foundry plugin logs <name> --lines 50` (its stderr, `h.Log()`,
   and the host's lines: starts, exits, refused calls, rejected views). Never `--follow`
   from your Bash tool: it does not return.
7. **Drive it without the GUI**: `code-foundry plugin <name> <command> [args]`;
   `code-foundry plugin surface <name> <surface>` prints the surface's view JSON and the
   elements that act; `code-foundry plugin act <name> <surface> <event> [--values '{...}']`
   clicks or submits one. A thread scoped surface uses your own thread
   (`$CODE_FOUNDRY_THREAD`) unless you pass `--context-thread <id>`. After every rebuild
   or `plugin.json` edit: `make build && code-foundry plugin restart <name>` (nothing
   watches the folder).
8. **Test** with plugintest: `go test ./...` (`reference/testing.md`). Test every command,
   every act, and that every view passes `ui.View.Validate`.
9. **Release**: a GitHub repository with the example's `.github/workflows/release.yml`;
   bump `version` in `plugin.json`, then tag `v<version>` and push the tag
   (`reference/publishing.md`).
10. **Registry**: a pull request adding `plugins/<name>.json` to
    `alexwaumann/code-foundry-plugins` (`reference/publishing.md`).

Ask the user before steps 9 and 10: they publish under the user's name.

## Design rules for surfaces

- The panel is 400 px wide and may be 280 px: short labels (pills of one or two words),
  no tables, no side-by-side layouts. Rows, pairs and chips wrap or truncate.
- **No filled buttons.** The one thing that needs the user next is `attention` (amber
  outline); everything else is the default `muted`, `outline` for a little weight, or
  `link`. The `primary` style does not exist; the host refuses it.
- Colour means status: `attention` (amber) needs the user, `error` (red) failed, `ok`
  (emerald) shows only in pills and status glyphs. Choose a status or tone, never a
  colour. The header icon is neutral: a plugin has no identity colour.
- **Actions as commands first.** Whatever a user can do is a manifest command (palette,
  CLI and agents get it too); the view's button runs it (`ui.CommandButton`). Events
  (`ui.EventButton`) are for what only makes sense in the view: tabs, form submits,
  selecting a row.
- Destructive actions are commands with `confirm` text; the host asks the user. Give
  their buttons the `destructive` style.
- **Secrets** never appear in a view, a log line, a command arg or argv. Collect one with
  a form's secret input with `store`: the host keeps it in the Keychain and the plugin
  reads it with `h.Secrets().Get`. A view shows only that it is set (`hasValue`).
- Nothing is revealed on hover; tooltips exist only on icon-only buttons. Plugin tabs have
  no hotkey letter.
- Let the host tick times (`ui.At`, `ui.For` spans) instead of re-sending views each
  second; stream output into a log node with `h.AppendLog`; mark last-known data
  `stale` when the backend is down.

## Good to know

- The plugin runs with its package folder as working directory and a minimal
  environment (PATH, HOME, USER, TMPDIR, LANG, …). `h.DataDir()` is its own state folder.
  stdout is the protocol: the SDK sends a stray `fmt.Println` to the log instead.
- Requests are handled concurrently (guard state with a mutex); events and other
  notifications arrive in order on one goroutine, so `OnEvent` must return quickly.
- A newer manifest that asks for more permissions disables the plugin until the user
  consents again (`plugin dev ... --yes` or `plugin enable <name> --yes`).
- `code-foundry plugin disable <name>` stops a dev plugin and removes its commands.

## References (next to this file)

- `reference/manifest.md`: every `plugin.json` field, permissions, scopes, `when` clauses.
- `reference/protocol.md`: methods both ways, errors, lifecycle, timeouts, crashes.
- `reference/primitives.md`: every view node and value type with JSON and Go, limits.
- `reference/host-api.md`: Invoke, flags, context facts, session environment, events,
  secrets, toasts.
- `reference/testing.md`: plugintest patterns.
- `reference/publishing.md`: release workflow, tarballs, the registry entry.
- `reference/cli.md`: the `plugin` commands' help (generated by this daemon).
- `reference/host-commands.md`: every command a plugin may run (generated).
- `example/`: the minimal plugin to copy.
