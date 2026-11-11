# plugin new (2026-11-10)

`code-foundry plugin new <name> <dir> [--owner <github owner>]` replaces the plugin
skill's copy, grep-rename and three go commands (old steps 1 and 3 of "The loop"), which
agents got wrong. It makes `<dir>/code-foundry-plugin-<name>` from the embedded minimal
example and runs `go mod init`, `go get` of the SDK at the daemon's pin and `go mod tidy`.

## What is here

| Piece | Where |
|---|---|
| Scaffold: template + name + module + pin → folder; the go step injected | `internal/pluginscaffold/scaffold.go` |
| `plugin.new` (NoPalette), `PluginScaffolder` | `internal/command/commands_plugin_new.go`, fake in `commandtest/plugin_new.go` |
| Wiring: home, `skills.SDKPin` of the build, `ShellGo` | `internal/daemon/daemon.go`, `internal/command/all/all.go` |
| `"new"` in `pluginsdk.ReservedNames` | `pluginsdk/manifest.go` |
| Skill steps 1 and 3, publishing.md's "repository created first" | `internal/skills/files/code-foundry-plugin/` |

## Decisions

* **The name is checked by the SDK on the manifest it makes.** Scaffold fills the name
  into the template's `plugin.json` and runs `pluginsdk.LoadManifest` on it before it
  writes anything, so the rules are exactly `plugin dev`'s: the name pattern, the reserved
  names, and (the template has a command and a surface) the command-segment rule, which
  refuses a digit first, a double or a trailing hyphen. No second copy of the rules.
* **`new` is reserved.** `managementVerb` (`internal/store/plugin/host.go`) refuses a
  plugin's `host/invoke` of `plugin.<reserved>.*`; without `new` on the list a plugin
  granted `plugin.**` could scaffold into the user's home. A plugin already named `new`
  stops validating (none is known).
* **Replacement.** `Minimal` → Title Case with hyphens as spaces (`pr-board` → `Pr Board`,
  the display name and the tab title), then `minimal` → the name. Both appear only as text
  in plugin.json, main.go, main_test.go and README.md. The template's package comment no
  longer says "replace minimal everywhere" (it would read as nonsense after the rename);
  it names `plugin new`.
* **Target.** `<dir>/code-foundry-plugin-<name>`, refused when it exists and is not
  empty, or when it resolves outside home (the deepest existing ancestor's symlinks are
  resolved, the same `fsx.Within` check `plugin dev` makes). Missing parents are made. A
  write that fails part way removes what it wrote.
* **Module path.** `github.com/<owner>/code-foundry-plugin-<name>` with `--owner` (checked
  as a GitHub login), else the bare `code-foundry-plugin-<name>`, and the output says to
  `go mod edit -module` before publishing.
* **The go step** is `$SHELL -lc 'go mod init … && go get …@<pin> && go mod tidy'` (login
  PATH, as project actions run), 5-minute timeout (3 until the GitHub fallback, plugin-author-spike.md). On failure the files stay, the go.mod
  and go.sum it may have made are removed (a second `go mod init` refuses an existing
  go.mod), the result carries the error with the last 10 lines of output and the three
  commands, and the exit code is 1. Not an error: the files are the useful part.
* **Not done by the command**: `git init`, `plugin dev` (consent is the user's), `cd`.
  The success output prints the next step, `cd <dir> && make build && code-foundry plugin
  dev "$PWD" --follow=false` (the folder single-quoted when it needs it).
* **Page class**: `pageRuns` (it runs go and writes outside the app's state).
  `NoKeybinding`, like the other plugin verbs that take a name.
* **Skill.** Step 1 is the one `plugin new` line; step 3 keeps its number (renumbering
  would collide with the parallel `plugin dev --watch` edit of steps 5 and 6) and is now
  the SDK pin for an existing plugin, so `{{cf.sdkPin}}` still renders. The body shrank
  about 290 bytes; the budget row is left as it is while the parallel plugin PRs edit the
  same file. `publishing.md`: a repository the user created first is not empty, so scaffold
  elsewhere and copy into the clone; `{{cf.example}}` stays where it restores `.github`.
* **Mock**: `gui/frontend/mock` lists only the plugin verbs the GUI runs (no
  `plugin.env`, `plugin.secrets.list`), so `plugin.new` is not added there.

## Tests

* `internal/pluginscaffold`: names (reserved, bad patterns, hyphenated), targets (not
  empty, empty, missing parents, outside home, a symlink out of home), no `minimal` left
  in any file and `plugin.json` passes `LoadManifest`, the go step's script and a failing
  step keeping the files, and a non-short test that scaffolds with a `replace` to this
  checkout's `pluginsdk` and runs `go build ./... && go test ./...`.
* `internal/command`: the output for an owner, a bare module with a folder that needs
  quoting, a failed go step (exit 1), a refused name (InvalidArgument), and unwired.

## Gotchas

* macOS file systems are case-insensitive: a test that checks a refused `Hello` left no
  folder finds an earlier case's `hello`.
* The go step runs in its own process group and the timeout kills the group: with
  `exec.CommandContext` alone it killed only the shell, and `go get` kept the output pipe
  open, so a 3-minute timeout returned after 15 minutes in the first end-to-end run.
* The pin of a dev build from a clean commit is that commit: `go get` fetches it through
  the module proxy, which only works once the commit is pushed, and the first fetch of a
  new commit takes a while.
