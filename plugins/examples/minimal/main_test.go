package main

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/plugintest"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// plugin.json is valid and declares exactly what the plugin serves.
func TestManifest(t *testing.T) {
	data, err := os.ReadFile("plugin.json")
	if err != nil {
		t.Fatal(err)
	}
	m, warnings, err := pluginsdk.LoadManifest(data)
	if err != nil || len(warnings) > 0 {
		t.Fatalf("plugin.json: %v %v", err, warnings)
	}
	p := plugin()
	for _, c := range m.Commands {
		if p.Commands[c.Name] == nil {
			t.Errorf("command %s is declared but not served", c.Name)
		}
	}
	for _, s := range m.Surfaces {
		if p.Surfaces[s.ID] == nil {
			t.Errorf("surface %s is declared but not served", s.ID)
		}
	}
	if len(p.Commands) != len(m.Commands) || len(p.Surfaces) != len(m.Surfaces) {
		t.Errorf("serves %d commands and %d surfaces, declares %d and %d", len(p.Commands), len(p.Surfaces), len(m.Commands), len(m.Surfaces))
	}
}

func TestHello(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	h := plugintest.Start(t, plugin(), plugintest.Options{Name: "minimal"})
	for _, tt := range []struct{ name, want string }{{"Ada", "Hello, Ada!"}, {"world", "Hello, world!"}} {
		res, err := h.Command(ctx, "hello", map[string]string{"name": tt.name}, pluginsdk.UiContext{})
		if err != nil || res.Message != tt.want {
			t.Errorf("hello %s = %q, %v; want %q", tt.name, res.Message, err, tt.want)
		}
	}
}

func TestStatusSurface(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	h := plugintest.Start(t, plugin(), plugintest.Options{Name: "minimal"})
	const inst = "minimal/status/thread:s-1"
	if err := h.OpenSurface(ctx, inst, "status", pluginsdk.UiContext{ThreadID: "s-1"}); err != nil {
		t.Fatal(err)
	}
	// view decodes the instance's last view and checks it as the host will.
	view := func() ui.View {
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
	count := func() string { return view().Nodes[0].Pairs.Items[2].Value.Text }
	if got := count(); got != "0" {
		t.Fatalf("count = %s, want 0", got)
	}
	for _, tt := range []struct{ action, want string }{{"count", "1"}, {"count", "2"}, {"reset", "0"}} {
		if err := h.Act(ctx, pluginsdk.SurfaceAct{Instance: inst, Kind: pluginsdk.ActClick, Action: tt.action}); err != nil {
			t.Fatal(err)
		}
		if got := count(); got != tt.want {
			t.Errorf("after %s: count = %s, want %s", tt.action, got, tt.want)
		}
	}
	if err := h.Act(ctx, pluginsdk.SurfaceAct{Instance: inst, Kind: pluginsdk.ActClick, Action: "nope"}); err == nil {
		t.Error("an unknown action was accepted")
	}
}
