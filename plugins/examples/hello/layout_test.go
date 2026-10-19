package main

import (
	"context"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/plugintest"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// The Layout tab's toolbar filters the runs (a search submit, the status chips), its
// footer counts them and clears the filter; other tabs have neither strip.
func TestLayoutChrome(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	h := plugintest.Start(t, plugin(), plugintest.Options{Name: "hello",
		Granted:      pluginsdk.Permissions{Secrets: true, Events: []string{"threads"}, ThreadStatus: true, SessionEnv: true, Threads: true, Terminals: true, Commands: []string{"thread.send"}},
		Capabilities: []string{"threads", "terminals"}})
	if err := h.OpenSurface(ctx, inst, "demo", pluginsdk.UiContext{ThreadID: "s-1"}); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(5*time.Second, func(h *plugintest.Host) bool { return h.Version(inst) >= 1 })
	if v := view(t, h); v.Toolbar != nil || v.Footer != nil {
		t.Fatalf("the overview has strips: %+v %+v", v.Toolbar, v.Footer)
	}
	act := func(a pluginsdk.SurfaceAct) ui.View {
		t.Helper()
		a.Instance = inst
		if err := h.Act(ctx, a); err != nil {
			t.Fatal(err)
		}
		return view(t, h)
	}
	runs := func(v ui.View) (titles []string) {
		var walk func(ns []ui.Node)
		walk = func(ns []ui.Node) {
			for _, n := range ns {
				if n.Key == "layout-runs" {
					for _, r := range n.List.Rows {
						titles = append(titles, r.Title)
					}
				}
				for _, ch := range n.Children() {
					walk(ch)
				}
			}
		}
		walk(v.Nodes)
		return titles
	}
	find := func(ns []ui.Node, key string) ui.Node {
		for _, n := range ns {
			if n.Key == key {
				return n
			}
		}
		t.Fatalf("no %s in %+v", key, ns)
		return ui.Node{}
	}
	v := act(pluginsdk.SurfaceAct{Kind: pluginsdk.ActTab, Action: "tab", Key: "layout"})
	if len(v.Toolbar) != 2 || find(v.Toolbar, "layout-search-form").Form == nil || find(v.Toolbar, "layout-status").Chips == nil {
		t.Fatalf("toolbar %+v", v.Toolbar)
	}
	if len(v.Footer) != 2 || find(v.Footer, "layout-count").Text.Content.Text != "6 of 6 runs" || !find(v.Footer, "layout-footer-bar").Actions.Buttons[0].Disabled {
		t.Fatalf("footer %+v", v.Footer)
	}
	if v.Nodes[0].Container == nil || v.Nodes[0].Container.Width != ui.ContainerWide {
		t.Errorf("the body is not in a wide container: %+v", v.Nodes[0])
	}
	if got := runs(v); len(got) != 6 {
		t.Errorf("runs %v", got)
	}

	v = act(pluginsdk.SurfaceAct{Kind: pluginsdk.ActSubmit, Action: "layout-filter", Key: "layout-search", Values: map[string]any{"q": "fix"}})
	if got := runs(v); len(got) != 2 || got[0] != "Build #5" || got[1] != "Build #2" {
		t.Errorf("q=fix: %v", got)
	}
	if q := find(v.Toolbar, "layout-search-form").Form.Fields[0].Input.Value; q != "fix" {
		t.Errorf("the search keeps %q", q)
	}
	v = act(pluginsdk.SurfaceAct{Kind: pluginsdk.ActClick, Action: "layout-status", Key: "layout-st-failed", Data: "failed"})
	if got := runs(v); len(got) != 1 || got[0] != "Build #5" {
		t.Errorf("q=fix, failed: %v", got)
	}
	chips := find(v.Toolbar, "layout-status").Chips.Chips
	if chips[2].Key != "layout-st-failed" || !chips[2].Selected || chips[0].Selected || chips[2].Meta.Text != "2" {
		t.Errorf("chips %+v", chips)
	}
	if c := find(v.Footer, "layout-count").Text.Content.Text; c != "1 of 6 runs" || find(v.Footer, "layout-footer-bar").Actions.Buttons[0].Disabled {
		t.Errorf("footer after filtering: %q", c)
	}
	v = act(pluginsdk.SurfaceAct{Kind: pluginsdk.ActClick, Action: "layout-status", Key: "layout-st-ok", Data: "ok"})
	if got := runs(v); len(got) != 1 || got[0] != "Build #2" {
		t.Errorf("q=fix, ok: %v", got)
	}

	reset := find(v.Toolbar, "layout-search-form").Form.ResetToken
	v = act(pluginsdk.SurfaceAct{Kind: pluginsdk.ActClick, Action: "layout-clear", Key: "layout-clear"})
	if got := runs(v); len(got) != 6 || find(v.Toolbar, "layout-search-form").Form.ResetToken == reset || find(v.Toolbar, "layout-search-form").Form.Fields[0].Input.Value != "" {
		t.Errorf("after clear: %v", got)
	}
	act(pluginsdk.SurfaceAct{Kind: pluginsdk.ActClick, Action: "layout-rerun", Key: "layout-rerun"})
	if ts := h.Toasts(); len(ts) == 0 || ts[len(ts)-1].Text != "build #6 queued again" {
		t.Errorf("toasts %+v", ts)
	}
	// The strips are the Layout tab's: the next tab's view has none.
	if v := act(pluginsdk.SurfaceAct{Kind: pluginsdk.ActTab, Action: "tab", Key: "form"}); v.Toolbar != nil || v.Footer != nil {
		t.Errorf("the form tab kept the strips")
	}
}
