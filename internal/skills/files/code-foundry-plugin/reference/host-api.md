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
  value. stderr lines land in the same log.

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
GitHub can also run `gh` itself (it is on PATH with the user's login).

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
- Flags are persisted and outlive restarts: `h.Flags()` (in Init) lists the plugin's
  live flags so it can clear what no longer holds. Disabling the plugin or archiving the
  thread clears them. `code-foundry thread flags <id>` shows them.

## SetContext: facts for when clauses

```go
_ = h.SetContext(pluginsdk.ContextParams{Key: "failing", Value: true, ThreadID: id})  // gh-actions.failing on that thread
_ = h.SetContext(pluginsdk.ContextParams{Key: "signed-in", Value: true})                // global
_ = h.SetContext(pluginsdk.ContextParams{Key: "failing", Value: nil, ThreadID: id})   // remove
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
- `Env`: names `[A-Za-z_][A-Za-z0-9_]*`, text values up to 8 KiB, at most 64. Reserved:
  `PATH`, `HOME`, `SHELL`, `USER`, `TMPDIR`, `CLAUDECODE`, `CLAUDE_CONFIG_DIR`,
  `CLAUDE_EFFORT` and anything starting `CODE_FOUNDRY_` or `CLAUDE_CODE_`.
- `PathPrepend` (prepended to PATH) and `AddDirs` (`--add-dir`, must exist): absolute or
  `~/` paths under the home directory, at most 16 each.
- `Scope`: nil means every project; `Projects` (project ids) limits it to their threads
  (a workspace thread counts if any member is listed); `NoProject` adds threads without
  a project.
- What breaks a rule is dropped with an issue in `res.Issues`; the rest applies
  (`res.Applied`). Plugins apply in name order: a variable an earlier plugin sets is
  dropped from a later one, with an issue. `code-foundry plugin env <name>` shows the
  result.
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

## Secrets (permission `secrets`)

```go
token, ok, err := h.Secrets().Get(ctx, "token")
err = h.Secrets().Set(ctx, "token", value)
err = h.Secrets().Delete(ctx, "token")
list, err := h.Secrets().List(ctx) // names and set times, never values
```

- The values live in the user's login Keychain (service `code-foundry-plugin`, account
  `<plugin>/<key>`), namespaced to the plugin. Keys `[A-Za-z0-9._-]{1,128}`; values
  non-empty UTF-8 up to 16 KiB.
- Values travel host → plugin only. Never put one in a view, a log, a toast, a command
  arg, argv or an environment variable you push.
- The usual way in is a form secret input with `store` (`reference/primitives.md`): the
  user types it, the host stores it, the plugin only reads it. A plugin that needs a
  secret it does not have shows a notice with a form, not an error.
- The user sees and deletes them with `code-foundry plugin secrets list|delete <name>`;
  disabling the plugin keeps them.

## Toasts

`h.Toast(pluginsdk.ToastInfo, "Rerun started")` shows a short message in the app
(`ToastAttention`, `ToastError` for the other tones); `h.ToastIn(instance, level, text)`
shows it in that surface's panel. Up to 200 characters, at most one a second per plugin
(more are dropped). A command's `Message` is toasted anyway when it runs from the GUI: do
not toast it twice.

## Views

`h.UpdateView(instance, view)`, `h.AppendLog(instance, key, text)`,
`h.AppendLogLines(instance, key, lines...)`: `reference/primitives.md`.

## Later

Plugin-owned threads and terminals (`thread/create`, `thread/send`, `terminal/create`,
`terminal/close`; permissions `threads`, `terminals`) arrive in a later version; the SDK
has no methods for them yet and the host answers -32601.
