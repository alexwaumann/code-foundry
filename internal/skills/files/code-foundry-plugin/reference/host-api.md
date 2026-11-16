# The host API (`*pluginsdk.Host`)

{{cf.provenance}}

Every handler gets `h *pluginsdk.Host`. Each method is one protocol call; the host checks
it against what the user granted (the manifest's `permissions`) and answers
-32001 `CodePermissionDenied` otherwise. Requests take a context: pass the handler's `ctx`
(it ends when the call it serves ends) or your own with a timeout. `SetContext`, `Toast`,
`ToastIn` and `ToastWith` are notifications: no context, and their error only says the message could
not be sent (a refusal shows in the plugin's log).

## Identity and logging

- `h.Name()`, `h.Dir()` (package folder, also the working directory), `h.DataDir()` (own
  state folder, 0700, kept across updates: caches, non-secret settings; never build the
  path yourself), `h.Granted()` (the permissions the user consented to), `h.Dev()`
  (running under `plugin dev`), `h.HostVersion()`, `h.HasCapability("view.tabs")`.
- `h.Log()` is a `*slog.Logger` writing to the plugin's log (`code-foundry plugin logs
  <name>`) and, at its level, the daemon's. Log keys, ids and counts; never a secret's
  value. Integers print as written (`run=39128319017`). stderr lines land in the same
  log.
- **Running the user's tools.** The plugin's PATH is the daemon's, which may lack
  Homebrew's or a version manager's tools. Run project tools through the login shell, as
  project actions do: `exec.Command(os.Getenv("SHELL"), "-lc", cmd)` (fall back to
  `/bin/zsh`), with `Dir` set to the worktree. `gh` and `git` are
  usually on PATH; resolve them the same way if not.

## Invoke: run a Code Foundry command

```go
res, err := h.Invoke(ctx, "thread.send", map[string]string{"text": "The deploy failed: …"},
	pluginsdk.UiContext{ThreadID: threadID})
```

- The command must match a glob in `permissions.commands`; `plugin.<verb>` management
  commands never do. The list of commands and their positional args:
  `reference/host-commands.md` (thread and view ones: `host-commands-thread-view.md`); every
  flag of one: `code-foundry help <command>`.
- `args` are the command's arg names (its flags) as strings; booleans "true"/"false".
  The context (`UiContext{ThreadID, ProjectID, WorktreePath, TerminalID, WorkspaceID}`)
  is what "the active thread" etc. means to the command: pass the thread the user is
  looking at (from `req.Context` or `SurfaceOpen.Context`).
- The result: `res.Message` (what the CLI would print), `res.JSON` (what `--json` prints:
  decode it), `res.ExitCode`. The host logs each call as `plugin:<name>`.
- A command that asks the user first (destructive ones; shown with `--yes`) fails with
  -32003 `CodeConfirmationRequired`: the plugin never confirms for the user.
  `h.InvokeAsk(...)` instead hands it to the GUI, which shows the command's own confirm
  dialog; it answers at once with `res.JSON = {"asked": true, "windows": N, "receivers":
  M}` (app windows open; streams that got it, CLI ones too, also in `delivered`) and
  fails like Invoke when no window is open. Learn the outcome from events.
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
or isolated daemon). `gh` events are sent only when that poll sees a change. Each poll
sends one `gh.pullRequestChanged` per pull request that changed, saying what changed
(`CHECKS`, `HEAD_PUSHED`, …; table below), for every pull request in the viewer's scope:
their open pull requests, those asking for or with their review, those merged in the
last week, and the viewer's pull requests on branches the app or a `pr.*` fact looked at
in the last 10 minutes. To follow check runs, subscribe to `gh` and call `pr.checks` when
a `CHECKS` or `HEAD_PUSHED` change names a pull request you care about; no timer is
needed. Latency is the poll interval. The `pr.checks` command reads the cached pull
request detail and fetches it again when it is older than about 30 s or the poll saw the
pull request move, so it is fresh when called (`when` clauses read `pr.checks.*` from a
cache of their own: `manifest.md`). A pull request outside that scope (someone else's)
sends nothing: sweep those with `pr.checks` or `gh`, about once a minute while something
runs, only while someone looks or a flag depends on it. A thread's pull request:
`pr.checks` with the thread's context answers -32002 "has no pull request" when there is
none (a new thread's branch is linked by the next poll); the `threadList` payload carries
only `branch` and the pull requests Claude linked (`linkedPullRequests`). That `branch`
is the one Code Foundry made the thread's worktree on, empty in an existing checkout; the
branch checked out now is the `project` source's `worktrees[].branch` for the thread's
`worktreePath`.

## Notify: the bell (permission `notifications`)

```go
res, err := h.Notify(ctx, pluginsdk.Notification{
	Key: "deploy-prod", Level: pluginsdk.NotifyError, ThreadID: id,
	Title: "Deploy to prod failed", Body: "Step migrate exited 1.",
	Actions: []pluginsdk.NotificationAction{
		pluginsdk.CommandAction("Open run", "open-run", map[string]string{"run": "42", "thread": id}),
		pluginsdk.OpenAction("Logs", runURL),
	},
})
gone, err := h.WithdrawNotification(ctx, "deploy-prod") // what it reported is over
```

- A notification goes in the bell in the app's top bar: one list, the same in every space.
  `Title` is one short line (at most 120 characters), `Body` optional (1000), `Level`
  `NotifyInfo` (default), `NotifyWarning` or `NotifyError`; there is no success.
  `TimeSensitive`, apart from the level, sorts it first, tints it and counts it in the Dock
  badge: only for what cannot wait. `ThreadID` names the thread it is about (it must
  exist). `ShowAt` keeps it back until then; the host holds the timer.
- **Keys.** One notification per plugin and `Key`; no plugin reaches another's. The same
  key with the same content is dropped (no card, no toast: re-post on every poll freely);
  changed content updates the card in place without a new toast; a key the user dismissed
  stays dismissed until its content changes. No key: the host derives one from title,
  body and thread. `res.Outcome` says what happened (`posted`, `updated`, `unchanged`,
  `scheduled`), `res.Status` where it stands (`shown`, `dismissed`, `resolved`, …).
- **Lifetime**: until the user dismisses it, presses an action that resolves it, or the
  plugin withdraws it by key (withdrawing a key with nothing active is not an error).
  Disabling or uninstalling the plugin withdraws them all; a restart or update keeps them.
- **Actions**: at most three buttons, the first the primary. `CommandAction` runs one of
  this plugin's manifest commands with args it declares, as the palette does (its
  `confirm` asks first; it gets no thread or project, so the args say what it is about);
  `SendAction` sends text to a thread; `StartAction` starts a thread with a prompt;
  `OpenAction` opens a URL. Command, send and start resolve the notification, open does
  not; `Resolves` overrides. Dismiss, Snooze and the thread's link are the host's, on
  every card: never add them.
- **Open the panel on an item**: the button runs the plugin's own command, which selects
  the item in its view state and calls `h.Invoke(ctx, "plugin.<name>.show.<surface>",
  map[string]string{"focus": "true"}, pluginsdk.UiContext{ThreadID: id})` (that show command
  listed in `permissions.commands`). The example's `notify.go` does it.
- **The host raises the arrival toast**, with the buttons, when a notification arrives:
  never toast for a notification.
- **About a thread** (what a flag used to say): set `ThreadID`, a key of your own per
  thread and condition (`"tests:" + id`), `NotifyWarning` or `NotifyError`. Post it while
  the condition holds (re-posting the same content is free) and withdraw the key when it
  ends. A one-off event (a run failed) names what happened in its content (`"Run 42
  failed"`), so the next one is a new card. Never post again what the user dismissed: the
  key rule keeps it dismissed until the content changes, so do not work around it with a
  new key. Keys starting with `flag:` are the host's.
- **An event a thread may wait on is reported once**, with the notification attached to
  the wake fire (`wakes.md`, "Report an event once"), never a fire plus a `Notify`.
- Refusals: no permission -32001; a command or arg the manifest does not declare, a bad
  level, title, URL or a `flag:` key -32602; an unknown thread -32004; over 10 posts a second -32005; 100
  active per plugin -32002. A host without `pluginsdk.NotificationsCapability` has none.

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

## SetEnvironment: what new Claude threads and shells get (permission `sessionEnv`)

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
  kept across restarts. An empty `Environment{}` withdraws it. New threads get the new
  one. A running thread keeps what it started with: its header shows "Plugin environment
  changed · Restart to apply" (only when what it would get really differs: pushing the
  same values again changes nothing), and the user restarts Claude for it
  (`thread restart`, the same conversation). New shells in scope (terminal tabs, quick terminals) get the
  `Env` and `PathPrepend` too (not `AddDirs`); running shells keep theirs. Do not push on
  a timer: every real change asks the user to restart their threads.
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
  limits it to their threads (a thread with several projects counts if any is listed), and
  `NoProject` adds threads without a project.
- What breaks a rule is dropped with an issue in `res.Issues`; the rest applies
  (`res.Applied`). Plugins apply in name order: a variable an earlier plugin sets is
  dropped from a later one, with an issue. `code-foundry plugin env <name>` shows the
  result (variable names, never their values).
- A new thread waits up to 2 s for a plugin with this permission that is still starting,
  so push early in Init.

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
  non-empty UTF-8 up to 1800 bytes. Only keys this plugin set through the host are read.
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
- The usual way in is a form secret input with `store` (`forms.md`): the
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
toaster (bottom right), in every window, the text as its title.
`h.ToastIn(instance, level, text)` shows the same toast only to whoever has that
instance on screen: not inside the surface. The plugin's name is not on a toast, so the
text has to say what it is about.
Levels: `ToastSuccess`, `ToastInfo`, `ToastAttention` (the app's warning), `ToastError`;
each tints the card. For a message that should stay with the surface, render a `notice` node.

`h.ToastWith(pluginsdk.ToastParams{Instance, Level, Text, Description})` adds a
description: `Text` is the title and the description goes under it, with or without an
instance. Keep the text short, it is the title
("Note saved", "Build #42 queued again"); the detail goes in the description ("On build
#41"). Text up to 200 characters, description up to 500, at most one toast a second per
plugin (more are dropped). A command's `Message` is toasted anyway when it runs from the
GUI: do not toast it twice.

Use success sparingly: feedback for an act belongs where it happened (the view after it
shows the change). A success toast is for when that place is gone (the act closed it, or
the result lands elsewhere: "Sent to the thread") or for background work that finished.
A host without capability `view.toast.description` (before this release) shows success as
info and drops the description, so the text must read right alone.

## SetFlag (deprecated since 2026-11-16: use Notify)

`h.SetFlag` (`thread/setFlag`, permission `threadStatus`) still works: the host turns the
flag into a notification naming the thread, under key `flag:<thread>`, warning for
`FlagAttention`, error for `FlagError`, the reason as its title; `FlagNone` withdraws it,
and an `UntilSeen` one is dismissed when the user opens the thread. It no longer changes
the thread's row. `h.Flags()` lists the plugin's active flag notifications. The plugin's
log says once per run that it is deprecated. Move to `Notify` ("About a thread" above);
`removals.md` has the list of calls on their way out.

## Elsewhere

`h.UpdateView`, `h.AppendLog`, `h.AppendLogLines`: `primitives.md`. `h.Subscribe`: `events.md`.
`h.FireWake`, `h.FireWakeNotify`: `wakes.md`. `h.CreateThread`, `h.CreateTerminal`: `owned.md`.

