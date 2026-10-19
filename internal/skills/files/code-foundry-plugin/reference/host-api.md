# The host API (`*pluginsdk.Host`)

Every handler gets `h *pluginsdk.Host`. Each method is one protocol call; the host checks
it against what the user granted (the manifest's `permissions`) and answers
-32001 `CodePermissionDenied` otherwise. Requests take a context: pass the handler's `ctx`
(it ends when the call it serves ends) or your own with a timeout. `SetContext`, `Toast`
and `ToastIn` are notifications: no context, and their error only says the message could
not be sent (a refusal shows in the plugin's log).

## Identity and logging

- `h.Name()`, `h.Dir()` (package folder, also the working directory), `h.DataDir()` (own
  state folder, 0700, kept across updates: caches, settings that are not secret; always
  use it rather than building the path, which follows the Code Foundry home),
  `h.Granted()` (the permissions the user consented to), `h.Dev()` (running under
  `plugin dev`), `h.HostVersion()`, `h.HasCapability("view.tabs")`.
- `h.Log()` is a `*slog.Logger` writing to the plugin's log (`code-foundry plugin logs
  <name>`) and, at its level, the daemon's. Log keys, ids and counts; never a secret's
  value. Integers print as written (`run=39128319017`). stderr lines land in the same
  log.
- **Running the user's tools.** The plugin's PATH is the daemon's, which may lack what
  the user's terminal has (Homebrew, a Go or Node version manager). Run project tools
  through the login shell, as project actions do: `exec.Command(os.Getenv("SHELL"), "-lc",
  cmd)` (fall back to `/bin/zsh`), with `Dir` set to the worktree. `gh` and `git` are
  usually on PATH; resolve them the same way if not.

## Invoke: run a Code Foundry command

```go
res, err := h.Invoke(ctx, "thread.send", map[string]string{"text": "The deploy failed: …"},
	pluginsdk.UiContext{ThreadID: threadID})
```

- The command must match a glob in `permissions.commands`; `plugin.<verb>` management
  commands never do. The list of commands and their positional args:
  `reference/host-commands.md`; every flag of one: `code-foundry help <command>`.
- `args` are the command's arg names (its flags) as strings; booleans "true"/"false".
  The context (`UiContext{ThreadID, ProjectID, WorktreePath, TerminalID, WorkspaceID}`)
  is what "the active thread" etc. means to the command: pass the thread the user is
  looking at (from `req.Context` or `SurfaceOpen.Context`).
- The result: `res.Message` (what the CLI would print), `res.JSON` (what `--json` prints:
  decode it), `res.ExitCode`. The host logs each call as `plugin:<name>`.
- A command that asks the user first (destructive ones; shown with `--yes`) fails with
  -32003 `CodeConfirmationRequired`: the plugin never confirms for the user.
  `h.InvokeAsk(...)` instead hands it to the GUI, which shows the command's own confirm
  dialog; it answers at once with `res.JSON = {"asked": true, "delivered": <windows>}`
  (and fails like Invoke when no GUI is open). Learn the outcome from events.
- Other failures keep their code: -32004 not found, -32602 invalid args, -32002 not
  available here. `pluginsdk.ErrorCode(err)` reads it.

Useful commands: `thread.send` (a message into a thread: `"Send failure to Claude"`),
`pr.checks` (a pull request's checks, `--json` shape `{repo, number, url, headSha,
checks: [{name, workflow, status, conclusion, app, provider, url, startedAt,
completedAt}]}`), `thread.get`, `thread.list`, `project.list`. A plugin that only needs
GitHub can also run `gh` itself (with the user's login).

**`pr.checks` and how fresh GitHub data is.** The daemon polls GitHub every
`github.poll_interval_seconds` (60 s) while an app window is visible, at most every 5
minutes while every window is hidden, and every 15 minutes with no app open (a CLI-only
or isolated daemon). `gh` events are sent only when that poll sees a change, so a plugin
cannot rely on them to follow check runs. `pr.checks` reads the cached pull request
detail and fetches it again when it is older than about 30 s, so it is fresh when called.
To follow runs, sweep: call `pr.checks` (or `gh`) per thread of interest about once a
minute while something runs and every few minutes otherwise, only while someone looks or
a flag depends on it. A thread's pull request: `pr.checks` with the thread's context
answers -32002 "has no pull request" when there is none (a new thread's branch is linked
by the next poll); the `threadList` payload carries only `branch` and the pull requests
Claude linked (`linkedPullRequests`).

## SetFlag: thread attention and error (permission `threadStatus`)

```go
err := h.SetFlag(ctx, pluginsdk.Flag{ThreadID: id, Level: pluginsdk.FlagError, Reason: "tests failed in pkg/api"})
err = h.SetFlag(ctx, pluginsdk.Flag{ThreadID: id, Level: pluginsdk.FlagNone}) // clear
```

- A flag puts the thread in the sidebar's attention group with "<display name>: <reason>"
  on its second line (amber for `attention`, red for `error`), rings the bell and the
  dock. It never changes the thread's own status.
- One flag per (thread, plugin): setting another replaces it; `FlagNone` clears it.
  `Reason` is one line of 1..80 characters without the plugin's name. `UntilSeen` clears
  it when the user opens the thread (at once if it is open now: then nothing is stored).
- At most one flag a second per thread (-32005 `CodeRateLimited`; clearing is never
  limited). An unknown thread is -32004; an archived one -32002.
- Setting the same level and reason again is a no-op (no bell, the set time stays): to
  ring again for a new failure, change the reason ("3 tests failed in pkg/api") or clear
  first. `UntilSeen` stays until a viewer opens the thread (the GUI showing it); without
  a GUI it stays.
- Flags are persisted and outlive restarts: `h.Flags()` (in Init) lists the plugin's
  live flags so it can clear what no longer holds (`plugintest.Options.Flags` tests it).
  Disabling the plugin or archiving the thread clears them. `code-foundry thread flags
  <id>` shows them.

**Choosing a flag mode** is the plugin's call; make it on purpose. `UntilSeen` suits a
one-off event the user only needs to notice (a CI run failed, a deploy finished): opening
the thread is the acknowledgement. Sticky (`UntilSeen: false`) suits a condition that
lasts until something changes (tests failing, a pull request blocked) and that the plugin
will clear itself (`FlagNone`) when it ends. A sticky flag must leave the user a visible
way out, because a plugin's quirk can keep it up for good: a clear command (a manifest
command, so the palette and CLI have it, with its button in the surface) or a line in the
surface saying the header chip's × or `code-foundry thread flag clear <id> --plugin
<name>` removes it. A user's clear is not reported to the plugin (a `threads`
subscription sees it leave `Thread.flags`), so remember the condition you flagged, not
whether the flag is up, and never raise it again until the condition changes (a different
set of failing tests, a new run that fails).

## SetContext: facts for when clauses

```go
_ = h.SetContext(pluginsdk.ContextParams{Key: "failing", Value: true, ThreadID: id})  // gh-actions.failing on that thread
_ = h.SetContext(pluginsdk.ContextParams{Key: "signed-in", Value: true})                // global
_ = h.SetContext(pluginsdk.ContextParams{Key: "failing", Value: nil, ThreadID: id})   // remove
// The same, typed:
_ = h.SetContextBool("failing", true, pluginsdk.ForThread(id))
_ = h.SetContextBool("signed-in", true)
_ = h.ClearContext("failing", pluginsdk.ForThread(id))
// also SetContextString, SetContextInt, SetContextStrings; pluginsdk.ForProject(id)
```

- Readable in every `when` clause as `<plugin>.<key>`: the thread's value, else the
  project's (`ProjectID`), else the global one. Commands and surfaces re-evaluate at once.
- Key: segments `[A-Za-z_][A-Za-z0-9_-]*`, up to 64 characters, with or without the
  `<plugin>.` prefix. Value: null (removes), a boolean, a string (1 KB), a number, or a
  list of those (100). For a thread or a project, not both. At most 1000 per plugin.
- A notification: a refusal only shows in the plugin's log. Facts belong to the process:
  after a restart there are none, so set them again in Init.

## SetEnvironment: what new Claude threads get (permission `sessionEnv`)

```go
res, err := h.SetEnvironment(ctx, pluginsdk.Environment{
	Env:         map[string]string{"ACME_API": "https://api.acme.dev"},
	PathPrepend: []string{"~/.acme/bin"},
	AddDirs:     []string{"~/acme/shared-docs"},
	Scope:       &pluginsdk.EnvironmentScope{Projects: []string{projectID}, NoProject: false},
})
for _, issue := range res.Issues { h.Log().Warn("environment", "issue", issue) }
```

- Pushed, not asked for: push in Init and again whenever it changes; the last push is
  kept across restarts. An empty `Environment{}` withdraws it. Running threads keep what
  they started with; new threads (and restarts) get the new one.
- `Env`: names `[A-Za-z_][A-Za-z0-9_]*`, text values up to 8 KiB, at most 64. Reserved,
  in any case (`path` is `PATH` to a shell): `PATH`, `HOME`, `SHELL`, `USER`, `TMPDIR`,
  `CLAUDECODE`, `CLAUDE_CONFIG_DIR`, `CLAUDE_EFFORT` and anything starting
  `CODE_FOUNDRY_` or `CLAUDE_CODE_`; and the keys
  that load code into every process the thread starts: `NODE_OPTIONS`, `PYTHONPATH`,
  `PERL5OPT`, `RUBYOPT`, `BASH_ENV`, `ENV`, `ZDOTDIR`, `SSH_ASKPASS` and anything starting
  `DYLD_` or `LD_`. `ANTHROPIC_*` and `AWS_*` are allowed (an auth plugin sets them).
  The same rules apply to a plugin thread's and terminal's own `Env`.
- `PathPrepend` (prepended to PATH) and `AddDirs` (`--add-dir`, must exist): absolute or
  `~/` paths under the home directory, at most 16 each.
- `Scope`: nil means threads of every project but not threads without a project;
  `&pluginsdk.EnvironmentScope{NoProject: true}` is everywhere; `Projects` (project ids)
  limits it to their threads (a workspace thread counts if any member is listed), and
  `NoProject` adds threads without a project.
- What breaks a rule is dropped with an issue in `res.Issues`; the rest applies
  (`res.Applied`). Plugins apply in name order: a variable an earlier plugin sets is
  dropped from a later one, with an issue. `code-foundry plugin env <name>` shows the
  result (variable names, never their values).
- A new thread waits up to 2 s for a plugin with this permission that is still starting,
  so push early in Init.

## Subscribe and OnEvent: the daemon's events (permission `events`)

```go
pluginsdk.Plugin{
	Init: func(ctx context.Context, h *pluginsdk.Host) error {
		_, err := h.Subscribe(ctx, "threads", "gh")
		return err
	},
	OnEvent: func(ctx context.Context, h *pluginsdk.Host, ev pluginsdk.Event) {
		var e struct {
			ThreadList *struct {
				Updated *struct{ ID, Name, Branch, Status string } `json:"updated"`
			} `json:"threadList"`
		}
		if json.Unmarshal(ev.Event, &e) == nil && e.ThreadList != nil && e.ThreadList.Updated != nil { … }
	},
}
```

- Sources (each must be in `permissions.events`): `threads` (the thread list: every
  thread's state), `thread` (threads' pending questions and permissions), `project`
  (projects and worktrees), `workspace`, `gh` (GitHub polling: pull requests, checks),
  `gitops` (git operations per worktree), `settings`, `update`, `action` (project
  actions and their runs), `plugin`.
- `ev.Event` is the event as JSON, exactly what `code-foundry events --json --source
  <source>` prints for the same source: one object keyed by the source with one change
  inside, plus `seq` and `epoch` (enums are their full names, `THREAD_STATUS_IDLE`):
  ```json
  {"threadList":{"updated":{"id":"s-1f2e3d4c5b6a","name":"Fix the login redirect","status":"THREAD_STATUS_IDLE", …}},"seq":"42","epoch":"c85aff6ef6fc"}
  {"threadList":{"removedId":"s-1e06a2c44e99"},"seq":"43","epoch":"c85aff6ef6fc"}
  {"gitops":{"finished":{…}},"seq":"44","epoch":"c85aff6ef6fc"}
  ```
  `updated` carries the whole object after the change, `removedId` (or `removedName`)
  the id of what went; `snapshot` replaces everything. The table below lists every
  change. See real payloads before decoding them: `events` streams until killed, so
  capture a few seconds of it (macOS has no `timeout`), doing whatever should produce the
  events meanwhile:
  ```
  code-foundry events --json --source thread-list > /tmp/events.json & pid=$!; sleep 5; kill $pid
  ```
  `code-foundry thread get <id> --json` shows a thread's fields. Decode only what you
  need.
- Each source starts with its snapshot (`ev.Snapshot` true; `{"threadList":{"snapshot":{"threads":[…]}}}`),
  then live events in order. Events may reach OnEvent before Subscribe returns.
- OnEvent runs on the notification goroutine: keep it short (hand work to a goroutine).
  A plugin that falls behind loses the oldest events (the host keeps 2,048 or 8 MiB) and
  then gets that source's snapshot again: treat a snapshot as "replace what you know".
- Subscriptions end with the process: subscribe in Init. At most 16 at once;
  `h.Unsubscribe(ctx, id)` ends one.

Every source and the changes it sends (this build):

{{cf.eventVariants}}

**The payloads.** protojson: lowerCamel fields, enums by full name, and empty lists,
`false`, `0` and `""` left out (an empty snapshot is `{"threadList":{"snapshot":{}}}`,
with no `threads`). The useful fields:

| Change | Fields |
|---|---|
| `threadList.snapshot` | `threads`: a list of threads |
| `threadList.updated` (a thread) | `id`, `projectId`, `workspaceId`, `worktreePath` (its cwd), `branch`, `name`, `state` (`THREAD_STATE_CONNECTED`, …), `status` (`THREAD_STATUS_BUSY`, `_IDLE`, `_NEEDS_ATTENTION`, `_ERROR`), `statusReason`, `lastActivityAt`, `linkedPullRequests` (`[{slug, number, url}]`), `archivedAt` |
| `threadList.removedId` | the removed thread's id (a string). Archiving is not removal: it arrives as `updated` with `archivedAt` set |
| `project.snapshot` | `projects`: each with `id`, `name`, `path`, `githubSlug`, `defaultBranch`, `git`, `worktrees` |
| `project.worktreeUpdated` (a worktree) | `projectId`, `path`, `branch`, `head`, `isMain`, `detached`, `status`: `{modified, staged, untracked, conflicted, dirty, ahead, behind, upstream, baseRef, baseAhead, baseBehind, operation, error, refreshedAt}` |
| `project.worktreeRemoved` | `{projectId, path}` |
| `project.projectUpdated` / `projectRemovedId` | a whole project (with its worktrees) / an id |
| `gh.branchPullRequestsUpdated` | `{repoSlug, headRef, fetchedAt}`: a watched branch's pull requests changed |
| `gh.pullRequestDetailUpdated` | `{repoSlug, number}`: re-read with `pr.checks` |
| `gitops.queued` / `started` / `finished` | a git operation on a worktree (fetch, pull, push, …) |

**No per-file events.** `project.worktreeUpdated` is sent when a worktree's status
*summary* changes: the counts above, `dirty`, `head`, `branch`, `operation`. Editing a file
that is already modified changes none of them and sends nothing. `worktreeDetailUpdated`
is sent only for worktrees whose detail someone asked for in the last 10 minutes (the
app's worktree panel), so a plugin cannot rely on it. A plugin that must see every edit
(a test watcher) uses `worktreeUpdated` as a hint and polls the worktree it watches
itself (`git status --porcelain` plus file mtimes, every second or two), only while a
viewer or a flag needs it.

## Secrets (permission `secrets`)

```go
token, ok, err := h.Secrets().Get(ctx, "token")
err = h.Secrets().Set(ctx, "token", value)
err = h.Secrets().Delete(ctx, "token")
list, err := h.Secrets().List(ctx) // names and set times, never values
```

- The values live in the user's login Keychain (service `code-foundry-plugin`, or
  `code-foundry-plugin-<hash>` for a `CODE_FOUNDRY_HOME` other than `~/.code-foundry`;
  account `<plugin>/<key>`), namespaced to the plugin by the host. Keys
  `[A-Za-z0-9._-]{1,128}` (anything else, `/` included, is invalid params); values
  non-empty UTF-8 up to 16 KiB. Only keys this plugin set through the host are read.
- They belong to the plugin's source (its registry, release repository or dev folder):
  a package of the same name from elsewhere starts without them (`plugin install` /
  `plugin dev --force` deletes them, data dir and consent included). Linking the plugin
  from another folder (a second checkout) is such a change.
- Values travel host → plugin only. Never put one in a view, a log, a toast, a command
  arg, argv or an environment variable you push (the host shows pushed variables by name
  only, but threads see them). The host cannot stop a plugin from leaking its own
  secret; it only never does so itself.
- This is isolation between well-behaved plugins, not a sandbox: a plugin runs as the
  user, and the items trust `/usr/bin/security`, so any of the user's processes can read
  them.
- The usual way in is a form secret input with `store` (`reference/primitives.md`): the
  user types it, the host stores it, the plugin only reads it. A plugin that needs a
  secret it does not have shows a notice with a form, not an error.
- The user sees and deletes them with `code-foundry plugin secrets list|delete <name>`
  (and in Settings). Disabling the plugin keeps them; `uninstall --purge` deletes them.

When the user deletes one, a running plugin gets `secret/changed` `{key, deleted: true}`
(`Plugin.OnSecretChanged`; not for its own `Delete`): drop what it read from it (a client,
a cached token) and bring back the form or notice that asks for it. A plugin that was
not running learns nothing, so still read a secret when you need it and handle "not
found" rather than caching that it exists. Consent never changes under a running plugin:
when an update asks for more the host stops it until the user consents again, and every
start hands over what was granted (`h.Granted()`). Test it with plugintest's
`h.DeleteSecret(key)`.

## Toasts

`h.Toast(pluginsdk.ToastInfo, "Rerun started")` shows a short message in the app's
toaster (bottom right) with the plugin's display name as its title (`ToastAttention`,
`ToastError` for the other levels, which differ by icon, not colour).
`h.ToastIn(instance, level, text)` shows it in the same toaster, without the name, only
to whoever has that instance on screen: not inside the panel. For a message that should
stay with the panel, render a `notice` node. Up to 200 characters, at most one a second per plugin
(more are dropped). A command's `Message` is toasted anyway when it runs from the GUI: do
not toast it twice.

## Views

`h.UpdateView(instance, view)`, `h.AppendLog(instance, key, text)`,
`h.AppendLogLines(instance, key, lines...)`: `reference/primitives.md`.

## Threads and terminals of its own (permissions `threads`, `terminals`)

```go
// A skill for the thread: Claude Code loads <add-dir>/.claude/skills/<skill>/SKILL.md.
skillDir := filepath.Join(h.DataDir(), "claude")
_ = os.MkdirAll(filepath.Join(skillDir, ".claude", "skills", "deploy-helper"), 0o755)
_ = os.WriteFile(filepath.Join(skillDir, ".claude", "skills", "deploy-helper", "SKILL.md"), skillMD, 0o644)
id, err := h.CreateThread(ctx, pluginsdk.ThreadCreateParams{Title: "Deploy helper",
	AddDirs: []string{skillDir}, Env: map[string]string{"DEPLOYBOT_URL": url}})
err = h.SendThread(ctx, id, "Summarize the last failed deploy in one line.")
term, err := h.CreateTerminal(ctx, pluginsdk.TerminalCreateParams{Argv: []string{"make", "test"}, Title: "tests"})
```

`CreateThread` makes a Claude thread the plugin owns: hidden from the sidebar, `thread
list`, attention counts and the dock (`code-foundry plugin threads <name>` lists them),
shown by a `thread` node. `Cwd` defaults to the plugin's data dir (with `ProjectID`, the
project's main worktree; a `cwd` must be under home); `Env` and `AddDirs` follow the
session environment's rules, but a bad one refuses the call, and they replace the
plugin's own session environment for this thread; `Model` and `Effort` default to the
user's settings (`Model` a model id, `Effort` `low` … `max`: the values `code-foundry help
thread.new` lists for `--model` and `--effort`); `Prompt` is an optional first message.
An `AddDirs` entry (here or in `SetEnvironment`) is a directory Claude Code may read and
loads skills from: a skill is `<dir>/.claude/skills/<skill>/SKILL.md` (with `name` and
`description` front matter), as above; `<dir>` itself is passed. It runs like any thread: a
message starts its Claude, which stops at cache expiry, and it costs what it costs (the
Usage page counts it). `SendThread` and `ArchiveThread` reach only the plugin's own
threads (-32004 otherwise; a send unarchives; an archived thread's node still renders,
so drop it from the view); `Threads` lists them. To write to the
user's thread, `Invoke` `thread.send` with the id from `act.Context`. `CreateTerminal`
starts a terminal the plugin owns (cwd the data dir unless given, under home; env checked
like a thread's; `$SHELL -lc` for the user's tools), shown by a `terminal` node and, on
request, in the bottom panel; `CloseTerminal` and `Terminals` as for threads, and an exited
terminal stays until closed. At most 32 live threads and 16 terminals. Disabling the
plugin archives its threads (enabling it again finds them with `Threads`; a send
unarchives one) and closes its terminals. Uninstalling it (with or without `--purge`), or
another source taking its name with `--force`, removes its threads for good, as `thread
remove` does (Claude stops first; the user is told how many), and closes its terminals.
Terminals end with the daemon, threads do not (find them again with `Threads` in Init).
plugintest keeps both
in memory (`CreatedThreads`, `ThreadSends`, `PluginTerminals`, `ExitTerminal`,
`SetTerminalText`).

A terminal's output is readable: `h.ReadTerminal(ctx, id, maxBytes)` returns the text on
its screen, plain (no escape sequences), one line per row with trailing spaces trimmed:
the rows the terminal shows (24 by default, more when a viewer made it taller), not the
scrollback above them, and at most `maxBytes` of it (0: 64 KiB, at most 256 KiB; its end,
from a line start, with `Truncated`). When its process exits the plugin gets
`terminal/exited` `{terminalId, exitCode}` (`Plugin.OnTerminalExit`; 128+n when signal n
killed it), once; read the screen then rather than polling `Terminals`. For a run whose
whole output matters, have the command also write it to a file under `h.DataDir()`
(`Argv: []string{"sh", "-c", "go test ./... 2>&1 | tee " + logPath}`) and read that file on exit.
