package thread

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
)

// extrasRecorder is a SpawnExtrasFunc returning what x holds, recording each call.
type extrasRecorder struct {
	mu    sync.Mutex
	x     SpawnExtras
	calls []SpawnInfo
}

func (r *extrasRecorder) fn(_ context.Context, in SpawnInfo) SpawnExtras {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, in)
	return r.x
}

func (r *extrasRecorder) set(x SpawnExtras) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.x = x
}

func (r *extrasRecorder) last() SpawnInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls[len(r.calls)-1]
}

func envValue(env []string, key string) (string, bool) {
	v := ""
	found := false
	for _, kv := range env {
		if rest, ok := strings.CutPrefix(kv, key+"="); ok {
			v, found = rest, true
		}
	}
	return v, found
}

// The spawn extras (plugins' session environment) join every spawn through
// claudeCommand: their dirs right after the skills dir, before the attachments dir and
// the workspace members; their env after the daemon's and the workspace's; their PATH
// entries in front of PATH. A spawn may wait for them, the effort restart never, and it
// reads the current contribution.
func TestSpawnExtras(t *testing.T) {
	skills, att, plug := filepath.Join(t.TempDir(), "claude"), filepath.Join(t.TempDir(), "attachments"), t.TempDir()
	bin := filepath.Join(t.TempDir(), "bin")
	rec := &extrasRecorder{x: SpawnExtras{Env: []string{"CF_HELLO=1"}, PathPrepend: []string{bin}, AddDirs: []string{plug}}}
	e := newWSFixtureEnv(t, "text-table", func(o *Options) {
		o.SkillsDir, o.AttachmentsDir = skills, att
		o.Env = append(o.Env, "PATH=/usr/bin:/bin")
	})
	e.m.SetSpawnExtras(rec.fn)

	// A workspace thread: skills, plugin dirs, attachments, the managed dir, members.
	w := e.connected(CreateOptions{WorkspaceID: "login", InitialPrompt: "hi"})
	spec := e.spec(w.ID)
	if got, want := addDirs(spec.Argv), []string{skills, plug, att, e.managed(), e.wt2}; !slices.Equal(got, want) {
		t.Errorf("workspace --add-dir = %q, want %q", got, want)
	}
	if v, _ := envValue(spec.Env, "CF_HELLO"); v != "1" {
		t.Errorf("env CF_HELLO = %q in %q", v, spec.Env)
	}
	if v, _ := envValue(spec.Env, "PATH"); v != bin+":/usr/bin:/bin" {
		t.Errorf("PATH = %q, want the plugin's dir first", v)
	}
	if in := rec.last(); !in.Wait || in.ThreadID != w.ID || in.WorkspaceID != "w-login" || !slices.Equal(in.MemberProjectIDs, []string{"r1", "r2"}) || in.NoProject {
		t.Errorf("SpawnInfo = %+v", in)
	}

	// A project thread, then its effort restart with a new contribution: re-read, no wait.
	p := e.connected(CreateOptions{Effort: "low"})
	if got, want := addDirs(e.spec(p.ID).Argv), []string{skills, plug, att}; !slices.Equal(got, want) {
		t.Errorf("project --add-dir = %q, want %q", got, want)
	}
	if in := rec.last(); in.ProjectID != "r1" || in.WorkspaceID != "" || in.NoProject {
		t.Errorf("project SpawnInfo = %+v", in)
	}
	e.waitFor(p.ID, "idle", func(s Thread) bool { return s.Status == StatusIdle })
	rec.set(SpawnExtras{Env: []string{"CF_HELLO=2"}})
	if _, err := e.m.SetEffort(e.ctx(), p.ID, "high"); err != nil {
		t.Fatal(err)
	}
	argv := e.waitArgv("the restart", func(a []string) bool { return argOf(a, "--effort") == "high" })
	if got, want := addDirs(argv), []string{skills, att}; !slices.Equal(got, want) {
		t.Errorf("restart --add-dir = %q, want %q", got, want)
	}
	if in := rec.last(); in.Wait || in.ThreadID != p.ID {
		t.Errorf("restart SpawnInfo = %+v, want no wait", in)
	}

	// A thread without a project says so; nothing set: nothing added.
	e.m.SetSpawnExtras(nil)
	h := e.connected(CreateOptions{NoProject: true})
	spec = e.spec(h.ID)
	if got := addDirs(spec.Argv); !slices.Equal(got, []string{skills, att}) {
		t.Errorf("no extras: --add-dir = %q", got)
	}
	if _, ok := envValue(spec.Env, "CF_HELLO"); ok {
		t.Errorf("no extras: env has CF_HELLO: %q", spec.Env)
	}
	e.m.SetSpawnExtras(rec.fn)
	h2 := e.connected(CreateOptions{NoProject: true})
	if in := rec.last(); !in.NoProject || in.ThreadID != h2.ID || in.Owner != "" {
		t.Errorf("no-project SpawnInfo = %+v", in)
	}

	// An owned thread's own env and dirs come after the extras' (its env wins), every
	// spawn; the extras learn its owner.
	own := t.TempDir()
	rec.set(SpawnExtras{Env: []string{"CF_HELLO=1"}, AddDirs: []string{plug}})
	o := e.connected(CreateOptions{NoProject: true, Owner: "plugin:hello", Env: []string{"CF_HELLO=thread", "CF_HELLO_THREAD=1"}, AddDirs: []string{own, plug}})
	spec = e.spec(o.ID)
	if got, want := addDirs(spec.Argv), []string{skills, plug, own, att}; !slices.Equal(got, want) {
		t.Errorf("owned --add-dir = %q, want %q", got, want)
	}
	if v, _ := envValue(spec.Env, "CF_HELLO"); v != "thread" {
		t.Errorf("owned env CF_HELLO = %q, want the thread's", v)
	}
	if v, _ := envValue(spec.Env, "CF_HELLO_THREAD"); v != "1" {
		t.Errorf("owned env CF_HELLO_THREAD = %q", v)
	}
	if in := rec.last(); in.Owner != "plugin:hello" || in.ThreadID != o.ID {
		t.Errorf("owned SpawnInfo = %+v", in)
	}
	e.restart()
	if got, _ := e.m.Get(e.ctx(), o.ID); !slices.Equal(got.SpawnEnv, []string{"CF_HELLO=thread", "CF_HELLO_THREAD=1"}) || !slices.Equal(got.SpawnAddDirs, []string{own, plug}) {
		t.Errorf("after restart: env %q dirs %q", got.SpawnEnv, got.SpawnAddDirs)
	}
}

func TestPrependPath(t *testing.T) {
	sep := string(os.PathListSeparator)
	tests := []struct {
		name   string
		env    []string
		dirs   []string
		osPath string
		want   string
	}{
		{"none", nil, nil, "/usr/bin", ""},
		{"daemon PATH", nil, []string{"/a", "/b"}, "/usr/bin", "PATH=/a" + sep + "/b" + sep + "/usr/bin"},
		{"env PATH wins, last one", []string{"PATH=/x", "PATH=/y"}, []string{"/a"}, "/usr/bin", "PATH=/a" + sep + "/y"},
		{"no PATH at all", nil, []string{"/a"}, "", "PATH=/a"},
	}
	for _, tt := range tests {
		if got := prependPath(tt.env, tt.dirs, tt.osPath); got != tt.want {
			t.Errorf("%s: prependPath = %q, want %q", tt.name, got, tt.want)
		}
	}
}
