package plugin_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// envPlugin is the helper plugin of the PR 3 hooks: in Init it pushes CF_HELLO=1
// (pushenv; slowenv after 300 ms; quietenv never) and subscribes to the threads source;
// "events" says how many events it got, "flag" raises a flag on thread t1 and
// "initflags" lists the flags initialize handed it.
func envPlugin(mode string) pluginsdk.Plugin {
	var mu sync.Mutex
	events, snapshots := 0, 0
	return pluginsdk.Plugin{
		Init: func(ctx context.Context, h *pluginsdk.Host) error {
			switch mode {
			case "slowenv":
				time.Sleep(300 * time.Millisecond)
				fallthrough
			case "pushenv":
				if _, err := h.SetEnvironment(ctx, pluginsdk.Environment{Env: map[string]string{"CF_HELLO": "1", "PATH": "/evil"}}); err != nil {
					return err
				}
			}
			_, err := h.Subscribe(ctx, "threads")
			return err
		},
		OnEvent: func(_ context.Context, _ *pluginsdk.Host, ev pluginsdk.Event) {
			mu.Lock()
			defer mu.Unlock()
			events++
			if ev.Snapshot {
				snapshots++
			}
		},
		Commands: map[string]pluginsdk.CommandFunc{
			"events": func(context.Context, *pluginsdk.Host, pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
				mu.Lock()
				defer mu.Unlock()
				return msg(fmt.Sprintf("%d events, %d snapshot", events, snapshots))
			},
			"flag": func(ctx context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
				err := h.SetFlag(ctx, pluginsdk.Flag{ThreadID: "t1", Level: req.Arg("level"), Reason: "deploy failed", UntilSeen: true})
				if err != nil {
					return msg(fmt.Sprintf("code %d: %v", pluginsdk.ErrorCode(err), err))
				}
				return msg("flagged")
			},
			"initflags": func(_ context.Context, h *pluginsdk.Host, _ pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
				var out []string
				for _, f := range h.Flags() {
					out = append(out, f.ThreadID+" "+f.Level+" "+f.Reason)
				}
				return msg(strings.Join(out, "; "))
			},
		},
	}
}

func hooksManifest(name string) pluginsdk.Manifest {
	return pluginsdk.Manifest{
		Name: name, DisplayName: "Hooks " + name, Version: "0.1.0", Protocol: 1, Exec: []string{"bin/plugin"},
		Permissions: pluginsdk.Permissions{Events: []string{"threads"}, ThreadStatus: true, SessionEnv: true},
		Commands: []pluginsdk.CommandSpec{
			{Name: "events", Title: "Events"},
			{Name: "flag", Title: "Flag", Args: []pluginsdk.ArgSpec{{Name: "level", Default: "attention"}}},
			{Name: "initflags", Title: "Init flags"},
		},
	}
}

// fakeFlags is plugin.ThreadFlags over a map, recording calls.
type fakeFlags struct {
	mu    sync.Mutex
	flags map[string]pluginsdk.Flag // by plugin + "/" + thread
	calls []string
}

func (f *fakeFlags) SetFlag(_ context.Context, id string, s plugin.FlagSpec) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, fmt.Sprintf("set %s %s %s %s %s seen=%v", s.Plugin, s.DisplayName, id, s.Level, s.Reason, s.UntilSeen))
	if id != "t1" {
		return false, fmt.Errorf("%w: thread %s", plugin.ErrNotFound, id)
	}
	k, fl := s.Plugin+"/"+id, pluginsdk.Flag{ThreadID: id, Level: s.Level, Reason: s.Reason, UntilSeen: s.UntilSeen}
	if old, ok := f.flags[k]; ok && old == fl {
		return false, nil // the same flag again: no change
	}
	if s.Level == pluginsdk.FlagNone {
		delete(f.flags, k)
	} else {
		f.flags[k] = fl
	}
	return true, nil
}

func (f *fakeFlags) ClearPlugin(_ context.Context, name string) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "clear "+name)
	n := 0
	for k := range f.flags {
		if strings.HasPrefix(k, name+"/") {
			delete(f.flags, k)
			n++
		}
	}
	return n, nil
}

func (f *fakeFlags) Of(name string) []pluginsdk.Flag {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []pluginsdk.Flag
	for k, v := range f.flags {
		if strings.HasPrefix(k, name+"/") {
			out = append(out, v)
		}
	}
	return out
}

func (f *fakeFlags) Plugins() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for k := range f.flags {
		p, _, _ := strings.Cut(k, "/")
		out = append(out, p)
	}
	return out
}

func (f *fakeFlags) called() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

// countFeed is a plugin.EventFeed: one snapshot event per source, then whatever emit sends.
type countFeed struct {
	mu    sync.Mutex
	sends []func(plugin.FeedEvent)
}

func (f *countFeed) Feed(_ context.Context, sources []string, send func(plugin.FeedEvent)) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sends = append(f.sends, send)
	for _, s := range sources {
		send(plugin.FeedEvent{Source: s, Snapshot: true, Event: json.RawMessage(`{"threadList":{"snapshot":{}}}`)})
	}
	return nil
}

func (f *countFeed) Snapshot(context.Context, string) []plugin.FeedEvent { return nil }

func (f *countFeed) emit(n int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for range n {
		for _, s := range f.sends {
			s(plugin.FeedEvent{Source: "threads", Event: json.RawMessage(`{"threadList":{"removedId":"x"}}`)})
		}
	}
}

func (e *env) eventually(what string, cond func() bool) {
	e.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			e.t.Fatalf("waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (e *env) envKeys(name string) string {
	e.t.Helper()
	envs, err := e.m.Environments(name)
	if err != nil {
		e.t.Fatal(err)
	}
	var out []string
	for _, en := range envs {
		for k, v := range en.Env {
			out = append(out, k+"="+v)
		}
	}
	slices.Sort(out)
	return strings.Join(out, ",")
}

// Events, flags and the session environment end to end with a real plugin process.
func TestPluginHooks(t *testing.T) {
	flags := &fakeFlags{flags: map[string]pluginsdk.Flag{}}
	feed := &countFeed{}
	e := newEnv(t, func(o *plugin.Options) { o.Flags, o.Events, o.Home = flags, feed, "" })
	e.install(e.opts.Dir, "hooks", "pushenv", hooksManifest("hooks"))
	m := e.start()
	envEvents := bus.Subscribe[plugin.Event](m.Bus(), 1024)
	defer envEvents.Close()
	if _, err := m.Enable(context.Background(), "hooks", true); err != nil {
		t.Fatal(err)
	}
	e.waitState("hooks", plugin.StateRunning)

	// The session environment: pushed in Init, PATH refused with an issue. Sources say
	// whose it is (the thread store's staleness fingerprint), and the push is announced.
	c := m.SessionEnvironment(context.Background(), plugin.SpawnScope{ThreadID: "t1", ProjectID: "p1"}, true)
	if !slices.Equal(c.Env, []string{"CF_HELLO=1"}) {
		t.Fatalf("SessionEnvironment = %+v", c)
	}
	if len(c.Sources) != 1 || c.Sources[0].Plugin != "hooks" || c.Sources[0].DisplayName != "Hooks hooks" || !slices.Equal(c.Sources[0].Env, []string{"CF_HELLO=1"}) {
		t.Errorf("Sources = %+v", c.Sources)
	}
	e.eventually("EnvironmentChanged for the push", func() bool { return sawEnvChanged(envEvents, "hooks") })
	envs, _ := m.Environments("hooks")
	if len(envs) != 1 || len(envs[0].Issues) != 1 || !strings.Contains(envs[0].Issues[0], "PATH is reserved") {
		t.Errorf("Environments = %+v", envs)
	}
	if c := m.SessionEnvironment(context.Background(), plugin.SpawnScope{NoProject: true}, false); len(c.Env) != 0 {
		t.Errorf("a home thread got %+v (no noProject scope)", c)
	}

	// Events: the snapshot, then live ones.
	e.eventually("the subscription", func() bool { feed.mu.Lock(); defer feed.mu.Unlock(); return len(feed.sends) == 1 })
	feed.emit(3)
	e.eventually("4 events", func() bool {
		r, err := e.invoke("plugin.hooks.events", nil, command.Context{})
		return err == nil && r.Message == "4 events, 1 snapshot"
	})

	// Flags: named after the plugin, rate limited per thread, errors mapped.
	if r, err := e.invoke("plugin.hooks.flag", nil, command.Context{}); err != nil || r.Message != "flagged" {
		t.Fatalf("flag = %+v, %v", r, err)
	}
	if r, _ := e.invoke("plugin.hooks.flag", map[string]string{"level": "error"}, command.Context{}); !strings.HasPrefix(r.Message, "code "+strconv.Itoa(pluginsdk.CodeRateLimited)) {
		t.Errorf("second flag within a second = %q", r.Message)
	}
	if r, _ := e.invoke("plugin.hooks.flag", map[string]string{"level": "loud"}, command.Context{}); !strings.HasPrefix(r.Message, "code "+strconv.Itoa(pluginsdk.CodeInvalidParams)) {
		t.Errorf("bad level = %q", r.Message)
	}
	if got := flags.called(); len(got) != 1 || got[0] != "set hooks Hooks hooks t1 attention deploy failed seen=true" {
		t.Errorf("flag calls = %q", got)
	}

	// A restart hands the plugin its live flags; the contribution survives it.
	if _, err := m.Restart(context.Background(), "hooks"); err != nil {
		t.Fatal(err)
	}
	e.waitState("hooks", plugin.StateRunning)
	if r, err := e.invoke("plugin.hooks.initflags", nil, command.Context{}); err != nil || r.Message != "t1 attention deploy failed" {
		t.Errorf("initflags = %+v, %v", r, err)
	}
	// Setting the same flag again changes nothing and logs at debug only.
	if r, err := e.invoke("plugin.hooks.flag", nil, command.Context{}); err != nil || r.Message != "flagged" {
		t.Fatalf("same flag again = %+v, %v", r, err)
	}
	if logs := e.logText("hooks"); !strings.Contains(logs, "host debug flag attention on t1 unchanged") ||
		strings.Count(logs, "host  flag attention on t1") != 1 {
		t.Errorf("a re-set flag is a debug line:\n%s", logs)
	}

	// Disabling drops the contribution (announced) and clears the flags.
	sawEnvChanged(envEvents, "hooks") // drained
	if _, err := m.Disable(context.Background(), "hooks"); err != nil {
		t.Fatal(err)
	}
	if !sawEnvChanged(envEvents, "hooks") {
		t.Error("no EnvironmentChanged when the plugin was disabled")
	}
	if k := e.envKeys(""); k != "" {
		t.Errorf("after disable: env %q", k)
	}
	if got := flags.called(); got[len(got)-1] != "clear hooks" || len(flags.Of("hooks")) != 0 {
		t.Errorf("after disable: flag calls %q", got)
	}
	if !strings.Contains(e.logText("hooks"), "session environment dropped") {
		t.Errorf("log: %s", e.logText("hooks"))
	}
}

// The last contribution is kept across a daemon restart; a spawn right after waits for a
// plugin still starting, and a plugin that never pushes holds a spawn only until it
// settles.
func TestSessionEnvironmentPersistsAndWaits(t *testing.T) {
	e := newEnv(t, nil)
	pkg := e.install(e.opts.Dir, "hooks", "pushenv", hooksManifest("hooks"))
	m := e.start()
	if _, err := m.Enable(context.Background(), "hooks", true); err != nil {
		t.Fatal(err)
	}
	e.eventually("the push", func() bool { return e.envKeys("hooks") == "CF_HELLO=1" })
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}

	// The next daemon: the plugin no longer pushes, the saved one applies at once.
	e.setMode(pkg, "quietenv")
	m = e.start()
	c := m.SessionEnvironment(context.Background(), plugin.SpawnScope{ProjectID: "p"}, false)
	if !slices.Equal(c.Env, []string{"CF_HELLO=1"}) {
		t.Errorf("saved contribution after restart = %+v", c)
	}
	start := time.Now()
	m.SessionEnvironment(context.Background(), plugin.SpawnScope{ProjectID: "p"}, true)
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("a quiet plugin held the spawn %s", d)
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}

	// A slow plugin, nothing saved: the spawn waits for its push.
	if _, err := e.opts.DB.Exec(`DELETE FROM plugin_environments`); err != nil {
		t.Fatal(err)
	}
	e.setMode(pkg, "slowenv")
	m = e.start()
	c = m.SessionEnvironment(context.Background(), plugin.SpawnScope{ProjectID: "p"}, true)
	if !slices.Equal(c.Env, []string{"CF_HELLO=1"}) {
		t.Errorf("waited spawn = %+v", c)
	}

	// Removed from disk while the daemon is stopped: the next start forgets it.
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(e.opts.Dir, "hooks")); err != nil {
		t.Fatal(err)
	}
	m = e.start()
	var n int
	if err := e.opts.DB.QueryRow(`SELECT count(*) FROM plugin_environments`).Scan(&n); err != nil || n != 0 {
		t.Errorf("saved environments after removal: %d, %v", n, err)
	}
	_ = m
}

// sawEnvChanged drains sub and reports whether it held an EnvironmentChanged for name.
func sawEnvChanged(sub *bus.Subscription[plugin.Event], name string) bool {
	saw := false
	for {
		select {
		case ev := <-sub.C():
			if c, ok := ev.(plugin.EnvironmentChanged); ok && c.Plugin == name {
				saw = true
			}
		default:
			return saw
		}
	}
}
