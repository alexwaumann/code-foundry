package daemon

import (
	"context"
	"errors"
	"log/slog"
	"maps"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/notification"
	"github.com/alexwaumann/code-foundry/internal/store/notification/notificationtest"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/plugin/plugintest"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

func helloPlugin(mut func(p *plugin.Plugin)) plugin.Plugin {
	p := plugin.Plugin{Name: "hello", Manifest: pluginsdk.Manifest{DisplayName: "Hello"}, Enabled: true, State: plugin.StateRunning}
	if mut != nil {
		mut(&p)
	}
	return p
}

// Every state: which posts, which clears, which keeps the card as it is.
func TestPluginHealth(t *testing.T) {
	const permissions = "its permissions changed: enable it again to review them"
	for _, tt := range []struct {
		name       string
		mut        func(p *plugin.Plugin)
		kind       healthKind
		level      notification.Level
		title      string
		body       string
		wantVerbs  []string
		wantLabels []string
	}{
		{name: "running", kind: healthClear},
		{name: "running after crashes", mut: func(p *plugin.Plugin) { p.Restarts = 4 }, kind: healthClear},
		{name: "starting", mut: func(p *plugin.Plugin) { p.State = plugin.StateStarting }, kind: healthKeep},
		{name: "a crash the store retries", mut: func(p *plugin.Plugin) {
			p.State, p.Restarts, p.LastError = plugin.StateCrashed, 3, "exit status 1"
		}, kind: healthKeep},
		{name: "a dev plugin crash-looping", mut: func(p *plugin.Plugin) {
			p.Dev, p.State, p.Restarts, p.LastError = true, plugin.StateCrashed, 40, "exit status 1"
		}, kind: healthKeep},
		{name: "a restart re-reading a fixed manifest", mut: func(p *plugin.Plugin) { p.State, p.LastError = plugin.StateFailed, "" }, kind: healthKeep},
		{name: "stopping", mut: func(p *plugin.Plugin) { p.State = plugin.StateStopping }, kind: healthKeep},
		{name: "the daemon shutting down", mut: func(p *plugin.Plugin) { p.State = plugin.StateStopped }, kind: healthKeep},
		{name: "enabled, not started yet", mut: func(p *plugin.Plugin) { p.State = plugin.StateDisabled }, kind: healthKeep},
		{name: "gave up restarting", mut: func(p *plugin.Plugin) {
			p.State, p.Restarts, p.LastError = plugin.StateFailed, 5, "crashed 5 times in 10m, last: exit status 2"
		}, kind: healthPost, level: notification.LevelError, title: "Hello stopped", body: "Crashed 5 times in 10m, last: exit status 2",
			wantVerbs: []string{"plugin.restart", "view.settings"}, wantLabels: []string{"Restart", "Open plugins"}},
		{name: "a bad manifest", mut: func(p *plugin.Plugin) {
			p.State, p.LastError = plugin.StateFailed, "manifest: unexpected end of JSON input"
		}, kind: healthPost, level: notification.LevelError, title: "Hello stopped", body: "Manifest: unexpected end of JSON input",
			wantVerbs: []string{"plugin.restart", "view.settings"}, wantLabels: []string{"Restart", "Open plugins"}},
		{name: "turned off by the daemon", mut: func(p *plugin.Plugin) {
			p.Enabled, p.State, p.DisabledReason, p.NeedsConsent = false, plugin.StateDisabled, permissions, true
		}, kind: healthPost, level: notification.LevelWarning, title: "Hello was turned off", body: "Its permissions changed: enable it again to review them",
			wantVerbs: []string{"view.settings"}, wantLabels: []string{"Open plugins"}},
		{name: "turned off by the daemon, then its manifest broke", mut: func(p *plugin.Plugin) {
			p.Enabled, p.State, p.DisabledReason, p.LastError = false, plugin.StateFailed, permissions, "manifest: bad"
		}, kind: healthPost, level: notification.LevelWarning, title: "Hello was turned off", body: "Its permissions changed: enable it again to review them",
			wantVerbs: []string{"view.settings"}, wantLabels: []string{"Open plugins"}},
		{name: "turned off by the user", mut: func(p *plugin.Plugin) { p.Enabled, p.State = false, plugin.StateDisabled }, kind: healthClear},
		{name: "never enabled", mut: func(p *plugin.Plugin) {
			p.Enabled, p.State, p.NeedsConsent = false, plugin.StateDisabled, true
		}, kind: healthClear},
		{name: "a manifest broken while the user had it off", mut: func(p *plugin.Plugin) {
			p.Enabled, p.State, p.LastError = false, plugin.StateFailed, "manifest: bad"
		}, kind: healthClear},
		{name: "no display name", mut: func(p *plugin.Plugin) {
			p.Manifest.DisplayName, p.State, p.LastError = "", plugin.StateFailed, "boom"
		}, kind: healthPost, level: notification.LevelError, title: "hello stopped", body: "Boom",
			wantVerbs: []string{"plugin.restart", "view.settings"}, wantLabels: []string{"Restart", "Open plugins"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			v := pluginHealth(helloPlugin(tt.mut))
			if v.kind != tt.kind {
				t.Fatalf("kind %d, want %d", v.kind, tt.kind)
			}
			if tt.kind != healthPost {
				return
			}
			p := v.post
			if p.Source != notification.SourcePlugins || p.Key != "hello" || p.Level != tt.level || p.Title != tt.title || p.Body != tt.body || p.TimeSensitive {
				t.Errorf("post %+v", p)
			}
			var verbs, labels []string
			for _, a := range p.Actions {
				verbs, labels = append(verbs, a.Command), append(labels, a.Label)
				if a.Kind != notification.KindCommand || a.Resolves == nil || *a.Resolves {
					t.Errorf("action %+v: a command that never resolves the card", a)
				}
			}
			if !slices.Equal(verbs, tt.wantVerbs) || !slices.Equal(labels, tt.wantLabels) {
				t.Errorf("actions %v %v", labels, verbs)
			}
			if p.Actions[0].Command == "plugin.restart" && !maps.Equal(p.Actions[0].Args, map[string]string{"name": "hello"}) {
				t.Errorf("restart args %v", p.Actions[0].Args)
			}
			if last := p.Actions[len(p.Actions)-1]; !maps.Equal(last.Args, map[string]string{"page": "plugins"}) {
				t.Errorf("open plugins args %v", last.Args)
			}
			// What the store takes: every card the rules make is a valid post.
			s := notificationtest.New(t, notificationtest.Options{})
			if err := s.Check(p); err != nil {
				t.Errorf("the store refuses it: %v", err)
			}
		})
	}
}

// A long or odd reason and display name still make a post the store takes.
func TestPluginHealthBounds(t *testing.T) {
	p := helloPlugin(func(p *plugin.Plugin) {
		p.Manifest.DisplayName = "Hello\nWorld " + strings.Repeat("x", 200)
		p.State, p.LastError = plugin.StateFailed, "\x1b[31mexit\x1b[0m\r\nstderr: "+strings.Repeat("y", 3000)+"\xff"
	})
	post := pluginHealth(p).post
	s := notificationtest.New(t, notificationtest.Options{})
	if err := s.Check(post); err != nil {
		t.Fatalf("refused: %v (%q / %q)", err, post.Title, post.Body)
	}
	if !strings.HasPrefix(post.Title, "Hello World xxx") || !strings.HasSuffix(post.Title, "… stopped") {
		t.Errorf("title %q", post.Title)
	}
}

// The plan: posts for what holds; retires a cleared plugin's key and a gone plugin's, and
// only keys the store has; keeps a transitional plugin's card.
func TestHealthPlan(t *testing.T) {
	failed := func(name string) plugin.Plugin {
		return helloPlugin(func(p *plugin.Plugin) { p.Name, p.State, p.LastError = name, plugin.StateFailed, "boom" })
	}
	running := func(name string) plugin.Plugin { return helloPlugin(func(p *plugin.Plugin) { p.Name = name }) }
	crashed := func(name string) plugin.Plugin {
		return helloPlugin(func(p *plugin.Plugin) { p.Name, p.State = name, plugin.StateCrashed })
	}
	for _, tt := range []struct {
		name       string
		plugins    []plugin.Plugin
		keys       []string
		wantPosts  []string
		wantRetire []string
	}{
		{name: "nothing"},
		{name: "a failure posts", plugins: []plugin.Plugin{failed("a"), running("b")}, wantPosts: []string{"a"}},
		{name: "running again retires", plugins: []plugin.Plugin{running("a")}, keys: []string{"a"}, wantRetire: []string{"a"}},
		{name: "running with no card is nothing to do", plugins: []plugin.Plugin{running("a")}},
		{name: "a crash keeps the card", plugins: []plugin.Plugin{crashed("a")}, keys: []string{"a"}},
		{name: "gone retires", plugins: []plugin.Plugin{failed("b")}, keys: []string{"a", "b"}, wantPosts: []string{"b"}, wantRetire: []string{"a"}},
		{name: "start: every stale card goes", keys: []string{"a", "b"}, wantRetire: []string{"a", "b"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			posts, retire := healthPlan(tt.plugins, tt.keys)
			var keys []string
			for _, p := range posts {
				keys = append(keys, p.Key)
			}
			if !slices.Equal(keys, tt.wantPosts) || !slices.Equal(retire, tt.wantRetire) {
				t.Errorf("posts %v retire %v; want %v %v", keys, retire, tt.wantPosts, tt.wantRetire)
			}
		})
	}
}

// The glue on the real notification store: the start reconcile, post → update → withdraw,
// no flapping across a retry, a dismissed card arriving again when the failure comes back
// after a recovery, the user's disable and a removal withdrawing, and a plugin's release
// leaving the daemon's card alone.
func TestPluginHealthGlue(t *testing.T) {
	ctx := context.Background()
	s := notificationtest.New(t, notificationtest.Options{})
	// A card left from the last run for a plugin that is gone now.
	if _, err := s.Post(ctx, notification.Post{Source: notification.SourcePlugins, Key: "gone", Title: "Gone stopped"}); err != nil {
		t.Fatal(err)
	}
	b := bus.New()
	plugins := plugintest.New(b)
	plugins.Put(helloPlugin(func(p *plugin.Plugin) { p.State, p.LastError = plugin.StateFailed, "manifest: bad" }))
	passes := make(chan struct{}, 64)
	stop := startPluginHealth(ctx, slog.New(slog.DiscardHandler), b, s, plugins.Snapshot, func() { passes <- struct{}{} })
	defer stop()
	wait := func() {
		t.Helper()
		select {
		case <-passes:
		case <-time.After(5 * time.Second):
			t.Fatal("no reconcile pass")
		}
	}
	put := func(mut func(p *plugin.Plugin)) {
		t.Helper()
		plugins.Put(helloPlugin(mut))
		wait()
	}
	card := func() (notification.Notification, bool) { return s.Active(notification.SourcePlugins, "hello") }

	// The start reconcile: the failure posted, the stale card withdrawn.
	wait()
	n, ok := card()
	if !ok || n.Title != "Hello stopped" || n.Body != "Manifest: bad" || n.Level != notification.LevelError {
		t.Fatalf("start: %+v %v", n, ok)
	}
	if _, ok := s.Active(notification.SourcePlugins, "gone"); ok {
		t.Error("start: a gone plugin's card stayed")
	}
	id := n.ID

	// A changed reason updates it in place.
	put(func(p *plugin.Plugin) { p.State, p.LastError = plugin.StateFailed, "manifest: worse" })
	if n, ok := card(); !ok || n.ID != id || n.Body != "Manifest: worse" {
		t.Fatalf("update: %+v %v", n, ok)
	}
	arrived := n.ArrivedAt
	s.Clock.Advance(time.Minute) // a new arrival from here on would have a later time

	// Restart: starting and a retried crash keep it; failing again with the same reason is
	// no new arrival.
	put(func(p *plugin.Plugin) { p.State = plugin.StateStarting })
	put(func(p *plugin.Plugin) { p.State, p.LastError = plugin.StateCrashed, "exit status 1" })
	put(func(p *plugin.Plugin) { p.State, p.LastError = plugin.StateFailed, "manifest: worse" })
	if n, ok := card(); !ok || n.ID != id || !n.ArrivedAt.Equal(arrived) {
		t.Fatalf("retry: %+v %v", n, ok)
	}

	// A plugin's own notifications are released with it; the daemon's card is not its.
	sink := pluginNotifications{store: s}
	if n, err := sink.WithdrawAll(ctx, notification.SourcePlugins); n != 0 || err != nil {
		t.Errorf("WithdrawAll(plugins) = %d, %v", n, err)
	}
	if slices.Contains(sink.Sources(), notification.SourcePlugins) {
		t.Error("the plugins source listed as a plugin's")
	}
	if _, err := sink.Post(ctx, notification.SourcePlugins, pluginsdk.Notification{Key: "hello", Title: "x"}); !errors.Is(err, plugin.ErrInvalidArgument) {
		t.Errorf("a plugin named plugins posted: %v", err)
	}

	// Running again withdraws it.
	put(nil)
	if _, ok := card(); ok {
		t.Fatal("running: the card stayed")
	}

	// Dismissed, then running, then the same failure: it arrives again.
	put(func(p *plugin.Plugin) { p.State, p.LastError = plugin.StateFailed, "manifest: worse" })
	n, _ = card()
	if _, err := s.Dismiss(ctx, n.ID); err != nil {
		t.Fatal(err)
	}
	put(func(p *plugin.Plugin) { p.State = plugin.StateStarting })
	if _, ok := card(); ok {
		t.Fatal("dismissed: back while starting")
	}
	put(nil)
	put(func(p *plugin.Plugin) { p.State, p.LastError = plugin.StateFailed, "manifest: worse" })
	if _, ok := card(); !ok {
		t.Fatal("the failure came back after a recovery and was not shown")
	}

	// The user disables it: withdrawn.
	put(func(p *plugin.Plugin) { p.Enabled, p.State = false, plugin.StateDisabled })
	if _, ok := card(); ok {
		t.Fatal("user disable: the card stayed")
	}

	// The daemon turns it off: a warning; enabled again and running: withdrawn.
	put(func(p *plugin.Plugin) {
		p.Enabled, p.State, p.DisabledReason = false, plugin.StateDisabled, "its permissions changed: enable it again to review them"
	})
	if n, ok := card(); !ok || n.Level != notification.LevelWarning || n.Title != "Hello was turned off" {
		t.Fatalf("daemon disable: %+v %v", n, ok)
	}
	put(nil)
	if _, ok := card(); ok {
		t.Fatal("enabled again: the card stayed")
	}

	// Removed while failed: withdrawn.
	put(func(p *plugin.Plugin) { p.State, p.LastError = plugin.StateFailed, "boom" })
	plugins.Remove("hello")
	wait()
	if _, ok := card(); ok {
		t.Fatal("removed: the card stayed")
	}
	if keys := s.Keys(notification.SourcePlugins); len(keys) != 0 {
		t.Errorf("keys left %v", keys)
	}
}
