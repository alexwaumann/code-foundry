# Testing a plugin

Two layers: unit tests against a fake host (`pluginsdk/plugintest`, fast, in `go test`),
then the real daemon (`plugin dev`, `plugin surface`, `plugin act`, `plugin logs`).

## plugintest

`plugintest.Start(t, plugin(), opts)` runs the plugin's `pluginsdk.Plugin` over in-memory
pipes, does the handshake, **waits for `Init` to return** (up to 5 s), records everything
the plugin asks of the host, and shuts the plugin down when the test ends. So what Init
sets up (subscriptions, the environment, state loaded from the data dir) is in place when
Start returns; a plugin whose Init blocks sets `NoInitWait`. It enforces permissions like the real host:
`Invoke` needs a matching `Granted.Commands` glob, secrets need `Granted.Secrets`, flags
`ThreadStatus`, environment `SessionEnv`, subscriptions `Events`.

```go
h := plugintest.Start(t, plugin(), plugintest.Options{
	Name:    "ci",                                     // default "test"
	Granted: pluginsdk.Permissions{Commands: []string{"thread.send"}, Secrets: true, ThreadStatus: true},
	Invoke: func(ctx context.Context, p pluginsdk.InvokeParams) (pluginsdk.CommandResult, error) {
		// answers the plugin's allowed host/invoke calls; nil answers "unknown command"
		return pluginsdk.CommandResult{Message: "sent"}, nil
	},
	Capabilities: []string{"surfaces", "view.tabs"}, // what h.HasCapability sees
	Secrets:      map[string]string{"token": "t0k"},  // stored before Init runs
	Flags:        []pluginsdk.Flag{{ThreadID: "s-1", Level: "error", Reason: "old"}}, // h.Flags() in Init
	DataDir:      dir,                                // default t.TempDir(); h.DataDir() returns it
})
```

Drive it like the host:

| Call | Does |
|---|---|
| `h.Command(ctx, "greet", args, uctx)` | `command/invoke`: returns the plugin's `CommandResult` or error |
| `h.OpenSurface(ctx, instance, "status", uctx)` | `surface/open` + `visibility true` |
| `h.OpenSurfaceWith(ctx, pluginsdk.SurfaceOpen{Instance, Surface, Context, Facts})` | the same with facts: a `pr` surface's `Facts["pr"]` (`json.RawMessage(`{"repo":"octo/app","number":12,"url":"…"}`)`) and the facts its `when` reads |
| `h.Act(ctx, pluginsdk.SurfaceAct{Instance, Kind, Action, Key, Data, Value, Values})` | `surface/act` (Version 0 = the latest) |
| `h.Visibility(instance, false)`, `h.CloseSurface(instance)` | visibility and close notifications |
| `h.Event(pluginsdk.Event{Subscription: "sub-1", Event: json.RawMessage(...)})` | an `events/event` |
| `h.Ping(ctx)`, `h.Shutdown(ctx)` | ping; shutdown and what `Serve` returned |
| `h.SetSecret(key, value)` | a secret as if the user had stored it (a form with `store`) |

And read what the plugin did: `h.View(instance)` (the last view's JSON), `h.Version(instance)`,
`h.Appends()`, `h.Toasts()`, `h.Logs()`, `h.Flags()`, `h.Contexts()`, `h.Environments()`,
`h.Subscriptions()`, `h.Invocations()` (allowed or not), `h.Secret(key)`.

`h.WaitFor(5*time.Second, func(h *plugintest.Host) bool { … })` waits for something done
asynchronously (a goroutine, a notification). It checks the condition at once, after
every call the plugin makes to the host, and every 20 ms, so the condition may read the
plugin's own state too (behind its mutex). On timeout it fails the test with the
plugin's last log lines: a view `UpdateView` refused inside a goroutine shows up there
(the previous view stays, so a test waiting for "loaded" just times out). Calls that are
requests (`UpdateView`, `SetFlag`, `Invoke`, secrets) are recorded before the plugin's
handler returns, so after `h.Act` or `h.Command` returns their effects are visible
without waiting; notifications (`Log`, `Toast`, `SetContext`) and anything from another
goroutine need `WaitFor`.

## Patterns

The example (`example/main_test.go`) has the three tests every plugin should have.

**The manifest matches the code.**

```go
func TestManifest(t *testing.T) {
	data, _ := os.ReadFile("plugin.json")
	m, warnings, err := pluginsdk.LoadManifest(data) // the host's validation
	if err != nil || len(warnings) > 0 {
		t.Fatalf("plugin.json: %v %v", err, warnings)
	}
	p := plugin()
	for _, c := range m.Commands {
		if p.Commands[c.Name] == nil {
			t.Errorf("command %s is declared but not served", c.Name)
		}
	}
	// … the same for surfaces, and the counts both ways
}
```

**Commands, table-driven**, including the errors:

```go
for _, tt := range []struct{ args map[string]string; want, err string }{
	{map[string]string{"name": "Ada"}, "Hello, Ada!", ""},
	{map[string]string{}, "", "a name is required"},
} {
	res, err := h.Command(ctx, "hello", tt.args, pluginsdk.UiContext{ThreadID: "s-1"})
	…
}
```

**Every view valid, every act handled.** Decode the view and run `Validate` (the host's
checks, so a view that passes here is accepted), then act and check the next view:

```go
const inst = "ci/runs/thread:s-1" // <plugin>/<surface>/<scope>: any string works here
if err := h.OpenSurface(ctx, inst, "runs", pluginsdk.UiContext{ThreadID: "s-1"}); err != nil {
	t.Fatal(err)
}
view := func() ui.View {
	raw, _ := h.View(inst)
	var v ui.View
	if err := json.Unmarshal(raw, &v); err != nil { t.Fatal(err) }
	if err := v.Validate(); err != nil { t.Fatalf("invalid view: %v", err) }
	return v
}
if err := h.Act(ctx, pluginsdk.SurfaceAct{Instance: inst, Kind: pluginsdk.ActTab, Action: "tab", Key: "log", Value: "log"}); err != nil {
	t.Fatal(err)
}
if v := view(); v.Tabs.Active != "log" { t.Errorf("active tab %s", v.Tabs.Active) }
```

A form submit with a stored secret arrives as `{"key": "token", "stored": true}` in
`act.Values` (read it with `act.Stored("token")`); in a test, `h.SetSecret("token", "t0k")`
plus `Values: map[string]any{"token": map[string]any{"key": "token", "stored": true}}` is
what the host would send.

**Restarts**: state that must survive a restart lives in `h.DataDir()` (and secrets).
Start one host with a `DataDir`, act, shut it down, start a second with the same
`DataDir` (and `Secrets`), and check Init restored it.

**Host calls**: grant the permission, give `Options.Invoke` a fake answer (decode
`p.Args`, return `CommandResult{JSON: …}` shaped like the real command's `--json`), then
assert `h.Invocations()`. Test the denial too: start without the permission and check
the plugin reports it sensibly.

**Events**: feed the JSON `code-foundry events --json --source <source>` printed (a
snapshot first, `Snapshot: true`), then `WaitFor` the effect (a flag, a view, a log
line). Wait on the last thing the plugin does, not an intermediate counter.

**Secrets**: assert no log line, toast or view contains a secret's value
(`strings.Contains(fmt.Sprint(h.Logs()), value)`).

**Time**: inject a clock (`now func() time.Time`) into the plugin's state rather than
sleeping; for pollers, make the interval a field the test shortens. That a poller stops
when its work is done is testable too: count the fake `Invoke` (or `gh`) calls, wait a few
intervals, and check the count did not grow.

**Flags in Init**: start with `Options.Flags` set and check Init cleared what no longer
holds (`h.Flags()` records the plugin's `SetFlag` calls).

## What plugintest does not do

It does not evaluate `when` clauses, check command buttons against the permissions,
coalesce views, keep log buffers, or store secrets from forms. Those are the daemon's:
after `go test ./...` passes, run the plugin for real (the skill's loop, steps 5 to 7)
and check `code-foundry plugin list` (state, NOTE), `plugin logs <name>` (no refused
views or calls), `plugin surface` for each surface and `plugin act` for each event.
`plugin surface` prints the view the host accepted and the elements an act can name.

## Against the daemon

What the unit tests cannot show, with the plugin linked by `plugin dev` (its folder, and
any scratch project you `code-foundry project add` to test against, must be under the
home directory; so must an unpacked release tarball you try):

- `code-foundry plugin <name> <command> [args] --thread <id>`: a command, as its view
  button would run it.
- `code-foundry plugin surface <name> <surface> --thread <id>` opens the surface for that
  thread as the panel would and prints the view the host accepted and the elements an
  act can name (a command button with its args). It returns at the first view: a surface
  that renders "Loading" first shows that; add `--settle 2s` to wait until no new view
  has come for 2 s (at most 30 s), or watch:
  `code-foundry plugin surface <name> <surface> --thread <id> --watch > /tmp/view.txt &
  pid=$!; sleep 5; kill $pid`. The instance stays open 10 minutes after the last look.
  `--thread` (and `--project`) take a unique suffix; the global `--context-thread` works
  too.
- `code-foundry plugin act <name> <surface> <event> --thread <id>` acts as a click: the
  event name positionally or `--key <element key>`, `tab --key <tab key>` for a tab,
  `--value` for a field's change, `--values '{"field": "…"}'` for a submit. An event goes
  to the plugin; a command button (`--key <button>`, or its command name positionally)
  runs its command with the panel's context, as the GUI does (a form's values become its
  args; a command that asks first needs `--yes`), and prints the command's result. Then
  it prints the view once no new one has come for `--settle` (default 500ms), so there
  is no need for a `plugin surface` after it; `--quiet` prints only what happened.
- A `pr` surface's `when` usually reads `pr.checks.*`: the first try for a thread fails
  with "not known yet" while the checks are fetched; retry after a few seconds.
- `code-foundry thread new --no-project --name test --created-by=` makes a thread to
  test against (no prompt: nothing is sent to Claude). Never send a prompt just to test.
- `code-foundry plugin logs <name> --lines 50` after each step: refused views and calls,
  your own log lines.
