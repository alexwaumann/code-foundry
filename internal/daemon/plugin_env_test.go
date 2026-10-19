package daemon

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// A shell's plugin scope: a thread's shell gets its thread's scope (the thread's project,
// workspace members or none, and owner), a project's shell its project's, a home shell
// the no-project scope; action runs and plugins' terminals get nothing.
func TestShellScope(t *testing.T) {
	threads := map[string]thread.SpawnInfo{
		"s-proj": {ThreadID: "s-proj", ProjectID: "p1"},
		"s-ws":   {ThreadID: "s-ws", ProjectID: "p1", WorkspaceID: "w1", MemberProjectIDs: []string{"p1", "p2"}},
		"s-home": {ThreadID: "s-home", NoProject: true},
		"s-own":  {ThreadID: "s-own", NoProject: true, Owner: "plugin:hello"},
	}
	info := func(id string) (thread.SpawnInfo, bool) { in, ok := threads[id]; return in, ok }
	tests := []struct {
		name   string
		labels map[string]string
		want   plugin.SpawnScope
		ok     bool
	}{
		{"a thread's shell gets its project", termlabel.Shell("s-proj", "p1", "/wt"), plugin.SpawnScope{ThreadID: "s-proj", ProjectID: "p1"}, true},
		{"a workspace thread's shell gets its members", termlabel.Shell("s-ws", "p1", "/wt"),
			plugin.SpawnScope{ThreadID: "s-ws", ProjectID: "p1", MemberProjectIDs: []string{"p1", "p2"}}, true},
		{"a home thread's shell is no-project", termlabel.Shell("s-home", "", "/Users/me"), plugin.SpawnScope{ThreadID: "s-home", NoProject: true}, true},
		{"a plugin thread's shell keeps the owner", termlabel.Shell("s-own", "", "/data"), plugin.SpawnScope{ThreadID: "s-own", NoProject: true, Owner: "plugin:hello"}, true},
		{"a project's shell gets the project", termlabel.Shell("", "p2", "/wt2"), plugin.SpawnScope{ProjectID: "p2"}, true},
		{"a removed thread's shell falls back to its project", termlabel.Shell("s-gone", "p3", "/wt3"), plugin.SpawnScope{ProjectID: "p3"}, true},
		{"a home shell is no-project", termlabel.Shell("", "", "/Users/me"), plugin.SpawnScope{NoProject: true}, true},
		{"an action run gets nothing", termlabel.ActionTerminal("s-proj", "p1", "/wt", "a1", "test", "r1"), plugin.SpawnScope{}, false},
		{"a plugin's terminal gets nothing", termlabel.PluginTerminal("hello", "Clock"), plugin.SpawnScope{}, false},
		{"an unlabelled terminal gets nothing", nil, plugin.SpawnScope{}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := shellScope(tt.labels, info)
			if ok != tt.ok || got.ThreadID != tt.want.ThreadID || got.ProjectID != tt.want.ProjectID || got.NoProject != tt.want.NoProject ||
				got.Owner != tt.want.Owner || len(got.MemberProjectIDs) != len(tt.want.MemberProjectIDs) {
				t.Errorf("shellScope = %+v, %v; want %+v, %v", got, ok, tt.want, tt.ok)
			}
		})
	}
}

type envChecks struct{ n atomic.Int32 }

func (c *envChecks) CheckSpawnExtras(context.Context) { c.n.Add(1) }

// Plugin events that may change a contribution make the thread store check its running
// threads; others do not.
func TestPluginEnvWatch(t *testing.T) {
	b := bus.New()
	c := &envChecks{}
	stop := startPluginEnvWatch(context.Background(), b, c)
	defer stop()
	waitN := func(want int32) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for c.n.Load() < want {
			if time.Now().After(deadline) {
				t.Fatalf("checks = %d, want %d", c.n.Load(), want)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	bus.Publish[plugin.Event](b, plugin.EnvironmentChanged{Plugin: "hello"})
	waitN(1)
	bus.Publish[plugin.Event](b, plugin.Changed{Plugin: plugin.Plugin{Name: "hello"}})
	waitN(2)
	bus.Publish[plugin.Event](b, plugin.Removed{Name: "hello"})
	waitN(3)
	bus.Publish[plugin.Event](b, plugin.AvailabilityChanged{Epoch: 1})
	time.Sleep(50 * time.Millisecond)
	if n := c.n.Load(); n != 3 {
		t.Errorf("an availability change checked: %d checks", n)
	}
}
