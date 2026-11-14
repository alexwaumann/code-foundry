---
name: code-foundry-plugin
description: "Build, debug and publish a Code Foundry plugin: a Go executable with a plugin.json manifest that adds commands, surfaces (tabs), thread flags, event subscriptions, session environment or its own Claude threads and terminals. Use for anything touching a plugin, plugin.json, pluginsdk, pluginsdk/ui or plugintest, for the code-foundry plugin dev, logs, surface or act commands, or for a plugin registry."
---

# Building a Code Foundry plugin

{{cf.provenance}}

A plugin is an executable the daemon starts and talks to over stdin and stdout
(newline-delimited JSON-RPC 2.0). Its `plugin.json` declares everything up front: commands,
surfaces (tabs drawn from a JSON view model; no HTML), wake sources, and the
permissions the user consents to. Write it in Go with `github.com/alexwaumann/code-foundry/pluginsdk`
(`/ui` builds views, `/plugintest` is a fake host). This Code Foundry is {{cf.version}}.

## Read only what the task needs

Files are split into `##` sections: `grep -n "^## " <file>`, then read the one you need.

| To | Read (in `reference/`) |
|---|---|
| Declare commands, surfaces, permissions, `when` clauses | `manifest.md` |
| Find an icon name (search it, do not read it) | `icons.md` |
| Draw a view: model, value types, limits, acts, design rules, which node to use | `primitives.md` |
| Use a display node (list, chips, log, notice, section…) or a menu | `nodes.md` |
| Take input (fields, pickers that search, drafts, secrets in forms) | `forms.md` |
| Lay out: columns, pane, grid, group, master-detail; a toolbar or footer (search, filters) | `ui-layout.md` |
| Call the host: `h.Log`, `h.DataDir`, Invoke, flags, context facts, session env, secrets, toasts | `host-api.md` |
| React to daemon events | `events.md` |
| Let agents wait on the plugin instead of polling | `wakes.md` |
| Run its own Claude threads or terminals | `owned.md` |
| Debug the wire: lifecycle, process, errors, timeouts, crashes | `protocol.md` |
| Write tests, drive it against the daemon | `testing.md` |
| Release, runners, the registry | `publishing.md` |
| Look up a CLI flag, or a host command it may run | `cli.md`, `host-commands.md` (threads, views: `host-commands-thread-view.md`) |

`example/` is the plugin to copy. `go doc github.com/alexwaumann/code-foundry/pluginsdk`
(`/ui`, `/plugintest`) has every type. For a working use of any component, `code-foundry
plugin install alexwaumann/code-foundry-plugin-showcase` and read its `tab_*.go`; larger
plugins: `alexwaumann/code-foundry-plugin-gh-actions`, `-test-watcher`.

## The loop

1. **Scaffold** under the home directory (ask where the user keeps code), with Go 1.24+:
   `code-foundry plugin new <name> <dir> --owner <github owner>` makes
   `<dir>/code-foundry-plugin-<name>` from the example, named, with the module (up to 5
   minutes). Fill in the README; ask which Actions runner to use (`publishing.md`, "Runners").
2. **Manifest**: edit `plugin.json`, with the fewest permissions that work.
3. **SDK**: `plugin new` pins this build's; an existing plugin takes it with
   `go get github.com/alexwaumann/code-foundry/pluginsdk@{{cf.sdkPin}}`.
4. **Serve**: in `main.go`, `pluginsdk.Serve(pluginsdk.Plugin{...})` with a handler for every
   manifest command (`Commands`, by name) and surface (`Surfaces`, by id), plus `Init`,
   `OnEvent` and `Shutdown` as needed.
5. **Run**: `code-foundry plugin dev "$PWD" --watch --follow=false` builds (`make build`)
   and restarts it now and after each edit (a failed build exits 1; the old one runs on).
   The first time, and when permissions grow, it prints the consent text and exits 2. A
   plugin you wrote here that asks for no permissions: re-run with `--yes`. One that asks for
   any: show the user that text and re-run only after they say yes. `plugin list` must say
   `running (dev, watching)`.
6. **Check**: `code-foundry plugin logs <name> --lines 50` shows its stderr, `h.Log()` and
   refused calls or views (never `--follow` from Bash: it does not return). Drive
   it with `plugin <name> <command>`, `plugin surface` (`--shot s.png` to see it) and
   `plugin act` (`testing.md`); after an edit they wait for the build.
7. **Test**: `go test ./...` with plugintest: every command, every act, and every view
   through `ui.View.Validate`.
8. **Publish** (`publishing.md`): only after asking the user, since it goes out under their
   name. List it only in a registry they configured, never a default.

## Rules Validate does not catch

- **Commands first.** Whatever a user can do is a manifest command (palette, CLI, agents)
  that a button runs. Events are for what only makes sense in the view: tabs, form submits,
  selecting a row.
- **Confirm** remote or side-effecting commands (cancel CI, deploy, delete, sign out) with
  `confirm` text. Local work that is cheap to redo needs none.
- **Secrets** never go in a view, log line, command arg or argv: a form's secret input with
  `store` keeps one, `h.Secrets().Get` reads it.
- **Handlers**: requests run concurrently, so guard state with a mutex; notifications run in
  order on one goroutine, so `OnEvent` returns quickly; none run before `Init` has returned.
- **Tools**: the plugin's environment is minimal, so run the user's own tools through
  `$SHELL -lc "<cmd>"`. stdout is the protocol; `h.DataDir()` is its state folder.
