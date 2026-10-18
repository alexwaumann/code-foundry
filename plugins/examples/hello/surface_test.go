package main

import (
	"context"
	"encoding/json"
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
	h := plugintest.Start(t, plugin(), plugintest.Options{Name: "hello", Granted: pluginsdk.Permissions{Secrets: true}})
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
	for _, tab := range []string{"form", "log"} {
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
	h.WaitFor(5*time.Second, func(h *plugintest.Host) bool { return len(h.Toasts()) == 1 })
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
