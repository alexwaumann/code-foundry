# Testing a plugin

Two layers: unit tests against a fake host (`pluginsdk/plugintest`, fast, in `go test`),
then the real daemon (`plugin dev`, `plugin surface`, `plugin act`, `plugin logs`).

## plugintest

`plugintest.Start(t, plugin(), opts)` runs the plugin's `pluginsdk.Plugin` over in-memory
pipes, does the handshake (so `Init` runs), records everything the plugin asks of the host,
and shuts the plugin down when the test ends. It enforces permissions like the real host:
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
	// DataDir defaults to t.TempDir()
})
```

Drive it like the host:

| Call | Does |
|---|---|
| `h.Command(ctx, "greet", args, uctx)` | `command/invoke`: returns the plugin's `CommandResult` or error |
| `h.OpenSurface(ctx, instance, "status", uctx)` | `surface/open` + `visibility true` |
| `h.Act(ctx, pluginsdk.SurfaceAct{Instance, Kind, Action, Key, Data, Value, Values})` | `surface/act` (Version 0 = the latest) |
| `h.Visibility(instance, false)`, `h.CloseSurface(instance)` | visibility and close notifications |
| `h.Event(pluginsdk.Event{Subscription: "sub-1", Event: json.RawMessage(...)})` | an `events/event` |
| `h.Ping(ctx)`, `h.Shutdown(ctx)` | ping; shutdown and what `Serve` returned |
| `h.SetSecret(key, value)` | a secret as if the user had stored it (a form with `store`) |

And read what the plugin did: `h.View(instance)` (the last view's JSON), `h.Version(instance)`,
`h.Appends()`, `h.Toasts()`, `h.Logs()`, `h.Flags()`, `h.Contexts()`, `h.Environments()`,
`h.Subscriptions()`, `h.Invocations()` (allowed or not), `h.Secret(key)`.

`h.WaitFor(5*time.Second, func(h *plugintest.Host) bool { … })` waits for something done
asynchronously (in Init, a goroutine, a notification); it re-checks after every recorded
call and fails the test on timeout. Calls that are requests (`UpdateView`, `SetFlag`,
`Invoke`, secrets) are recorded before the plugin's handler returns, so after `h.Act` or
`h.Command` returns their effects are visible without waiting; notifications (`Log`,
`Toast`, `SetContext`) and anything from another goroutine need `WaitFor`.

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

A form submit with a stored secret arrives as `pluginsdk.StoredSecret`; in a test,
`h.SetSecret("token", "t0k")` plus
`Values: map[string]any{"token": map[string]any{"key": "token", "stored": true}}` is what
the host would send.

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
sleeping; for pollers, make the interval a field the test shortens.

## What plugintest does not do

It does not evaluate `when` clauses, check command buttons against the permissions,
coalesce views, keep log buffers, or store secrets from forms. Those are the daemon's:
after `go test ./...` passes, run the plugin for real (the skill's loop, steps 5 to 7)
and check `code-foundry plugin list` (state, NOTE), `plugin logs <name>` (no refused
views or calls), `plugin surface` for each surface and `plugin act` for each event.
`plugin surface` prints the view the host accepted and the elements an act can name.
