package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/plugintest"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// The Runs tab: a master-detail with nothing chosen (its empty detail), a select act
// choosing a run (its facts and tabs), the detail's own tab act (the Log pane), a note
// kept per run, the view's tabs still switching the view, and no thread made.
func TestRunsMasterDetail(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	h := plugintest.Start(t, plugin(), plugintest.Options{Name: "hello",
		Granted:      pluginsdk.Permissions{Secrets: true, Events: []string{"threads"}, ThreadStatus: true, SessionEnv: true, Threads: true, Terminals: true, Commands: []string{"thread.send"}},
		Capabilities: []string{"threads", "terminals"}})
	if err := h.OpenSurface(ctx, inst, "demo", pluginsdk.UiContext{ThreadID: "s-1"}); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(5*time.Second, func(h *plugintest.Host) bool { return h.Version(inst) >= 1 })
	act := func(a pluginsdk.SurfaceAct) ui.View {
		t.Helper()
		a.Instance = inst
		if err := h.Act(ctx, a); err != nil {
			t.Fatal(err)
		}
		return view(t, h)
	}
	md := func(v ui.View) *ui.MasterDetail {
		t.Helper()
		if len(v.Nodes) != 2 || v.Nodes[1].MasterDetail == nil {
			t.Fatalf("nodes %+v", v.Nodes)
		}
		return v.Nodes[1].MasterDetail
	}
	tabs := func(m *ui.MasterDetail) *ui.TabsNode {
		t.Helper()
		if len(m.Detail) != 2 || m.Detail[0].Pairs == nil || m.Detail[1].Tabs == nil {
			t.Fatalf("detail %+v", m.Detail)
		}
		return m.Detail[1].Tabs
	}

	v := act(pluginsdk.SurfaceAct{Kind: pluginsdk.ActTab, Action: "tab", Key: "run-list", Value: "run-list"})
	m := md(v)
	if v.Tabs.Active != "run-list" || m.Selected != "" || len(m.Detail) != 0 || m.EmptyDetail == nil || len(m.List.Rows) != 6 || m.List.Rows[1].Key != "runs-run-5" {
		t.Fatalf("the runs tab %+v", m)
	}
	v = act(pluginsdk.SurfaceAct{Kind: pluginsdk.ActSelect, Action: "select", Key: "runs-run-5", Value: "runs-run-5", Node: "runs-md"})
	m = md(v)
	tb := tabs(m)
	if m.Selected != "runs-run-5" || tb.Active != runsTabOverview || len(tb.Items) != 2 || tb.Items[1].Badge == nil || tb.Children[1].Form == nil {
		t.Fatalf("after the select %+v %+v", m, tb)
	}
	v = act(pluginsdk.SurfaceAct{Kind: pluginsdk.ActTab, Action: "tab", Key: runsTabLog, Value: runsTabLog, Node: "runs-tabs"})
	tb = tabs(md(v))
	if v.Tabs.Active != "run-list" || tb.Active != runsTabLog || len(tb.Children) != 1 || tb.Children[0].Pane == nil || tb.Children[0].Pane.Children[0].Log == nil {
		t.Fatalf("after the node tab: view tab %s, %+v", v.Tabs.Active, tb)
	}
	if lines := tb.Children[0].Pane.Children[0].Log.Lines; !strings.Contains(lines[len(lines)-1].Text, "FAIL") || lines[len(lines)-1].Tone != ui.ToneError {
		t.Errorf("build 5's log %+v", lines)
	}
	// Another run keeps the detail's tab; a passed run's Log has no badge.
	tb = tabs(md(act(pluginsdk.SurfaceAct{Kind: pluginsdk.ActSelect, Action: "select", Key: "runs-run-4", Value: "runs-run-4", Node: "runs-md"})))
	if tb.Active != runsTabLog || tb.Items[1].Badge != nil {
		t.Errorf("run 4 %+v", tb)
	}
	act(pluginsdk.SurfaceAct{Kind: pluginsdk.ActTab, Action: "tab", Key: runsTabOverview, Value: runsTabOverview, Node: "runs-tabs"})
	tb = tabs(md(act(pluginsdk.SurfaceAct{Kind: pluginsdk.ActSubmit, Action: "runs-note", Key: "runs-note-save", Values: map[string]any{"note": " flaky "}})))
	if got := tb.Children[1].Form.Fields[0].Input.Value; got != "flaky" {
		t.Errorf("the note %q", got)
	}
	if ts := h.Toasts(); len(ts) == 0 || ts[len(ts)-1].Text != "note saved" {
		t.Errorf("toasts %+v", ts)
	}
	tb = tabs(md(act(pluginsdk.SurfaceAct{Kind: pluginsdk.ActSelect, Action: "select", Key: "runs-run-5", Value: "runs-run-5", Node: "runs-md"})))
	if got := tb.Children[1].Form.Fields[0].Input.Value; got != "" {
		t.Errorf("run 5's note %q (notes are per run)", got)
	}
	if err := h.Act(ctx, pluginsdk.SurfaceAct{Instance: inst, Kind: pluginsdk.ActSelect, Action: "select", Key: "runs-run-9", Node: "runs-md"}); err == nil || !strings.Contains(err.Error(), `no run "runs-run-9"`) {
		t.Errorf("an unknown run: %v", err)
	}
	if len(h.CreatedThreads()) != 0 || len(h.CreatedTerminals()) != 0 {
		t.Errorf("the Runs tab made a thread or a terminal: %+v %+v", h.CreatedThreads(), h.CreatedTerminals())
	}
	if v := act(pluginsdk.SurfaceAct{Kind: pluginsdk.ActTab, Action: "tab", Key: "overview", Value: "overview"}); v.Tabs.Active != "overview" {
		t.Errorf("the view's tab %s", v.Tabs.Active)
	}
}
