package daemon

import (
	"context"
	"log/slog"
	"slices"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/bus"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	"github.com/alexwaumann/code-foundry/internal/store/layout/layouttest"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/terminal/terminaltest"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// A terminal tab (or quick terminal) restored as a fresh shell names its old, ended terminal
// from the commit that puts it back until the glue acts on that commit and starts the shell.
// A sweep, or the old shell's removal, in that window must not close it
// (docs/notes/shell-25g-race-chord.md). The glue runs here without its loop: each test calls
// its steps in the order of the race, so nothing waits on timing.

// steppedGlue is a glue whose steps the test calls: newGlueEnv's helpers over a glue with no
// loop and no start sweep.
func steppedGlue(t *testing.T, threads []thread.Thread, seed func(e *glueEnv)) (*glueEnv, *layoutGlue) {
	t.Helper()
	b := bus.New()
	e := &glueEnv{t: t, ctx: context.Background(), bus: b, layout: layouttest.New(b), terms: terminaltest.New(b), thrs: threads}
	if seed != nil {
		seed(e)
	}
	log := slog.New(slog.DiscardHandler)
	g, err := newLayoutGlue(e.ctx, layoutGlueOptions{
		Log: log, Layout: e.layout, Terminals: e.terms, Bus: b, Shell: func() []string { return []string{"zsh"} },
		Threads: func() *thread.Snapshot {
			e.mu.Lock()
			defer e.mu.Unlock()
			return &thread.Snapshot{Threads: slices.Clone(e.thrs)}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	e.goings = layoutShellsGoing(log, e.layout, e.terms)
	t.Cleanup(func() {
		g.stop()
		g.threadEvents.Close()
		g.layoutEvents.Close()
	})
	return e, g
}

// acted has the glue act on every layout commit published so far, its own included, and
// waits for the terminals it ends. The layout publishes a commit before Apply returns.
func acted(g *layoutGlue) {
	for {
		select {
		case ev := <-g.layoutEvents.C():
			g.commit(ev)
		default:
			g.wg.Wait()
			return
		}
	}
}

// freshUnder reports the terminal tab names when it names a running shell other than old.
func freshUnder(e *glueEnv, tab, old string) (string, bool) {
	_, _, tb := e.state().FindTab(tab)
	if tb == nil {
		return "", false
	}
	id := tb.Params[core.TerminalParam]
	return id, id != old && e.running(id)
}

func TestLayoutGlueFreshShellRace(t *testing.T) {
	// Between a commit that restores fresh shells and the glue acting on it.
	type between func(e *glueEnv, g *layoutGlue, old []string)
	sweep := func(_ *glueEnv, g *layoutGlue, _ []string) { g.sweep() }
	removal := func(e *glueEnv, g *layoutGlue, old []string) {
		for _, id := range old {
			g.terminalEvent(terminal.Event{RemovedID: id})
		}
	}
	nothing := func(*glueEnv, *layoutGlue, []string) {}

	tests := []struct {
		name string
		// put closes or snoozes what the restore brings back and commits the restore, which
		// the glue has not acted on; it returns the restored tabs and the ended terminals.
		put     func(e *glueEnv, g *layoutGlue) (tabs, old []string)
		between between
	}{
		{"a reopened terminal tab, a sweep between", reopenTab, sweep},
		{"a reopened terminal tab, the old shell's removal between", reopenTab, removal},
		{"a snooze's restored tabs, a sweep between", restoreSet, sweep},
		{"a snooze's restored tabs, the old shells' removals between", restoreSet, removal},
		{"nothing between", reopenTab, nothing},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, g := steppedGlue(t, []thread.Thread{th("th-a")}, nil)
			tabs, old := tt.put(e, g)
			tt.between(e, g, old)
			for _, tab := range tabs {
				if _, _, tb := e.state().FindTab(tab); tb == nil {
					t.Fatalf("tab %s closed before its fresh shell started", tab)
				}
			}
			acted(g)
			for i, tab := range tabs {
				if _, ok := freshUnder(e, tab, old[i%len(old)]); !ok {
					_, _, tb := e.state().FindTab(tab)
					t.Errorf("tab %s after the glue acted: %+v, want a fresh running shell", tab, tb)
				}
			}
			// What waited was judged and let be: nothing left over, and a later sweep keeps it.
			if len(g.waiting) != 0 {
				t.Errorf("still waiting: %v", g.waiting)
			}
			g.sweep()
			acted(g)
			for _, tab := range tabs {
				if _, _, tb := e.state().FindTab(tab); tb == nil {
					t.Errorf("a later sweep closed tab %s", tab)
				}
			}
		})
	}
}

// reopenTab opens a terminal tab of th-a, closes it (its shell ends) and reopens it.
func reopenTab(e *glueEnv, g *layoutGlue) ([]string, []string) {
	e.t.Helper()
	e.apply(&core.OpenThread{Thread: "th-a", Focus: true})
	old := e.shell("th-a")
	tab := e.termTab("th-a", old)
	e.apply(&core.CloseTab{Tab: tab, Record: true})
	acted(g)
	if !e.gone(old) {
		e.t.Fatal("the closed tab's shell did not end")
	}
	c := e.apply(&core.ReopenClosed{})
	if len(c.Result.Fresh) != 1 {
		e.t.Fatalf("reopen result %+v", c.Result)
	}
	return c.Result.Fresh, []string{old}
}

// restoreSet snoozes th-a with two terminal tabs (their shells go) and opens it again.
func restoreSet(e *glueEnv, g *layoutGlue) ([]string, []string) {
	e.t.Helper()
	x, y := openWithSet(e)
	acted(g)
	e.goings(e.ctx, "th-a", thread.ShellsSnoozed)
	for _, id := range []string{x, y} {
		if err := terminal.KillAndRemove(e.ctx, e.terms, id); err != nil {
			e.t.Fatal(err)
		}
	}
	acted(g)
	c := e.apply(&core.OpenThread{Thread: "th-a", Focus: true})
	if len(c.Result.Fresh) != 2 {
		e.t.Fatalf("restore result %+v", c.Result)
	}
	// Fresh lists the tabs in the order the set is put back; the old terminal of each is
	// what it names now.
	var old []string
	for _, tab := range c.Result.Fresh {
		_, _, tb := e.state().FindTab(tab)
		old = append(old, tb.Params[core.TerminalParam])
	}
	return c.Result.Fresh, old
}

// The quick terminal a snooze ended comes back open with its thread's tab; a sweep, or the
// old quick shell's removal, before the glue acts on that commit must not draw it closed.
func TestLayoutGlueFreshQuickRace(t *testing.T) {
	for _, tc := range []struct {
		name    string
		between func(g *layoutGlue, old string)
	}{
		{"a sweep between", func(g *layoutGlue, _ string) { g.sweep() }},
		{"the old quick shell's removal between", func(g *layoutGlue, old string) {
			g.terminalEvent(terminal.Event{RemovedID: old})
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e, g := steppedGlue(t, []thread.Thread{th("th-a")}, nil)
			e.apply(&core.OpenThread{Thread: "th-a", Focus: true})
			q, err := e.terms.Create(e.ctx, terminal.Spec{Argv: []string{"zsh"}, Cwd: glueWT, Labels: termlabel.QuickShell("th-a", "pj", glueWT)})
			if err != nil {
				t.Fatal(err)
			}
			g.labels[q.ID] = q.Labels // the terminal event the loop would have read
			e.apply(&core.SetQuick{Thread: "th-a", Open: true})
			acted(g)
			e.goings(e.ctx, "th-a", thread.ShellsSnoozed)
			if err := terminal.KillAndRemove(e.ctx, e.terms, q.ID); err != nil {
				t.Fatal(err)
			}
			acted(g)
			if c := e.apply(&core.OpenThread{Thread: "th-a", Focus: true}); c.Result.FreshQuick != "th-a" {
				t.Fatalf("FreshQuick = %q", c.Result.FreshQuick)
			}
			tc.between(g, q.ID)
			if !quickOpen(e.state(), "th-a") {
				t.Fatal("the quick terminal was drawn closed before its fresh shell started")
			}
			acted(g)
			if !quickOpen(e.state(), "th-a") || !g.hasQuick("th-a") {
				t.Errorf("after the glue acted: open %v, a shell %v; want both", quickOpen(e.state(), "th-a"), g.hasQuick("th-a"))
			}
			if len(g.waitingQuick) != 0 {
				t.Errorf("still waiting: %v", g.waitingQuick)
			}
		})
	}
}

// A tab that waited for its fresh shell, whose shell then cannot start (its thread has no
// checkout), still closes; so does a quick terminal's. Nothing is left waiting.
func TestLayoutGlueFreshShellRaceThenNoShell(t *testing.T) {
	e, g := steppedGlue(t, []thread.Thread{th("th-a")}, nil)
	tabs, _ := reopenTab(e, g)
	noCheckout := th("th-a")
	noCheckout.WorktreePath = ""
	e.mu.Lock()
	e.thrs = []thread.Thread{noCheckout}
	e.mu.Unlock()
	g.sweep()
	if _, _, tb := e.state().FindTab(tabs[0]); tb == nil {
		t.Fatal("the tab closed before the glue acted on its reopen")
	}
	acted(g)
	if _, _, tb := e.state().FindTab(tabs[0]); tb != nil {
		t.Errorf("tab %+v still open with no shell", tb)
	}
	if len(g.waiting) != 0 || len(e.terms.List(e.ctx)) != 0 {
		t.Errorf("waiting %v, terminals %+v; want none", g.waiting, e.terms.List(e.ctx))
	}
}

// A daemon that stopped between a reopen's commit and its fresh shell: the stored layout has
// the tab naming its old terminal, and no terminal survives a restart. The new glue never
// sees that commit; its start sweep drops the tab, like every other terminal tab after a
// restart, and nothing is left waiting.
func TestLayoutGlueRestartWithAPendingFreshTab(t *testing.T) {
	var tab string
	e, g := steppedGlue(t, []thread.Thread{th("th-a")}, func(e *glueEnv) {
		e.apply(&core.OpenThread{Thread: "th-a", Focus: true})
		tab = e.termTab("th-a", "t-before-restart")
		e.apply(&core.CloseTab{Tab: tab, Record: true})
		tab = e.apply(&core.ReopenClosed{}).Result.Tab
	})
	if _, _, tb := e.state().FindTab(tab); tb == nil {
		t.Fatal("the seed did not reopen the tab")
	}
	g.sweep()
	acted(g)
	if core.Holds(e.state(), "t-before-restart") {
		t.Error("the pending tab lingers after the restart")
	}
	if len(g.waiting) != 0 {
		t.Errorf("still waiting: %v", g.waiting)
	}
}
