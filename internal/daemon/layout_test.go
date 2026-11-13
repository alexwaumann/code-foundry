package daemon

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	layoutstore "github.com/alexwaumann/code-foundry/internal/store/layout"
	"github.com/alexwaumann/code-foundry/internal/store/layout/layouttest"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/terminal/terminaltest"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// The layout glue (layout.go) over fakes: the layout fake runs the real ops, the terminal
// fake's events come over the same bus, and thread events are published by hand.

type glueEnv struct {
	t      *testing.T
	ctx    context.Context
	bus    *bus.Bus
	layout *layouttest.Fake
	terms  *terminaltest.Fake
	mu     sync.Mutex
	thrs   []thread.Thread
	stop   func()
	goings func(context.Context, string, thread.ShellsGo)
}

const glueWT = "/tmp/wt-a"

// newGlueEnv starts the glue over a layout with one space "Main" (sp-n1) and threads, each
// with a checkout. seed runs before the glue starts (for the start sweep).
func newGlueEnv(t *testing.T, threads []thread.Thread, seed func(e *glueEnv)) *glueEnv {
	t.Helper()
	return newGlueEnvWith(t, threads, seed, nil)
}

// newGlueEnvWith is newGlueEnv with the glue's options changed by opts.
func newGlueEnvWith(t *testing.T, threads []thread.Thread, seed func(e *glueEnv), opts func(*layoutGlueOptions)) *glueEnv {
	t.Helper()
	b := bus.New()
	e := &glueEnv{t: t, ctx: context.Background(), bus: b, layout: layouttest.New(b), terms: terminaltest.New(b), thrs: threads}
	if seed != nil {
		seed(e)
	}
	log := slog.New(slog.DiscardHandler)
	o := layoutGlueOptions{
		Log: log, Layout: e.layout, Terminals: e.terms, Bus: b, Shell: func() []string { return []string{"zsh"} },
		Threads: func() *thread.Snapshot {
			e.mu.Lock()
			defer e.mu.Unlock()
			return &thread.Snapshot{Threads: slices.Clone(e.thrs)}
		},
	}
	if opts != nil {
		opts(&o)
	}
	stop, err := startLayoutGlue(e.ctx, o)
	if err != nil {
		t.Fatal(err)
	}
	e.stop = stop
	e.goings = layoutShellsGoing(log, e.layout, e.terms)
	t.Cleanup(stop)
	return e
}

func th(id string) thread.Thread {
	return thread.Thread{ID: id, ProjectID: "pj", WorktreePath: glueWT}
}

func (e *glueEnv) apply(op core.Op) layoutstore.Commit {
	e.t.Helper()
	c, err := e.layout.Apply(e.ctx, op, layoutstore.ApplyOptions{})
	if err != nil {
		e.t.Fatalf("%s: %v", op.OpName(), err)
	}
	return c
}

// shell starts a running shell; thread "" is a free shell.
func (e *glueEnv) shell(thread string) string {
	e.t.Helper()
	labels := termlabel.Free()
	if thread != "" {
		labels = termlabel.Shell(thread, "pj", glueWT)
	}
	tm, err := e.terms.Create(e.ctx, terminal.Spec{Argv: []string{"zsh"}, Cwd: glueWT, Labels: labels})
	if err != nil {
		e.t.Fatal(err)
	}
	return tm.ID
}

// termTab opens a tab for terminal id, linked to thread (or unlinked for "").
func (e *glueEnv) termTab(thread, id string) string {
	e.t.Helper()
	return e.apply(&core.OpenSurface{Tab: &core.Tab{Kind: "terminal", Thread: thread, Params: map[string]string{core.TerminalParam: id}}}).Result.Tab
}

func (e *glueEnv) running(id string) bool {
	t, err := e.terms.Get(e.ctx, id)
	return err == nil && t.State == terminal.StateRunning
}

func (e *glueEnv) gone(id string) bool {
	_, err := e.terms.Get(e.ctx, id)
	return errors.Is(err, terminal.ErrNotFound)
}

func (e *glueEnv) state() *core.State { return e.layout.Snapshot().State }

func (e *glueEnv) publish(ev thread.Event) {
	if u, ok := ev.(thread.Updated); ok {
		e.mu.Lock()
		e.thrs = append(slices.DeleteFunc(e.thrs, func(x thread.Thread) bool { return x.ID == u.Thread.ID }), u.Thread)
		e.mu.Unlock()
	}
	bus.Publish(e.bus, ev)
}

// eventually waits for cond, failing with what after a few seconds.
func (e *glueEnv) eventually(what string, cond func() bool) {
	e.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			e.t.Fatalf("timed out: %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// settle lets the glue drain what it has been sent: a no-op op's turn through the loop
// can't be observed, so it waits a moment for a negative check.
func settle() { time.Sleep(80 * time.Millisecond) }

// A new thread joins its creator's space, else the current one; a plugin's thread and a
// thread the layout already placed stay; an unarchived thread joins the current space.
func TestLayoutGlueNewThreadJoinsASpace(t *testing.T) {
	old := th("th-old")
	old.ArchivedAt = time.Unix(100, 0)
	e := newGlueEnv(t, []thread.Thread{th("th-creator"), old}, nil)
	main := e.state().CurrentSpace
	review := e.apply(&core.NewSpace{Name: "Review", Switch: true}).Result.Space
	work := e.apply(&core.NewSpace{Name: "Work"}).Result.Space
	e.apply(&core.MoveThreadToSpace{Thread: "th-creator", Space: work})
	// th-placed was sent from a composer in Main: thread.new --compose placed it there.
	e.apply(&core.NewThread{Space: main, Focus: false})
	compose := ""
	for _, p := range core.Panes(e.state().Space(main).Root) {
		compose = p.Tabs[0].ID
	}
	e.apply(&core.OpenThread{Thread: "th-placed", Compose: compose})

	user := th("th-user")
	child := th("th-child")
	child.CreatedBy = "th-creator"
	plugin := th("th-plugin")
	plugin.Owner = "plugin:x"
	for _, x := range []thread.Thread{user, child, plugin, th("th-placed")} {
		e.publish(thread.Updated{Thread: x})
	}
	old.ArchivedAt = time.Time{}
	e.publish(thread.Updated{Thread: old})
	want := map[string]string{"th-user": review, "th-child": work, "th-plugin": main, "th-placed": main, "th-old": review}
	e.eventually("threads placed", func() bool {
		st := e.state()
		for id, sp := range want {
			if st.SpaceOf(id) != sp {
				return false
			}
		}
		return true
	})
	settle()
	for id, sp := range want {
		if got := e.state().SpaceOf(id); got != sp {
			t.Errorf("%s in %s, want %s", id, got, sp)
		}
	}
	// A thread already seen is not new again.
	e.apply(&core.MoveThreadToSpace{Thread: "th-user", Space: main})
	e.publish(thread.Updated{Thread: user})
	settle()
	if got := e.state().SpaceOf("th-user"); got != main {
		t.Errorf("an update moved th-user again, to %s", got)
	}
}

// openWithSet opens thread th-a's tab with a diff tab and two terminal tabs beside it, and
// returns the two shells (the first runs "make dev", the second last ran "ls").
func openWithSet(e *glueEnv) (string, string) {
	e.t.Helper()
	e.apply(&core.OpenThread{Thread: "th-a", Focus: true})
	e.apply(&core.OpenSurface{Tab: &core.Tab{Kind: "diff", Thread: "th-a", Params: map[string]string{"project": "pj", "worktree": glueWT}}})
	x, y := e.shell("th-a"), e.shell("th-a")
	e.termTab("th-a", x)
	e.termTab("th-a", y)
	if err := e.terms.SetFacts(x, glueWT, "make dev", ""); err != nil {
		e.t.Fatal(err)
	}
	if err := e.terms.SetFacts(y, glueWT, "", "ls"); err != nil {
		e.t.Fatal(err)
	}
	return x, y
}

// A snooze, in the thread store's order: the hook first (what runs in each shell is read,
// the tabs close into the set marked fresh), then the shells go. Their removals must not
// forget the fresh terminals. Opening the thread again brings the set back, with a new shell
// under each terminal tab and the command it ran kept for "Run again".
func TestLayoutGlueSnoozeKeepsTheSetWithFreshShells(t *testing.T) {
	e := newGlueEnv(t, []thread.Thread{th("th-a")}, nil)
	x, y := openWithSet(e)
	e.goings(e.ctx, "th-a", thread.ShellsSnoozed)
	// removeShells, as the thread store does it after the hook:
	for _, id := range []string{x, y} {
		if err := terminal.KillAndRemove(e.ctx, e.terms, id); err != nil {
			t.Fatal(err)
		}
	}
	settle()
	st := e.state()
	if threadOpen(st, "th-a") || len(core.Panes(st.Space(st.CurrentSpace).Root)) != 0 {
		t.Fatalf("the thread's tabs are still open: %+v", st.Space(st.CurrentSpace).Root)
	}
	rem := st.Threads["th-a"].Remembered
	if rem == nil || len(rem.Tabs) != 3 {
		t.Fatalf("remembered %+v, want the diff and two terminals", rem)
	}
	ran := map[string]string{}
	for _, rt := range rem.Tabs {
		if rt.Tab.Kind == "terminal" {
			if rt.Fresh == nil {
				t.Errorf("terminal %s not marked fresh", rt.Tab.Params[core.TerminalParam])
				continue
			}
			ran[rt.Tab.Params[core.TerminalParam]] = rt.Fresh.Ran
		}
	}
	if ran[x] != "make dev" || ran[y] != "ls" {
		t.Errorf("ran %v: the foreground job, else the last command", ran)
	}

	// Unsnoozing changes nothing in the layout (the store publishes an update); opening does.
	e.publish(thread.Updated{Thread: th("th-a")})
	c := e.apply(&core.OpenThread{Thread: "th-a", Focus: true})
	if len(c.Result.Fresh) != 2 {
		t.Fatalf("fresh %v", c.Result.Fresh)
	}
	e.eventually("fresh shells under the restored tabs", func() bool {
		for _, tab := range c.Result.Fresh {
			_, _, tb := e.state().FindTab(tab)
			if tb == nil || tb.Params[core.TerminalParam] == x || tb.Params[core.TerminalParam] == y || !e.running(tb.Params[core.TerminalParam]) {
				return false
			}
		}
		return true
	})
	got := map[string]string{}
	for _, tab := range c.Result.Fresh {
		_, _, tb := e.state().FindTab(tab)
		nt, _ := e.terms.Get(e.ctx, tb.Params[core.TerminalParam])
		if nt.Labels[termlabel.Thread] != "th-a" || nt.Cwd != glueWT {
			t.Errorf("fresh shell %+v: not th-a's, in its checkout", nt)
		}
		got[tb.Params[core.RanParam]] = nt.ID
	}
	if got["make dev"] == "" || got["ls"] == "" {
		t.Errorf("restored tabs by ran: %v", got)
	}
}

// Archiving closes the thread's tabs everywhere, forgets its record, and ends its terminals:
// open, remembered running, and in another space. Removing a thread does the same.
func TestLayoutGlueArchiveAndRemove(t *testing.T) {
	for _, why := range []thread.ShellsGo{thread.ShellsArchived, thread.ShellsRemoved} {
		t.Run(why.String(), func(t *testing.T) {
			e := newGlueEnv(t, []thread.Thread{th("th-a")}, nil)
			x, y := openWithSet(e)
			other := e.apply(&core.NewSpace{Name: "Other"}).Result.Space
			z := e.shell("th-a")
			e.apply(&core.OpenSurface{Space: other, Tab: &core.Tab{Kind: "terminal", Thread: "th-a", Params: map[string]string{core.TerminalParam: z}}})
			e.apply(&core.CloseThread{Thread: "th-a"}) // x and y now remembered, running
			if !e.running(x) || !e.running(y) {
				t.Fatal("closing the thread ended its terminals")
			}
			e.goings(e.ctx, "th-a", why)
			e.eventually("the thread's terminals end", func() bool { return e.gone(x) && e.gone(y) && e.gone(z) })
			st := e.state()
			if st.Threads["th-a"] != nil || len(core.Panes(st.Space(other).Root)) != 0 {
				t.Errorf("something of th-a stayed: %+v %+v", st.Threads["th-a"], st.Space(other).Root)
			}
		})
	}
}

// A thread removed (its event) loses whatever the layout still had of it.
func TestLayoutGlueRemovedThread(t *testing.T) {
	e := newGlueEnv(t, []thread.Thread{th("th-a")}, nil)
	e.apply(&core.OpenThread{Thread: "th-a", Focus: true})
	e.apply(&core.SetQuick{Thread: "th-a", Open: true, Height: 200})
	e.publish(thread.Removed{ID: "th-a"})
	e.eventually("th-a forgotten", func() bool { return !threadOpen(e.state(), "th-a") && e.state().Threads["th-a"] == nil })
}

// A terminal tab closed by itself ends its terminal, linked or free, whatever closed it
// (close_tab, close_pane, remove_space). A plugin's terminal is its plugin's to end.
func TestLayoutGlueClosedTabEndsItsTerminal(t *testing.T) {
	e := newGlueEnv(t, []thread.Thread{th("th-a")}, nil)
	e.apply(&core.OpenThread{Thread: "th-a", Focus: true})
	linked, free := e.shell("th-a"), e.shell("")
	plug, err := e.terms.Create(e.ctx, terminal.Spec{Argv: []string{"go", "test"}, Labels: termlabel.PluginTerminal("tw", "Tests")})
	if err != nil {
		t.Fatal(err)
	}
	linkedTab, plugTab := e.termTab("th-a", linked), e.termTab("", plug.ID)
	e.apply(&core.CloseTab{Tab: linkedTab})
	e.apply(&core.CloseTab{Tab: plugTab})
	e.eventually("the linked shell ends", func() bool { return e.gone(linked) })

	// A free shell in its own pane, closed with the pane.
	freeTab := e.termTab("", free)
	_, p, _ := e.state().FindTab(freeTab)
	moved := e.apply(&core.MoveTab{Tab: freeTab, Pane: p.ID, Edge: core.Right}).Result.Pane
	e.apply(&core.ClosePane{Pane: moved})
	e.eventually("the free shell ends", func() bool { return e.gone(free) })

	// Every tab of a removed space closes.
	sp := e.apply(&core.NewSpace{Name: "Gone"}).Result.Space
	in := e.shell("")
	e.apply(&core.OpenSurface{Space: sp, Tab: &core.Tab{Kind: "terminal", Params: map[string]string{core.TerminalParam: in}}})
	e.apply(&core.RemoveSpace{Space: sp})
	e.eventually("the removed space's shell ends", func() bool { return e.gone(in) })
	if !e.running(plug.ID) {
		t.Error("closing a plugin terminal's tab ended it")
	}
}

// Closing a thread keeps its terminals running (they come back with it); one that then goes
// away is forgotten, so the thread does not bring back a dead terminal.
func TestLayoutGlueThreadCloseKeepsTerminals(t *testing.T) {
	e := newGlueEnv(t, []thread.Thread{th("th-a")}, nil)
	x, y := openWithSet(e)
	e.apply(&core.CloseThread{Thread: "th-a"})
	settle()
	if !e.running(x) || !e.running(y) {
		t.Fatal("closing the thread ended its terminals")
	}
	if err := terminal.KillAndRemove(e.ctx, e.terms, x); err != nil { // x exits; the reaper removes it
		t.Fatal(err)
	}
	e.eventually("x forgotten", func() bool { return !core.Holds(e.state(), x) })
	c := e.apply(&core.OpenThread{Thread: "th-a", Focus: true})
	if n := len(c.Result.Back) + len(c.Result.Placed); n != 2 || len(c.Result.Fresh) != 0 {
		t.Errorf("came back: %+v, want the diff and y", c.Result)
	}
	if !core.Holds(e.state(), y) {
		t.Error("y did not come back")
	}
}

// A terminal that goes away closes its tab; a reset's new shell takes the old one's tab,
// whichever of the two events comes first.
func TestLayoutGlueTerminalGoneAndReset(t *testing.T) {
	e := newGlueEnv(t, []thread.Thread{th("th-a")}, nil)
	e.apply(&core.OpenThread{Thread: "th-a", Focus: true})
	gone, reset1, reset2 := e.shell("th-a"), e.shell("th-a"), e.shell("")
	goneTab, tab1, tab2 := e.termTab("th-a", gone), e.termTab("th-a", reset1), e.termTab("", reset2)

	if err := terminal.KillAndRemove(e.ctx, e.terms, gone); err != nil {
		t.Fatal(err)
	}
	e.eventually("its tab closes", func() bool { _, _, tb := e.state().FindTab(goneTab); return tb == nil })

	// The new shell first, then the old one goes (terminal.reset's order).
	l := termlabel.Shell("th-a", "pj", glueWT)
	l[termlabel.Replaces] = reset1
	n1, err := e.terms.Create(e.ctx, terminal.Spec{Argv: []string{"zsh"}, Labels: l})
	if err != nil {
		t.Fatal(err)
	}
	if err := terminal.KillAndRemove(e.ctx, e.terms, reset1); err != nil {
		t.Fatal(err)
	}
	// A free shell's reset, in the same order: the new shell exists before the old one goes, so
	// whichever event the glue takes first, the tab follows (the removal finds the new shell by
	// its label). Killing the old one first raced: a removal handled before the new shell existed
	// rightly closes the tab.
	l2 := termlabel.Free()
	l2[termlabel.Replaces] = reset2
	n2, err := e.terms.Create(e.ctx, terminal.Spec{Argv: []string{"zsh"}, Labels: l2})
	if err != nil {
		t.Fatal(err)
	}
	if err := terminal.KillAndRemove(e.ctx, e.terms, reset2); err != nil {
		t.Fatal(err)
	}
	e.eventually("both tabs follow", func() bool {
		_, _, a := e.state().FindTab(tab1)
		_, _, b := e.state().FindTab(tab2)
		return a != nil && b != nil && a.Params[core.TerminalParam] == n1.ID && b.Params[core.TerminalParam] == n2.ID
	})
	settle()
	if !e.running(n1.ID) || !e.running(n2.ID) {
		t.Error("a reset's new shell was ended")
	}
}

// The quick terminal is drawn closed when its shell goes, unless the thread has another (a
// reset's); the start sweep closes quick terminals and drops tabs whose terminal is gone (a
// restart: no terminal survives one).
func TestLayoutGlueQuickAndSweep(t *testing.T) {
	e := newGlueEnv(t, []thread.Thread{th("th-a"), th("th-b")}, func(e *glueEnv) {
		e.apply(&core.OpenThread{Thread: "th-b", Focus: true})
		e.apply(&core.SetQuick{Thread: "th-b", Open: true})
		e.apply(&core.OpenSurface{Tab: &core.Tab{Kind: "terminal", Thread: "th-b", Params: map[string]string{core.TerminalParam: "t-before-restart"}}})
	})
	e.eventually("the sweep drops what died with the last daemon", func() bool {
		ts := e.state().Threads["th-b"]
		return !core.Holds(e.state(), "t-before-restart") && (ts == nil || ts.Quick == nil || !ts.Quick.Open)
	})

	quick := func() string {
		tm, err := e.terms.Create(e.ctx, terminal.Spec{Argv: []string{"zsh"}, Labels: termlabel.QuickShell("th-a", "pj", glueWT)})
		if err != nil {
			t.Fatal(err)
		}
		return tm.ID
	}
	open := func() bool { ts := e.state().Threads["th-a"]; return ts != nil && ts.Quick != nil && ts.Quick.Open }
	q1 := quick()
	e.apply(&core.SetQuick{Thread: "th-a", Open: true})
	q2 := quick() // a reset: the new one starts before the old one goes
	if err := terminal.KillAndRemove(e.ctx, e.terms, q1); err != nil {
		t.Fatal(err)
	}
	settle()
	if !open() {
		t.Fatal("the quick terminal closed while the thread had another")
	}
	if err := terminal.KillAndRemove(e.ctx, e.terms, q2); err != nil {
		t.Fatal(err)
	}
	e.eventually("the quick terminal is drawn closed", func() bool { return !open() })
}

// A restored terminal of a thread with no checkout gets no shell: its tab closes.
func TestLayoutGlueFreshWithoutACheckout(t *testing.T) {
	e := newGlueEnv(t, []thread.Thread{th("th-a")}, nil)
	x, y := openWithSet(e)
	e.goings(e.ctx, "th-a", thread.ShellsSnoozed)
	e.eventually("the snooze ends its shells", func() bool { return e.gone(x) && e.gone(y) })
	noCheckout := th("th-a")
	noCheckout.WorktreePath = ""
	e.publish(thread.Updated{Thread: noCheckout})
	settle()
	c := e.apply(&core.OpenThread{Thread: "th-a", Focus: true})
	e.eventually("the restored terminal tabs close", func() bool {
		for _, tab := range c.Result.Fresh {
			if _, _, tb := e.state().FindTab(tab); tb != nil {
				return false
			}
		}
		return true
	})
	settle()
	if got := e.terms.List(e.ctx); len(got) != 0 {
		t.Errorf("a shell started: %+v", got)
	}
}
