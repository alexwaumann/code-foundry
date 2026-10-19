package plugin_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// The surface tests run the test binary as a plugin with surfaces (surfacePlugin), under
// its own variable so helper_test.go's modes stay as they are.
const surfaceHelperEnv = "CF_PLUGIN_SURFACE_HELPER"

func init() {
	if os.Getenv(surfaceHelperEnv) != "" {
		if err := pluginsdk.Serve(surfacePlugin()); err != nil {
			fmt.Fprintln(os.Stderr, "serve:", err)
			os.Exit(1)
		}
		os.Exit(0)
	}
}

// panel is the test plugin's main surface: a counter, a form, a log.
type panel struct {
	h    *pluginsdk.Host
	inst string
	mu   sync.Mutex
	n    int
	got  string
}

func (p *panel) view() ui.View {
	p.mu.Lock()
	defer p.mu.Unlock()
	submit := ui.EventButton("save", "Save", "save")
	form := ui.NewForm("form", &submit, ui.TextField("name", "name", "Name"), ui.SecretField("tok", "tok", "Token", "tok"))
	return ui.View{Nodes: []ui.Node{
		ui.NewText("count", ui.Plain(fmt.Sprintf("count %d; got %s", p.n, p.got))),
		ui.NewActions("bar", ui.EventButton("inc", "Inc", "inc"), ui.EventButton("append", "Append", "append"),
			ui.EventButton("bad", "Bad", "bad"), ui.EventButton("flood", "Flood", "flood"), ui.EventButton("fail", "Fail", "fail"),
			ui.CommandButton("cmd", "Cmd", "plugin.surf.on", nil)),
		ui.NewActions("bar2", ui.EventButton("hang", "Hang", "hang"), ui.EventButton("exit", "Exit", "exit")),
		form,
		{Key: "out", Log: &ui.Log{}},
		ui.NewMasterDetail("pmd", ui.List{Rows: []ui.Row{ui.NewRow("pr1", "Run 1"), ui.NewRow("pr2", "Run 2")}}, "pr1",
			ui.NewTabsNode("ptabs", ui.NewTabs("pt1", ui.NewTab("pt1", "One"), ui.NewTab("pt2", "Two")))),
	}}
}

func (p *panel) Act(ctx context.Context, act pluginsdk.SurfaceAct) error {
	if act.Context.ThreadID != "" {
		p.h.Log().Info("act", "viewer", act.Context.ThreadID)
	}
	if act.Kind == pluginsdk.ActSelect || act.Kind == pluginsdk.ActTab {
		// Dispatch on the kind: a click's event may be named "select" or "tab" too.
		p.mu.Lock()
		vals, _ := json.Marshal(act.Values)
		p.got = fmt.Sprintf("%s:%s key=%s value=%v node=%q values=%s version=%d", act.Kind, act.Action, act.Key, act.Value, act.Node, vals, act.Version)
		p.mu.Unlock()
		return p.h.UpdateView(p.inst, p.view())
	}
	switch act.Action {
	case "inc":
		p.mu.Lock()
		p.n++
		p.mu.Unlock()
	case "save":
		b, _ := json.Marshal(act.Values)
		p.mu.Lock()
		p.got = string(b)
		p.mu.Unlock()
	case "append":
		for _, s := range []string{"a\n", "b\n", "c\n"} {
			if err := p.h.AppendLog(p.inst, "out", s); err != nil {
				return err
			}
		}
		return nil
	case "bad":
		return p.h.UpdateView(p.inst, map[string]any{"nodes": []any{map[string]any{"key": "x", "table": map[string]any{}}}})
	case "flood":
		for i := range 100 {
			p.mu.Lock()
			p.n = 1000 + i
			p.mu.Unlock()
			if err := p.h.UpdateView(p.inst, p.view()); err != nil {
				return err
			}
		}
		return nil
	case "fail":
		return errors.New("it broke")
	case "hang": // past the host's act timeout
		select {
		case <-ctx.Done():
		case <-time.After(5 * time.Second):
		}
		return nil
	case "exit": // the plugin stops while it has the act
		os.Exit(3)
	}
	return p.h.UpdateView(p.inst, p.view())
}

func (p *panel) Visibility(v bool) { p.h.Log().Info("visibility", "instance", p.inst, "visible", v) }
func (p *panel) Close(r pluginsdk.CloseReason) {
	p.h.Log().Info("closed", "instance", p.inst, "reason", string(r))
}

type still struct{}

func (still) Act(context.Context, pluginsdk.SurfaceAct) error { return nil }
func (still) Visibility(bool)                                 {}
func (still) Close(pluginsdk.CloseReason)                     {}

func surfacePlugin() pluginsdk.Plugin {
	setCtx := func(v any) pluginsdk.CommandFunc {
		return func(_ context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
			return pluginsdk.CommandResult{Message: "ok"}, h.SetContext(pluginsdk.ContextParams{Key: "on", Value: v, ThreadID: req.Context.ThreadID})
		}
	}
	return pluginsdk.Plugin{
		Commands: map[string]pluginsdk.CommandFunc{
			"on":  setCtx(true),
			"off": setCtx(nil),
			"ask": func(ctx context.Context, h *pluginsdk.Host, _ pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
				return h.InvokeAsk(ctx, "thread.archive", nil, pluginsdk.UiContext{ThreadID: "s-1"})
			},
			"toast": func(_ context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
				return pluginsdk.CommandResult{}, h.ToastIn(req.Arg("instance"), pluginsdk.ToastError, "boom")
			},
		},
		Surfaces: map[string]pluginsdk.SurfaceFactory{
			"panel": func(_ context.Context, h *pluginsdk.Host, open pluginsdk.SurfaceOpen) (pluginsdk.Surface, error) {
				p := &panel{h: h, inst: open.Instance}
				h.Log().Info("open", "instance", open.Instance, "thread", open.Context.ThreadID, "facts", len(open.Facts))
				return p, h.UpdateView(open.Instance, p.view())
			},
			"gated": func(_ context.Context, h *pluginsdk.Host, open pluginsdk.SurfaceOpen) (pluginsdk.Surface, error) {
				return still{}, h.UpdateView(open.Instance, ui.View{Nodes: []ui.Node{ui.NewText("g", ui.Plain("gated"))}})
			},
			"checks": func(_ context.Context, h *pluginsdk.Host, open pluginsdk.SurfaceOpen) (pluginsdk.Surface, error) {
				facts, _ := json.Marshal(open.Facts)
				return still{}, h.UpdateView(open.Instance, ui.View{Nodes: []ui.Node{ui.NewText("f", ui.Plain(string(facts)))}})
			},
			"broken": func(_ context.Context, h *pluginsdk.Host, open pluginsdk.SurfaceOpen) (pluginsdk.Surface, error) {
				_ = h.UpdateView(open.Instance, map[string]any{"nodes": []any{map[string]any{"key": "x"}}})
				return still{}, nil
			},
			"silent": func(context.Context, *pluginsdk.Host, pluginsdk.SurfaceOpen) (pluginsdk.Surface, error) {
				return still{}, nil
			},
		},
	}
}

func surfaceManifest() pluginsdk.Manifest {
	return pluginsdk.Manifest{
		Name: "surf", DisplayName: "Surf", Version: "0.1.0", Protocol: 1, Exec: []string{"bin/plugin"},
		Permissions: pluginsdk.Permissions{Commands: []string{"thread.archive"}, Secrets: true},
		Commands: []pluginsdk.CommandSpec{
			{Name: "on", Title: "On"}, {Name: "off", Title: "Off"}, {Name: "ask", Title: "Ask"},
			{Name: "toast", Title: "Toast", Args: []pluginsdk.ArgSpec{{Name: "instance"}}},
			{Name: "gated-cmd", Title: "Gated", When: "surf.on"},
			{Name: "broken-when", Title: "Broken when", When: "thread &&"},
		},
		Surfaces: []pluginsdk.SurfaceSpec{
			{ID: "panel", Title: "Panel"},
			{ID: "gated", Title: "Gated", When: "surf.on"},
			{ID: "checks", Title: "Checks", Scope: pluginsdk.ScopePR, When: `"github-actions" in pr.checks.provider`},
			{ID: "broken", Title: "Broken"},
			{ID: "silent", Title: "Silent", Scope: pluginsdk.ScopeGlobal},
			{ID: "proj", Title: "Project", Scope: pluginsdk.ScopeProject},
		},
	}
}

// fakeFacts is a FactSource whose pull request checks wait for release.
type fakeFacts struct {
	mu      sync.Mutex
	threads map[string]plugin.ThreadFacts
	checks  []plugin.CheckRun
	release chan struct{}
	fetches int
}

func (f *fakeFacts) Thread(id string) (plugin.ThreadFacts, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	t, ok := f.threads[id]
	return t, ok
}

func (f *fakeFacts) Project(id string) (plugin.ProjectFacts, bool) {
	return plugin.ProjectFacts{ID: id, Name: id}, id != ""
}

func (f *fakeFacts) PullRequestChecks(ctx context.Context, _ string, _ int) ([]plugin.CheckRun, error) {
	f.mu.Lock()
	f.fetches++
	rel := f.release
	f.mu.Unlock()
	select {
	case <-rel:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.checks, nil
}

type surfEnv struct {
	*env
	facts *fakeFacts
	emit  *commandtest.Emitter
}

// newSurfEnv starts a manager with the surface plugin enabled and running.
func newSurfEnv(t *testing.T, mod func(*plugin.Options)) *surfEnv {
	t.Helper()
	facts := &fakeFacts{release: make(chan struct{}), threads: map[string]plugin.ThreadFacts{
		"s-1": {ID: "s-1", ProjectID: "p-1", PullRequests: []plugin.PullRequestRef{{Slug: "o/r", Number: 1, URL: "https://github.com/o/r/pull/1"}}},
		"s-2": {ID: "s-2", ProjectID: "p-1"},
	}}
	emit := &commandtest.Emitter{Delivered: 1}
	e := newEnv(t, func(o *plugin.Options) {
		o.Facts, o.Emitter = facts, emit
		o.SurfaceGrace, o.FirstViewTimeout, o.CoalesceInterval = 300*time.Millisecond, 500*time.Millisecond, 20*time.Millisecond
		if mod != nil {
			mod(o)
		}
	})
	pkg := filepath.Join(e.opts.Dir, "surf")
	if err := os.MkdirAll(filepath.Join(pkg, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(surfaceManifest())
	if err := os.WriteFile(filepath.Join(pkg, "plugin.json"), b, 0o644); err != nil {
		t.Fatal(err)
	}
	self, _ := os.Executable()
	script := fmt.Sprintf("#!/bin/sh\n%s=1 exec '%s'\n", surfaceHelperEnv, self)
	if err := os.WriteFile(filepath.Join(pkg, "bin", "plugin"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	m := e.start()
	if _, err := m.Enable(context.Background(), "surf", true); err != nil {
		t.Fatal(err)
	}
	e.waitState("surf", plugin.StateRunning)
	return &surfEnv{env: e, facts: facts, emit: emit}
}

// watcher collects one WatchSurface stream.
type watcher struct {
	t      *testing.T
	key    string
	ch     <-chan plugin.SurfaceUpdate
	cancel context.CancelFunc
}

func (e *surfEnv) watch(surface string, uctx command.Context) *watcher {
	e.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	key, ch, err := e.m.WatchSurface(ctx, plugin.SurfaceRef{Plugin: "surf", Surface: surface, Context: uctx})
	if err != nil {
		cancel()
		e.t.Fatalf("watch %s: %v", surface, err)
	}
	e.t.Cleanup(cancel)
	return &watcher{t: e.t, key: key, ch: ch, cancel: cancel}
}

// until reads updates until cond accepts one; it fails after 10 s.
func (w *watcher) until(what string, cond func(u plugin.SurfaceUpdate) bool) plugin.SurfaceUpdate {
	w.t.Helper()
	timeout := time.After(10 * time.Second)
	for {
		select {
		case u, ok := <-w.ch:
			if !ok {
				w.t.Fatalf("%s: stream closed", what)
			}
			if cond(u) {
				return u
			}
		case <-timeout:
			w.t.Fatalf("%s: timed out", what)
		}
	}
}

func (w *watcher) view(what string, cond func(v *plugin.SurfaceView) bool) *plugin.SurfaceView {
	w.t.Helper()
	return w.until(what, func(u plugin.SurfaceUpdate) bool { return u.View != nil && cond(u.View) }).View
}

func (w *watcher) state(what string, p plugin.SurfacePhase) *plugin.SurfaceState {
	w.t.Helper()
	return w.until(what, func(u plugin.SurfaceUpdate) bool { return u.State != nil && u.State.Phase == p }).State
}

func contains(s string) func(v *plugin.SurfaceView) bool {
	return func(v *plugin.SurfaceView) bool { return strings.Contains(string(v.JSON), s) }
}

func (e *surfEnv) act(key string, req plugin.ActRequest) (uint64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req.Instance = key
	return e.m.Act(ctx, req)
}

func (e *surfEnv) waitLog(what string) {
	e.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !strings.Contains(e.logText("surf"), what) {
		if time.Now().After(deadline) {
			e.t.Fatalf("log lacks %q:\n%s", what, e.logText("surf"))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

var s1 = command.Context{ActiveThreadID: "s-1"}

func TestSurfaceLifecycle(t *testing.T) {
	e := newSurfEnv(t, nil)
	w := e.watch("panel", s1)
	if w.key != "surf/panel/thread:s-1" {
		t.Fatalf("key %s", w.key)
	}
	w.state("live", plugin.PhaseLive)
	v1v := w.view("first view", contains("count 0"))
	e.waitLog("log info open facts=0 instance=surf/panel/thread:s-1 thread=s-1")
	e.waitLog("visible=true")

	if _, err := e.act(w.key, plugin.ActRequest{Key: "inc"}); err != nil {
		t.Fatal(err)
	}
	v2 := w.view("after inc", contains("count 1"))
	if v2.Version != v1v.Version+1 {
		t.Errorf("versions %d then %d", v1v.Version, v2.Version)
	}
	// The act carries the acting panel's context (the plugin's SurfaceAct.Context).
	if _, err := e.act(w.key, plugin.ActRequest{Key: "inc", Context: command.Context{ActiveThreadID: "s-viewer"}}); err != nil {
		t.Fatal(err)
	}
	e.waitLog("act viewer=s-viewer")
	w.view("after the second inc", contains("count 2"))
	// A second watcher gets the current view at once.
	w2 := e.watch("panel", s1)
	w2.view("second watcher", contains("count 2"))
	w2.cancel()
	w.cancel()
	e.waitLog("visible=false")
	e.waitLog("host  closed surf/panel/thread:s-1 (no viewer for")
	e.waitLog("log info closed instance=surf/panel/thread:s-1")

	// Back after the grace: the cached view paints, then the plugin reopens it.
	w3 := e.watch("panel", s1)
	st := w3.until("first update", func(u plugin.SurfaceUpdate) bool { return u.State != nil }).State
	if st.Phase != plugin.PhaseOpening || st.Message != "updating" {
		t.Errorf("reopen state %+v", st)
	}
	w3.view("cached view", contains("count 2"))
	w3.view("fresh view", contains("count 0"))

	// Another thread is another instance; a project-scoped surface needs a project.
	if w4 := e.watch("panel", command.Context{ActiveThreadID: "s-2"}); w4.key != "surf/panel/thread:s-2" {
		t.Errorf("s-2 key %s", w4.key)
	}
	if _, _, err := e.m.WatchSurface(context.Background(), plugin.SurfaceRef{Plugin: "surf", Surface: "panel"}); !errors.Is(err, plugin.ErrFailedPrecondition) ||
		!strings.Contains(err.Error(), "it shows a thread") {
		t.Errorf("no thread: %v", err)
	}
	if _, _, err := e.m.WatchSurface(context.Background(), plugin.SurfaceRef{Plugin: "surf", Surface: "nope", Context: s1}); !errors.Is(err, plugin.ErrNotFound) {
		t.Errorf("unknown surface: %v", err)
	}
	if w5 := e.watch("proj", s1); w5.key != "surf/proj/project:p-1" {
		t.Errorf("project key from the thread: %s", w5.key)
	}
}

func TestSurfaceActs(t *testing.T) {
	e := newSurfEnv(t, nil)
	w := e.watch("panel", s1)
	first := w.view("first", contains("count 0"))

	// A form submit: the secret with store goes to the Keychain, the plugin gets a marker.
	if _, err := e.act(w.key, plugin.ActRequest{Action: "save", Values: map[string]any{"name": "Ada", "tok": "s3cr3t"}}); err != nil {
		t.Fatal(err)
	}
	got := w.view("saved", contains("Ada"))
	if !strings.Contains(string(got.JSON), `\"tok\":{\"key\":\"tok\",\"stored\":true}`) || strings.Contains(string(got.JSON), "s3cr3t") {
		t.Errorf("saved view %s", got.JSON)
	}
	if v, ok, _ := e.secrets.Get(context.Background(), "surf", "tok"); !ok || v != "s3cr3t" {
		t.Errorf("stored secret %q %v", v, ok)
	}
	if list, _ := e.m.Secrets(context.Background(), "surf"); len(list) != 1 || list[0].Key != "tok" {
		t.Errorf("secrets list %+v", list)
	}
	if strings.Contains(e.logText("surf"), "s3cr3t") {
		t.Error("a secret reached the log")
	}

	tests := []struct {
		name string
		req  plugin.ActRequest
		want error
		msg  string
	}{
		{"unknown field", plugin.ActRequest{Action: "save", Values: map[string]any{"nope": "x"}}, plugin.ErrInvalidArgument, "not a field"},
		{"unknown key", plugin.ActRequest{Key: "zz"}, plugin.ErrInvalidArgument, "no acting element"},
		{"host action", plugin.ActRequest{Key: "cmd"}, plugin.ErrInvalidArgument, "command action: the host runs it"},
		{"wrong action", plugin.ActRequest{Key: "inc", Action: "save"}, plugin.ErrInvalidArgument, `not "save"`},
		{"plugin error", plugin.ActRequest{Key: "fail"}, plugin.ErrPluginRefused, "it broke"},
		{"old version", plugin.ActRequest{Key: "inc", Version: 999}, plugin.ErrFailedPrecondition, "the view changed"},
		{"values too big", plugin.ActRequest{Action: "save", Values: map[string]any{"name": strings.Repeat("x", ui.MaxActValues)}},
			plugin.ErrInvalidArgument, "values are over 65536 bytes"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := e.act(w.key, tt.req)
			if !errors.Is(err, tt.want) || !strings.Contains(err.Error(), tt.msg) {
				t.Errorf("err = %v, want %v with %q", err, tt.want, tt.msg)
			}
		})
	}
	// An older version still acts while it is kept (keptFor after it was replaced).
	if ver, err := e.act(w.key, plugin.ActRequest{Key: "inc", Version: first.Version}); err != nil || ver != first.Version {
		t.Errorf("act on version %d: %d, %v", first.Version, ver, err)
	}
	if _, err := e.m.Act(context.Background(), plugin.ActRequest{Instance: "surf/panel/thread:nope", Key: "inc"}); !errors.Is(err, plugin.ErrNotFound) {
		t.Errorf("unknown instance: %v", err)
	}
	elements := e.m.SurfaceElements(w.key, 0)
	if len(elements) != 13 || elements[0].Key != "inc" || elements[8].Kind != "submit" || elements[8].Form != "form" || elements[9].Kind != "select" {
		t.Errorf("elements %+v", elements)
	}
}

func TestSurfaceAppendsAndCoalescing(t *testing.T) {
	e := newSurfEnv(t, nil)
	w := e.watch("panel", s1)
	w.view("first", contains("count 0"))
	if _, err := e.act(w.key, plugin.ActRequest{Key: "append"}); err != nil {
		t.Fatal(err)
	}
	var text string
	for text != "a\nb\nc\n" {
		u := w.until("appends", func(u plugin.SurfaceUpdate) bool { return u.Append != nil })
		if u.Append.Key != "out" {
			t.Fatalf("append %+v", u.Append)
		}
		text += u.Append.Text
	}
	// A late watcher gets the log in the view.
	w2 := e.watch("panel", s1)
	w2.view("late", contains(`"log":{"text":"a\nb\nc\n"}`))

	// 100 views in a burst reach a watcher coalesced, ending with the last.
	before, _ := e.act(w.key, plugin.ActRequest{Key: "inc"})
	if _, err := e.act(w.key, plugin.ActRequest{Key: "flood"}); err != nil {
		t.Fatal(err)
	}
	seen := 0
	last := w.view("last of the flood", func(v *plugin.SurfaceView) bool {
		seen++
		return strings.Contains(string(v.JSON), "count 1099")
	})
	if last.Version < before+100 || seen > 60 {
		t.Errorf("version %d (from %d), %d views seen", last.Version, before, seen)
	}
}

func TestSurfaceInvalidViews(t *testing.T) {
	e := newSurfEnv(t, nil)
	w := e.watch("panel", s1)
	good := w.view("first", contains("count 0"))
	_, err := e.act(w.key, plugin.ActRequest{Key: "bad"})
	if !errors.Is(err, plugin.ErrPluginRefused) || !strings.Contains(err.Error(), "view rejected: nodes[0]: a node has exactly one kind") {
		t.Fatalf("bad view: %v", err)
	}
	e.waitLog("host  view for surf/panel/thread:s-1 rejected (1 problems)")
	p := e.wait("surf", "the issue", func(p plugin.Plugin) bool { return len(p.Issues) > 0 })
	if !strings.Contains(strings.Join(p.Issues, "\n"), "surface panel: its last view was rejected: nodes[0]") {
		t.Errorf("issues %v", p.Issues)
	}
	// Not a dev plugin: the last good view stays.
	if _, err := e.act(w.key, plugin.ActRequest{Key: "inc"}); err != nil {
		t.Fatal(err)
	}
	if v := w.view("next", contains("count 1")); v.Version != good.Version+1 || v.HostRendered {
		t.Errorf("after a rejected view: %+v", v)
	}
	e.wait("surf", "the issue cleared", func(p plugin.Plugin) bool { return len(p.Issues) == 1 }) // broken-when stays

	// Without a good view the instance shows the host's notice.
	b := e.watch("broken", s1)
	v := b.view("notice", contains("Invalid view"))
	if !v.HostRendered || !strings.Contains(string(v.JSON), `"tone":"error"`) || !strings.Contains(string(v.JSON), "code-foundry plugin logs surf") {
		t.Errorf("notice %s", v.JSON)
	}
}

func TestSurfaceNotRespondingAndPluginDown(t *testing.T) {
	e := newSurfEnv(t, nil)
	w := e.watch("silent", command.Context{})
	if w.key != "surf/silent/global" {
		t.Fatalf("key %s", w.key)
	}
	w.state("not responding", plugin.PhaseNotResponding)

	p := e.watch("panel", s1)
	p.view("first", contains("count 0"))
	// Facts set by this run vanish with it.
	if _, err := e.invoke("plugin.surf.on", nil, s1); err != nil {
		t.Fatal(err)
	}
	e.waitAvailable("plugin.surf.show.gated", s1, true)
	pl, _ := e.m.Snapshot().Plugin("surf")
	if err := syscall.Kill(pl.PID, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	st := p.state("plugin down", plugin.PhasePluginDown)
	if st.PluginState != plugin.StateCrashed || !strings.Contains(st.Message, "crashed") {
		t.Errorf("down state %+v", st)
	}
	p.state("reopened", plugin.PhaseLive)
	// The new process sent the same view (no new version); it acts on it.
	if _, err := e.act(p.key, plugin.ActRequest{Key: "inc"}); err != nil {
		t.Fatal(err)
	}
	p.view("after the restart", contains("count 1"))
	e.waitAvailable("plugin.surf.show.gated", s1, false)
}

// waitAvailable waits for a command's availability in uctx.
func (e *surfEnv) waitAvailable(name string, uctx command.Context, want bool) {
	e.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		c, ok := e.reg.Get(name)
		if ok && c.Available(uctx) == want {
			return
		}
		if time.Now().After(deadline) {
			e.t.Fatalf("%s available = %v, want %v", name, !want, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestShowCommandsAndContextFacts(t *testing.T) {
	e := newSurfEnv(t, nil)
	sub := bus.Subscribe[plugin.Event](e.opts.Bus, 256)
	defer sub.Close()
	avail := func(name string, uctx command.Context) bool {
		c, ok := e.reg.Get(name)
		if !ok {
			t.Fatalf("%s not registered", name)
		}
		return c.Available(uctx)
	}
	s2 := command.Context{ActiveThreadID: "s-2"}
	for _, tt := range []struct {
		name string
		uctx command.Context
		want bool
	}{
		{"plugin.surf.show.panel", s1, true},
		{"plugin.surf.show.panel", command.Context{}, false},
		{"plugin.surf.show.panel", command.Context{ActiveThreadID: "s-nope"}, false},
		{"plugin.surf.show.silent", command.Context{}, true},
		{"plugin.surf.show.gated", s1, false},
		{"plugin.surf.gated-cmd", s1, false},
		{"plugin.surf.broken-when", s1, false},
		{"plugin.surf.on", command.Context{}, true},
	} {
		if got := avail(tt.name, tt.uctx); got != tt.want {
			t.Errorf("%s in %+v = %v, want %v", tt.name, tt.uctx, got, tt.want)
		}
	}
	if _, err := e.invoke("plugin.surf.broken-when", nil, s1); err == nil || !strings.Contains(err.Error(), "does not compile") {
		t.Errorf("broken when: %v", err)
	}
	p, _ := e.m.Snapshot().Plugin("surf")
	if !strings.Contains(strings.Join(p.Issues, "\n"), "commands[5].when:") {
		t.Errorf("issues %v", p.Issues)
	}

	// context/set for s-1 makes gated available there only, and says so on the bus.
	if _, err := e.invoke("plugin.surf.on", nil, s1); err != nil {
		t.Fatal(err)
	}
	e.waitAvailable("plugin.surf.show.gated", s1, true)
	if avail("plugin.surf.show.gated", s2) || !avail("plugin.surf.gated-cmd", s1) {
		t.Error("the fact leaked to s-2, or the command did not follow")
	}
	waitEvent(t, sub, func(ev plugin.Event) bool { _, ok := ev.(plugin.AvailabilityChanged); return ok })
	if a := e.m.SurfaceAvailable("surf", "gated", s2); a.Available || a.Unknown || !strings.Contains(a.Reason, "surf.on") {
		t.Errorf("s-2: %+v", a)
	}
	if _, err := e.invoke("plugin.surf.off", nil, s1); err != nil {
		t.Fatal(err)
	}
	e.waitAvailable("plugin.surf.show.gated", s1, false)

	// The show command emits the panel's ShowView with the thread.
	if _, err := e.invoke("plugin.surf.show.panel", nil, s1); err != nil {
		t.Fatal(err)
	}
	in := e.emit.Intents()
	if len(in) == 0 || in[len(in)-1].GetShowView().GetName() != "panel.plugin.surf.panel?thread=s-1" {
		t.Errorf("intents %v", in)
	}
}

func waitEvent(t *testing.T, sub *bus.Subscription[plugin.Event], cond func(plugin.Event) bool) {
	t.Helper()
	timeout := time.After(10 * time.Second)
	for {
		select {
		case ev := <-sub.C():
			if cond(ev) {
				return
			}
		case <-timeout:
			t.Fatal("event timed out")
		}
	}
}

func TestAsyncChecksFact(t *testing.T) {
	e := newSurfEnv(t, nil)
	sub := bus.Subscribe[plugin.Event](e.opts.Bus, 256)
	defer sub.Close()
	show, _ := e.reg.Get("plugin.surf.show.checks")
	if show.Available(s1) {
		t.Fatal("available before the checks are known")
	}
	if why := show.WhyUnavailable(s1); !strings.Contains(why, "not known yet") {
		t.Errorf("why %q", why)
	}
	if a := e.m.SurfaceAvailable("surf", "checks", s1); a.Available || !a.Unknown {
		t.Errorf("s-1 before the checks: %+v, want unknown", a)
	}
	if a := e.m.SurfaceAvailable("surf", "checks", command.Context{ActiveThreadID: "s-2"}); a.Available || a.Unknown || !strings.Contains(a.Reason, "no pull request") {
		t.Errorf("s-2 (no pull request): %+v", a)
	}
	e.facts.mu.Lock()
	e.facts.checks = []plugin.CheckRun{{Name: "test", App: "github-actions", URL: "https://github.com/o/r/actions/runs/1/job/2"}, {Name: "jenkins", URL: "https://ci.example/1"}}
	close(e.facts.release)
	e.facts.mu.Unlock()
	waitEvent(t, sub, func(ev plugin.Event) bool { _, ok := ev.(plugin.AvailabilityChanged); return ok })
	if !show.Available(s1) {
		t.Fatal("not available once the checks arrived")
	}
	w := e.watch("checks", s1)
	if w.key != "surf/checks/pr:o/r#1" {
		t.Errorf("key %s", w.key)
	}
	v := w.view("facts", contains("github-actions"))
	if !strings.Contains(string(v.JSON), `\"pr\":{\"number\":1,\"repo\":\"o/r\"`) {
		t.Errorf("facts view %s", v.JSON)
	}
	e.facts.mu.Lock()
	if e.facts.fetches != 1 {
		t.Errorf("%d fetches", e.facts.fetches)
	}
	e.facts.mu.Unlock()
}

func TestInvokeAskAndToasts(t *testing.T) {
	e := newSurfEnv(t, nil)
	r, err := e.invoke("plugin.surf.ask", nil, command.Context{})
	if err != nil || !strings.Contains(r.Message, "asked the user to confirm thread.archive") {
		t.Fatalf("ask = %+v, %v", r, err)
	}
	var ask *v1.UiIntent_InvokeCommand
	for _, in := range e.emit.Intents() {
		if in.GetInvokeCommand() != nil {
			ask = in.GetInvokeCommand()
		}
	}
	if ask == nil || ask.GetName() != "thread.archive" || ask.GetCaller() != "plugin:surf" || ask.GetContext().GetActiveThreadId() != "s-1" {
		t.Errorf("intent %v", ask)
	}
	// Nobody to ask: the plugin gets confirmation-required as before.
	e.emit.Delivered = 0
	if _, err := e.invoke("plugin.surf.ask", nil, command.Context{}); err == nil || !strings.Contains(err.Error(), "asks the user first") {
		t.Errorf("no GUI: %v", err)
	}

	w := e.watch("panel", s1)
	w.view("first", contains("count 0"))
	if _, err := e.invoke("plugin.surf.toast", map[string]string{"instance": w.key}, command.Context{}); err != nil {
		t.Fatal(err)
	}
	u := w.until("toast", func(u plugin.SurfaceUpdate) bool { return u.Toast != nil })
	if u.Toast.Level != "error" || u.Toast.Text != "boom" {
		t.Errorf("toast %+v", u.Toast)
	}
}

// An open instance closes at once when its thread is archived (context_gone) or its
// when clause stops holding (unavailable), not after the idle grace; a watched one closed
// as unavailable reopens when the clause holds again.
func TestSurfaceCloseReasons(t *testing.T) {
	if plugin.DefaultSurfaceGrace != 10*time.Minute {
		t.Errorf("grace %s, want 10m", plugin.DefaultSurfaceGrace)
	}
	e := newSurfEnv(t, func(o *plugin.Options) { o.SurfaceGrace = time.Minute })
	s2 := command.Context{ActiveThreadID: "s-2"}

	// context_gone: s-1's panel, no longer watched, its thread archived.
	w := e.watch("panel", s1)
	w.view("first view", contains("count 0"))
	w.cancel()
	e.waitLog("visible=false")
	e.facts.mu.Lock()
	t1 := e.facts.threads["s-1"]
	t1.Archived = true
	e.facts.threads["s-1"] = t1
	e.facts.mu.Unlock()
	e.m.ContextsChanged()
	e.waitLog("host  closed surf/panel/thread:s-1 (context_gone: the thread was archived)")
	e.waitLog("log info closed instance=surf/panel/thread:s-1 reason=context_gone")
	if _, _, err := e.m.WatchSurface(context.Background(), plugin.SurfaceRef{Plugin: "surf", Surface: "panel", Context: s1}); !errors.Is(err, plugin.ErrFailedPrecondition) ||
		!strings.Contains(err.Error(), "the thread is archived") {
		t.Errorf("watching an archived thread's surface: %v", err)
	}

	// unavailable: s-2's gated surface, watched, when surf.on stops holding.
	if _, err := e.invoke("plugin.surf.on", nil, s2); err != nil {
		t.Fatal(err)
	}
	e.waitAvailable("plugin.surf.show.gated", s2, true)
	g := e.watch("gated", s2)
	g.view("gated view", contains("gated"))
	if _, err := e.invoke("plugin.surf.off", nil, s2); err != nil {
		t.Fatal(err)
	}
	st := g.state("closed", plugin.PhaseFailed)
	if !strings.Contains(st.Message, "closed: its condition does not hold here: surf.on") {
		t.Errorf("closed state %+v", st)
	}
	e.waitLog("host  closed surf/gated/thread:s-2 (unavailable: its condition does not hold here: surf.on)")
	if strings.Contains(e.logText("surf"), "closed surf/gated/thread:s-2 (no viewer") {
		t.Error("closed for idle")
	}
	// The clause holds again: its watcher gets it back.
	if _, err := e.invoke("plugin.surf.on", nil, s2); err != nil {
		t.Fatal(err)
	}
	g.state("reopened", plugin.PhaseLive)
	e.eventually("a second surface/open", func() bool { return strings.Count(e.logText("surf"), "host  opened surf/gated/thread:s-2") == 2 })
}

// A master-detail's row without an action sends a select act and a tabs node's tab a tab
// act, both naming their node; the plugin answers with a new view. GetSurface's elements
// carry the node too.
func TestSurfaceSelectAndNodeTabActs(t *testing.T) {
	e := newSurfEnv(t, nil)
	w := e.watch("panel", s1)
	w.view("first view", contains("count 0"))
	if _, err := e.act(w.key, plugin.ActRequest{Key: "pr2"}); err != nil {
		t.Fatal(err)
	}
	w.view("after the select", contains(`got select:select key=pr2 value=pr2 node=\"pmd\"`))
	if _, err := e.act(w.key, plugin.ActRequest{Key: "pt2", Action: "tab"}); err != nil {
		t.Fatal(err)
	}
	w.view("after the node tab", contains(`got tab:tab key=pt2 value=pt2 node=\"ptabs\"`))
	// A value from the client does not replace the row's key; a wrong action is refused.
	v := "pr1"
	if _, err := e.act(w.key, plugin.ActRequest{Key: "pr2", Value: &v}); err != nil {
		t.Fatal(err)
	}
	w.view("the select keeps its key", contains(`got select:select key=pr2 value=pr2`))
	if _, err := e.act(w.key, plugin.ActRequest{Key: "pr1", Action: "click"}); !errors.Is(err, plugin.ErrInvalidArgument) || !strings.Contains(err.Error(), `element "pr1"'s action is "select", not "click"`) {
		t.Errorf("a select acted as a click: %v", err)
	}
	if _, err := e.act(w.key, plugin.ActRequest{Action: "select"}); !errors.Is(err, plugin.ErrInvalidArgument) || !strings.Contains(err.Error(), `no element acts "select"`) {
		t.Errorf("a select without a key: %v", err)
	}
	els := map[string]plugin.SurfaceElement{}
	for _, el := range e.m.SurfaceElements(w.key, 0) {
		els[el.Key] = el
	}
	if el := els["pr1"]; el.Kind != pluginsdk.ActSelect || el.Action != "select" || el.Node != "pmd" || el.Label != "Run 1" {
		t.Errorf("pr1 element %+v", el)
	}
	if el := els["pt2"]; el.Kind != pluginsdk.ActTab || el.Node != "ptabs" || el.Label != "Two" {
		t.Errorf("pt2 element %+v", el)
	}
}
