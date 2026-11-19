package daemon

import (
	"cmp"
	"context"
	"errors"
	"log/slog"
	"slices"
	"strings"
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
	e.goings = layoutShellsGoing(log, e.layout)
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

// woken waits for the glue to tell the layout that thread woke (set_snoozed).
func (e *glueEnv) woken(thread string) {
	e.t.Helper()
	e.eventually(thread+" woken in the layout", func() bool {
		ts := e.state().Threads[thread]
		return ts == nil || !ts.Snoozed
	})
}

// snoozedTh is thread id as the thread store has it while snoozed.
func snoozedTh(id string) thread.Thread {
	t := th(id)
	t.SnoozedUntil = time.Unix(4e9, 0)
	return t
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

// olderSnooze leaves thread as an older build's snooze left it, before a snooze left its
// terminals running (docs/notes/snooze-without-teardown.md): its tabs closed into its set
// (its action runs' tabs dropped), each remembered terminal marked to come back as a fresh
// shell with the command it ran, its quick terminal, when open, the same, the thread marked
// snoozed; then its shells ended, as that build's thread store ended them. A layout saved
// then still restores so.
func (e *glueEnv) olderSnooze(thread string) {
	e.t.Helper()
	st := e.state()
	var terms []string
	for _, sp := range st.Spaces {
		for _, p := range core.Panes(sp.Root) {
			for _, tb := range p.Tabs {
				if tb.Kind == "terminal" && tb.Thread == thread {
					terms = append(terms, tb.Params[core.TerminalParam])
				}
			}
		}
	}
	ran := map[string]string{}
	for _, id := range terms {
		tm, err := e.terms.Get(e.ctx, id)
		if err != nil {
			continue
		}
		if termlabel.IsAction(tm.Labels) {
			e.apply(&core.DropTerminal{Terminal: id})
			continue
		}
		ran[id] = cmp.Or(tm.Foreground, tm.LastCommand)
	}
	quickRan := ""
	for _, tm := range e.terms.List(e.ctx) {
		if termlabel.IsQuick(tm.Labels) && tm.Labels[termlabel.Thread] == thread && tm.State != terminal.StateExited {
			quickRan = cmp.Or(tm.Foreground, tm.LastCommand)
		}
	}
	if threadOpen(e.state(), thread) {
		e.apply(&core.CloseThread{Thread: thread})
	}
	next := e.state().Clone()
	if next.Threads == nil {
		next.Threads = map[string]*core.ThreadState{}
	}
	ts := next.Threads[thread]
	if ts == nil {
		ts = &core.ThreadState{Space: next.SpaceOf(thread)}
		next.Threads[thread] = ts
	}
	if ts.Remembered != nil {
		for i, rt := range ts.Remembered.Tabs {
			if rt.Tab.Kind == "terminal" && rt.Fresh == nil {
				ts.Remembered.Tabs[i].Fresh = &core.Fresh{Name: rt.Tab.Name, Ran: ran[rt.Tab.Params[core.TerminalParam]]}
			}
		}
	}
	if ts.Quick != nil && ts.Quick.Open {
		ts.Quick.Open, ts.Quick.Fresh, ts.Quick.Ran = false, true, quickRan
	}
	ts.Snoozed = true
	e.layout.Put(next)
	for _, tm := range e.terms.List(e.ctx) {
		if termlabel.IsPanel(tm.Labels) && tm.Labels[termlabel.Thread] == thread {
			if err := terminal.KillAndRemove(e.ctx, e.terms, tm.ID); err != nil {
				e.t.Fatal(err)
			}
		}
	}
}

// A snooze (docs/notes/snooze-without-teardown.md) closes the thread's tab and its linked
// tabs as closing its tab does: they join its set, their terminals running on. Undoing it
// (the user's unsnooze) puts its tab back where it was, its set beside it as before, over the
// same terminals: no fresh shell. Saving for later does the same.
func TestLayoutGlueSnoozeAndUndo(t *testing.T) {
	for _, form := range []string{"until", "save"} {
		t.Run(form, func(t *testing.T) {
			e := newGlueEnv(t, []thread.Thread{th("th-a")}, nil)
			x, y := openWithSet(e)
			before := e.state().Clone()
			sp := before.Space(before.CurrentSpace)
			put := th("th-a")
			if form == "save" {
				put.SavedAt = time.Unix(1, 0)
			} else {
				put = snoozedTh("th-a")
			}
			e.publish(thread.Updated{Thread: put})
			e.eventually("the thread's tabs close", func() bool { return !threadOpen(e.state(), "th-a") })
			settle()
			st := e.state()
			// The thread's pane held only its tab once its set was put away: it stays, with
			// New thread in its place (docs/notes/put-away-undo.md).
			if got := tabsByPane(st.Space(st.CurrentSpace)); len(got) != 1 || !strings.HasSuffix(got[0], ":compose//") {
				t.Fatalf("tabs after the snooze %v, want the thread's pane with only the empty composer", got)
			}
			ts := st.Threads["th-a"]
			if ts == nil || !ts.Snoozed || ts.SnoozedTab == nil || ts.Remembered == nil || len(ts.Remembered.Tabs) != 3 {
				t.Fatalf("thread state %+v, want snoozed with its tab's place and the diff and two terminals", ts)
			}
			for _, rt := range ts.Remembered.Tabs {
				if rt.Fresh != nil {
					t.Errorf("remembered %s marked fresh", rt.Tab.ID)
				}
			}
			if !e.running(x) || !e.running(y) {
				t.Fatal("the snooze ended the thread's terminals")
			}
			if len(st.Space(st.CurrentSpace).Closed) != 0 {
				t.Errorf("the snooze was recorded for reopening: %+v", st.Space(st.CurrentSpace).Closed)
			}

			e.publish(thread.Updated{Thread: th("th-a")})
			e.woken("th-a")
			e.eventually("the thread's tab back", func() bool { return threadOpen(e.state(), "th-a") })
			settle()
			if !e.running(x) || !e.running(y) {
				t.Fatal("the undo ended the thread's terminals")
			}
			after := e.state()
			if ts := after.Threads["th-a"]; ts != nil && (ts.Remembered != nil || ts.SnoozedTab != nil || ts.Snoozed) {
				t.Errorf("thread state after the undo %+v, want nothing remembered", ts)
			}
			if got, want := tabsByPane(after.Space(after.CurrentSpace)), tabsByPane(sp); !slices.Equal(got, want) {
				t.Errorf("tabs after the undo %v, want as before %v", got, want)
			}
			if len(e.terms.List(e.ctx)) != 2 {
				t.Errorf("terminals %+v, want the two shells only", e.terms.List(e.ctx))
			}
		})
	}
}

// tabsByPane is each pane's tabs in order, as "pane:kind/thread/terminal" lines, for
// comparing a layout before and after.
func tabsByPane(sp *core.Space) []string {
	var out []string
	for _, p := range core.Panes(sp.Root) {
		for _, tb := range p.Tabs {
			out = append(out, p.ID+":"+tb.Kind+"/"+tb.Thread+"/"+tb.Params[core.TerminalParam])
		}
	}
	return out
}

// A layout an older build's snooze left (olderSnooze): opening the thread again brings the
// set back, with a new shell under each terminal tab and the command it ran kept for "Run
// again".
func TestLayoutGlueOlderSnoozeComesBackWithFreshShells(t *testing.T) {
	e := newGlueEnv(t, []thread.Thread{th("th-a")}, nil)
	x, y := openWithSet(e)
	e.olderSnooze("th-a")
	settle()
	st := e.state()
	rem := st.Threads["th-a"].Remembered
	if rem == nil || len(rem.Tabs) != 3 {
		t.Fatalf("remembered %+v, want the diff and two terminals", rem)
	}
	e.publish(thread.Updated{Thread: th("th-a")})
	e.woken("th-a")
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

// A snooze leaves the thread's action runs running, their tabs in its set as its shells'
// are; the undo puts them back over the same terminals.
func TestLayoutGlueSnoozeKeepsActionRuns(t *testing.T) {
	e := newGlueEnv(t, []thread.Thread{th("th-a")}, nil)
	e.apply(&core.OpenThread{Thread: "th-a", Focus: true})
	tm, err := e.terms.Create(e.ctx, terminal.Spec{Argv: []string{"zsh", "-lc", "x"}, Cwd: glueWT, Labels: termlabel.ActionTerminal("th-a", "pj", glueWT, "ac-Dev", "Dev", "run-Dev")})
	if err != nil {
		t.Fatal(err)
	}
	e.termTab("th-a", tm.ID)
	e.publish(thread.Updated{Thread: snoozedTh("th-a")})
	e.eventually("the thread's tabs close", func() bool { return !threadOpen(e.state(), "th-a") })
	settle()
	if !e.running(tm.ID) {
		t.Fatal("the snooze ended the action run")
	}
	e.publish(thread.Updated{Thread: th("th-a")})
	e.eventually("the action's tab back over its run", func() bool {
		for _, p := range core.Panes(e.state().Space(e.state().CurrentSpace).Root) {
			for _, tb := range p.Tabs {
				if tb.Kind == "terminal" && tb.Params[core.TerminalParam] == tm.ID {
					return true
				}
			}
		}
		return false
	})
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

// An archive keeps a pane whose only tab was the thread's, New thread in its place, with the
// focus it had; a pane with other tabs shows its next one (docs/notes/put-away-undo.md).
func TestLayoutGlueArchiveKeepsThePane(t *testing.T) {
	e := newGlueEnv(t, []thread.Thread{th("th-a"), th("th-b"), th("th-c")}, nil)
	a := e.apply(&core.OpenThread{Thread: "th-a", Focus: true}).Result
	b := e.apply(&core.OpenThread{Thread: "th-b", Edge: core.Right}).Result
	e.apply(&core.OpenThread{Thread: "th-c", Pane: b.Pane, Focus: true})
	e.apply(&core.FocusTab{Tab: a.Tab})

	e.goings(e.ctx, "th-a", thread.ShellsArchived)
	e.eventually("th-a's tab closes", func() bool { return !threadOpen(e.state(), "th-a") })
	st := e.state()
	sp := st.Space(st.CurrentSpace)
	_, p := st.FindPane(a.Pane)
	if p == nil || len(p.Tabs) != 1 || p.Tabs[0].Kind != "compose" || sp.Focus != a.Pane {
		t.Fatalf("th-a's pane after the archive %+v (focus %s), want it kept with New thread and the focus", p, sp.Focus)
	}

	e.goings(e.ctx, "th-b", thread.ShellsArchived)
	e.eventually("th-b's tab closes", func() bool { return !threadOpen(e.state(), "th-b") })
	st = e.state()
	if got := tabsByPane(st.Space(st.CurrentSpace)); !slices.Equal(got, []string{a.Pane + ":compose//", b.Pane + ":thread/th-c/"}) {
		t.Errorf("tabs after the second archive %v, want th-c in front of th-b's pane", got)
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
	e.olderSnooze("th-a")
	e.eventually("the snooze ends its shells", func() bool { return e.gone(x) && e.gone(y) })
	noCheckout := th("th-a")
	noCheckout.WorktreePath = ""
	e.publish(thread.Updated{Thread: noCheckout})
	e.woken("th-a")
	c := e.apply(&core.OpenThread{Thread: "th-a", Focus: true})
	if len(c.Result.Fresh) == 0 {
		t.Fatal("no terminal tab came back")
	}
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

// An older build's snooze with the quick terminal open (olderSnooze): it was marked fresh,
// then its shell went (which must not settle the mark). Opening the thread's tab while it is
// still snoozed brings nothing back; when it wakes with its tab open,
// the quick terminal comes back open over a fresh quick shell in the checkout, the command
// kept for "Run again". One started meanwhile (terminal.quick) is kept: no second shell.
func TestLayoutGlueSnoozeBringsTheQuickTerminalBack(t *testing.T) {
	for _, tc := range []struct {
		name     string
		meantime bool
	}{
		{name: "a fresh shell"},
		{name: "one started meanwhile is kept", meantime: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newGlueEnv(t, []thread.Thread{th("th-a")}, nil)
			e.apply(&core.OpenThread{Thread: "th-a", Focus: true})
			startQuick := func() string {
				tm, err := e.terms.Create(e.ctx, terminal.Spec{Argv: []string{"zsh"}, Cwd: glueWT, Labels: termlabel.QuickShell("th-a", "pj", glueWT)})
				if err != nil {
					t.Fatal(err)
				}
				return tm.ID
			}
			old := startQuick()
			if err := e.terms.SetFacts(old, glueWT, "npm run dev", ""); err != nil {
				t.Fatal(err)
			}
			e.apply(&core.SetQuick{Thread: "th-a", Open: true, Height: 200})

			e.olderSnooze("th-a")
			settle()
			if q := e.state().Threads["th-a"].Quick; q == nil || q.Open || !q.Fresh || q.Ran != "npm run dev" || q.Height != 200 {
				t.Fatalf("quick after the snooze: %+v, want closed, fresh, ran npm run dev, 200 high", q)
			}

			e.publish(thread.Updated{Thread: snoozedTh("th-a")})
			settle()
			c := e.apply(&core.OpenThread{Thread: "th-a", Focus: true})
			if c.Result.FreshQuick != "" {
				t.Fatalf("opened while snoozed: FreshQuick = %q", c.Result.FreshQuick)
			}
			meantime := ""
			if tc.meantime {
				meantime = startQuick()
			}
			e.publish(thread.Updated{Thread: th("th-a")})
			e.woken("th-a")
			quicks := func() []terminal.Terminal {
				var out []terminal.Terminal
				for _, tm := range e.terms.List(e.ctx) {
					if termlabel.IsQuick(tm.Labels) && tm.Labels[termlabel.Thread] == "th-a" && tm.State == terminal.StateRunning {
						out = append(out, tm)
					}
				}
				return out
			}
			e.eventually("a running quick shell for th-a", func() bool { return len(quicks()) == 1 })
			settle()
			got := quicks()
			if len(got) != 1 || got[0].ID == old || got[0].Cwd != glueWT || (tc.meantime && got[0].ID != meantime) {
				t.Fatalf("quick shells %+v, want one new one in the checkout (the meantime one: %q)", got, meantime)
			}
			if q := e.state().Threads["th-a"].Quick; q == nil || !q.Open || q.Fresh || q.Ran != "npm run dev" {
				t.Errorf("quick after opening: %+v, want open with its Run again line", q)
			}
		})
	}
}
