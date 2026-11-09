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

// The Runs tab's tables: the builds sort by the header the host's sort act names (#
// descending first, Branch ascending first, Duration descending first), the failed builds
// carry a Rerun button and every build a menu, the tests table's Passed group starts
// collapsed with its whole count, and the captured run-list view the mock replays has the
// same tables. HELLO_DUMP_RUNS=<file> writes the Runs tab's view as JSON (to recapture
// internal/store/plugin/testdata/hello-demo/run-list.json).
func TestBuildsTable(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	h := plugintest.Start(t, plugin(), plugintest.Options{Name: "hello",
		Granted:      pluginsdk.Permissions{Secrets: true, Events: []string{"threads"}, ThreadStatus: true, SessionEnv: true, Threads: true, Terminals: true, Commands: []string{"thread.send"}},
		Capabilities: []string{"threads", "terminals"}})
	if err := h.OpenSurface(ctx, inst, "demo", pluginsdk.UiContext{ThreadID: "s-1"}); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(5*time.Second, func(h *plugintest.Host) bool { return h.Version(inst) >= 1 })
	if err := h.Act(ctx, pluginsdk.SurfaceAct{Instance: inst, Kind: pluginsdk.ActTab, Key: "run-list"}); err != nil {
		t.Fatal(err)
	}
	v := view(t, h)
	if file := os.Getenv("HELLO_DUMP_RUNS"); file != "" {
		b, _ := json.MarshalIndent(v, "", "  ")
		if err := os.WriteFile(file, b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	table := func(v ui.View, key string) *ui.Table {
		t.Helper()
		for _, n := range v.Nodes {
			if n.Key == key && n.Table != nil {
				return n.Table
			}
		}
		t.Fatalf("no table %s in %+v", key, v.Nodes)
		return nil
	}
	builds := table(v, "builds")
	if builds.Title != "Builds" || *builds.Count != 1288 || len(builds.Rows) != 30 || builds.Sort.Column != "b-num" || builds.Sort.Dir != ui.SortDesc {
		t.Fatalf("builds %+v", builds)
	}
	first := builds.Rows[0]
	if first.Key != "b-1288" || first.Cells["b-num"].Glyph.Status != ui.StatusRunning || first.Cells["b-status"].Pill.Label != "running" || first.Menu == nil || first.Action == nil {
		t.Errorf("the first row %+v", first)
	}
	for _, r := range builds.Rows {
		failed := r.Cells["b-num"].Glyph.Status == ui.StatusFailed
		if failed != (len(r.Actions) == 1) {
			t.Errorf("%s: buttons %+v", r.Key, r.Actions)
		}
	}
	order := func() string {
		keys, _ := h.TableRows(inst, "builds")
		return strings.Join(keys[:3], " ") + " … " + keys[len(keys)-1]
	}
	for _, c := range []struct {
		column string
		dir    ui.SortDir
		want   string
	}{
		{"b-num", "", "b-1259 b-1260 b-1261 … b-1288"},    // sorted descending by #: the other way
		{"b-dur", "", "b-1285 b-1273 b-1280 … b-1270"},    // Duration, longest first
		{"b-branch", "", "b-1262 b-1269 b-1276 … b-1288"}, // Branch, cf/sidebar first
		{"b-branch", ui.SortDesc, "b-1288 b-1287 b-1286 … b-1262"},
	} {
		ver := h.Version(inst)
		if err := h.Sort(ctx, inst, c.column, c.dir); err != nil {
			t.Fatal(err)
		}
		h.WaitFor(2*time.Second, func(h *plugintest.Host) bool { return h.Version(inst) > ver })
		if got := order(); got != c.want {
			t.Errorf("sort %s %q: %s, want %s", c.column, c.dir, got, c.want)
		}
		if s := table(view(t, h), "builds").Sort; s.Column != c.column {
			t.Errorf("sort %s: the view says %+v", c.column, s)
		}
	}
	if err := h.Sort(ctx, inst, "b-age", ""); err == nil {
		t.Error("Age is not sortable")
	}
	if err := h.PickItem(ctx, inst, "b-1287-console"); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(2*time.Second, func(h *plugintest.Host) bool { return view(t, h).Tabs.Active == "log" })

	tests := table(v, "tests")
	if !tests.Dense || len(tests.Groups) != 3 || !tests.Groups[2].Collapsed || *tests.Groups[2].Count != 142 || tests.Groups[0].Collapsed {
		t.Errorf("tests %+v", tests)
	}
	matchRunsFixture(t, v)
}

// matchRunsFixture compares the Runs tab's tables in v (as first shown) with the captured
// run-list view the mock daemon replays.
func matchRunsFixture(t *testing.T, v ui.View) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "internal", "store", "plugin", "testdata", "hello-demo", "run-list.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fx ui.View
	if err := json.Unmarshal(b, &fx); err != nil {
		t.Fatal(err)
	}
	enc := func(x any) string { b, _ := json.Marshal(x); return string(b) }
	if len(fx.Nodes) != len(v.Nodes) {
		t.Fatalf("run-list.json has %d nodes, the plugin %d", len(fx.Nodes), len(v.Nodes))
	}
	for i, n := range v.Nodes {
		if n.Table == nil {
			continue
		}
		if got, want := enc(fx.Nodes[i]), enc(n); got != want {
			t.Errorf("run-list.json's %s\n%s\nwant %s", n.Key, got, want)
		}
	}
}
