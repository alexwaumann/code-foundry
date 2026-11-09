package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/plugintest"
)

// The Layout toolbar's branch picker searches the branches, and picking filters the runs;
// Clear filter drops the picks. The Form tab's reviewers picker searches people.
func TestDemoPickers(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	h := plugintest.Start(t, plugin(), plugintest.Options{Name: "hello",
		Granted:      pluginsdk.Permissions{Secrets: true, Events: []string{"threads"}, ThreadStatus: true, SessionEnv: true, Threads: true, Terminals: true, Commands: []string{"thread.send"}},
		Capabilities: []string{"threads", "terminals"}})
	if err := h.OpenSurface(ctx, inst, "demo", pluginsdk.UiContext{ThreadID: "s-1"}); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(5*time.Second, func(h *plugintest.Host) bool { return h.Version(inst) >= 1 })
	if err := h.Act(ctx, pluginsdk.SurfaceAct{Instance: inst, Kind: pluginsdk.ActTab, Action: "tab", Key: "layout"}); err != nil {
		t.Fatal(err)
	}
	values := func(field, query string) string {
		t.Helper()
		res, ok := h.Results(inst, field, query)
		if !ok {
			t.Fatalf("no results for %q", query)
		}
		var out []string
		for _, o := range res {
			out = append(out, o.Value)
		}
		return strings.Join(out, " ")
	}
	if err := h.Search(ctx, inst, "layout-branch", "cf/"); err != nil {
		t.Fatal(err)
	}
	if got := values("layout-branch", "cf/"); got != "cf/fix cf/retry cf/sidebar cf/plugin-picker" {
		t.Errorf("cf/ matches %q", got)
	}
	if err := h.Pick(ctx, inst, "layout-branch", "cf/retry"); err != nil {
		t.Fatal(err)
	}
	if err := h.Pick(ctx, inst, "layout-branch", "cf/retry", "main"); err != nil {
		t.Fatal(err)
	}
	v := view(t, h)
	count := func() string { return v.Footer[0].Text.Content.Text }
	if count() != "4 of 6 runs" {
		t.Errorf("main and cf/retry: %s", count())
	}
	branch := v.Toolbar[1].Form.Fields[0].Select
	if strings.Join(branch.Value, ",") != "cf/retry,main" || branch.Options[0].Group != "Selected" || branch.Options[0].Value != "cf/retry" || branch.Options[2].Value != "cf/fix" {
		t.Errorf("branch picker %+v", branch)
	}
	if err := h.Act(ctx, pluginsdk.SurfaceAct{Instance: inst, Kind: pluginsdk.ActClick, Action: "layout-clear", Key: "layout-clear"}); err != nil {
		t.Fatal(err)
	}
	if v = view(t, h); count() != "6 of 6 runs" || len(v.Toolbar[1].Form.Fields[0].Select.Value) != 0 {
		t.Errorf("after clear: %s %+v", count(), v.Toolbar[1].Form.Fields[0].Select)
	}

	if err := h.Act(ctx, pluginsdk.SurfaceAct{Instance: inst, Kind: pluginsdk.ActTab, Action: "tab", Key: "form"}); err != nil {
		t.Fatal(err)
	}
	if err := h.Search(ctx, inst, "f-reviewers", "ale"); err != nil {
		t.Fatal(err)
	}
	if got := values("f-reviewers", "ale"); got != "alejandra alessio" {
		t.Errorf("ale matches %q", got)
	}
	res, _ := h.Results(inst, "f-reviewers", "ale")
	if res[0].Avatar != "A" || res[0].Detail != "platform" || res[0].Group != "Matches" {
		t.Errorf("a match %+v", res[0])
	}
}
