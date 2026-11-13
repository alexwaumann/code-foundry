package command_test

import (
	"context"
	"maps"
	"slices"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	layoutstore "github.com/alexwaumann/code-foundry/internal/store/layout"
	"github.com/alexwaumann/code-foundry/internal/store/layout/layouttest"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// self is the thread the view.open tests call from (inThread) and open tabs for.
const self = "s-aaaaaaaaaaa1"

// The callers of the view.open tests: the thread's own CLI, and the app with the thread selected.
var (
	selfCLI = command.Context{Origin: command.OriginCLI, ActiveThreadID: self}
	selfApp = command.Context{ActiveThreadID: self, ActiveView: "thread", ActiveProjectID: "r1", ActiveWorktreePath: "/wt", ActiveWorkspaceID: "w1"}
)

// threadPane is a layout of one space and one pane, holding self's tab (focused); the Pull
// Requests page waits in a second space.
//
//	Main  p-main * t-a (thread self)
//	Two   p-two  * t-prs (prs)
func threadPane() *core.State {
	return &core.State{
		V: core.Version, CurrentSpace: "sp-main", DefaultSpace: "sp-main",
		Spaces: []*core.Space{
			{ID: "sp-main", Name: "Main", Focus: "p-main", MRU: []string{"t-a"},
				Root: &core.Node{T: core.NodePane, ID: "p-main", Active: "t-a", Tabs: []*core.Tab{
					{ID: "t-a", Kind: "thread", Thread: self, Key: "thread:" + self},
				}}},
			{ID: "sp-two", Name: "Two", Focus: "p-two",
				Root: &core.Node{T: core.NodePane, ID: "p-two", Active: "t-prs", Tabs: []*core.Tab{{ID: "t-prs", Kind: "prs", Key: "prs"}}}},
		},
	}
}

// openFixture is every command over richThread (named self), one window and a layout of
// threadPane. Files, diffs, a pull request and an image are there for each item verb.
type openFixture struct {
	reg   *command.Registry
	emit  *commandtest.Emitter
	store *layouttest.Fake
	diffs *commandtest.FileDiffs
}

func newOpenFixture(t *testing.T, terms ...*v1.Terminal) openFixture {
	t.Helper()
	th := richThread()
	th.Id = self
	th.CheckoutPaths = []*v1.ThreadCheckoutPath{{ProjectId: "r1", Path: "/wt"}, {ProjectId: "r2", Path: "/api"}}
	store := layouttest.New(nil)
	store.Put(threadPane())
	diffs := &commandtest.FileDiffs{}
	reg, emit := panelRegistryWith(t, &commandtest.Thread{Current: th}, panelDeps{
		windows:  1,
		files:    &commandtest.Files{Files: []string{"/wt/a.go", "/wt/b.go", "/wt/p.html", "/wt/shot.png"}, Mime: map[string]string{"/wt/shot.png": "image/png"}},
		diffs:    diffs,
		projects: &commandtest.Project{Projects: []*v1.Project{{Id: "r1", GithubSlug: "owner/repo"}}},
		prs:      &commandtest.PullRequestChecks{Res: &v1.GetPullRequestResponse{PullRequest: &v1.PullRequest{}}},
		layout:   store,
		terms:    &commandtest.Terminal{Terminals: terms},
	})
	return openFixture{reg: reg, emit: emit, store: store, diffs: diffs}
}

func (f openFixture) run(t *testing.T, uctx command.Context, name string, args map[string]string) command.Result {
	t.Helper()
	res, err := f.reg.Invoke(context.Background(), uctx, name, args)
	if err != nil {
		t.Fatalf("%s %v: %v", name, args, err)
	}
	return res
}

func (f openFixture) state() *core.State { return f.store.Snapshot().State }

// focus is the current space, its focused pane and that pane's active tab.
func (f openFixture) focus() string {
	st := f.state()
	sp := st.Space(st.CurrentSpace)
	_, p := st.FindPane(sp.Focus)
	return sp.ID + "/" + p.ID + "/" + p.Active
}

// tabsOf are the tabs of kind in the layout, in layout order.
func (f openFixture) tabsOf(kind string) []*core.Tab {
	var out []*core.Tab
	for _, sp := range f.state().Spaces {
		for _, p := range core.Panes(sp.Root) {
			for _, tb := range p.Tabs {
				if tb.Kind == kind {
					out = append(out, tb)
				}
			}
		}
	}
	return out
}

// openVerbs are the item verbs, each with args that show something and the tab kind it opens.
var openVerbs = []struct {
	item string
	args map[string]string
	kind string
}{
	{"file", map[string]string{"path": "/wt/a.go"}, "file"},
	{"page", map[string]string{"path": "/wt/p.html"}, "file"},
	{"diff", map[string]string{}, "diff"},
	{"pr", map[string]string{"number": "7"}, "pullrequest"},
	{"gallery", map[string]string{"title": "Shots", "images": `[{"path":"/wt/shot.png"}]`}, "gallery"},
	{"mcp", map[string]string{}, "mcp"},
}

// Each view.open verb and its view.panel alias, from the thread's CLI: one open_surface of a
// tab linked to the thread, placed beside it (a new pane on its right: there is room), the
// user's focus where it was, and no intent: the tab is the whole effect.
func TestViewOpenPlacesALinkedTab(t *testing.T) {
	for _, v := range openVerbs {
		for _, name := range []string{"view.open." + v.item, "view.panel." + v.item} {
			t.Run(name, func(t *testing.T) {
				f := newOpenFixture(t)
				res := f.run(t, selfCLI, name, v.args)
				if ops := f.store.Ops(); !slices.Equal(ops, []string{"open_surface"}) {
					t.Fatalf("ops = %v, want one open_surface", ops)
				}
				tabs := f.tabsOf(v.kind)
				if len(tabs) != 1 || tabs[0].Thread != self {
					t.Fatalf("%s tabs = %+v, want one linked to %s", v.kind, tabs, self)
				}
				_, p, _ := f.state().FindTab(tabs[0].ID)
				if p.ID == "p-main" || p.Active != tabs[0].ID {
					t.Errorf("tab in pane %s (active %s), want a new pane beside the thread with it active", p.ID, p.Active)
				}
				if got := f.focus(); got != "sp-main/p-main/t-a" {
					t.Errorf("focus = %s, want the user's, unmoved", got)
				}
				sameIntents(t, f.emit.Intents(), nil)
				out, ok := res.JSON.(command.PanelResult)
				if !ok || out.Tab != tabs[0].ID || out.Pane != p.ID || out.Rule != "5" || out.TabFocused {
					t.Errorf("JSON = %+v, want tab %s in pane %s by rule 5, unfocused", res.JSON, tabs[0].ID, p.ID)
				}
				want := "opened tab " + tabs[0].ID + " in pane " + p.ID + " for thread " + self + " (in a new pane right of the thread); windows=1"
				if res.Message != want {
					t.Errorf("message = %q, want %q", res.Message, want)
				}
				if v.kind != "mcp" && maps2(tabs[0].Params) == "" {
					t.Errorf("tab params empty, want the item's")
				}
			})
		}
	}
}

// maps2 is a map's sorted "k=v" pairs, for messages.
func maps2(m map[string]string) string {
	var out []string
	for k, v := range m {
		out = append(out, k+"="+v)
	}
	slices.Sort(out)
	return strings.Join(out, " ")
}

// Who takes the focus: the user's call (the app) does, a thread's only with --focus. The layout
// is the whole effect: no FocusThread, which would take the window to the thread's own tab.
// --pane puts the tab in that pane.
func TestViewOpenFocus(t *testing.T) {
	tests := []struct {
		name      string
		ctx       command.Context
		args      map[string]string
		wantFocus bool
		wantRule  string
	}{
		{name: "the app", ctx: selfApp, wantFocus: true, wantRule: "5"},
		{name: "the thread's CLI", ctx: selfCLI, wantRule: "5"},
		{name: "the thread's CLI with --focus", ctx: selfCLI, args: map[string]string{"focus": "true"}, wantFocus: true, wantRule: "5"},
		{name: "the app with --focus=false", ctx: selfApp, args: map[string]string{"focus": "false"}, wantRule: "5"},
		{name: "--pane", ctx: selfCLI, args: map[string]string{"pane": "p-main"}, wantRule: "pane"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newOpenFixture(t)
			args := map[string]string{"path": "/wt/a.go"}
			for k, v := range tt.args {
				args[k] = v
			}
			res := f.run(t, tt.ctx, "view.open.file", args)
			tb := f.tabsOf("file")[0]
			_, p, _ := f.state().FindTab(tb.ID)
			want := "sp-main/p-main/t-a"
			if tt.wantFocus {
				want = "sp-main/" + p.ID + "/" + tb.ID
			}
			if got := f.focus(); got != want {
				t.Errorf("focus = %s, want %s", got, want)
			}
			if out := res.JSON.(command.PanelResult); out.Rule != tt.wantRule || out.TabFocused != tt.wantFocus {
				t.Errorf("JSON = %+v, want rule %s, focused %v", out, tt.wantRule, tt.wantFocus)
			}
			sameIntents(t, f.emit.Intents(), nil)
		})
	}
}

// Identity: a second open of the same surface uses the open tab (rule 1) and opens nothing; a
// different pull request or file is a new tab, which joins the thread's other linked tabs; a
// diff is one per thread and checkout (a --title makes one of the thread's own).
func TestViewOpenIdentity(t *testing.T) {
	type call struct {
		verb string
		args map[string]string
	}
	tests := []struct {
		name  string
		calls []call
		kind  string
		tabs  int
	}{
		{name: "the same diff twice", kind: "diff", tabs: 1, calls: []call{{"view.open.diff", nil}, {"view.panel.diff", map[string]string{"path": "/wt/a.go"}}}},
		{name: "a diff of another checkout", kind: "diff", tabs: 2, calls: []call{{"view.open.diff", nil}, {"view.open.diff", map[string]string{"path": "/api/x.go"}}}},
		{name: "a titled diff", kind: "diff", tabs: 2, calls: []call{{"view.open.diff", nil}, {"view.open.diff", map[string]string{"title": "The fix"}}}},
		{name: "a diff a thread framed with a side", kind: "diff", tabs: 2, calls: []call{{"view.open.diff", nil}, {"view.open.diff", map[string]string{"base": "main"}}}},
		{name: "a diff a thread framed with a note", kind: "diff", tabs: 2, calls: []call{{"view.open.diff", nil}, {"view.open.diff", map[string]string{"path": "/wt/a.go", "note": "Why"}}}},
		{name: "the same pull request twice", kind: "pullrequest", tabs: 1, calls: []call{{"view.open.pr", map[string]string{"number": "7"}}, {"view.panel.pr", map[string]string{"number": "7"}}}},
		{name: "another pull request", kind: "pullrequest", tabs: 2, calls: []call{{"view.open.pr", map[string]string{"number": "7"}}, {"view.open.pr", map[string]string{"number": "12"}}}},
		{name: "the same file twice", kind: "file", tabs: 1, calls: []call{{"view.open.file", map[string]string{"path": "/wt/a.go"}}, {"view.open.file", map[string]string{"path": "/wt/a.go", "line": "3"}}}},
		{name: "another file", kind: "file", tabs: 2, calls: []call{{"view.open.file", map[string]string{"path": "/wt/a.go"}}, {"view.open.file", map[string]string{"path": "/wt/b.go"}}}},
		{name: "the same gallery title twice", kind: "gallery", tabs: 1, calls: []call{
			{"view.open.gallery", map[string]string{"title": "Shots", "images": `[{"path":"/wt/shot.png"}]`}},
			{"view.open.gallery", map[string]string{"title": "Shots", "images": `[{"path":"/wt/shot.png","caption":"Now"}]`}}}},
		{name: "mcp twice", kind: "mcp", tabs: 1, calls: []call{{"view.open.mcp", nil}, {"view.panel.mcp", nil}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newOpenFixture(t)
			var last command.Result
			for _, c := range tt.calls {
				last = f.run(t, selfCLI, c.verb, c.args)
			}
			tabs := f.tabsOf(tt.kind)
			if len(tabs) != tt.tabs {
				t.Fatalf("%d %s tabs, want %d: %+v", len(tabs), tt.kind, tt.tabs, tabs)
			}
			out := last.JSON.(command.PanelResult)
			if existing := tt.tabs == 1; out.Existing != existing || (existing && out.Rule != "1") {
				t.Errorf("second call: JSON = %+v, want existing %v", out, existing)
			}
			if tt.tabs == 1 && !strings.Contains(last.Message, "is already open in pane") {
				t.Errorf("second call: message = %q, want it to say the tab is open", last.Message)
			}
			if tt.tabs == 2 {
				// Rule 2 for the second, unless it is the same pane anyway: beside the first.
				_, p1, _ := f.state().FindTab(tabs[0].ID)
				_, p2, _ := f.state().FindTab(tabs[1].ID)
				if p1 != p2 || out.Rule != "2" {
					t.Errorf("second tab in pane %s by rule %s, want the first's (%s) by rule 2", p2.ID, out.Rule, p1.ID)
				}
			}
			if got := f.focus(); got != "sp-main/p-main/t-a" {
				t.Errorf("focus = %s, want the user's, unmoved", got)
			}
		})
	}
}

// The checkout's own diff is the user's: a thread's call that only picks a file (no asker) shows
// it as the user has it (filter, folds) with the file picked there when the user's sides list it
// (asked only when they differ from the call's), out of a commit the user was in; otherwise the
// file opens in a tab of the thread's own and the user's stays as it was. A call with no file
// leaves the user's tab as it is.
func TestViewOpenDiffPicksInTheUsersTab(t *testing.T) {
	tests := []struct {
		name     string
		mine     map[string]string
		args     map[string]string
		unlisted bool
		want     map[string]string // the user's tab after the call
		own      map[string]string // the thread's own tab, nil for none
		compares int
	}{
		{name: "the same sides: picked at once",
			mine: map[string]string{"project": "r1", "worktree": "/wt", "own": "1", "filter": "go", "fold": "1", "path": "b.go"},
			args: map[string]string{"path": "/wt/a.go"},
			want: map[string]string{"project": "r1", "worktree": "/wt", "own": "1", "filter": "go", "fold": "1", "path": "a.go"}},
		{name: "other sides that list it: picked there",
			mine: map[string]string{"project": "r1", "worktree": "/wt", "own": "1", "base": "ref:v1", "path": "b.go"},
			args: map[string]string{"path": "/wt/a.go"}, compares: 1,
			want: map[string]string{"project": "r1", "worktree": "/wt", "own": "1", "base": "ref:v1", "path": "a.go"}},
		{name: "other sides that do not list it: a tab of the thread's own",
			mine: map[string]string{"project": "r1", "worktree": "/wt", "own": "1", "base": "ref:v1", "path": "b.go"},
			args: map[string]string{"path": "/wt/a.go"}, unlisted: true, compares: 1,
			want: map[string]string{"project": "r1", "worktree": "/wt", "own": "1", "base": "ref:v1", "path": "b.go"},
			own:  map[string]string{"project": "r1", "worktree": "/wt", "own": "1", "path": "a.go", "thread": self}},
		{name: "in a commit: back to the sides it came from, the file picked",
			mine: map[string]string{"project": "r1", "worktree": "/wt", "own": "1", "commit": "abc", "backBase": "merge-base", "backHead": "working", "backPath": "b.go", "commits": "1"},
			args: map[string]string{"path": "/wt/a.go"},
			want: map[string]string{"project": "r1", "worktree": "/wt", "own": "1", "commits": "1", "path": "a.go"}},
		{name: "no file: the user's tab as it is",
			mine: map[string]string{"project": "r1", "worktree": "/wt", "own": "1", "base": "staged", "filter": "x", "commit": "abc", "backBase": "merge-base"},
			want: map[string]string{"project": "r1", "worktree": "/wt", "own": "1", "base": "staged", "filter": "x", "commit": "abc", "backBase": "merge-base"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newOpenFixture(t)
			f.run(t, selfCLI, "view.open.diff", nil)
			tabs := f.tabsOf("diff")
			if len(tabs) != 1 {
				t.Fatalf("diff tabs = %+v", tabs)
			}
			if _, err := f.store.Apply(context.Background(), &core.SetTabParams{Tab: tabs[0].ID, Params: tt.mine}, layoutstore.ApplyOptions{}); err != nil {
				t.Fatal(err)
			}
			diffs := f.diffs
			before := len(diffs.Requests())
			if tt.unlisted {
				diffs.Unlisted = func(base, path string) bool { return base == "v1" && path == "a.go" }
			}
			out := f.run(t, selfCLI, "view.open.diff", tt.args).JSON.(command.PanelResult)
			// The call's own check compares once; the pick asks again only for other sides.
			if n := len(diffs.Requests()) - before - 1; n != tt.compares {
				t.Errorf("%d comparisons for the pick, want %d", n, tt.compares)
			}
			tabs = f.tabsOf("diff")
			if !maps.Equal(tabs[0].Params, tt.want) {
				t.Errorf("the user's tab = %v, want %v", tabs[0].Params, tt.want)
			}
			if tt.own == nil {
				if len(tabs) != 1 || !out.Existing {
					t.Errorf("diff tabs = %+v (existing %v), want only the user's", tabs, out.Existing)
				}
				return
			}
			if len(tabs) != 2 || !maps.Equal(tabs[1].Params, tt.own) || out.Existing {
				t.Errorf("diff tabs = %+v, want the thread's own with %v", tabs, tt.own)
			}
		})
	}
}

// The pick reads the user's tab before it asks the checkout whether the user's sides list the
// file, and writes it after. A change the user made to the tab while that comparison ran (a
// filter, a file, other sides) is what the pick starts from, never written over with what the tab
// held before.
func TestViewOpenDiffPickKeepsAChangeMadeWhileItCompares(t *testing.T) {
	tests := []struct {
		name     string
		mine     map[string]string // the user's tab before the call
		changed  map[string]string // what the user set while the pick compared
		want     map[string]string // the user's tab after the call
		own      bool              // the file went to a tab of the thread's own
		compares int
	}{
		{name: "a filter set meanwhile stays, the file picked",
			mine:    map[string]string{"project": "r1", "worktree": "/wt", "own": "1", "base": "ref:v1", "path": "b.go"},
			changed: map[string]string{"project": "r1", "worktree": "/wt", "own": "1", "base": "ref:v1", "path": "c.go", "filter": "rs"},
			want:    map[string]string{"project": "r1", "worktree": "/wt", "own": "1", "base": "ref:v1", "path": "a.go", "filter": "rs"}, compares: 2},
		{name: "sides changed meanwhile to ones that do not list it: the user's tab as they left it",
			mine:    map[string]string{"project": "r1", "worktree": "/wt", "own": "1", "base": "ref:v1", "path": "b.go"},
			changed: map[string]string{"project": "r1", "worktree": "/wt", "own": "1", "base": "ref:v2", "path": "c.go"},
			want:    map[string]string{"project": "r1", "worktree": "/wt", "own": "1", "base": "ref:v2", "path": "c.go"}, own: true, compares: 2},
		{name: "sides changed meanwhile to the call's: picked there without asking again",
			mine:    map[string]string{"project": "r1", "worktree": "/wt", "own": "1", "base": "ref:v1", "path": "b.go"},
			changed: map[string]string{"project": "r1", "worktree": "/wt", "own": "1", "path": "c.go", "fold": "1"},
			want:    map[string]string{"project": "r1", "worktree": "/wt", "own": "1", "path": "a.go", "fold": "1"}, compares: 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newOpenFixture(t)
			f.run(t, selfCLI, "view.open.diff", nil)
			tab := f.tabsOf("diff")[0].ID
			set := func(params map[string]string) {
				if _, err := f.store.Apply(context.Background(), &core.SetTabParams{Tab: tab, Params: params}, layoutstore.ApplyOptions{}); err != nil {
					t.Fatal(err)
				}
			}
			set(tt.mine)
			diffs := f.diffs
			diffs.Unlisted = func(base, path string) bool { return base == "v2" && path == "a.go" }
			before := len(diffs.Requests())
			once := false
			diffs.During = func(r *v1.CompareWorktreeRequest) {
				// The pick's comparison names the user's base; the call's own check does not.
				if !once && r.GetBase().GetRef() == "v1" {
					once = true
					set(tt.changed)
				}
			}
			f.run(t, selfCLI, "view.open.diff", map[string]string{"path": "/wt/a.go"})
			if !once {
				t.Fatal("the pick never compared the user's sides")
			}
			if n := len(diffs.Requests()) - before - 1; n != tt.compares {
				t.Errorf("%d comparisons for the pick, want %d", n, tt.compares)
			}
			tabs := f.tabsOf("diff")
			if !maps.Equal(tabs[0].Params, tt.want) {
				t.Errorf("the user's tab = %v, want %v", tabs[0].Params, tt.want)
			}
			if got := len(tabs) == 2; got != tt.own {
				t.Errorf("diff tabs = %+v, want a tab of the thread's own: %v", tabs, tt.own)
			}
		})
	}
}

// A refused item opens no tab and shows nothing in the classic window.
func TestViewOpenRefusedOpensNothing(t *testing.T) {
	f := newOpenFixture(t)
	if _, err := f.reg.Invoke(context.Background(), selfCLI, "view.open.file", map[string]string{"path": "/wt/missing.go"}); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("err = %v, want not found", err)
	}
	if ops := f.store.Ops(); len(ops) != 0 {
		t.Errorf("ops = %v, want none", ops)
	}
	sameIntents(t, f.emit.Intents(), nil)
}

// view.inline --panel also opens the page's tab beside the thread.
func TestViewInlinePanelOpensATab(t *testing.T) {
	f := newOpenFixture(t)
	if _, err := f.reg.Invoke(context.Background(), selfCLI, "view.inline", map[string]string{"path": "/wt/p.html", "panel": "true"}); err != nil {
		t.Fatal(err)
	}
	if tabs := f.tabsOf("file"); len(tabs) != 1 || tabs[0].Params["path"] != "/wt/p.html" || tabs[0].Thread != self {
		t.Errorf("file tabs = %+v, want the page's, linked", tabs)
	}
}

// thread.focus is thread.open --focus in the layout: the thread's space becomes current and its
// tab takes the focus, opened when it is closed. Its FocusThread stays: it is what puts the
// keyboard in the thread's prompt, which the layout does not carry.
func TestThreadFocusOpensItsTab(t *testing.T) {
	f := newOpenFixture(t)
	f.run(t, selfCLI, "space.switch", map[string]string{"space": "sp-two", "focus": "true"})
	res := f.run(t, selfCLI, "thread.focus", map[string]string{"id": self})
	if got := f.focus(); got != "sp-main/p-main/t-a" {
		t.Errorf("focus = %s, want the thread's tab in its space", got)
	}
	if !strings.HasPrefix(res.Message, "thread "+self+" has the focus as tab t-a in pane p-main of space sp-main; windows=1") {
		t.Errorf("message = %q", res.Message)
	}
	intents := f.emit.Intents()
	if len(intents) != 1 || intents[0].GetFocusThread().GetThreadId() != self {
		t.Errorf("intents = %v, want the FocusThread", intents)
	}

	// Closed: it opens (in the focused pane of its space).
	f.run(t, fromCLI, "thread.close", map[string]string{"id": self})
	f.run(t, selfCLI, "thread.focus", map[string]string{"id": self})
	if tabs := f.tabsOf("thread"); len(tabs) != 1 || !strings.HasSuffix(f.focus(), "/"+tabs[0].ID) {
		t.Errorf("thread tabs %+v, focus %s: want its tab open and focused", tabs, f.focus())
	}
}

// ui.focus.terminal focuses the terminal's tab, opening it by the rules when it has none: a
// thread's shell linked to the thread, a project's unlinked; a quick terminal opens under its
// thread, whose tab takes the focus.
func TestFocusTerminalOpensItsTab(t *testing.T) {
	shell := &v1.Terminal{Id: "t-sh1", Labels: termlabel.Shell(self, "r1", "/wt")}
	quick := &v1.Terminal{Id: "t-qk1", Labels: termlabel.QuickShell(self, "r1", "/wt")}
	free := &v1.Terminal{Id: "t-fr1", Labels: termlabel.Free()}

	f := newOpenFixture(t, shell, quick, free)
	f.run(t, fromCLI, "ui.focus.terminal", map[string]string{"id": "t-sh1"})
	tabs := f.tabsOf("terminal")
	if len(tabs) != 1 || tabs[0].Thread != self || tabs[0].Params[core.TerminalParam] != "t-sh1" || !strings.HasSuffix(f.focus(), "/"+tabs[0].ID) {
		t.Fatalf("terminal tabs %+v, focus %s: want t-sh1's, linked to the thread and focused", tabs, f.focus())
	}
	// Again: the same tab.
	f.run(t, fromCLI, "ui.focus.terminal", map[string]string{"id": "t-sh1"})
	if n := len(f.tabsOf("terminal")); n != 1 {
		t.Errorf("%d terminal tabs after a second focus, want 1", n)
	}

	f.run(t, fromCLI, "ui.focus.terminal", map[string]string{"id": "t-fr1"})
	if tabs := f.tabsOf("terminal"); len(tabs) != 2 || tabs[1].Thread != "" {
		t.Errorf("terminal tabs %+v, want the free shell's, unlinked", tabs)
	}

	f.run(t, fromCLI, "ui.focus.terminal", map[string]string{"id": "t-qk1"})
	if ts := f.state().Threads[self]; ts == nil || ts.Quick == nil || !ts.Quick.Open {
		t.Errorf("thread state %+v, want the quick terminal open", ts)
	}
	if got := f.focus(); got != "sp-main/p-main/t-a" {
		t.Errorf("focus = %s, want the thread's tab", got)
	}
	if n := len(f.tabsOf("terminal")); n != 2 {
		t.Errorf("%d terminal tabs, want no tab for the quick terminal", n)
	}
}

// view.pullrequests and view.projects open their page's tab in the current space (one each),
// focusing the one already open; from a thread they leave the focus. No intent goes out.
func TestPageVerbsOpenTheirTab(t *testing.T) {
	f := newOpenFixture(t)
	res := f.run(t, fromCLI, "view.pullrequests", nil)
	prs := f.tabsOf("prs")
	if len(prs) != 2 || !strings.HasSuffix(f.focus(), "/"+prs[0].ID) {
		t.Fatalf("prs tabs %+v, focus %s: want one in Main, focused", prs, f.focus())
	}
	if out, ok := res.JSON.(command.PageTabResult); !ok || out.Space != "sp-main" || out.Existing {
		t.Errorf("JSON = %+v, want a new tab in sp-main", res.JSON)
	}
	if res.Message != "opened prs tab "+prs[0].ID+" in pane p-main of space sp-main; windows=1" {
		t.Errorf("message = %q", res.Message)
	}
	if res := f.run(t, fromCLI, "view.pullrequests", nil); !res.JSON.(command.PageTabResult).Existing || !strings.Contains(res.Message, "is already open") {
		t.Errorf("again: %+v, want the open tab", res)
	}
	f.run(t, fromCLI, "tab.focus", map[string]string{"tab": "t-a"})

	// From a thread (the window shows it, so the page verb may run): no focus.
	res = f.run(t, selfCLI, "view.projects", map[string]string{"project": "r1"})
	projs := f.tabsOf("projects")
	if len(projs) != 1 || projs[0].Params["project"] != "r1" {
		t.Fatalf("projects tabs %+v, want one showing r1", projs)
	}
	if got := f.focus(); got != "sp-main/p-main/t-a" {
		t.Errorf("focus = %s, want the user's, unmoved", got)
	}
	// Plain view.projects shows the index: the open tab leaves the project's page.
	f.run(t, fromCLI, "view.projects", nil)
	if projs := f.tabsOf("projects"); len(projs) != 1 || len(projs[0].Params) != 0 {
		t.Errorf("projects tabs %+v, want the one tab, on the index", projs)
	}
	sameIntents(t, f.emit.Intents(), nil)
}

// view.thread-diff: from the thread's tab, its diff (opened beside it, focused); from that
// diff, back to the thread; again, the same diff tab as it is. A thread's CLI needs --focus.
func TestThreadDiffToggle(t *testing.T) {
	f := newOpenFixture(t)
	res := f.run(t, fromCLI, "view.thread-diff", nil)
	diffs := f.tabsOf("diff")
	if len(diffs) != 1 || diffs[0].Thread != self || diffs[0].Params["worktree"] != "/wt" || !strings.HasSuffix(f.focus(), "/"+diffs[0].ID) {
		t.Fatalf("diff tabs %+v, focus %s: want the thread's own, focused", diffs, f.focus())
	}
	if res.Message != "thread "+self+"'s diff is tab "+diffs[0].ID {
		t.Errorf("message = %q", res.Message)
	}
	f.run(t, fromCLI, "view.thread-diff", nil)
	if got := f.focus(); got != "sp-main/p-main/t-a" {
		t.Errorf("from the diff: focus = %s, want the thread", got)
	}
	// The user picked a file in it; going there again keeps it.
	f.run(t, fromCLI, "tab.focus", map[string]string{"tab": diffs[0].ID})
	f.store.Put(withParam(f.state(), diffs[0].ID, "path", "a.go"))
	f.run(t, fromCLI, "tab.focus", map[string]string{"tab": "t-a"})
	f.run(t, fromCLI, "view.thread-diff", nil)
	if d := f.tabsOf("diff"); len(d) != 1 || d[0].Params["path"] != "a.go" || !strings.HasSuffix(f.focus(), "/"+d[0].ID) {
		t.Errorf("diff tabs %+v, focus %s: want the same tab, its file kept, focused", d, f.focus())
	}

	if _, err := f.reg.Invoke(context.Background(), selfCLI, "view.thread-diff", map[string]string{"tab": "t-a"}); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Errorf("from a thread without --focus: err = %v, want a refusal", err)
	}
	f.run(t, fromCLI, "tab.focus", map[string]string{"tab": "t-prs"})
	if _, err := f.reg.Invoke(context.Background(), fromCLI, "view.thread-diff", nil); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Errorf("from a page: err = %v, want a refusal", err)
	}
}

// withParam is st with tab id's param k set to v.
func withParam(st *core.State, id, k, v string) *core.State {
	st = st.Clone()
	_, _, tb := st.FindTab(id)
	tb.Params[k] = v
	return st
}

// ui.focus.terminal --pane (a pane's "+" menu): a running terminal with no tab gets one in that
// pane, even another space's; one that has a tab is focused where it is.
func TestFocusTerminalInAPane(t *testing.T) {
	free := &v1.Terminal{Id: "t-fr1", Labels: termlabel.Free()}
	f := newOpenFixture(t, free)
	paneOf := func(id string) string {
		for _, sp := range f.state().Spaces {
			for _, p := range core.Panes(sp.Root) {
				for _, tb := range p.Tabs {
					if tb.Kind == "terminal" && tb.Params[core.TerminalParam] == id {
						return p.ID
					}
				}
			}
		}
		return ""
	}
	f.run(t, fromCLI, "ui.focus.terminal", map[string]string{"id": "t-fr1", "pane": "p-two"})
	if got := paneOf("t-fr1"); got != "p-two" {
		t.Fatalf("the free shell's tab is in %q, want p-two", got)
	}
	f.run(t, fromCLI, "ui.focus.terminal", map[string]string{"id": "t-fr1", "pane": "p-main"})
	if got, n := paneOf("t-fr1"), len(f.tabsOf("terminal")); got != "p-two" || n != 1 {
		t.Errorf("after a second call: in %q with %d terminal tabs, want the one tab still in p-two", got, n)
	}
}
