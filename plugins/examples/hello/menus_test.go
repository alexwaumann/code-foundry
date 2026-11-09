package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/plugintest"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// The demo's menus act as the host sends them (plugintest PickItem): Priority moves the check,
// Reset the click count zeroes it, Rerun toasts; and the captured fixtures the mock daemon
// replays hold the same menus as the plugin sends (the header's in every tab's fixture).
func TestDemoMenus(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	h := plugintest.Start(t, plugin(), plugintest.Options{Name: "hello",
		Granted: pluginsdk.Permissions{Secrets: true, Events: []string{"threads"}, ThreadStatus: true, SessionEnv: true, Threads: true, Terminals: true,
			Commands: []string{"thread.send"}},
		Capabilities: []string{"threads", "terminals"}})
	if err := h.OpenSurface(ctx, inst, "demo", pluginsdk.UiContext{ThreadID: "s-1"}); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(5*time.Second, func(h *plugintest.Host) bool { return h.Version(inst) >= 1 })
	checked := func() string {
		for _, n := range view(t, h).Nodes {
			if n.List == nil {
				continue
			}
			for _, r := range n.List.Rows {
				for _, it := range r.Menu.AllItems() {
					if it.Checked {
						return it.Key
					}
				}
			}
		}
		return ""
	}
	if got := checked(); got != "run-2-p-normal" {
		t.Fatalf("checked %q", got)
	}
	matchFixtures(t, view(t, h))

	ver := h.Version(inst)
	if err := h.PickItem(ctx, inst, "run-2-p-high"); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(2*time.Second, func(h *plugintest.Host) bool { return h.Version(inst) > ver })
	if got := checked(); got != "run-2-p-high" {
		t.Fatalf("after Priority ▸ High: checked %q", got)
	}
	if err := h.PickItem(ctx, inst, "run-2-delete"); err == nil {
		t.Error("picked a disabled item")
	}
	if err := h.PickItem(ctx, inst, "run-2-rerun-clean"); err != nil {
		t.Fatal(err)
	}
	// A toast is a notification: it lands after the act returns.
	h.WaitFor(5*time.Second, func(h *plugintest.Host) bool { return len(h.Toasts()) > 0 })
	if ts := h.Toasts(); len(ts) == 0 || ts[len(ts)-1].Text != "build #2 queued again" {
		t.Errorf("toasts %+v", ts)
	}
	ver = h.Version(inst)
	if err := h.PickItem(ctx, inst, "hdr-form"); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(2*time.Second, func(h *plugintest.Host) bool { return h.Version(inst) > ver })
	if v := view(t, h); v.Tabs.Active != "form" {
		t.Errorf("Go to the form: tab %s", v.Tabs.Active)
	}
}

// matchFixtures compares the demo's menus in v (the overview, nothing picked yet) with the
// captured views the mock daemon replays.
func matchFixtures(t *testing.T, v ui.View) {
	t.Helper()
	enc := func(x any) string { b, _ := json.Marshal(x); return string(b) }
	files, _ := filepath.Glob(filepath.Join("..", "..", "..", "internal", "store", "plugin", "testdata", "hello-demo", "*.json"))
	if len(files) < 7 {
		t.Fatalf("fixtures: %v", files)
	}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var fx ui.View
		if err := json.Unmarshal(b, &fx); err != nil {
			t.Fatal(err)
		}
		if got, want := enc(fx.Header.Menu), enc(v.Header.Menu); got != want {
			t.Errorf("%s: header menu\n%s\nwant %s", f, got, want)
		}
		if filepath.Base(f) != "overview.json" {
			continue
		}
		find := func(view ui.View, key string) (row *ui.Row, button *ui.Button) {
			for _, n := range view.Nodes {
				switch {
				case n.List != nil:
					for i := range n.List.Rows {
						if n.List.Rows[i].Key == key {
							return &n.List.Rows[i], nil
						}
					}
				case n.Actions != nil:
					for i := range n.Actions.Buttons {
						if n.Actions.Buttons[i].Key == key {
							return nil, &n.Actions.Buttons[i]
						}
					}
				}
			}
			return nil, nil
		}
		gotRow, _ := find(fx, "run-2")
		wantRow, _ := find(v, "run-2")
		if gotRow == nil || enc(gotRow.Actions) != enc(wantRow.Actions) || enc(gotRow.Menu) != enc(wantRow.Menu) {
			t.Errorf("%s: run-2's actions and menu\n%s\nwant %s %s", f, enc(gotRow), enc(wantRow.Actions), enc(wantRow.Menu))
		}
		_, gotBtn := find(fx, "bar-more")
		_, wantBtn := find(v, "bar-more")
		if enc(gotBtn) != enc(wantBtn) {
			t.Errorf("%s: the bar's More\n%s\nwant %s", f, enc(gotBtn), enc(wantBtn))
		}
	}
}
