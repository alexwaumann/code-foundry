package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/plugintest"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// The Overview's figures: the stats row and the chart agree (pass rate, median as the
// reference), the Failing card toggles the chart to the failed builds and shows pressed,
// and a bar's click reaches the plugin (a toast). HELLO_DUMP_OVERVIEW=<file> writes the
// overview's figure nodes as JSON (to splice into the mock's captured view).
func TestOverviewFigures(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	h := plugintest.Start(t, plugin(), plugintest.Options{Name: "hello",
		Granted:      pluginsdk.Permissions{Secrets: true, Events: []string{"threads"}, ThreadStatus: true, SessionEnv: true, Threads: true, Terminals: true, Commands: []string{"thread.send"}},
		Capabilities: []string{"threads", "terminals"}})
	if err := h.OpenSurface(ctx, inst, "demo", pluginsdk.UiContext{ThreadID: "s-1"}); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(5*time.Second, func(h *plugintest.Host) bool { return h.Version(inst) >= 1 })
	figures := func(v ui.View) (*ui.Stats, *ui.Bars) {
		t.Helper()
		if len(v.Nodes) < 3 || v.Nodes[1].Stats == nil || v.Nodes[2].Bars == nil {
			t.Fatalf("overview nodes %+v", v.Nodes[:min(3, len(v.Nodes))])
		}
		return v.Nodes[1].Stats, v.Nodes[2].Bars
	}
	v := view(t, h)
	if file := os.Getenv("HELLO_DUMP_OVERVIEW"); file != "" {
		b, _ := json.MarshalIndent(v.Nodes[1:3], "", "  ")
		if err := os.WriteFile(file, b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	stats, bars := figures(v)
	got := []string{}
	for _, c := range stats.Cards {
		got = append(got, c.Label+"="+c.Value)
	}
	if want := "[Pass rate=86% Median time=4m 12s Failing=4 Queue=1]"; fmt.Sprint(got) != want {
		t.Errorf("cards %v, want %s", got, want)
	}
	if len(bars.Bars) != 30 || bars.Reference == nil || bars.Reference.Label != "median 4m 12s" || bars.StartLabel != "#1259" || bars.EndLabel != "#1288" {
		t.Errorf("chart %d bars, reference %+v, labels %q %q", len(bars.Bars), bars.Reference, bars.StartLabel, bars.EndLabel)
	}
	if last := bars.Bars[29]; last.Status != ui.StatusRunning || last.Title != "#1288 · running 2m 10s" {
		t.Errorf("last bar %+v", last)
	}
	// The Failing card toggles the failed builds.
	act := pluginsdk.SurfaceAct{Instance: inst, Kind: pluginsdk.ActClick, Action: "stat-filter", Key: "stat-failing", Data: "failed"}
	if err := h.Act(ctx, act); err != nil {
		t.Fatal(err)
	}
	stats, bars = figures(view(t, h))
	if !stats.Cards[2].Pressed || len(bars.Bars) != 4 || bars.StartLabel != "#1264" || bars.EndLabel != "#1285" {
		t.Errorf("filtered: pressed %v, %d bars, labels %q %q", stats.Cards[2].Pressed, len(bars.Bars), bars.StartLabel, bars.EndLabel)
	}
	for _, b := range bars.Bars {
		if b.Status != ui.StatusFailed {
			t.Errorf("filtered chart shows %+v", b)
		}
	}
	if err := h.Act(ctx, act); err != nil {
		t.Fatal(err)
	}
	if stats, bars = figures(view(t, h)); stats.Cards[2].Pressed || len(bars.Bars) != 30 {
		t.Errorf("unfiltered: pressed %v, %d bars", stats.Cards[2].Pressed, len(bars.Bars))
	}
	// A bar's click is the plugin's: it toasts the build.
	if err := h.Act(ctx, pluginsdk.SurfaceAct{Instance: inst, Kind: pluginsdk.ActClick, Action: "open-build", Key: "build-1280", Data: "1280"}); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(5*time.Second, func(h *plugintest.Host) bool { return len(h.Toasts()) == 1 })
	if tt := h.Toasts()[0]; tt.Text != "build #1280" {
		t.Errorf("toast %+v", tt)
	}
}
