package plugintest_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/plugintest"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// recorder records the acts it gets.
type recorder struct{ got chan pluginsdk.SurfaceAct }

func (r recorder) Act(_ context.Context, a pluginsdk.SurfaceAct) error { r.got <- a; return nil }
func (recorder) Visibility(bool)                                       {}
func (recorder) Close(pluginsdk.CloseReason)                           {}

// Act shapes a tab or select act as the host does from the latest view (kind, action,
// node, Value the key, no Values), refuses one that names the other kind, and sends any
// other act as given.
func TestActShapesTabsAndSelects(t *testing.T) {
	rec := recorder{got: make(chan pluginsdk.SurfaceAct, 1)}
	p := pluginsdk.Plugin{Surfaces: map[string]pluginsdk.SurfaceFactory{
		"s": func(_ context.Context, h *pluginsdk.Host, open pluginsdk.SurfaceOpen) (pluginsdk.Surface, error) {
			md := ui.NewMasterDetail("md", ui.List{Rows: []ui.Row{ui.NewRow("r1", "One"), ui.NewRow("r2", "Two")}}, "r1",
				ui.NewTabsNode("nt", ui.NewTabs("nt-a", ui.NewTab("nt-a", "A"), ui.NewTab("nt-b", "B"))))
			v := ui.View{Tabs: ui.NewTabs("vt-a", ui.NewTab("vt-a", "A"), ui.NewTab("vt-b", "B")), Nodes: []ui.Node{md}}
			return rec, h.UpdateView(open.Instance, v)
		},
	}}
	h := plugintest.Start(t, p, plugintest.Options{})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := h.OpenSurface(ctx, "i", "s", pluginsdk.UiContext{}); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(2*time.Second, func(h *plugintest.Host) bool { _, ok := h.View("i"); return ok })
	for _, c := range []struct {
		name string
		act  pluginsdk.SurfaceAct
		want pluginsdk.SurfaceAct
	}{
		{"a select with values and no node", pluginsdk.SurfaceAct{Key: "r2", Values: map[string]any{"name": "Ada"}},
			pluginsdk.SurfaceAct{Kind: pluginsdk.ActSelect, Action: "select", Key: "r2", Node: "md", Value: "r2"}},
		{"a node tab without its value", pluginsdk.SurfaceAct{Kind: pluginsdk.ActTab, Key: "nt-b"},
			pluginsdk.SurfaceAct{Kind: pluginsdk.ActTab, Action: "tab", Key: "nt-b", Node: "nt", Value: "nt-b"}},
		{"a view tab", pluginsdk.SurfaceAct{Kind: pluginsdk.ActTab, Action: "tab", Key: "vt-b", Value: "x"},
			pluginsdk.SurfaceAct{Kind: pluginsdk.ActTab, Action: "tab", Key: "vt-b", Value: "vt-b"}},
		{"another act goes as given", pluginsdk.SurfaceAct{Kind: pluginsdk.ActClick, Action: "nope", Key: "x", Values: map[string]any{"a": "b"}},
			pluginsdk.SurfaceAct{Kind: pluginsdk.ActClick, Action: "nope", Key: "x", Values: map[string]any{"a": "b"}}},
	} {
		c.act.Instance = "i"
		if err := h.Act(ctx, c.act); err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		got := <-rec.got
		if got.Kind != c.want.Kind || got.Action != c.want.Action || got.Key != c.want.Key || got.Node != c.want.Node ||
			got.Value != c.want.Value || len(got.Values) != len(c.want.Values) || got.Version != 1 {
			t.Errorf("%s: the plugin got %+v", c.name, got)
		}
	}
	for _, act := range []pluginsdk.SurfaceAct{
		{Instance: "i", Kind: pluginsdk.ActTab, Key: "r1"},
		{Instance: "i", Action: "select", Key: "nt-a"},
	} {
		if err := h.Act(ctx, act); err == nil || !strings.Contains(err.Error(), "the host refuses it") {
			t.Errorf("%+v: %v", act, err)
		}
	}
}

// Start announces the real host's capabilities unless the options list others.
func TestDefaultCapabilities(t *testing.T) {
	for _, c := range []struct {
		caps []string
		want bool
	}{{nil, true}, {[]string{}, false}, {[]string{"surfaces"}, false}} {
		var has bool
		p := pluginsdk.Plugin{Init: func(_ context.Context, h *pluginsdk.Host) error {
			has = h.HasCapability("view.node.masterDetail") && h.HasCapability("terminals")
			return nil
		}}
		plugintest.Start(t, p, plugintest.Options{Capabilities: c.caps})
		if has != c.want {
			t.Errorf("Capabilities %v: masterDetail and terminals %v", c.caps, has)
		}
	}
}
