package plugin_test

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// threadsRig is the registry rig with hello installed from the registry and enabled,
// two threads of hello (one in the middle of a turn, one archived), a terminal of hello,
// and a thread of another plugin and one of the user that nothing may touch
// (docs/notes/plugins-plugin-threads-remove.md).
type threadsRig struct {
	*regRig
	m     *plugin.Manager
	owned *fakeOwned
}

var helloThreads = []string{"s-h1", "s-h2"}

func newThreadsRig(t *testing.T) *threadsRig {
	t.Helper()
	g := newRegRig(t)
	owned := newFakeOwned()
	g.opts.Threads, g.opts.Terminals = owned, fakeTerms{owned}
	g.publish(g.build("hello", "0.1.0", basePerms), basePerms)
	g.ghRelease("evil/hello", g.build("hello", "0.9.0", basePerms))
	m := g.start()
	ctx := context.Background()
	if _, err := m.Install(ctx, plugin.InstallRequest{Ref: "hello", Enable: true, Consent: true}); err != nil {
		t.Fatal(err)
	}
	g.waitState("hello", plugin.StateRunning)
	owned.add("plugin:hello", pluginsdk.PluginThread{ThreadID: "s-h1", Title: "mid-turn", State: "connected", Status: "busy"})
	owned.add("plugin:hello", pluginsdk.PluginThread{ThreadID: "s-h2", Title: "old", State: "disconnected", Archived: true})
	owned.add("plugin:other", pluginsdk.PluginThread{ThreadID: "s-o1", Title: "another plugin's"})
	if _, err := (fakeTerms{owned}).Create(ctx, "hello", plugin.TerminalSpec{Argv: []string{"sh"}, Title: "Shell"}); err != nil {
		t.Fatal(err)
	}
	return &threadsRig{regRig: g, m: m, owned: owned}
}

// hello is what is left of hello's threads: id → archived.
func (r *threadsRig) hello() map[string]bool {
	out := map[string]bool{}
	for _, t := range r.owned.Owned("plugin:hello") {
		out[t.ThreadID] = t.Archived
	}
	return out
}

// TestPluginThreadsOnTheWayOut: disabling archives a plugin's threads (enabling again
// finds them, still its own); uninstalling, with or without --purge, and a forced
// takeover through install or dev remove them through the thread store's Remove (the
// one that is mid-turn too) and report their ids. Terminals are closed on every path;
// another plugin's and the user's threads are never touched.
func TestPluginThreadsOnTheWayOut(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name string
		// act does it and returns the thread ids its result reports removed.
		act func(t *testing.T, r *threadsRig) []string
		// removed: hello's threads are gone; otherwise they are all archived.
		removed bool
	}{
		{name: "disable archives", act: func(t *testing.T, r *threadsRig) []string {
			if _, err := r.m.Disable(ctx, "hello"); err != nil {
				t.Fatal(err)
			}
			if log := r.logText("hello"); !strings.Contains(log, "archived its threads: 1") {
				t.Errorf("log:\n%s", log)
			}
			return nil
		}},
		{name: "enable again gets them back", act: func(t *testing.T, r *threadsRig) []string {
			if _, err := r.m.Disable(ctx, "hello"); err != nil {
				t.Fatal(err)
			}
			if _, err := r.m.Enable(ctx, "hello", true); err != nil {
				t.Fatal(err)
			}
			r.waitState("hello", plugin.StateRunning)
			list, err := r.m.Threads("hello")
			if err != nil || len(list) != 2 {
				t.Errorf("Threads after enabling again = %+v, %v", list, err)
			}
			for _, id := range helloThreads {
				if o, ok := r.owned.Owner(id); !ok || o != "plugin:hello" {
					t.Errorf("%s: owner %q, %v", id, o, ok)
				}
			}
			return nil
		}},
		{name: "uninstall removes", removed: true, act: func(t *testing.T, r *threadsRig) []string {
			res, err := r.m.Uninstall(ctx, "hello", false)
			if err != nil {
				t.Fatal(err)
			}
			return res.RemovedThreads
		}},
		{name: "uninstall --purge removes", removed: true, act: func(t *testing.T, r *threadsRig) []string {
			res, err := r.m.Uninstall(ctx, "hello", true)
			if err != nil {
				t.Fatal(err)
			}
			return res.RemovedThreads
		}},
		{name: "forced takeover by install removes", removed: true, act: func(t *testing.T, r *threadsRig) []string {
			_, err := r.m.Install(ctx, plugin.InstallRequest{Ref: "evil/hello"})
			if !errors.Is(err, plugin.ErrFailedPrecondition) || !strings.Contains(err.Error(), "its 2 threads") {
				t.Fatalf("without --force: %v", err)
			}
			if got := r.hello(); len(got) != 2 {
				t.Fatalf("the refusal touched the threads: %v", got)
			}
			res, err := r.m.Install(ctx, plugin.InstallRequest{Ref: "evil/hello", Force: true})
			if err != nil {
				t.Fatal(err)
			}
			if len(res.Warnings) != 1 || !strings.Contains(res.Warnings[0], "removed its 2 threads") {
				t.Errorf("warnings = %q", res.Warnings)
			}
			if log := r.logText("hello"); !strings.Contains(log, "taken over by the releases of evil/hello: deleted the consent you gave it and removed its 2 threads") {
				t.Errorf("log:\n%s", log)
			}
			return res.RemovedThreads
		}},
		{name: "forced takeover by dev removes", removed: true, act: func(t *testing.T, r *threadsRig) []string {
			src := r.install(t.TempDir(), "hello", "ok", testManifest("hello"))
			res, err := r.m.Dev(ctx, src, false, true, true)
			if err != nil || !strings.Contains(res.Consent, "the consent you gave it will be deleted, and it removes its 2 threads.") {
				t.Fatalf("dry run = %+v, %v", res, err)
			}
			if got := r.hello(); len(got) != 2 {
				t.Fatalf("the dry run touched the threads: %v", got)
			}
			res, err = r.m.Dev(ctx, src, true, false, true)
			if err != nil {
				t.Fatal(err)
			}
			return res.RemovedThreads
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := newThreadsRig(t)
			got := tt.act(t, r)
			left := r.hello()
			switch {
			case tt.removed:
				// The store's removals run at once, in any order; the result is oldest first.
				if !slices.Equal(got, helloThreads) || len(left) != 0 || !slices.Equal(slices.Sorted(slices.Values(r.owned.removed)), helloThreads) {
					t.Errorf("removed %v (store: %v), left %v", got, r.owned.removed, left)
				}
			default:
				if len(got) != 0 || len(r.owned.removed) != 0 || len(left) != 2 || !left["s-h1"] || !left["s-h2"] {
					t.Errorf("removed %v (store: %v), left %v; want both archived", got, r.owned.removed, left)
				}
			}
			if ts := (fakeTerms{r.owned}).Owned("hello"); len(ts) != 0 {
				t.Errorf("terminals left: %+v", ts)
			}
			for _, id := range []string{"s-o1", "s-user"} {
				if _, ok := r.owned.Owner(id); !ok {
					t.Errorf("%s was removed", id)
				}
			}
			if left := r.owned.live("plugin:other"); left != 1 {
				t.Errorf("another plugin's thread was archived")
			}
		})
	}
}

// A name whose only leftover is threads (its package deleted by hand while the daemon was
// down archived them, and its consent was purged) is still a takeover: a package from
// another source would list and send into them.
func TestThreadsAloneAreInherited(t *testing.T) {
	ctx := context.Background()
	r := newThreadsRig(t)
	if _, err := r.m.Uninstall(ctx, "hello", true); err != nil {
		t.Fatal(err)
	}
	// Threads tagged hello again (as if left by an older daemon), and a row for its
	// origin without consent, secrets or data.
	r.owned.add("plugin:hello", pluginsdk.PluginThread{ThreadID: "s-h3", Archived: true})
	if _, err := r.m.Install(ctx, plugin.InstallRequest{Ref: "hello"}); err != nil {
		t.Fatal(err)
	}
	_, err := r.m.Install(ctx, plugin.InstallRequest{Ref: "evil/hello"})
	if !errors.Is(err, plugin.ErrFailedPrecondition) || !strings.Contains(err.Error(), "would inherit its 1 thread;") {
		t.Fatalf("install of another source: %v", err)
	}
	res, err := r.m.Install(ctx, plugin.InstallRequest{Ref: "evil/hello", Force: true})
	if err != nil || !slices.Equal(res.RemovedThreads, []string{"s-h3"}) {
		t.Fatalf("forced = %+v, %v", res, err)
	}
}
