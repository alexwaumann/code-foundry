package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/plugintest"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

const inst = "hello/demo/thread:s-1"

// view returns the instance's last view, decoded and valid.
func view(t *testing.T, h *plugintest.Host) ui.View {
	t.Helper()
	raw, ok := h.View(inst)
	if !ok {
		t.Fatal("no view")
	}
	var v ui.View
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if err := v.Validate(); err != nil {
		t.Fatalf("invalid view: %v", err)
	}
	return v
}

func TestDemoSurface(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	h := plugintest.Start(t, plugin(), plugintest.Options{Name: "hello",
		Granted: pluginsdk.Permissions{Secrets: true, Events: []string{"threads"}, ThreadStatus: true, SessionEnv: true, Threads: true, Terminals: true,
			Commands: []string{"thread.send"}},
		Capabilities: []string{"threads", "terminals"},
		Invoke: func(context.Context, pluginsdk.InvokeParams) (pluginsdk.CommandResult, error) {
			return pluginsdk.CommandResult{Message: "sent"}, nil
		}})
	if err := h.OpenSurface(ctx, inst, "demo", pluginsdk.UiContext{ThreadID: "s-1"}); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(5*time.Second, func(h *plugintest.Host) bool { return h.Version(inst) >= 1 })
	v := view(t, h)
	if v.Tabs == nil || v.Tabs.Active != "overview" || len(v.Nodes) < 10 {
		t.Fatalf("overview: %+v", v)
	}
	kinds := map[string]bool{}
	var walk func(ns []ui.Node)
	walk = func(ns []ui.Node) {
		for _, n := range ns {
			b, _ := json.Marshal(n)
			var m map[string]json.RawMessage
			_ = json.Unmarshal(b, &m)
			for k := range m {
				kinds[k] = true
			}
			if n.Section != nil {
				walk(n.Section.Children)
			}
		}
	}
	walk(v.Nodes)
	for _, tab := range []string{"form", "log", "assistant", "shell"} {
		if err := h.Act(ctx, pluginsdk.SurfaceAct{Instance: inst, Kind: pluginsdk.ActTab, Action: "tab", Key: tab, Value: tab}); err != nil {
			t.Fatal(err)
		}
		if v := view(t, h); v.Tabs.Active != tab {
			t.Fatalf("tab %s: active %s", tab, v.Tabs.Active)
		}
		walk(view(t, h).Nodes)
	}
	for _, k := range []string{"text", "markdown", "pairs", "list", "chips", "log", "actions", "progress", "notice", "empty", "section", "form", "thread", "terminal"} {
		if !kinds[k] {
			t.Errorf("the demo has no %s node", k)
		}
	}

	// The Assistant tab made the plugin's thread (data dir, the skill dir, the env), the
	// Shell tab its clock terminal; a second visit finds them again.
	created := h.CreatedThreads()
	if len(created) != 1 || created[0].Title != assistantTitle || created[0].Env["CF_HELLO_THREAD"] != "1" || len(created[0].AddDirs) != 1 {
		t.Fatalf("created threads %+v", created)
	}
	if _, err := os.Stat(filepath.Join(created[0].AddDirs[0], ".claude", "skills", "hello-greeting", "SKILL.md")); err != nil {
		t.Errorf("the skill: %v", err)
	}
	if terms := h.CreatedTerminals(); len(terms) != 1 || terms[0].Argv[2] != clockArgv[2] || terms[0].Title != shellTitle {
		t.Fatalf("created terminals %+v", terms)
	}
	if err := h.Act(ctx, pluginsdk.SurfaceAct{Instance: inst, Kind: pluginsdk.ActTab, Action: "tab", Key: "assistant"}); err != nil {
		t.Fatal(err)
	}
	if len(h.CreatedThreads()) != 1 {
		t.Error("a second visit made another thread")
	}
	// Send hello goes to the assistant; Ask the main thread to the panel's thread (the
	// act's context), through thread.send.
	if err := h.Act(ctx, pluginsdk.SurfaceAct{Instance: inst, Kind: pluginsdk.ActClick, Action: "send-hello", Key: "send-hello"}); err != nil {
		t.Fatal(err)
	}
	if s := h.ThreadSends(); len(s) != 1 || s[0].ThreadID != "pt-1" || s[0].Text != helloPrompt {
		t.Errorf("sends %+v", s)
	}
	if err := h.Act(ctx, pluginsdk.SurfaceAct{Instance: inst, Kind: pluginsdk.ActClick, Action: "ask-main", Key: "ask-main",
		Context: pluginsdk.UiContext{ThreadID: "s-viewer"}}); err != nil {
		t.Fatal(err)
	}
	if inv := h.Invocations(); len(inv) != 1 || inv[0].Command != "thread.send" || inv[0].Context.ThreadID != "s-viewer" || inv[0].Args["text"] != askMainPrompt {
		t.Errorf("invocations %+v", inv)
	}
	// Restart closes the clock and starts another.
	if err := h.Act(ctx, pluginsdk.SurfaceAct{Instance: inst, Kind: pluginsdk.ActClick, Action: "restart-shell", Key: "restart-shell"}); err != nil {
		t.Fatal(err)
	}
	if terms := h.PluginTerminals(); len(terms) != 1 || terms[0].TerminalID != "pterm-2" {
		t.Errorf("after restart %+v", terms)
	}

	// A submit without a name is the plugin's error; with one it is saved and toasted.
	if err := h.Act(ctx, pluginsdk.SurfaceAct{Instance: inst, Kind: pluginsdk.ActTab, Action: "tab", Key: "form"}); err != nil {
		t.Fatal(err)
	}
	err := h.Act(ctx, pluginsdk.SurfaceAct{Instance: inst, Kind: pluginsdk.ActSubmit, Action: "save", Key: "f-save", Values: map[string]any{"name": ""}})
	if err == nil || !strings.Contains(err.Error(), "a name is required") {
		t.Errorf("empty save: %v", err)
	}
	if err := h.Act(ctx, pluginsdk.SurfaceAct{Instance: inst, Kind: pluginsdk.ActSubmit, Action: "save", Key: "f-save",
		Values: map[string]any{"name": "Ada", "token": map[string]any{"key": "token", "stored": true}}}); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(5*time.Second, func(h *plugintest.Host) bool { return len(h.Toasts()) == 3 })
	if !strings.Contains(string(mustJSON(view(t, h))), `"hasValue":true`) {
		t.Error("the saved token is not shown as set")
	}

	// The log tab streams a build through view/append.
	if err := h.Act(ctx, pluginsdk.SurfaceAct{Instance: inst, Kind: pluginsdk.ActClick, Action: "start-log", Key: "log-start"}); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(10*time.Second, func(h *plugintest.Host) bool { return len(h.Appends()) == 6 })
	if a := h.Appends()[5]; a.Key != "build-log" || !strings.Contains(a.Text, "done") {
		t.Errorf("last append %+v", a)
	}

	// Pin sets the thread's context fact.
	if err := h.Act(ctx, pluginsdk.SurfaceAct{Instance: inst, Kind: pluginsdk.ActClick, Action: "pin", Key: "pin"}); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(5*time.Second, func(h *plugintest.Host) bool { return len(h.Contexts()) == 1 })
	if c := h.Contexts()[0]; c.Key != "pinned" || c.Value != true || c.ThreadID != "s-1" {
		t.Errorf("context %+v", c)
	}
	if err := h.Act(ctx, pluginsdk.SurfaceAct{Instance: inst, Kind: pluginsdk.ActClick, Action: "nope", Key: "x"}); err == nil {
		t.Error("an unknown action passed")
	}
	if err := h.CloseSurface(inst); err != nil {
		t.Fatal(err)
	}
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}
