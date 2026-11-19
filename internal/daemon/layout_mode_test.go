package daemon

import (
	"context"
	"log/slog"
	"slices"
	"testing"

	core "github.com/alexwaumann/code-foundry/internal/layout"
	layoutstore "github.com/alexwaumann/code-foundry/internal/store/layout"
	"github.com/alexwaumann/code-foundry/internal/store/layout/layouttest"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
)

// Setting layout.threads_open_as to panes or single converts the layout before the change is
// published (settings.set returns with it converted); toward tabs, and a change of another
// setting, apply nothing.
func TestConvertLayoutOnModeChange(t *testing.T) {
	st := openSettings(t)
	l := layouttest.New(nil)
	ctx := context.Background()
	// Two thread tabs in one pane, opened under tabs.
	for _, th := range []string{"a", "b"} {
		if _, err := l.Apply(ctx, &core.OpenThread{Thread: th, Focus: true}, layoutstore.ApplyOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	convertLayoutOnModeChange(st, l, slog.New(slog.DiscardHandler))
	conforms := func() int {
		return len(slices.DeleteFunc(l.Ops(), func(op string) bool { return op != "conform" }))
	}
	if n := conforms(); n != 0 {
		t.Fatalf("registering converted %d times", n)
	}
	set := func(k, v string) {
		t.Helper()
		if _, err := st.Update(ctx, map[string]string{k: v}); err != nil {
			t.Fatal(err)
		}
	}
	set(settings.KeySmartSwap, "false")
	if n := conforms(); n != 0 {
		t.Fatalf("another setting converted %d times", n)
	}
	l.Mode = core.ModePanes // the store reads the setting at every op, as the daemon's does
	set(settings.KeyThreadsOpenAs, settings.ThreadsOpenAsPanes)
	if n := conforms(); n != 1 {
		t.Fatalf("panes converted %d times, want 1", n)
	}
	if p := core.Panes(l.Snapshot().State.Spaces[0].Root); len(p) != 1 || len(p[0].Tabs) != 1 {
		t.Errorf("after panes: %d panes, first with %d tabs", len(p), len(p[0].Tabs))
	}
	l.Mode = core.ModeTabs
	set(settings.KeyThreadsOpenAs, settings.ThreadsOpenAsTabs)
	if n := conforms(); n != 1 {
		t.Errorf("tabs converted: %d conforms, want still 1", n)
	}
	if v := st.Settings().Layout.SmartSwap; v {
		t.Error("smart swap was rewritten")
	}
}
