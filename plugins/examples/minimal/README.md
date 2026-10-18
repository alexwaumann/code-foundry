# code-foundry-plugin-minimal

A [Code Foundry](https://github.com/alexwaumann/code-foundry) plugin: one command that
answers with a greeting and a **Minimal** tab in each thread's side panel with a counter.
(Say in a sentence or two what the plugin does and for whom.)

## Install

```
code-foundry plugin install minimal                         # from a registry you configured
code-foundry plugin install <owner>/code-foundry-plugin-minimal   # straight from the latest release
```

Code Foundry shows what the plugin may do and asks before it runs.

## What it adds

| | |
|---|---|
| `code-foundry plugin minimal hello [name]` | "Hello, name!" (palette: *Say Hello*) |
| **Minimal** tab (each thread's side panel) | the thread's id, when the tab opened, a counter with Count and Reset, a Say hello button |

## Permissions and why

It asks for none. (List each permission `plugin.json` asks for and what needs it, in the
user's words: "`threadStatus`: flags a thread whose tests fail". Say what leaves the Mac,
if anything.)

## Development

```
make build && code-foundry plugin dev "$PWD" --yes   # link and run it
make test                                           # plugintest
code-foundry plugin surface minimal status --thread <id>
code-foundry plugin logs minimal --lines 50
```

Releases: bump `version` in `plugin.json` (and `version` in `main.go`), tag `v<version>`
and push the tag; `.github/workflows/release.yml` publishes the tarballs.

## License

(The license you chose, if any.)
