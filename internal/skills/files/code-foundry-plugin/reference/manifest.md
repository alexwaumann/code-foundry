# plugin.json

The manifest sits at the root of the plugin's folder (the package directory). The host
reads it before running anything: for the consent text, the command list, and the
commands and surfaces that stay listed while the plugin is down. `pluginsdk.Manifest` is
its Go type; `pluginsdk.LoadManifest(data)` parses and validates it as the host does
(the example's `TestManifest` runs it). Unknown fields are warnings, never errors: they
show in `code-foundry plugin list`'s NOTE column.

```json
{
  "name": "gh-actions",
  "displayName": "GitHub Actions",
  "version": "0.1.0",
  "description": "Runs, jobs and failed-step logs for the selected thread's pull request.",
  "protocol": 1,
  "exec": ["bin/gh-actions"],
  "permissions": {
    "commands": ["thread.send", "pr.checks"],
    "events": ["gh"],
    "threadStatus": true
  },
  "commands": [
    {
      "name": "rerun-failed",
      "title": "Rerun Failed Jobs",
      "description": "Rerun the failed jobs of the thread's pull request's latest run.",
      "when": "\"github-actions\" in pr.checks.provider",
      "timeoutSeconds": 60,
      "args": [{ "name": "thread", "context": "thread", "description": "The thread (default: the active one)" }]
    },
    {
      "name": "cancel",
      "title": "Cancel Run",
      "confirm": "Cancel run {run}?",
      "args": [{ "name": "run", "required": true, "positional": true, "description": "Run id" }]
    }
  ],
  "surfaces": [
    {
      "id": "runs",
      "title": "Actions",
      "icon": "workflow",
      "scope": "pr",
      "when": "\"github-actions\" in pr.checks.provider"
    }
  ]
}
```

## Top level

| Field | Rules |
|---|---|
| `name` | Required. `[a-z0-9][a-z0-9-]{0,63}`; with commands also a command segment: a letter first, no double or trailing hyphen (`gh-actions`, not `1password` or `gh--x`). Not one of the host's verbs: {{cf.reservedNames}}. It is the folder name under `~/.code-foundry/plugins`, the command prefix `plugin.<name>.` and the registry entry's name. |
| `displayName` | Up to 60 characters; shown in lists, as the palette group of its commands and before its flag reasons ("GitHub Actions: deploy failed"). Default: `name`. |
| `version` | Required. Strict semantic version without a leading `v`: `0.1.0`, `1.0.0-rc.1`. The release tag is `v<version>`. |
| `description` | Up to 300 characters; shown in the consent dialog and the registry. |
| `protocol` | Required: `1`. |
| `exec` | Required: the argv the host starts. `exec[0]` with a slash is relative to the package folder and must stay inside it (`bin/gh-actions`, `./run.sh`); a bare word (`python3`, `node`) is looked up on PATH. Use `bin/<name>`: the example's Makefile builds it there. |
| `permissions` | What the plugin may do through the host (below). `{}` asks for nothing; the user still consents once to running the plugin at all. |
| `commands` | Up to 100 (below). |
| `surfaces` | Up to 20 (below). |

## Permissions

The keys are fixed (the registry entry repeats the block exactly); a missing key reads
false or empty. The user sees them in words before the plugin first runs, and again
whenever a new version asks for more (the plugin is disabled until they agree).

| Key | Type | Grants |
|---|---|---|
| `commands` | globs | `Host.Invoke` and view command buttons for these host commands. Globs over dotted names: `*` within a segment, `**` across (`"thread.send"`, `"view.open.*"`, `"action.**"`). `plugin.<verb>` management commands are refused whatever the globs. The list: `reference/host-commands.md`. |
| `events` | sources | `Host.Subscribe` to these event sources: {{cf.eventSources}}. |
| `threadStatus` | bool | `Host.SetFlag`: attention or error flags on threads. |
| `sessionEnv` | bool | `Host.SetEnvironment`: env, PATH entries and `--add-dir`s for new Claude threads. |
| `secrets` | bool | `Host.Secrets()` and form secret inputs with `store`: the plugin's own Keychain namespace. |
| `threads` | bool | Plugin-owned Claude threads (`thread` node). Arrives in a later version. |
| `terminals` | bool | Plugin-owned terminals (`terminal` node). Arrives in a later version. |
| `api` | bool | The daemon's endpoint and token in `CODE_FOUNDRY_ENDPOINT` / `CODE_FOUNDRY_TOKEN`: full control of Code Foundry. Avoid; the consent text warns the user. |

## Commands

Each becomes `plugin.<name>.<command>`: a palette entry under the display name, and
`code-foundry plugin <name> <command>` on the CLI, a dotted name with spaces
(`run.rerun-failed` is `code-foundry plugin ci run rerun-failed`; the dotted form
`plugin.ci.run.rerun-failed` works too). The plugin handles it in
`Plugin.Commands["run.rerun-failed"]`.

| Field | Rules |
|---|---|
| `name` | Required. Dotted kebab-case segments: `greet`, `run.rerun-failed`. `show` and `show.*` are reserved (each surface gets `plugin.<name>.show.<surface>`). |
| `title` | Required, up to 80 characters, Title Case ("Rerun Failed Jobs"). The palette entry. |
| `description` | One or two sentences; the CLI's help and the palette's detail. |
| `when` | A clause (below) deciding where the command is available; elsewhere it is unavailable, and running it says why. Default: always. |
| `confirm` | Makes it ask first: the host shows this text and runs it only on yes; the CLI needs `--yes`. The plugin never confirms for the user. `{arg}` placeholders take the arg's value after defaults (a bool `true`/`false`); an arg neither given nor defaulted shows `(none)`. The text is rendered before the plugin runs, so it cannot name what the plugin would pick ("the newest run"): word it to read well with `(none)`, or leave the placeholder out. |
| `timeoutSeconds` | How long one run may take: default 30, at most 600. |
| `args` | Below. |

Args (`pluginsdk.ArgSpec`); values reach the handler as strings in `req.Args`
(`req.Arg("name")`), defaults applied; an arg neither given nor defaulted is absent.

| Field | Rules |
|---|---|
| `name` | Required, kebab case; also the CLI flag (`--until-seen`). Reserved: {{cf.reservedArgs}}. |
| `type` | `string` (default), `bool` ("true"/"false"), `int`, `enum`, `path`. The host validates before the plugin sees it. |
| `enum` | The values of an `enum` arg (required for one, refused for others). |
| `default` | A default value (in `enum` for an enum). Not with `required`. |
| `required` | The command refuses to run without it. |
| `positional` | Also takes a bare word on the CLI, in declaration order: `plugin gh-actions cancel 123`. One word each: quote text with spaces (`plugin notes add "buy milk"`). |
| `context` | `thread`, `project`, `worktree` or `terminal` (string and path args only): defaults to the caller's active one (the GUI's selection, `--context-thread` on the CLI, or `$CODE_FOUNDRY_THREAD` in a thread). A thread or terminal id given as a unique suffix (`c820`) is resolved to the full id, also in `req.Context`. A view's command button fills it from the panel's context, so its `args` can leave it out. |
| `description` | The flag's help. |

The command also gets the caller's context in `req.Context` (`ThreadID`, `ProjectID`,
`WorktreePath`, `TerminalID`, `WorkspaceID`, `View`), whatever its args. Only a context
arg resolves id suffixes: a command that reads `req.Context.ThreadID` without declaring a
`context: thread` arg gets `--context-thread` exactly as typed, so declare the arg when a
command acts on a thread. A result's
`Message` is what the CLI prints and the GUI toasts; `JSON` is `--json`'s output;
`ExitCode` the CLI's exit status. Return an error to fail: its message is the CLI's
error (exit 1) and the GUI's error toast; `pluginsdk.NewError(pluginsdk.CodeInvalidParams, ...)`
makes it a usage error (exit 2).

## Surfaces

A surface is a view the host renders from the plugin's view model
(`reference/primitives.md`). One **instance** exists per scope value; the host opens it
when someone first looks (`surface/open` → `Plugin.Surfaces[<id>]`) and closes it a
minute after the last viewer left.

| Field | Rules |
|---|---|
| `id` | Required, kebab case, unique. |
| `title` | Required, up to 80 characters: the tab's title and `Show <title>` in the palette. |
| `icon` | A lucide icon name from the list below; any other name draws a plain circle. |
| `scope` | What one instance is for (below). Default `thread`. |
| `placement` | `["panel"]` (default): the side panel. `settings` is accepted and reserved for a later version. |
| `when` | A clause; the surface is offered only where it holds (and its scope's context exists). |

| Scope | One instance per | Context the plugin gets (`SurfaceOpen.Context`) | Debug it with |
|---|---|---|---|
| `global` | Code Foundry | nothing | `plugin surface <name> <id>` |
| `thread` | thread | the thread, its project, worktree, workspace | `--thread <id>` (default: yours) |
| `project` | project | the project | `--project <id>` |
| `worktree` | worktree | the worktree | `--context-worktree <path>` |
| `pr` | pull request (`owner/repo#n`) | the opening thread's context, and `Facts["pr"] = {"repo","number","url"}` | `--thread <id>` of a thread with a pull request |

`plugin surface` and `plugin act` take `--thread <id>` (a unique suffix works) or
`--project <id>`; the global `--context-thread` works too.

**One instance, many viewers.** A `pr` instance serves every thread on that pull request,
but its `SurfaceOpen.Context` is the first opener's thread, and a `surface/act` carries no
viewer context (the same holds for a `project` or `global` surface shown beside different
threads). So an event that acts on "this
thread" (send a failure to Claude) would reach the first opener's thread. Make anything
thread-specific a **command button** instead: the host runs it with the viewing panel's
context, so the command's `context: thread` arg is the thread the user is looking at.
Command args travel inside the view (its 256 KB budget; an event's `data` is capped at
1 KB): pass an id the command can look up (a run id, a job id), not the text itself.

The instance id is `<plugin>/<surface>/<scope id>` (`gh-actions/runs/pr:octo/app#12`,
`minimal/status/thread:s-1f2e3d4c5b6a`). `SurfaceOpen.Facts` also carries the value of
every fact the surface's `when` clause reads. Each surface gets a command
`plugin.<name>.show.<id>` (`code-foundry plugin <name> show <id>`) that opens it in the
GUI; it is available exactly where the surface is.

## Icons

The GUI draws these lucide icons (header and surface icons, glyphs, buttons, notices;
`ui.Icons` in the SDK, `ui.KnownIcon(name)`); any other name draws a plain circle:

{{cf.icons}}

## When clauses

```
expr    := or ;  or := and ("||" and)* ;  and := unary ("&&" unary)*
unary   := "!" unary | "(" expr ")" | operand [op operand]
op      := "==" | "!=" | "=~" | "in"
operand := fact | "str" | 'str' | number | true | false | null | [literal, ...] | /re2/
fact    := segment ("." segment)*        segment := [A-Za-z_][A-Za-z0-9_-]*
```

- A bare operand is true unless it is null, false, "", 0 or [].
- `==` / `!=` compare like kinds; with a list on either side, `==` holds if any element
  matches, `!=` if none does. `=~` takes a regular expression on the right:
  `project.slug =~ /^acme\//`. Comparisons do not chain.
- `x in y`: any element of x equals any element of y (a scalar is a one-element list):
  `"github-actions" in pr.checks.provider`, `project.slug in ["acme/api", "acme/web"]`.
- Facts about pull request checks are fetched lazily, the first time a clause reads them
  for a thread: until they arrive the clause is "not known yet" (unavailable: `plugin
  surface` fails with `not known yet (…waits on a pull request's checks)`, `plugin list`
  shows `off`); retry a few seconds later. A new thread's branch is matched to its pull
  request by the next GitHub poll (up to a minute with the app open). `unknown && false`
  is false, `unknown || true` is true.
- A clause that does not parse is a plugin issue (NOTE column) and its command or surface
  is never available.

Host facts (this build): {{cf.facts}}.

| Fact | Value |
|---|---|
| `view` | the view the user is in |
| `thread`, `thread.id`, `thread.branch` | a known thread is active; its id and branch |
| `thread.state`, `thread.status` | its process (`starting`, `connected`, `closing`, `disconnected`) and its status (`busy`, `idle`, `needs attention`, `error`) |
| `thread.hasPr`, `thread.pr.url` (list), `thread.pr.number`, `thread.pr.repo` | the thread's pull requests: its branch's first, then ones Claude linked |
| `project`, `project.id`, `.name`, `.slug` (`owner/repo`), `.git` | the context's project, else the thread's |
| `workspace`, `workspace.id` | the context's workspace, else the thread's |
| `pr.checks` (any), `pr.checks.provider`, `.app`, `.name`, `.workflow`, `.url`, `.conclusion` (lists) | the checks of the thread's first pull request. `provider` is the GitHub App's slug (`github-actions`), `github-actions` for an Actions URL, else `status` (a commit status: Jenkins and other external CI); `pluginsdk.CheckProvider` computes it the same way |
| `<plugin>.<key>` | what a plugin set with `Host.SetContext` (`reference/host-api.md`): the thread's value, else the project's, else the global one |

Examples: `thread.hasPr`, `project.slug == "acme/api"`, `!thread || thread.status == "idle"`,
`gh-actions.failing` (a fact the plugin sets per thread), `"status" in pr.checks.provider
&& pr.checks.url =~ /jenkins\.acme\.com/`.

Check availability from the CLI: `code-foundry commands --context-thread <id>` (the
AVAILABLE column: yes or no), `code-foundry plugin list --context-thread <id>`
(`runs(on)`), and running the command, which says why it is unavailable ("its condition
does not hold here: …", "not known yet …").
