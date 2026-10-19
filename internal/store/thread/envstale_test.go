package thread

import (
	"context"
	"strings"
	"sync"
	"testing"
)

func hello(env ...string) ExtrasSource {
	return ExtrasSource{ID: "hello", Name: "Hello", Env: env}
}

func extrasOf(sources ...ExtrasSource) SpawnExtras {
	x := SpawnExtras{Sources: sources}
	for _, s := range sources {
		x.Env = append(x.Env, s.Env...)
		x.PathPrepend = append(x.PathPrepend, s.PathPrepend...)
		x.AddDirs = append(x.AddDirs, s.AddDirs...)
	}
	return x
}

// The summary names sources and variables, never values, and is empty when nothing
// changed.
func TestChangeSummary(t *testing.T) {
	gh := func(env ...string) ExtrasSource {
		return ExtrasSource{ID: "gh-actions", Name: "GitHub Actions", Env: env}
	}
	tests := []struct {
		name     string
		was, now SpawnExtras
		want     string
	}{
		{"nothing either way", SpawnExtras{}, SpawnExtras{}, ""},
		{"the same values again", extrasOf(hello("CF_HELLO=1")), extrasOf(hello("CF_HELLO=1")), ""},
		{"a changed value", extrasOf(hello("CF_HELLO=1")), extrasOf(hello("CF_HELLO=2")), "Hello changed CF_HELLO"},
		{"a source disabled", extrasOf(hello("CF_HELLO=1")), SpawnExtras{}, "Hello removed CF_HELLO"},
		{"a source enabled", SpawnExtras{}, extrasOf(gh("GH_A=1", "GH_B=2")), "GitHub Actions added 2 variables"},
		{"two sources", extrasOf(hello("CF_HELLO=1")), extrasOf(gh("GH_A=1"), hello("CF_HELLO=1", "CF_X=1")),
			"GitHub Actions added GH_A; Hello added CF_X"},
		{"added, changed and removed at once", extrasOf(hello("A=1", "B=1", "C=1")), extrasOf(hello("A=2", "D=1", "E=1")),
			"Hello added 2 variables, changed A, removed 2 variables"},
		{"PATH entries", extrasOf(ExtrasSource{ID: "hello", Name: "Hello", PathPrepend: []string{"/a"}}),
			extrasOf(ExtrasSource{ID: "hello", Name: "Hello", PathPrepend: []string{"/b"}}), "Hello changed its PATH entries"},
		{"folders", extrasOf(ExtrasSource{ID: "hello", Name: "Hello", AddDirs: []string{"/a"}}),
			extrasOf(ExtrasSource{ID: "hello", Name: "Hello", AddDirs: []string{"/a", "/b"}}), "Hello changed its folders"},
		{"unnamed entries", SpawnExtras{Env: []string{"X=1"}}, SpawnExtras{Env: []string{"X=2"}}, "A plugin changed X"},
		{"renamed source keeps quiet", extrasOf(hello("CF_HELLO=1")),
			extrasOf(ExtrasSource{ID: "hello", Name: "Hello!", Env: []string{"CF_HELLO=1"}}), ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := changeSummary(printOf(tt.was), printOf(tt.now)); got != tt.want {
				t.Errorf("summary = %q, want %q", got, tt.want)
			}
		})
	}
	// Never a value, and bounded.
	var many []ExtrasSource
	for _, n := range strings.Fields("a b c d e f g h i j k l m n o p q r s t") {
		many = append(many, ExtrasSource{ID: n, Name: "Plugin with a long name " + n, Env: []string{"SECRET_" + n + "=hunter2"}})
	}
	got := changeSummary(printOf(SpawnExtras{}), printOf(extrasOf(many...)))
	if strings.Contains(got, "hunter2") || len(got) > maxEnvChange+len("…") {
		t.Errorf("summary %q (%d bytes)", got, len(got))
	}
	if p := printOf(extrasOf(hello("CF_HELLO=hunter2"))); strings.Contains(p["hello"].env["CF_HELLO"], "hunter2") {
		t.Errorf("fingerprint keeps the value: %+v", p)
	}
}

// scopedExtras returns a contribution by scope: one for project threads, one for
// threads without a project.
type scopedExtras struct {
	mu                 sync.Mutex
	project, noProject SpawnExtras
}

func (s *scopedExtras) fn(_ context.Context, in SpawnInfo) SpawnExtras {
	s.mu.Lock()
	defer s.mu.Unlock()
	if in.NoProject {
		return s.noProject
	}
	return s.project
}

func (s *scopedExtras) set(project, noProject SpawnExtras) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.project, s.noProject = project, noProject
}

// A running thread is stale once what a spawn in its scope would get differs from what
// its process got: by fingerprint, so the same values again are no change and undoing a
// change clears it. A respawn (the effort restart, a user's restart) and the process's
// end clear it.
func TestPluginEnvStale(t *testing.T) {
	e := newEnv(t)
	x := &scopedExtras{}
	x.set(extrasOf(hello("CF_HELLO=1")), extrasOf(hello("CF_HELLO=1")))
	e.m.SetSpawnExtras(x.fn)
	p := e.connected(CreateOptions{Effort: "low"})
	h := e.connected(CreateOptions{NoProject: true})
	steps := []struct {
		name               string
		project, noProject SpawnExtras
		wantP, wantH       string // the summary; "" not stale
	}{
		{"the same values pushed again", extrasOf(hello("CF_HELLO=1")), extrasOf(hello("CF_HELLO=1")), "", ""},
		{"a changed value", extrasOf(hello("CF_HELLO=2")), extrasOf(hello("CF_HELLO=1")), "Hello changed CF_HELLO", ""},
		{"the change undone", extrasOf(hello("CF_HELLO=1")), extrasOf(hello("CF_HELLO=1")), "", ""},
		{"another scope's change", extrasOf(hello("CF_HELLO=1")), extrasOf(hello("CF_HELLO=1"), ExtrasSource{ID: "x", Name: "X", Env: []string{"X=1"}}), "", "X added X"},
		{"the plugin disabled", SpawnExtras{}, SpawnExtras{}, "Hello removed CF_HELLO", "Hello removed CF_HELLO"},
	}
	for _, st := range steps {
		x.set(st.project, st.noProject)
		e.m.CheckSpawnExtras(e.ctx())
		for _, c := range []struct {
			id, want string
		}{{p.ID, st.wantP}, {h.ID, st.wantH}} {
			got, _ := e.m.Get(e.ctx(), c.id)
			if got.PluginEnvStale != (c.want != "") || got.PluginEnvChange != c.want {
				t.Errorf("%s: thread %s stale %v %q, want %q", st.name, c.id, got.PluginEnvStale, got.PluginEnvChange, c.want)
			}
		}
	}
	// Published: the thread list sees it.
	if !sawUpdate(e, p.ID, func(s Thread) bool { return s.PluginEnvStale && s.PluginEnvChange == "Hello removed CF_HELLO" }) {
		t.Error("no Updated event with the stale thread")
	}

	// The effort restart spawns with the current extras: no longer stale.
	if _, err := e.m.SetEffort(e.ctx(), p.ID, "high"); err != nil {
		t.Fatal(err)
	}
	e.waitFor(p.ID, "restarted, current", func(s Thread) bool { return !s.EffortPending && !s.PluginEnvStale && s.State == StateConnected })
	e.m.CheckSpawnExtras(e.ctx())
	if got, _ := e.m.Get(e.ctx(), p.ID); got.PluginEnvStale {
		t.Errorf("stale again after the restart: %q", got.PluginEnvChange)
	}
	// The process's end clears it too; a stopped thread is never stale.
	if err := e.m.Close(e.ctx(), h.ID); err != nil {
		t.Fatal(err)
	}
	e.m.CheckSpawnExtras(e.ctx())
	if got, _ := e.m.Get(e.ctx(), h.ID); got.PluginEnvStale || got.PluginEnvChange != "" {
		t.Errorf("stopped thread stale %v %q", got.PluginEnvStale, got.PluginEnvChange)
	}
	// No extras at all: nothing to compare.
	e.m.SetSpawnExtras(nil)
	e.m.CheckSpawnExtras(e.ctx())
}

// sawUpdate reports whether an Updated event for id satisfying cond was published.
func sawUpdate(e *env, id string, cond func(Thread) bool) bool {
	for {
		select {
		case ev := <-e.events.C():
			if u, ok := ev.(Updated); ok && u.Thread.ID == id && cond(u.Thread) {
				return true
			}
		default:
			return false
		}
	}
}
