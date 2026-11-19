package layout

import (
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/db/dbtest"
	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// openMode is open with the settings layout.threads_open_as and layout.smart_swap read through
// the funcs given, as the daemon reads them at every op.
func openMode(t *testing.T, opts Options) *Manager {
	t.Helper()
	opts.IDs, opts.FocusDelay, opts.Log = &core.SeqIDs{}, time.Hour, slog.New(slog.DiscardHandler)
	m, err := New(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Close(context.Background()) })
	return m
}

// threadTabs counts the thread tabs of the first space and the panes holding one.
func threadTabs(st *core.State) (tabs, panes int) {
	for _, p := range core.Panes(st.Spaces[0].Root) {
		n := 0
		for _, tb := range p.Tabs {
			if tb.Kind == "thread" {
				n++
			}
		}
		tabs += n
		if n > 0 {
			panes++
		}
	}
	return tabs, panes
}

// Each op reads the setting: under tabs a thread opens as a tab beside the other, under panes
// it replaces it, under single too; the stored layout follows.
func TestModeReadAtEveryOp(t *testing.T) {
	db := dbtest.Open(t)
	mode := "tabs"
	m := openMode(t, Options{DB: db, ThreadsOpenAs: func() string { return mode }})
	apply(t, m, &core.OpenThread{Thread: "a", Focus: true})
	apply(t, m, &core.OpenThread{Thread: "b", Focus: true})
	if tabs, _ := threadTabs(m.Snapshot().State); tabs != 2 {
		t.Fatalf("tabs: %d thread tabs, want 2", tabs)
	}
	apply(t, m, &core.CloseThread{Thread: "a"})
	mode = "panes"
	c := apply(t, m, &core.OpenThread{Thread: "c", Focus: true})
	if tabs, _ := threadTabs(m.Snapshot().State); tabs != 1 || c.Result.Rule != "replace" {
		t.Fatalf("panes: %d thread tabs, rule %q; want 1, replace", tabs, c.Result.Rule)
	}
	// What is stored is what was shown.
	m2 := openMode(t, Options{DB: db, ThreadsOpenAs: func() string { return mode }})
	if tabs, _ := threadTabs(m2.Snapshot().State); tabs != 1 {
		t.Errorf("reloaded: %d thread tabs, want 1", tabs)
	}
}

// A layout stored under tabs and loaded under panes or single (the settings file edited while
// the daemon was down) is converted as it loads, and the conversion is stored.
func TestModeConvertsAtLoad(t *testing.T) {
	for _, tt := range []struct {
		mode        string
		tabs, panes int
	}{{"tabs", 3, 2}, {"panes", 2, 2}, {"single", 1, 1}, {"bogus", 3, 2}} {
		t.Run(tt.mode, func(t *testing.T) {
			db := dbtest.Open(t)
			m := openMode(t, Options{DB: db})
			apply(t, m, &core.OpenThread{Thread: "a", Focus: true})
			c := apply(t, m, &core.OpenThread{Thread: "b", Focus: true})
			apply(t, m, &core.OpenThread{Thread: "c", Pane: c.Result.Pane, Edge: core.Right, Focus: true})
			if err := m.Close(context.Background()); err != nil {
				t.Fatal(err)
			}
			again := openMode(t, Options{DB: db, ThreadsOpenAs: func() string { return tt.mode }})
			tabs, panes := threadTabs(again.Snapshot().State)
			if tabs != tt.tabs || panes != tt.panes {
				t.Errorf("loaded: %d thread tabs in %d panes, want %d in %d", tabs, panes, tt.tabs, tt.panes)
			}
			// Stored: a third open under tabs reads the converted layout back.
			third := openMode(t, Options{DB: db})
			if tabs, _ := threadTabs(third.Snapshot().State); tabs != tt.tabs {
				t.Errorf("stored: %d thread tabs, want %d", tabs, tt.tabs)
			}
		})
	}
}

// Panes forces smart swap on while the stored setting says off: the store reads the setting
// and never writes it, so going back to tabs finds it as the user left it.
func TestModeForcesSmartSwap(t *testing.T) {
	db := dbtest.Open(t)
	mode, swapReads := "tabs", 0
	m := openMode(t, Options{DB: db, ThreadsOpenAs: func() string { return mode },
		SmartSwap: func() bool { swapReads++; return false }})
	a := apply(t, m, &core.OpenThread{Thread: "a", Focus: true})
	apply(t, m, &core.OpenSurface{Tab: &core.Tab{Kind: "diff", Thread: "a", Params: map[string]string{"project": "pj", "worktree": "wa"}}})
	b := apply(t, m, &core.OpenThread{Thread: "b", Pane: a.Result.Pane, Edge: core.Bottom, Focus: true})
	apply(t, m, &core.OpenSurface{Tab: &core.Tab{Kind: "diff", Thread: "b", Params: map[string]string{"project": "pj", "worktree": "wb"}}})
	// Both diffs share one pane now, showing b's. a's tab takes the focus: with smart swap off
	// the pane keeps b's diff; then b's, and a's again under panes, where it swaps.
	if c := apply(t, m, &core.FocusTab{Tab: a.Result.Tab}); len(c.Result.Swapped) != 0 {
		t.Fatalf("tabs with smart swap off swapped %v", c.Result.Swapped)
	}
	apply(t, m, &core.FocusTab{Tab: b.Result.Tab})
	mode = "panes"
	if c := apply(t, m, &core.FocusTab{Tab: a.Result.Tab}); len(c.Result.Swapped) != 1 {
		t.Errorf("panes swapped %v, want one pane", c.Result.Swapped)
	}
	if swapReads == 0 {
		t.Error("the store never read layout.smart_swap")
	}
}

// The conform op changes nothing under tabs, and converts under panes (the daemon applies it
// when the setting changes): one commit, Result.Conformed saying what.
func TestModeConformOp(t *testing.T) {
	db := dbtest.Open(t)
	mode := "tabs"
	m := openMode(t, Options{DB: db, ThreadsOpenAs: func() string { return mode }})
	apply(t, m, &core.OpenThread{Thread: "a", Focus: true})
	apply(t, m, &core.OpenThread{Thread: "b", Focus: true})
	if c := apply(t, m, &core.Conform{}); c.Changed {
		t.Fatal("conform under tabs changed the layout")
	}
	mode = "panes"
	c := apply(t, m, &core.Conform{})
	if !c.Changed || c.Result.Conformed == nil || c.Result.Conformed.ThreadTabs != 1 {
		t.Fatalf("conform under panes: changed %v, %+v", c.Changed, c.Result.Conformed)
	}
	if !strings.Contains(c.Result.Closed[0].Thread, "a") {
		t.Errorf("closed %v, want thread a (b was active)", c.Result.Closed[0])
	}
}
