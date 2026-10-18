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

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// ownedPlugin is the helper plugin of plugin threads and terminals: it pushes a session
// environment, and its commands run thread/* and terminal/* with the JSON in arg "p"
// (answering "code N: …" on an error), and report the host's capabilities.
func ownedPlugin() pluginsdk.Plugin {
	call := func(fn func(ctx context.Context, h *pluginsdk.Host, p json.RawMessage) (any, error)) pluginsdk.CommandFunc {
		return func(ctx context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
			out, err := fn(ctx, h, json.RawMessage(req.Arg("p")))
			if err != nil {
				return msg(fmt.Sprintf("code %d: %v", pluginsdk.ErrorCode(err), err))
			}
			b, _ := json.Marshal(out)
			return msg(string(b))
		}
	}
	return pluginsdk.Plugin{
		Init: func(ctx context.Context, h *pluginsdk.Host) error {
			if h.Granted().SessionEnv {
				_, err := h.SetEnvironment(ctx, pluginsdk.Environment{Env: map[string]string{"OWNED_SESSION": "1"}, Scope: &pluginsdk.EnvironmentScope{NoProject: true}})
				return err
			}
			return nil
		},
		Commands: map[string]pluginsdk.CommandFunc{
			"create": call(func(ctx context.Context, h *pluginsdk.Host, p json.RawMessage) (any, error) {
				var c pluginsdk.ThreadCreateParams
				_ = json.Unmarshal(p, &c)
				return h.CreateThread(ctx, c)
			}),
			"send": call(func(ctx context.Context, h *pluginsdk.Host, p json.RawMessage) (any, error) {
				var c pluginsdk.ThreadSendParams
				_ = json.Unmarshal(p, &c)
				return "sent", h.SendThread(ctx, c.ThreadID, c.Text)
			}),
			"archive": call(func(ctx context.Context, h *pluginsdk.Host, p json.RawMessage) (any, error) {
				var c pluginsdk.ThreadRef
				_ = json.Unmarshal(p, &c)
				return "archived", h.ArchiveThread(ctx, c.ThreadID)
			}),
			"threads": call(func(ctx context.Context, h *pluginsdk.Host, _ json.RawMessage) (any, error) { return h.Threads(ctx) }),
			"term": call(func(ctx context.Context, h *pluginsdk.Host, p json.RawMessage) (any, error) {
				var c pluginsdk.TerminalCreateParams
				_ = json.Unmarshal(p, &c)
				return h.CreateTerminal(ctx, c)
			}),
			"termclose": call(func(ctx context.Context, h *pluginsdk.Host, p json.RawMessage) (any, error) {
				var c pluginsdk.TerminalRef
				_ = json.Unmarshal(p, &c)
				return "closed", h.CloseTerminal(ctx, c.TerminalID)
			}),
			"terms": call(func(ctx context.Context, h *pluginsdk.Host, _ json.RawMessage) (any, error) { return h.Terminals(ctx) }),
			"caps": func(_ context.Context, h *pluginsdk.Host, _ pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
				var out []string
				for _, c := range []string{"threads", "terminals", "view.node.thread", "view.node.terminal", "act.context"} {
					if h.HasCapability(c) {
						out = append(out, c)
					}
				}
				return msg(strings.Join(out, ","))
			},
		},
	}
}

func ownedManifest(name string, perms pluginsdk.Permissions) pluginsdk.Manifest {
	mf := pluginsdk.Manifest{Name: name, DisplayName: "Owned", Version: "0.1.0", Protocol: 1, Exec: []string{"bin/plugin"}, Permissions: perms}
	for _, c := range []string{"create", "send", "archive", "threads", "term", "termclose", "terms", "caps"} {
		mf.Commands = append(mf.Commands, pluginsdk.CommandSpec{Name: c, Title: c, Args: []pluginsdk.ArgSpec{{Name: "p"}}})
	}
	return mf
}

// fakeOwned is plugin.OwnedThreads and plugin.OwnedTerminals over maps.
type fakeOwned struct {
	mu        sync.Mutex
	threads   []pluginsdk.PluginThread
	owners    map[string]string // thread id → owner
	specs     map[string]plugin.ThreadSpec
	sends     []string
	terms     []pluginsdk.PluginTerminal
	termOwner map[string]string
	termSpecs map[string]plugin.TerminalSpec
}

func newFakeOwned() *fakeOwned {
	f := &fakeOwned{owners: map[string]string{"s-user": ""}, specs: map[string]plugin.ThreadSpec{},
		termOwner: map[string]string{"t-shell": ""}, termSpecs: map[string]plugin.TerminalSpec{}}
	f.threads = append(f.threads, pluginsdk.PluginThread{ThreadID: "s-user", Title: "mine"})
	return f
}

func (f *fakeOwned) Create(_ context.Context, owner string, s plugin.ThreadSpec) (pluginsdk.PluginThread, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if s.Model == "bogus" {
		return pluginsdk.PluginThread{}, fmt.Errorf("%w: unknown model %q", plugin.ErrInvalidArgument, s.Model)
	}
	id := "s-p" + strconv.Itoa(len(f.specs)+1)
	t := pluginsdk.PluginThread{ThreadID: id, Title: s.Title, Cwd: s.Cwd, ProjectID: s.ProjectID, Model: s.Model, State: "starting", Status: "unknown"}
	f.threads = append(f.threads, t)
	f.owners[id], f.specs[id] = owner, s
	return t, nil
}

func (f *fakeOwned) Send(_ context.Context, id, text string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sends = append(f.sends, id+":"+text)
	return nil
}

func (f *fakeOwned) Archive(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := range f.threads {
		if f.threads[i].ThreadID == id {
			f.threads[i].Archived = true
		}
	}
	return nil
}

func (f *fakeOwned) Owner(id string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	o, ok := f.owners[id]
	return o, ok
}

func (f *fakeOwned) Owned(owner string) []pluginsdk.PluginThread {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []pluginsdk.PluginThread
	for _, t := range f.threads {
		if f.owners[t.ThreadID] == owner {
			out = append(out, t)
		}
	}
	return out
}

func (f *fakeOwned) LiveOwners() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, t := range f.threads {
		if o := f.owners[t.ThreadID]; o != "" && !t.Archived && !slices.Contains(out, o) {
			out = append(out, o)
		}
	}
	return out
}

func (f *fakeOwned) live(owner string) int {
	n := 0
	for _, t := range f.Owned(owner) {
		if !t.Archived {
			n++
		}
	}
	return n
}

// terminals: a separate type so both interfaces' Create can coexist.
type fakeTerms struct{ f *fakeOwned }

func (t fakeTerms) Create(_ context.Context, name string, s plugin.TerminalSpec) (pluginsdk.PluginTerminal, error) {
	f := t.f
	f.mu.Lock()
	defer f.mu.Unlock()
	id := "t-p" + strconv.Itoa(len(f.termSpecs)+1)
	pt := pluginsdk.PluginTerminal{TerminalID: id, Title: s.Title, Argv: s.Argv, Cwd: s.Cwd, State: "running"}
	f.terms = append(f.terms, pt)
	f.termOwner[id], f.termSpecs[id] = name, s
	return pt, nil
}

func (t fakeTerms) Close(_ context.Context, id string) error {
	f := t.f
	f.mu.Lock()
	defer f.mu.Unlock()
	f.terms = slices.DeleteFunc(f.terms, func(x pluginsdk.PluginTerminal) bool { return x.TerminalID == id })
	delete(f.termOwner, id)
	return nil
}

func (t fakeTerms) Owner(id string) (string, bool) {
	t.f.mu.Lock()
	defer t.f.mu.Unlock()
	o, ok := t.f.termOwner[id]
	return o, ok
}

func (t fakeTerms) Owned(name string) []pluginsdk.PluginTerminal {
	t.f.mu.Lock()
	defer t.f.mu.Unlock()
	var out []pluginsdk.PluginTerminal
	for _, x := range t.f.terms {
		if t.f.termOwner[x.TerminalID] == name {
			out = append(out, x)
		}
	}
	return out
}

// Plugin threads and terminals end to end with a real plugin process: create with a
// checked env and cwd, reach only its own, its session environment skipped for its own
// threads, and everything archived and closed when it is disabled.
func TestPluginThreadsAndTerminals(t *testing.T) {
	owned := newFakeOwned()
	var home string
	e := newEnv(t, func(o *plugin.Options) { o.Threads, o.Terminals = owned, fakeTerms{owned} })
	home = e.root
	e.opts.Home = home
	skills := filepath.Join(home, "skills")
	if err := os.MkdirAll(skills, 0o755); err != nil {
		t.Fatal(err)
	}
	e.install(e.opts.Dir, "owned", "owned", ownedManifest("owned", pluginsdk.Permissions{Threads: true, Terminals: true, SessionEnv: true}))
	m := e.start()
	if _, err := m.Enable(context.Background(), "owned", true); err != nil {
		t.Fatal(err)
	}
	e.waitState("owned", plugin.StateRunning)
	run := func(cmd string, p any) string {
		t.Helper()
		b, _ := json.Marshal(p)
		r, err := e.invoke("plugin.owned."+cmd, map[string]string{"p": string(b)}, command.Context{})
		if err != nil {
			t.Fatalf("%s: %v", cmd, err)
		}
		return r.Message
	}
	if got := run("caps", nil); got != "threads,terminals,view.node.thread,view.node.terminal,act.context" {
		t.Errorf("capabilities = %q", got)
	}

	// Create: the data dir by default, env and add-dirs checked, then the owner's.
	got := run("create", pluginsdk.ThreadCreateParams{Title: "Assistant", Env: map[string]string{"CF_HELLO_THREAD": "1"}, AddDirs: []string{"~/skills"}})
	if got != `"s-p1"` {
		t.Fatalf("create = %s", got)
	}
	spec := owned.specs["s-p1"]
	if owned.owners["s-p1"] != "plugin:owned" || spec.Cwd != filepath.Join(e.opts.DataDir, "owned") || !slices.Equal(spec.Env, []string{"CF_HELLO_THREAD=1"}) ||
		!slices.Equal(spec.AddDirs, []string{skills}) || spec.Title != "Assistant" {
		t.Errorf("created %s: %+v", owned.owners["s-p1"], spec)
	}
	for _, tt := range []struct {
		name string
		p    pluginsdk.ThreadCreateParams
		want string
	}{
		{"no title", pluginsdk.ThreadCreateParams{}, "title is required"},
		{"two lines", pluginsdk.ThreadCreateParams{Title: "a\nb"}, "one line"},
		{"reserved env", pluginsdk.ThreadCreateParams{Title: "x", Env: map[string]string{"PATH": "/x", "CLAUDE_CODE_X": "1"}}, "PATH is reserved"},
		{"missing add-dir", pluginsdk.ThreadCreateParams{Title: "x", AddDirs: []string{"~/nope"}}, "is not a directory"},
		{"cwd outside home", pluginsdk.ThreadCreateParams{Title: "x", Cwd: t.TempDir()}, "outside your home"},
		{"store refuses", pluginsdk.ThreadCreateParams{Title: "x", Model: "bogus"}, "unknown model"},
	} {
		if got := run("create", tt.p); !strings.HasPrefix(got, "code "+strconv.Itoa(pluginsdk.CodeInvalidParams)) || !strings.Contains(got, tt.want) {
			t.Errorf("%s: create = %s", tt.name, got)
		}
	}

	// Its own threads only.
	if got := run("send", pluginsdk.ThreadSendParams{ThreadID: "s-p1", Text: "say hello"}); got != `"sent"` {
		t.Errorf("send = %s", got)
	}
	for _, id := range []string{"s-user", "s-nope"} {
		if got := run("send", pluginsdk.ThreadSendParams{ThreadID: id, Text: "x"}); !strings.HasPrefix(got, "code "+strconv.Itoa(pluginsdk.CodeNotFound)) {
			t.Errorf("send to %s = %s", id, got)
		}
	}
	if got := run("send", pluginsdk.ThreadSendParams{ThreadID: "s-p1", Text: "  "}); !strings.Contains(got, "text is required") {
		t.Errorf("empty send = %s", got)
	}
	var list []pluginsdk.PluginThread
	if err := json.Unmarshal([]byte(run("threads", nil)), &list); err != nil || len(list) != 1 || list[0].ThreadID != "s-p1" {
		t.Errorf("threads = %+v, %v", list, err)
	}
	if got := owned.sends; !slices.Equal(got, []string{"s-p1:say hello"}) {
		t.Errorf("sends = %q", got)
	}

	// Its own session environment is not applied to its own thread; others' are.
	c := m.SessionEnvironment(context.Background(), plugin.SpawnScope{ThreadID: "s-p1", NoProject: true, Owner: "plugin:owned"}, false)
	if len(c.Env) != 0 {
		t.Errorf("own thread got the session env %q", c.Env)
	}
	c = m.SessionEnvironment(context.Background(), plugin.SpawnScope{ThreadID: "s-user", NoProject: true}, false)
	if !slices.Equal(c.Env, []string{"OWNED_SESSION=1"}) {
		t.Errorf("another thread's session env = %q", c.Env)
	}

	// Terminals: data dir, title from argv, env checked, its own only.
	if got := run("term", pluginsdk.TerminalCreateParams{Argv: []string{"/bin/sh", "-c", "date"}, Env: map[string]string{"X": "1"}}); got != `"t-p1"` {
		t.Fatalf("term = %s", got)
	}
	if ts := owned.termSpecs["t-p1"]; ts.Title != "sh" || ts.Cwd != filepath.Join(e.opts.DataDir, "owned") || !slices.Equal(ts.Env, []string{"X=1"}) {
		t.Errorf("terminal spec = %+v", ts)
	}
	if got := run("term", pluginsdk.TerminalCreateParams{Argv: []string{"sh"}, Env: map[string]string{"HOME": "/x"}}); !strings.Contains(got, "HOME is reserved") {
		t.Errorf("reserved terminal env = %s", got)
	}
	if got := run("term", pluginsdk.TerminalCreateParams{}); !strings.Contains(got, "argv is required") {
		t.Errorf("no argv = %s", got)
	}
	if got := run("termclose", pluginsdk.TerminalRef{TerminalID: "t-shell"}); !strings.HasPrefix(got, "code "+strconv.Itoa(pluginsdk.CodeNotFound)) {
		t.Errorf("close a shell = %s", got)
	}
	if got := run("term", pluginsdk.TerminalCreateParams{Argv: []string{"sleep", "60"}, Title: "Sleeper"}); got != `"t-p2"` {
		t.Fatalf("second term = %s", got)
	}
	if got := run("termclose", pluginsdk.TerminalRef{TerminalID: "t-p1"}); got != `"closed"` {
		t.Errorf("close = %s", got)
	}
	if ts, _ := m.Terminals("owned"); len(ts) != 1 || ts[0].Title != "Sleeper" {
		t.Errorf("Terminals = %+v", ts)
	}

	// Disabling archives its threads and closes its terminals.
	if _, err := m.Disable(context.Background(), "owned"); err != nil {
		t.Fatal(err)
	}
	if n := owned.live("plugin:owned"); n != 0 {
		t.Errorf("%d threads left live", n)
	}
	if ts := (fakeTerms{owned}).Owned("owned"); len(ts) != 0 {
		t.Errorf("terminals left: %+v", ts)
	}
	if log := e.logText("owned"); !strings.Contains(log, "archived its threads: 1") || !strings.Contains(log, "closed its terminals: 1") {
		t.Errorf("log: %s", log)
	}
}

// Without the permissions, thread/* and terminal/* are refused.
func TestPluginThreadsNeedThePermission(t *testing.T) {
	owned := newFakeOwned()
	e := newEnv(t, func(o *plugin.Options) { o.Threads, o.Terminals = owned, fakeTerms{owned} })
	e.install(e.opts.Dir, "owned", "owned", ownedManifest("owned", pluginsdk.Permissions{}))
	m := e.start()
	if _, err := m.Enable(context.Background(), "owned", true); err != nil {
		t.Fatal(err)
	}
	e.waitState("owned", plugin.StateRunning)
	for _, cmd := range []string{"create", "threads", "term"} {
		r, err := e.invoke("plugin.owned."+cmd, map[string]string{"p": `{"title":"x","argv":["sh"]}`}, command.Context{})
		if err != nil || !strings.HasPrefix(r.Message, "code "+strconv.Itoa(pluginsdk.CodePermissionDenied)) {
			t.Errorf("%s = %+v, %v", cmd, r, err)
		}
	}
	if len(owned.specs) != 0 {
		t.Errorf("created: %+v", owned.specs)
	}
}

// A plugin disabled while the daemon was stopped has its threads archived at start.
func TestStartArchivesThreadsOfDisabledPlugins(t *testing.T) {
	owned := newFakeOwned()
	owned.threads = append(owned.threads, pluginsdk.PluginThread{ThreadID: "s-gone"})
	owned.owners["s-gone"] = "plugin:gone"
	e := newEnv(t, func(o *plugin.Options) { o.Threads, o.Terminals = owned, fakeTerms{owned} })
	e.start()
	if n := owned.live("plugin:gone"); n != 0 {
		t.Errorf("a removed plugin's thread is still live")
	}
}
