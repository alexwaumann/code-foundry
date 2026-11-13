package command_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	"github.com/alexwaumann/code-foundry/internal/store/layout/layouttest"
)

// The callers a layout verb tells apart: the app (a view), the user's own CLI (no view, no
// thread) and a thread's CLI (no view, the thread it runs in).
var (
	fromApp    = command.Context{ActiveView: "thread", ActiveThreadID: "s-aaaa00000001"}
	fromCLI    = command.Context{Origin: command.OriginCLI}
	fromThread = command.Context{Origin: command.OriginCLI, ActiveThreadID: "s-me0000000001"}
)

// seeded is a layout with two spaces. Main: thread A's tab and the Pull Requests page in
// p-left (A focused), A's diff in p-right. Two: one pane with the Projects page.
//
//	Main  row s-root [0.6 0.4]
//	  p-left   * t-a (thread s-aaaa00000001), t-prs (prs)
//	  p-right  * t-diff (diff of s-aaaa00000001)
//	Two   p-two * t-proj (projects)
func seeded() *core.State {
	return &core.State{
		V: core.Version, CurrentSpace: "sp-main", DefaultSpace: "sp-main",
		Spaces: []*core.Space{
			{
				ID: "sp-main", Name: "Main", Focus: "p-left", MRU: []string{"t-a", "t-diff"},
				Root: &core.Node{T: core.NodeSplit, ID: "s-root", Dir: core.Row, Sizes: []float64{0.6, 0.4}, Kids: []*core.Node{
					{T: core.NodePane, ID: "p-left", Active: "t-a", Tabs: []*core.Tab{
						{ID: "t-a", Kind: "thread", Thread: "s-aaaa00000001", Key: "thread:s-aaaa00000001"},
						{ID: "t-prs", Kind: "prs", Key: "prs"},
					}},
					{T: core.NodePane, ID: "p-right", Active: "t-diff", Tabs: []*core.Tab{
						{ID: "t-diff", Kind: "diff", Thread: "s-aaaa00000001", Key: "diff:s-aaaa00000001:pj-1:/w", Params: map[string]string{"project": "pj-1", "worktree": "/w"}},
					}},
				}},
			},
			{
				ID: "sp-two", Name: "Two", Focus: "p-two",
				Root: &core.Node{T: core.NodePane, ID: "p-two", Active: "t-proj", Tabs: []*core.Tab{{ID: "t-proj", Kind: "projects", Key: "projects"}}},
			},
		},
	}
}

type layoutFixture struct {
	reg    *command.Registry
	store  *layouttest.Fake
	thread *commandtest.Thread
}

func newLayoutFixture(t *testing.T) layoutFixture {
	t.Helper()
	f := layoutFixture{reg: command.NewRegistry(), store: layouttest.New(nil), thread: &commandtest.Thread{}}
	if err := command.RegisterLayout(f.reg, command.LayoutDeps{Layout: f.store, Thread: f.thread}); err != nil {
		t.Fatal(err)
	}
	f.store.Put(seeded())
	return f
}

func (f layoutFixture) run(t *testing.T, uctx command.Context, name string, args map[string]string, opts ...command.InvokeOption) (command.Result, error) {
	t.Helper()
	return f.reg.Invoke(context.Background(), uctx, name, args, opts...)
}

func (f layoutFixture) must(t *testing.T, uctx command.Context, name string, args map[string]string, opts ...command.InvokeOption) command.Result {
	t.Helper()
	res, err := f.run(t, uctx, name, args, opts...)
	if err != nil {
		t.Fatalf("%s %v: %v", name, args, err)
	}
	return res
}

func (f layoutFixture) state() *core.State { return f.store.Snapshot().State }

// focus is the current space, its focused pane and that pane's active tab.
func (f layoutFixture) focus() string {
	st := f.state()
	sp := st.Space(st.CurrentSpace)
	_, p := st.FindPane(sp.Focus)
	return sp.ID + "/" + p.ID + "/" + p.Active
}

func paneOfTab(st *core.State, tab string) string {
	_, p, _ := st.FindTab(tab)
	if p == nil {
		return ""
	}
	return p.ID
}

// From inside a thread a verb acts only on the ids it is given: the user's focus is no
// default. The same calls from the user act on the focus.
func TestLayoutRefusesImplicitIDsFromAThread(t *testing.T) {
	tests := []struct {
		name string
		args map[string]string
	}{
		{"tab.close", nil},
		{"pane.close", nil},
		{"pane.split", nil},
		{"tab.next", nil},
		{"pane.move.right", nil},
		{"space.rename", map[string]string{"name": "Mine"}},
		{"space.remove", nil},
		{"thread.close", nil},
		{"thread.space.move", map[string]string{"space": "Two"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newLayoutFixture(t)
			before := f.store.Snapshot().Rev
			_, err := f.run(t, fromThread, tt.name, tt.args, command.Confirmed(true))
			if !errors.Is(err, command.ErrInvalidArgs) || !strings.Contains(err.Error(), "from inside a thread, name the") {
				t.Fatalf("err = %v; want the refusal", err)
			}
			if f.store.Snapshot().Rev != before {
				t.Error("a refused call changed the layout")
			}
		})
	}
}

// A verb that only moves the focus is refused from a thread without --focus, and runs with it.
func TestLayoutFocusOnlyVerbsFromAThread(t *testing.T) {
	for _, tt := range []struct {
		name string
		args map[string]string
		want string
	}{
		{"space.switch", map[string]string{"space": "Two"}, "sp-two/p-two/t-proj"},
		{"pane.focus", map[string]string{"pane": "p-right"}, "sp-main/p-right/t-diff"},
		{"pane.focus.right", map[string]string{"pane": "p-left"}, "sp-main/p-right/t-diff"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			f := newLayoutFixture(t)
			_, err := f.run(t, fromThread, tt.name, tt.args)
			if connect.CodeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "--focus") {
				t.Fatalf("err = %v; want a refusal naming --focus", err)
			}
			args := map[string]string{"focus": "true"}
			for k, v := range tt.args {
				args[k] = v
			}
			f.must(t, fromThread, tt.name, args)
			if got := f.focus(); got != tt.want {
				t.Errorf("focus %s; want %s", got, tt.want)
			}
		})
	}
}

// From a thread the verbs never take the user's focus: a tab moved into the focused pane
// waits behind the focused tab, one moved elsewhere is active in its own pane, and a thread
// opened elsewhere does not switch spaces. --focus takes it.
func TestLayoutVerbsFromAThreadKeepTheFocus(t *testing.T) {
	f := newLayoutFixture(t)
	f.must(t, fromThread, "tab.move", map[string]string{"tab": "t-diff", "pane": "p-left"})
	st := f.state()
	if f.focus() != "sp-main/p-left/t-a" || paneOfTab(st, "t-diff") != "p-left" {
		t.Fatalf("focus %s, diff in %s", f.focus(), paneOfTab(st, "t-diff"))
	}
	f.must(t, fromThread, "tab.move", map[string]string{"tab": "t-prs", "outer": "bottom"})
	st = f.state()
	_, p := st.FindPane(paneOfTab(st, "t-prs"))
	if f.focus() != "sp-main/p-left/t-a" || p.Active != "t-prs" {
		t.Fatalf("focus %s; prs pane active %s", f.focus(), p.Active)
	}
	// A thread living in Two opens there without switching spaces.
	f.must(t, fromCLI, "thread.space.move", map[string]string{"id": "s-bbbb00000002", "space": "Two"})
	f.must(t, fromThread, "thread.open", map[string]string{"id": "s-bbbb00000002"})
	if f.focus() != "sp-main/p-left/t-a" {
		t.Fatalf("focus %s after thread.open from a thread", f.focus())
	}
	f.must(t, fromThread, "thread.open", map[string]string{"id": "s-bbbb00000002", "focus": "true"})
	if got := f.focus(); !strings.HasPrefix(got, "sp-two/p-two/") || got == "sp-two/p-two/t-proj" {
		t.Fatalf("focus %s after thread.open --focus", got)
	}
}

// The user's verbs act on the focus and take it.
func TestLayoutUserVerbs(t *testing.T) {
	f := newLayoutFixture(t)
	// The app's tab.next goes round the focused pane's strip.
	f.must(t, fromApp, "tab.next", nil)
	if f.focus() != "sp-main/p-left/t-prs" {
		t.Fatalf("after tab.next: %s", f.focus())
	}
	f.must(t, fromApp, "tab.next", nil)
	f.must(t, fromApp, "tab.previous", nil)
	if f.focus() != "sp-main/p-left/t-prs" {
		t.Fatalf("after next, previous: %s", f.focus())
	}
	// Direction keys use the stored layout: right of p-left is p-right, nothing left of it.
	f.must(t, fromApp, "pane.focus.right", nil)
	if f.focus() != "sp-main/p-right/t-diff" {
		t.Fatalf("after pane.focus.right: %s", f.focus())
	}
	res := f.must(t, fromCLI, "pane.focus.right", nil)
	if !strings.Contains(res.Message, "no pane right of pane p-right") {
		t.Errorf("nothing to the right: %q", res.Message)
	}
	if res := f.must(t, fromApp, "pane.focus.right", nil); res.Message != "" {
		t.Errorf("the app says nothing for a key with nothing to do: %q", res.Message)
	}
	// pane.move.left swaps the focused pane with its neighbour; the focus stays on it.
	f.must(t, fromApp, "pane.move.left", nil)
	if root := f.state().Space("sp-main").Root; root.Kids[0].ID != "p-right" || f.focus() != "sp-main/p-right/t-diff" {
		t.Fatalf("after pane.move.left: %v %s", core.PaneIDs(root), f.focus())
	}
	// pane.split takes the active tab off into a new pane.
	f.must(t, fromApp, "pane.split", map[string]string{"pane": "p-left", "edge": "bottom"})
	st := f.state()
	if paneOfTab(st, "t-prs") == "p-left" || len(core.Panes(st.Space("sp-main").Root)) != 3 {
		t.Fatalf("after pane.split: %v", core.PaneIDs(st.Space("sp-main").Root))
	}
	if _, err := f.run(t, fromApp, "pane.split", map[string]string{"pane": "p-left"}); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Errorf("split a pane of one tab: %v", err)
	}
}

// tab.close on a thread's tab closes the thread from its space (its linked tabs are kept),
// and pane.close closes the threads in it the same way.
func TestLayoutCloseThreads(t *testing.T) {
	f := newLayoutFixture(t)
	res := f.must(t, fromCLI, "tab.close", map[string]string{"tab": "t-a"})
	if got := f.store.Ops(); got[len(got)-1] != "close_thread" || !strings.Contains(res.Message, "1 linked tab of its thread remembered") {
		t.Fatalf("ops %v, %q", got, res.Message)
	}
	if paneOfTab(f.state(), "t-diff") != "" {
		t.Error("the diff stayed open")
	}
	res = f.must(t, fromCLI, "thread.open", map[string]string{"id": "s-aaaa00000001"})
	if paneOfTab(f.state(), "t-diff") == "" || !strings.Contains(res.Message, "1 linked tab came back") {
		t.Fatalf("reopen: %q", res.Message)
	}
	threadPane := paneOfTab(f.state(), "t-a")
	res = f.must(t, fromCLI, "pane.close", map[string]string{"pane": threadPane})
	if ts := f.state().Threads["s-aaaa00000001"]; ts == nil || ts.Remembered == nil || len(ts.Remembered.Tabs) != 1 {
		t.Fatalf("pane.close did not remember the diff: %+v (%q)", ts, res.Message)
	}
	// thread.close from the app defaults to the active thread; with no tab open it is not found.
	if _, err := f.run(t, fromApp, "thread.close", nil); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("close a closed thread: %v", err)
	}
}

// The argument shapes a model uses (plan 2.8): tab.move and pane.move take exactly one
// destination, pane.resize a split and its sizes.
func TestLayoutArgumentShapes(t *testing.T) {
	tests := []struct {
		name string
		cmd  string
		args map[string]string
		code connect.Code // 0: succeeds
		pane func(*core.State) bool
	}{
		{"tab into a strip at an index", "tab.move", map[string]string{"tab": "t-diff", "pane": "p-left", "index": "0"}, 0,
			func(st *core.State) bool { _, p := st.FindPane("p-left"); return p.Tabs[0].ID == "t-diff" }},
		{"tab split off beside a pane", "tab.move", map[string]string{"tab": "t-prs", "split": "p-right", "edge": "bottom", "frac": "0.3"}, 0,
			func(st *core.State) bool {
				p := paneOfTab(st, "t-prs")
				return p != "p-left" && p != "p-right" && len(core.Panes(st.Space("sp-main").Root)) == 3
			}},
		{"tab onto the outer edge", "tab.move", map[string]string{"tab": "t-prs", "outer": "left"}, 0,
			func(st *core.State) bool { return core.Panes(st.Space("sp-main").Root)[0].Tabs[0].ID == "t-prs" }},
		{"tab to another space", "tab.move", map[string]string{"tab": "t-prs", "space": "Two"}, 0,
			func(st *core.State) bool { return paneOfTab(st, "t-prs") == "p-two" }},
		{"a thread's tab to another space", "tab.move", map[string]string{"tab": "t-a", "space": "Two"}, connect.CodeFailedPrecondition, nil},
		{"tab with no destination", "tab.move", map[string]string{"tab": "t-prs"}, connect.CodeInvalidArgument, nil},
		{"tab with two destinations", "tab.move", map[string]string{"tab": "t-prs", "pane": "p-right", "outer": "left"}, connect.CodeInvalidArgument, nil},
		{"--split without --edge", "tab.move", map[string]string{"tab": "t-prs", "split": "p-right"}, connect.CodeInvalidArgument, nil},
		{"--edge without --split", "tab.move", map[string]string{"tab": "t-prs", "pane": "p-right", "edge": "top"}, connect.CodeInvalidArgument, nil},
		{"a bad frac", "tab.move", map[string]string{"tab": "t-prs", "outer": "left", "frac": "2"}, connect.CodeInvalidArgument, nil},
		{"an unknown tab", "tab.move", map[string]string{"tab": "t-nope", "pane": "p-left"}, connect.CodeNotFound, nil},
		{"pane beside a pane", "pane.move", map[string]string{"pane": "p-right", "beside": "p-left", "edge": "left"}, 0,
			func(st *core.State) bool { return core.PaneIDs(st.Space("sp-main").Root)[0] == "p-right" }},
		{"pane into a strip", "pane.move", map[string]string{"pane": "p-right", "into": "p-left", "index": "1"}, 0,
			func(st *core.State) bool { _, p := st.FindPane("p-left"); return p.Tabs[1].ID == "t-diff" }},
		{"pane onto the outer edge", "pane.move", map[string]string{"pane": "p-right", "outer": "top"}, 0,
			func(st *core.State) bool { return st.Space("sp-main").Root.Dir == core.Col }},
		{"a pane without a thread to another space", "pane.move", map[string]string{"pane": "p-two", "space": "Main"}, 0,
			func(st *core.State) bool { return paneOfTab(st, "t-proj") == "p-two" && st.Space("sp-two").Root == nil }},
		{"pane with no destination", "pane.move", map[string]string{"pane": "p-right"}, connect.CodeInvalidArgument, nil},
		{"--beside without --edge", "pane.move", map[string]string{"pane": "p-right", "beside": "p-left"}, connect.CodeInvalidArgument, nil},
		{"resize a split", "pane.resize", map[string]string{"split": "s-root", "sizes": "0.25, 0.75"}, 0,
			func(st *core.State) bool { return st.Space("sp-main").Root.Sizes[0] == 0.25 }},
		{"resize with the wrong count", "pane.resize", map[string]string{"split": "s-root", "sizes": "1,1,1"}, connect.CodeInvalidArgument, nil},
		{"resize with words", "pane.resize", map[string]string{"split": "s-root", "sizes": "half,half"}, connect.CodeInvalidArgument, nil},
		{"resize by a suffix of the split id", "pane.resize", map[string]string{"split": "root", "sizes": "1,3"}, 0,
			func(st *core.State) bool { return st.Space("sp-main").Root.Sizes[0] == 0.25 }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newLayoutFixture(t)
			_, err := f.run(t, fromThread, tt.cmd, tt.args)
			if tt.code != 0 {
				if connect.CodeOf(err) != tt.code && !(tt.code == connect.CodeInvalidArgument && errors.Is(err, command.ErrInvalidArgs)) {
					t.Fatalf("err = %v; want %v", err, tt.code)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !tt.pane(f.state()) {
				t.Errorf("layout after: %s", f.must(t, fromCLI, "layout.show", nil).Message)
			}
		})
	}
}

// Spaces: new, rename, switch by name and by index, reorder, remove with its threads moved
// or archived.
func TestLayoutSpaces(t *testing.T) {
	f := newLayoutFixture(t)
	f.must(t, fromCLI, "space.new", map[string]string{"name": "Review"})
	st := f.state()
	if len(st.Spaces) != 3 || st.Spaces[2].Name != "Review" || st.CurrentSpace != st.Spaces[2].ID {
		t.Fatalf("space.new from the user: %+v current %s", st.Spaces, st.CurrentSpace)
	}
	review := st.Spaces[2].ID
	f.must(t, fromThread, "space.new", map[string]string{"name": "Quiet"})
	if f.state().CurrentSpace != review {
		t.Fatal("space.new from a thread switched spaces")
	}
	f.must(t, fromCLI, "space.rename", map[string]string{"name": "Code review"})
	if f.state().Space(review).Name != "Code review" {
		t.Fatal("space.rename did not rename the current space")
	}
	f.must(t, fromApp, "space.switch", map[string]string{"index": "1"})
	if f.state().CurrentSpace != "sp-main" {
		t.Fatal("space.switch --index 1")
	}
	f.must(t, fromApp, "space.switch", map[string]string{"space": "code REVIEW"})
	if f.state().CurrentSpace != review {
		t.Fatal("space.switch by name")
	}
	if _, err := f.run(t, fromApp, "space.switch", map[string]string{"index": "9"}); !errors.Is(err, command.ErrInvalidArgs) {
		t.Errorf("space.switch --index 9: %v", err)
	}
	f.must(t, fromThread, "space.move", map[string]string{"space": "Quiet", "index": "1"})
	if f.state().Spaces[0].Name != "Quiet" {
		t.Fatalf("space.move: %v", f.state().Spaces)
	}

	// Remove Two with its thread moved to Main; then Main with its threads archived.
	f.thread.Others = []*v1.Thread{{Id: "s-aaaa00000001"}, {Id: "s-bbbb00000002"}}
	f.must(t, fromCLI, "thread.space.move", map[string]string{"id": "s-bbbb00000002", "space": "Two"})
	_, err := f.run(t, fromCLI, "space.remove", map[string]string{"space": "Two", "to": "Main"})
	var ce *command.ConfirmError
	if !errors.As(err, &ce) || ce.Message != `Remove space "Two"? Its tab closes, and its thread moves to "Main".` {
		t.Fatalf("space.remove asks: %v", err)
	}
	f.must(t, fromCLI, "space.remove", map[string]string{"space": "Two", "to": "Main"}, command.Confirmed(true))
	st = f.state()
	if st.Space("sp-two") != nil || st.SpaceOf("s-bbbb00000002") != "sp-main" {
		t.Fatalf("after removing Two: %v, b in %s", st.Spaces, st.SpaceOf("s-bbbb00000002"))
	}
	if _, err := f.run(t, fromCLI, "space.remove", map[string]string{"space": "Main", "to": "Main"}, command.Confirmed(true)); !errors.Is(err, command.ErrInvalidArgs) {
		t.Errorf("--to the space itself: %v", err)
	}
	res := f.must(t, fromCLI, "space.remove", map[string]string{"space": "Main", "archive": "true"}, command.Confirmed(true))
	var archived []string
	for _, r := range f.thread.Requests() {
		if a, ok := r.(*v1.ArchiveThreadRequest); ok {
			archived = append(archived, a.GetId())
		}
	}
	slices.Sort(archived)
	if !slices.Equal(archived, []string{"s-aaaa00000001", "s-bbbb00000002"}) || !strings.Contains(res.Message, "archived 2 threads") {
		t.Fatalf("archived %v (%q)", archived, res.Message)
	}
	// An empty space goes without a question; the last one stays.
	f.must(t, fromCLI, "space.remove", map[string]string{"space": "Code review"})
	if _, err := f.run(t, fromCLI, "space.remove", map[string]string{"space": "Quiet"}, command.Confirmed(true)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Errorf("remove the last space: %v", err)
	}
}

// layout.show prints the outline a model reads ids from; ids resolve from unique suffixes,
// and spaces by name.
func TestLayoutShowAndIDs(t *testing.T) {
	f := newLayoutFixture(t)
	f.thread.Others = []*v1.Thread{{Id: "s-aaaa00000001", Name: "Fix login"}}
	res := f.must(t, fromThread, "layout.show", nil)
	for _, want := range []string{
		"laid out in 1180x820",
		`space sp-main "Main" (current)`,
		"row s-root [0.60 0.40]",
		"pane p-left (focused)",
		`* t-a thread s-aaaa00000001 "Fix login"`,
		`* t-diff diff of s-aaaa00000001 "Fix login"`,
		`space sp-two "Two"`,
	} {
		if !strings.Contains(res.Message, want) {
			t.Errorf("layout.show lacks %q:\n%s", want, res.Message)
		}
	}
	if v, ok := res.JSON.(command.LayoutView); !ok || len(v.Spaces) != 2 || v.Width != 1180 {
		t.Errorf("JSON %#v", res.JSON)
	}
	if res := f.must(t, fromCLI, "layout.show", map[string]string{"space": "two"}); strings.Contains(res.Message, "sp-main") {
		t.Errorf("--space two:\n%s", res.Message)
	}
	// "diff" is a unique suffix of t-diff; "-two" of p-two needs 4 characters.
	f.must(t, fromThread, "tab.move", map[string]string{"tab": "diff", "pane": "p-two"})
	if paneOfTab(f.state(), "t-diff") != "p-two" {
		t.Fatal("tab suffix did not resolve")
	}
	if _, err := f.run(t, fromThread, "tab.close", map[string]string{"tab": "zzzz"}); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("unknown suffix: %v", err)
	}
	if _, err := f.run(t, fromThread, "space.switch", map[string]string{"space": "Nowhere", "focus": "true"}); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("unknown space: %v", err)
	}
	res = f.must(t, fromCLI, "tab.list", map[string]string{"thread": "s-aaaa00000001"})
	if lines := strings.Split(res.Message, "\n"); len(lines) != 2 {
		t.Errorf("tab.list --thread:\n%s", res.Message)
	}
	res = f.must(t, fromCLI, "space.list", nil)
	if !strings.Contains(res.Message, "* 1. sp-main  Main  1 pane, 2 tabs") {
		t.Errorf("space.list:\n%s", res.Message)
	}
}

// Without a layout store the verbs are registered and fail as unimplemented.
func TestLayoutWithoutAStore(t *testing.T) {
	reg := command.NewRegistry()
	if err := command.RegisterLayout(reg, command.LayoutDeps{}); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Invoke(context.Background(), fromCLI, "layout.show", nil); connect.CodeOf(err) != connect.CodeUnimplemented {
		t.Errorf("layout.show: %v", err)
	}
}

// The composer and its drafts: New thread focuses the empty composer or opens one, the first
// text makes it a draft the space lists, and the row's verbs open and discard it.
func TestLayoutComposerDrafts(t *testing.T) {
	f := newLayoutFixture(t)
	res := f.must(t, fromApp, "composer.new", map[string]string{"project": "pj-1"})
	tab := res.JSON.(command.LayoutResult).Tab
	if f.focus() != "sp-main/p-left/"+tab {
		t.Fatalf("composer.new: focus %s, tab %s", f.focus(), tab)
	}
	if again := f.must(t, fromApp, "composer.new", nil).JSON.(command.LayoutResult); again.Tab != tab {
		t.Fatalf("a second composer.new opened %s; want the empty composer %s", again.Tab, tab)
	}
	res = f.must(t, fromApp, "composer.draft.start", map[string]string{"tab": tab, "id": "d-first0001", "label": "Fix"})
	if res.JSON.(command.LayoutResult).Draft != "d-first0001" {
		t.Fatalf("start: %#v", res.JSON)
	}
	// A suffix names the draft.
	f.must(t, fromApp, "composer.draft.label", map[string]string{"draft": "first0001", "label": "Fix the login"})
	if d := f.state().Space("sp-main").Drafts; len(d) != 1 || d[0].Label != "Fix the login" || d[0].Params["project"] != "pj-1" {
		t.Fatalf("drafts %+v", d)
	}
	f.must(t, fromApp, "tab.close", map[string]string{"tab": tab})
	f.must(t, fromApp, "composer.draft.open", map[string]string{"draft": "d-first0001"})
	if _, _, tb := f.state().FindTab(tab); tb != nil {
		t.Fatal("the closed draft's tab came back under its old id")
	}
	if got := f.focus(); !strings.HasPrefix(got, "sp-main/p-left/") {
		t.Fatalf("open: %s", got)
	}
	f.must(t, fromApp, "composer.draft.discard", map[string]string{"draft": "d-first0001"})
	if d := f.state().Space("sp-main").Drafts; len(d) != 0 {
		t.Fatalf("discard left %+v", d)
	}
	if _, err := f.run(t, fromApp, "composer.draft.clear", map[string]string{"draft": "d-first0001"}); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("clear a discarded draft: %v", err)
	}
}

// tab.rename gives a terminal tab a name of its own and --auto (or an empty name) gives it back
// its automatic one. A thread's tab renames the thread. Other kinds take no name; the two flags
// together are refused; from inside a thread the tab must be named.
func TestTabRename(t *testing.T) {
	f := newLayoutFixture(t)
	if _, err := f.store.Apply(context.Background(), &core.AddTab{Pane: "p-right", Tab: &core.Tab{ID: "t-term", Kind: "terminal", Thread: "s-aaaa00000001",
		Params: map[string]string{core.TerminalParam: "t-1"}}, Focus: true}, layoutApply()); err != nil {
		t.Fatal(err)
	}
	name := func() string {
		_, _, tb := f.state().FindTab("t-term")
		return tb.Name
	}
	f.must(t, fromApp, "tab.rename", map[string]string{"name": "  dev server "})
	if got := name(); got != "dev server" {
		t.Fatalf("name %q", got)
	}
	f.must(t, fromCLI, "tab.rename", map[string]string{"tab": "t-term", "auto": "true"})
	if got := name(); got != "" {
		t.Fatalf("after --auto: %q", got)
	}
	f.must(t, fromThread, "tab.rename", map[string]string{"tab": "t-term", "name": "logs"})
	f.must(t, fromCLI, "tab.rename", map[string]string{"tab": "t-term"})
	if got := name(); got != "" {
		t.Fatalf("after an empty name: %q", got)
	}
	for _, tc := range []struct {
		name string
		uctx command.Context
		args map[string]string
		code connect.Code
		is   error
	}{
		{"a diff's tab", fromCLI, map[string]string{"tab": "t-diff", "name": "x"}, connect.CodeFailedPrecondition, nil},
		{"a thread's tab with no name", fromCLI, map[string]string{"tab": "t-a"}, 0, command.ErrInvalidArgs},
		{"both flags", fromCLI, map[string]string{"tab": "t-term", "name": "x", "auto": "true"}, 0, command.ErrInvalidArgs},
		{"from a thread, no tab", fromThread, map[string]string{"name": "x"}, 0, command.ErrInvalidArgs},
		{"no such tab", fromCLI, map[string]string{"tab": "t-zzz", "name": "x"}, connect.CodeNotFound, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := f.run(t, tc.uctx, "tab.rename", tc.args)
			switch {
			case tc.is != nil && !errors.Is(err, tc.is):
				t.Errorf("err = %v, want %v", err, tc.is)
			case tc.is == nil && connect.CodeOf(err) != tc.code:
				t.Errorf("err = %v, want %v", err, tc.code)
			}
		})
	}
}

// A thread's tab is the thread: tab.rename renames it and tab.auto-name (cmd+shift+r) has its
// name generated again; on a terminal's tab tab.auto-name drops the manual name. The layout
// does not change for a thread.
func TestTabRenameThreadAndAutoName(t *testing.T) {
	f := newLayoutFixture(t)
	if _, err := f.store.Apply(context.Background(), &core.AddTab{Pane: "p-right", Tab: &core.Tab{ID: "t-term", Kind: "terminal", Thread: "s-aaaa00000001",
		Params: map[string]string{core.TerminalParam: "t-1"}, Name: "logs"}}, layoutApply()); err != nil {
		t.Fatal(err)
	}
	rev := f.store.Snapshot().Rev
	if res := f.must(t, fromCLI, "tab.rename", map[string]string{"tab": "t-a", "name": "Fix login"}); res.Message != `renamed thread "Fix login"` && !strings.Contains(res.Message, "Fix login") {
		t.Errorf("message %q", res.Message)
	}
	if res := f.must(t, fromApp, "tab.auto-name", map[string]string{"tab": "t-a"}); !strings.Contains(res.Message, commandtest.RegeneratedName) {
		t.Errorf("message %q", res.Message)
	}
	if got := f.store.Snapshot().Rev; got != rev {
		t.Errorf("a thread's rename changed the layout: rev %d -> %d", rev, got)
	}
	var kinds []string
	for _, r := range f.thread.Requests() {
		kinds = append(kinds, fmt.Sprintf("%T", r))
	}
	if want := []string{"*codefoundryv1.RenameThreadRequest", "*codefoundryv1.RegenerateNameRequest"}; !slices.Equal(kinds, want) {
		t.Errorf("thread calls %v, want %v", kinds, want)
	}
	f.must(t, fromCLI, "tab.auto-name", map[string]string{"tab": "t-term"})
	if _, _, tb := f.state().FindTab("t-term"); tb.Name != "" {
		t.Errorf("terminal tab name after tab.auto-name: %q", tb.Name)
	}
	if _, err := f.run(t, fromThread, "tab.auto-name", nil); !errors.Is(err, command.ErrInvalidArgs) {
		t.Errorf("from a thread with no tab: %v", err)
	}
}
