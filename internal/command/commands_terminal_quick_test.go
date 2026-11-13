package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	layoutstore "github.com/alexwaumann/code-foundry/internal/store/layout"
	"github.com/alexwaumann/code-foundry/internal/store/layout/layouttest"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// Terminals and the layout (commands_terminal_quick.go): a new shell's tab, the quick
// terminal and the ring. The layout is seeded() (commands_layout_test.go): thread A's tab in
// p-left, its diff in p-right.

const threadA = "s-aaaa00000001"

type termLayoutFixture struct {
	reg   *command.Registry
	store *layouttest.Fake
	term  *listing
}

func newTermLayoutFixture(t *testing.T) termLayoutFixture {
	t.Helper()
	t.Setenv("SHELL", "/bin/fish")
	f := termLayoutFixture{reg: command.NewRegistry(), store: layouttest.New(nil), term: &listing{Terminal: &commandtest.Terminal{}}}
	f.store.Put(seeded())
	if err := command.RegisterTerminal(f.reg, command.TerminalDeps{
		Terminal: f.term, Project: &commandtest.Project{},
		Thread: &commandtest.Thread{Current: &v1.Thread{Id: threadA, ProjectId: "pj-1", WorktreePath: "/w"}},
		Layout: f.store,
	}); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f termLayoutFixture) run(t *testing.T, uctx command.Context, name string, args map[string]string) (command.Result, error) {
	t.Helper()
	return f.reg.Invoke(context.Background(), uctx, name, args)
}

func (f termLayoutFixture) state() *core.State { return f.store.Snapshot().State }

// terminalTab finds terminal id's tab: its pane, its thread, and whether it has the focus.
func (f termLayoutFixture) terminalTab(id string) (pane, thread string, focused bool) {
	st := f.state()
	for _, sp := range st.Spaces {
		for _, p := range core.Panes(sp.Root) {
			for _, tb := range p.Tabs {
				if tb.Kind == "terminal" && tb.Params[core.TerminalParam] == id {
					return p.ID, tb.Thread, st.CurrentSpace == sp.ID && sp.Focus == p.ID && p.Active == tb.ID
				}
			}
		}
	}
	return "", "", false
}

// A thread's new shell gets a linked tab placed by the rules (beside its diff); a shell of
// no thread an unlinked tab in the focused pane. The user's own call focuses it, a thread's
// never does. The quick terminal is no tab.
func TestTerminalNewOpensATab(t *testing.T) {
	for _, tc := range []struct {
		name, verb   string
		uctx         command.Context
		args         map[string]string
		pane, thread string
		focused      bool
	}{
		{name: "a thread's shell from the app", verb: "terminal.new", uctx: fromApp, pane: "p-right", thread: threadA, focused: true},
		{name: "a thread's shell from the thread", verb: "terminal.new", uctx: command.Context{Origin: command.OriginCLI, ActiveThreadID: threadA},
			pane: "p-right", thread: threadA},
		{name: "a worktree's shell", verb: "terminal.new", uctx: command.Context{ActiveView: "projects", ActiveWorktreePath: "/w"},
			pane: "p-left", focused: true},
		{name: "a free shell", verb: "terminal.new-free", uctx: fromCLI, pane: "p-left", focused: true},
		{name: "a free shell from a thread", verb: "terminal.new-free", uctx: fromThread, pane: "p-left"},
		// A pane's "+" menu: --pane puts the tab there, linked or not.
		{name: "a thread's shell in a pane", verb: "terminal.new", uctx: fromApp, args: map[string]string{"pane": "p-left"}, pane: "p-left", thread: threadA, focused: true},
		{name: "a free shell in a pane", verb: "terminal.new-free", uctx: fromCLI, args: map[string]string{"pane": "p-right"}, pane: "p-right", focused: true},
		{name: "the quick terminal", verb: "terminal.new", uctx: fromApp, args: map[string]string{"quick": "true"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newTermLayoutFixture(t)
			reg := f.reg
			if tc.uctx.ActiveWorktreePath != "" {
				reg = command.NewRegistry()
				proj := &commandtest.Project{Projects: []*v1.Project{{Id: "pj-1", Worktrees: []*v1.Worktree{{Path: "/w"}}}}}
				if err := command.RegisterTerminal(reg, command.TerminalDeps{Terminal: f.term, Project: proj, Thread: &commandtest.Thread{}, Layout: f.store}); err != nil {
					t.Fatal(err)
				}
			}
			res, err := reg.Invoke(context.Background(), tc.uctx, tc.verb, tc.args)
			if err != nil {
				t.Fatal(err)
			}
			id := res.JSON.(*v1.Terminal).GetId()
			pane, thread, focused := f.terminalTab(id)
			if pane != tc.pane || thread != tc.thread || focused != tc.focused {
				t.Errorf("tab in %q of %q focused %v; want %q of %q focused %v (%s)", pane, thread, focused, tc.pane, tc.thread, tc.focused, res.Message)
			}
		})
	}
}

// terminal.quick toggles the thread's quick terminal: opening starts its shell once and, from
// the user, focuses the thread; closing leaves the shell running. Without a thread it takes
// the focused tab's; from inside a thread it must be named.
func TestTerminalQuick(t *testing.T) {
	f := newTermLayoutFixture(t)
	open := func() bool {
		ts := f.state().Threads[threadA]
		return ts != nil && ts.Quick != nil && ts.Quick.Open
	}
	// The user on the Pull Requests tab (no thread): the focused tab names none.
	if _, err := f.store.Apply(context.Background(), &core.FocusTab{Tab: "t-prs"}, layoutApply()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.run(t, fromCLI, "terminal.quick", nil); !errors.Is(err, command.ErrInvalidArgs) {
		t.Fatalf("no thread focused: %v", err)
	}
	// From the diff (a linked surface): its thread's quick terminal opens and the thread
	// takes the focus.
	if _, err := f.store.Apply(context.Background(), &core.FocusTab{Tab: "t-diff"}, layoutApply()); err != nil {
		t.Fatal(err)
	}
	res, err := f.run(t, fromCLI, "terminal.quick", nil)
	if err != nil {
		t.Fatal(err)
	}
	q := res.JSON.(command.QuickResult)
	if !open() || !q.Open || q.TerminalID == "" || len(creates(f.term.Requests())) != 1 {
		t.Fatalf("open %v, %+v, creates %d", open(), q, len(creates(f.term.Requests())))
	}
	if c := creates(f.term.Requests())[0]; !termlabel.IsQuick(c.GetLabels()) || c.GetCwd() != "/w" {
		t.Errorf("created %v", c)
	}
	if st := f.state(); st.Space(st.CurrentSpace).Focus != "p-left" {
		t.Errorf("the thread did not take the focus: %+v", st.Space(st.CurrentSpace))
	}
	// Again: closed, the shell kept (nothing created, nothing closed).
	if _, err := f.run(t, fromCLI, "terminal.quick", nil); err != nil || open() {
		t.Fatalf("toggle: %v, open %v", err, open())
	}
	// --open twice: open, one shell.
	for range 2 {
		if _, err := f.run(t, fromApp, "terminal.quick", map[string]string{"open": "true"}); err != nil || !open() {
			t.Fatalf("--open: %v, open %v", err, open())
		}
	}
	if n := len(creates(f.term.Requests())); n != 1 {
		t.Errorf("%d shells started, want 1", n)
	}
	// From inside a thread: the thread must be named; named, it opens without the focus.
	if _, err := f.run(t, fromThread, "terminal.quick", map[string]string{"close": "true"}); !errors.Is(err, command.ErrInvalidArgs) {
		t.Errorf("from a thread with no id: %v", err)
	}
	if _, err := f.store.Apply(context.Background(), &core.FocusTab{Tab: "t-prs"}, layoutApply()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.run(t, fromThread, "terminal.quick", map[string]string{"id": threadA, "close": "true"}); err != nil || open() {
		t.Fatalf("from a thread, named: %v, open %v", err, open())
	}
	if _, err := f.run(t, fromThread, "terminal.quick", map[string]string{"id": threadA, "open": "true"}); err != nil || !open() {
		t.Fatalf("from a thread, named: %v, open %v", err, open())
	}
	if st := f.state(); st.Space(st.CurrentSpace).Focus != "p-left" || paneActive(st, "p-left") != "t-prs" {
		t.Errorf("a thread's call moved the user's focus")
	}
}

// terminal.quick --height alone sets the height and keeps the open state (the height drag);
// with --open it opens at that height. The height outlives a close.
func TestTerminalQuickHeight(t *testing.T) {
	f := newTermLayoutFixture(t)
	quick := func() *core.Quick {
		if ts := f.state().Threads[threadA]; ts != nil {
			return ts.Quick
		}
		return nil
	}
	arg := map[string]string{"id": threadA}
	with := func(kv ...string) map[string]string {
		m := map[string]string{"id": threadA}
		for i := 0; i+1 < len(kv); i += 2 {
			m[kv[i]] = kv[i+1]
		}
		return m
	}
	res, err := f.run(t, fromApp, "terminal.quick", with("open", "true", "height", "240"))
	if err != nil {
		t.Fatal(err)
	}
	if q := quick(); q == nil || !q.Open || q.Height != 240 {
		t.Fatalf("opened: %+v", q)
	}
	if r := res.JSON.(command.QuickResult); r.Rev == 0 || !r.Open {
		t.Errorf("result %+v", r)
	}
	if _, err := f.run(t, fromApp, "terminal.quick", with("height", "300")); err != nil {
		t.Fatal(err)
	}
	if q := quick(); q == nil || !q.Open || q.Height != 300 {
		t.Fatalf("resized: %+v", q)
	}
	if _, err := f.run(t, fromApp, "terminal.quick", arg); err != nil {
		t.Fatal(err)
	}
	if q := quick(); q == nil || q.Open || q.Height != 300 {
		t.Fatalf("closed: %+v", q)
	}
	if _, err := f.run(t, fromApp, "terminal.quick", with("height", "200")); err != nil {
		t.Fatal(err)
	}
	if q := quick(); q == nil || q.Open || q.Height != 200 {
		t.Fatalf("resized while closed: %+v", q)
	}
	if _, err := f.run(t, fromApp, "terminal.quick", with("height", "-5")); !errors.Is(err, command.ErrInvalidArgs) {
		t.Errorf("a negative height: %v", err)
	}
}

func paneActive(st *core.State, pane string) string {
	_, p := st.FindPane(pane)
	return p.Active
}

// terminal.cycle walks the ring: the thread, its terminal tabs in layout order, the thread;
// from a view it starts at the first terminal. From inside a thread it needs --focus.
func TestTerminalCycle(t *testing.T) {
	f := newTermLayoutFixture(t)
	var terms []string
	for range 2 {
		res, err := f.run(t, fromApp, "terminal.new", nil)
		if err != nil {
			t.Fatal(err)
		}
		if pane, _, focused := f.terminalTab(res.JSON.(*v1.Terminal).GetId()); pane == "" || !focused {
			t.Fatalf("no focused tab for %s", res.Message)
		}
		terms = append(terms, f.focusedTab())
	}
	if _, err := f.store.Apply(context.Background(), &core.FocusTab{Tab: "t-a"}, layoutApply()); err != nil {
		t.Fatal(err)
	}
	want := []string{terms[0], terms[1], "t-a", terms[0]}
	for i, w := range want {
		if _, err := f.run(t, fromCLI, "terminal.cycle", nil); err != nil {
			t.Fatal(err)
		}
		if got := f.focusedTab(); got != w {
			t.Fatalf("step %d: focused %s, want %s", i, got, w)
		}
	}
	if _, err := f.store.Apply(context.Background(), &core.FocusTab{Tab: "t-diff"}, layoutApply()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.run(t, fromCLI, "terminal.cycle", nil); err != nil || f.focusedTab() != terms[0] {
		t.Errorf("from the diff: %v, focused %s", err, f.focusedTab())
	}
	if _, err := f.run(t, fromThread, "terminal.cycle", map[string]string{"tab": "t-a"}); err == nil {
		t.Error("terminal.cycle from a thread without --focus")
	}
	if _, err := f.run(t, fromCLI, "terminal.cycle", map[string]string{"tab": "t-prs"}); err == nil {
		t.Error("terminal.cycle from a tab of no thread")
	}
}

func layoutApply() layoutstore.ApplyOptions { return layoutstore.ApplyOptions{} }

func (f termLayoutFixture) focusedTab() string {
	st := f.state()
	sp := st.Space(st.CurrentSpace)
	return paneActive(st, sp.Focus)
}

// layout.show lists what a thread stores beside its tabs: a space not the default, its quick
// terminal open and the tabs it remembers, a snoozed terminal marked to come back fresh with what it ran,
// and a snoozed quick terminal.
func TestLayoutShowThreads(t *testing.T) {
	f := newTermLayoutFixture(t)
	st := seeded()
	st.Threads = map[string]*core.ThreadState{
		threadA: {Space: "sp-main", Quick: &core.Quick{Open: true}, Remembered: &core.Remembered{Pane: "p-left", Tabs: []core.RememberedTab{
			{Tab: &core.Tab{ID: "t-x", Kind: "terminal", Thread: threadA, Params: map[string]string{"terminal": "term-x"}}, Pane: "p-right", Fresh: &core.Fresh{Ran: "make dev"}},
			// A snooze takes a terminal tab from another space with that space.
			{Tab: &core.Tab{ID: "t-y", Kind: "terminal", Thread: threadA, Params: map[string]string{"terminal": "term-y"}}, Space: "sp-two", Pane: "p-two", Fresh: &core.Fresh{}},
			// The first-load import remembers tabs with no pane.
			{Tab: &core.Tab{ID: "t-f", Kind: "file", Thread: threadA, Title: "notes.md", Params: map[string]string{"path": "/w/notes.md"}}},
		}}},
		"s-quiet0000001": {Space: "sp-main"},
		"s-moved0000001": {Space: "sp-two"},
		// A snoozed thread whose quick terminal was open.
		"s-snoozed00001": {Space: "sp-main", Quick: &core.Quick{Fresh: true, Ran: "make dev"}},
	}
	f.store.Put(st)
	reg := command.NewRegistry()
	if err := command.RegisterLayout(reg, command.LayoutDeps{Layout: f.store}); err != nil {
		t.Fatal(err)
	}
	res, err := reg.Invoke(context.Background(), fromCLI, "layout.show", nil)
	if err != nil {
		t.Fatal(err)
	}
	want := "threads\n" +
		"  thread s-aaaa00000001 in space sp-main, quick terminal open\n" +
		"    remembered t-x terminal of s-aaaa00000001 terminal term-x in pane p-right (comes back as a fresh shell; ran \"make dev\")\n" +
		"    remembered t-y terminal of s-aaaa00000001 terminal term-y in pane p-two of space sp-two (comes back as a fresh shell)\n" +
		"    remembered t-f file of s-aaaa00000001 \"notes.md\", placed fresh beside the thread\n" +
		"  thread s-moved0000001 in space sp-two\n" +
		"  thread s-snoozed00001 in space sp-main, quick terminal comes back open as a fresh shell (ran \"make dev\")"
	if !strings.HasSuffix(res.Message, want) {
		t.Errorf("layout show:\n%s\nwant it to end with:\n%s", res.Message, want)
	}
}
