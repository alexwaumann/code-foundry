package layout

import (
	"errors"
	"math/rand/v2"
	"slices"
	"strings"
	"testing"
)

// Threads open as (modes.go). The trees are written with mtab/mpane/msplit and compared as
// bare shapes: "row(p-a[th:a] p-d[t-da])", a thread tab named by its thread, a split by its
// direction, sizes left out.

func mth(id, thread string) *Tab { return &Tab{ID: id, Kind: "thread", Thread: thread} }

func mdiff(id, thread string) *Tab {
	return &Tab{ID: id, Kind: "diff", Thread: thread, Params: map[string]string{"project": "pj", "worktree": "w-" + thread}}
}

func mfile(id string) *Tab {
	return &Tab{ID: id, Kind: "file", Params: map[string]string{"path": "/r/" + id}}
}

func mcompose(id string) *Tab { return &Tab{ID: id, Kind: "compose"} }

func mpane(id string, tabs ...*Tab) *Node {
	return &Node{T: NodePane, ID: id, Tabs: tabs, Active: tabs[0].ID}
}

func msplit(id string, dir Dir, kids ...*Node) *Node {
	sizes := make([]float64, len(kids))
	for i := range kids {
		sizes[i] = 1 / float64(len(kids))
	}
	return &Node{T: NodeSplit, ID: id, Dir: dir, Kids: kids, Sizes: sizes}
}

// mstate is one space "sp-a" with root, focus on pane focus, and mru (tab ids, newest first).
func mstate(t *testing.T, root *Node, focus string, mru ...string) *State {
	t.Helper()
	st := NewState("sp-a", "A")
	st.Spaces[0].Root, st.Spaces[0].Focus, st.Spaces[0].MRU = root, focus, mru
	walk(root, func(n *Node) {
		for _, tb := range n.Tabs {
			_, key, err := Identify(tb)
			if err != nil {
				t.Fatal(err)
			}
			tb.Key = key
		}
	})
	return st
}

// wide is the pane area the tests lay out in unless they name one: three open panes fit.
const wideW, wideH = 2400.0, 1000.0

// bare is a tree's shape without ids of splits, sizes or the active tab.
func bare(n *Node) string {
	if n == nil {
		return "-"
	}
	if n.IsPane() {
		names := make([]string, len(n.Tabs))
		for i, tb := range n.Tabs {
			switch tb.Kind {
			case "thread":
				names[i] = "th:" + tb.Thread
			default:
				names[i] = tb.ID
			}
			if tb.Kind == "compose" {
				names[i] = "compose"
			}
		}
		fold := ""
		if n.Collapsed {
			fold = "~"
		}
		return n.ID + fold + "[" + strings.Join(names, " ") + "]"
	}
	kids := make([]string, len(n.Kids))
	for i, k := range n.Kids {
		kids[i] = bare(k)
	}
	return string(n.Dir) + "(" + strings.Join(kids, " ") + ")"
}

func tabIDs(tabs []*Tab) []string {
	out := make([]string, len(tabs))
	for i, tb := range tabs {
		out[i] = tb.ID
	}
	return out
}

// checkMode fails when st is not in mode's form: a pane holding a thread or a composer holds
// nothing else, and under Single a space has at most one such pane.
func checkMode(t *testing.T, st *State, mode Mode, what string) {
	t.Helper()
	for _, sp := range st.Spaces {
		n := 0
		for _, p := range Panes(sp.Root) {
			if !holdsThread(p) {
				continue
			}
			n++
			if len(p.Tabs) != 1 {
				t.Fatalf("%s: thread pane %s holds %s", what, p.ID, bare(p))
			}
		}
		if mode == ModeSingle && n > 1 {
			t.Fatalf("%s: space %s has %d thread panes: %s", what, sp.ID, n, bare(sp.Root))
		}
	}
}

// The panes base: thread a in p-a, its diff in p-d, thread b closed with its diff remembered
// in p-d (b was in p-a before).
func panesBase(t *testing.T) *State {
	st := mstate(t, msplit("s-r", Row, mpane("p-a", mth("t-a", "a")), mpane("p-d", mdiff("t-da", "a"))), "p-a", "t-a", "t-da")
	st.Threads = map[string]*ThreadState{"b": {Space: "sp-a", Remembered: &Remembered{Pane: "p-a",
		Tabs: []RememberedTab{{Tab: mdiff("t-db", "b"), Pane: "p-d", Index: 1, Active: true, Adjacent: true,
			Beside: &Beside{Neighbours: []string{"p-a"}, Edge: Right, Frac: 0.5}}}}}}
	return st
}

func TestPanesOpenThread(t *testing.T) {
	tests := []struct {
		name   string
		mode   Mode
		state  func(t *testing.T) *State
		op     *OpenThread
		shape  string
		focus  string // the focused pane after
		closed []string
		kept   []string
		rule   string
		err    error
	}{
		{
			name: "replaces the focused thread pane's thread; its linked tab is remembered and the new one's comes back",
			mode: ModePanes, state: panesBase, op: &OpenThread{Thread: "b", Focus: true},
			shape: "row(p-a[th:b] p-d[t-db])", focus: "p-a", closed: []string{"t-a"}, kept: []string{"t-da"}, rule: "replace",
		},
		{
			name: "single replaces the same way",
			mode: ModeSingle, state: panesBase, op: &OpenThread{Thread: "b", Focus: true},
			shape: "row(p-a[th:b] p-d[t-db])", focus: "p-a", closed: []string{"t-a"}, kept: []string{"t-da"}, rule: "replace",
		},
		{
			name: "focus on a pane of other tabs: the most recently focused thread pane is the target",
			mode: ModePanes,
			state: func(t *testing.T) *State {
				return mstate(t, msplit("s-r", Row, mpane("p-a", mth("t-a", "a")), mpane("p-c", mth("t-c", "c")), mpane("p-f", mfile("t-f"))),
					"p-f", "t-f", "t-c", "t-a")
			},
			op: &OpenThread{Thread: "b", Focus: true}, shape: "row(p-a[th:a] p-c[th:b] p-f[t-f])", focus: "p-c", closed: []string{"t-c"}, rule: "replace",
		},
		{
			name: "no thread pane: a new pane on the left of the pane area",
			mode: ModePanes,
			state: func(t *testing.T) *State {
				return mstate(t, mpane("p-f", mfile("t-f")), "p-f", "t-f")
			},
			op: &OpenThread{Thread: "b", Focus: true}, shape: "row(p-n1[th:b] p-f[t-f])", focus: "p-n1", rule: "new",
		},
		{
			name: "an empty space: its first pane",
			mode: ModeSingle,
			state: func(t *testing.T) *State {
				return mstate(t, nil, "")
			},
			op: &OpenThread{Thread: "b", Focus: true}, shape: "p-n1[th:b]", focus: "p-n1", rule: "new",
		},
		{
			name: "the space's ephemeral composer is the thread pane's content: replaced",
			mode: ModePanes,
			state: func(t *testing.T) *State {
				return mstate(t, mpane("p-c", mcompose("t-c")), "p-c", "t-c")
			},
			op: &OpenThread{Thread: "b", Focus: true}, shape: "p-c[th:b]", focus: "p-c", closed: []string{"t-c"},
		},
		{
			name: "a thread already open is focused where it is, not duplicated",
			mode: ModePanes,
			state: func(t *testing.T) *State {
				return mstate(t, msplit("s-r", Row, mpane("p-a", mth("t-a", "a")), mpane("p-b", mth("t-b", "b"))), "p-a", "t-a", "t-b")
			},
			op: &OpenThread{Thread: "b", Focus: true}, shape: "row(p-a[th:a] p-b[th:b])", focus: "p-b", rule: "1",
		},
		{
			name: "a drop on a thread pane's middle or strip replaces its thread",
			mode: ModePanes,
			state: func(t *testing.T) *State {
				return mstate(t, msplit("s-r", Row, mpane("p-a", mth("t-a", "a")), mpane("p-b", mth("t-b", "b"))), "p-a", "t-a", "t-b")
			},
			op: &OpenThread{Thread: "c", Pane: "p-b", Focus: true}, shape: "row(p-a[th:a] p-b[th:c])", focus: "p-b", closed: []string{"t-b"}, rule: "replace",
		},
		{
			name: "a drop on a pane of other tabs opens a thread pane on its left",
			mode: ModePanes, state: panesBase, op: &OpenThread{Thread: "c", Pane: "p-d", Focus: true},
			shape: "row(p-a[th:a] p-n1[th:c] p-d[t-da])", focus: "p-n1", rule: "edge",
		},
		{
			name: "single: a drop on a pane of other tabs replaces the space's thread pane",
			mode: ModeSingle, state: panesBase, op: &OpenThread{Thread: "c", Pane: "p-d", Focus: true},
			shape: "p-a[th:c]", focus: "p-a", closed: []string{"t-a"}, kept: []string{"t-da"}, rule: "replace",
		},
		{
			name: "an edge of a pane makes a second thread pane",
			mode: ModePanes, state: panesBase, op: &OpenThread{Thread: "c", Pane: "p-a", Edge: Bottom, Focus: true},
			shape: "row(col(p-a[th:a] p-n1[th:c]) p-d[t-da])", focus: "p-n1", rule: "edge",
		},
		{
			name: "an outer edge makes a second thread pane",
			mode: ModePanes, state: panesBase, op: &OpenThread{Thread: "c", Edge: Left, Focus: true},
			shape: "row(p-n1[th:c] p-a[th:a] p-d[t-da])", focus: "p-n1", rule: "edge",
		},
		{
			name: "single: an edge replaces",
			mode: ModeSingle, state: panesBase, op: &OpenThread{Thread: "c", Pane: "p-a", Edge: Bottom, Focus: true},
			shape: "p-a[th:c]", focus: "p-a", closed: []string{"t-a"}, kept: []string{"t-da"}, rule: "replace",
		},
		{
			name: "beside a pane: a new pane on its right",
			mode: ModePanes, state: panesBase, op: &OpenThread{Thread: "c", Beside: "p-a", Focus: true},
			shape: "row(p-a[th:a] p-n1[th:c] p-d[t-da])", focus: "p-n1", rule: "edge",
		},
		{
			name: "beside a thread: a new pane on the right of its pane",
			mode: ModePanes, state: panesBase, op: &OpenThread{Thread: "c", Beside: "a", Focus: true},
			shape: "row(p-a[th:a] p-n1[th:c] p-d[t-da])", focus: "p-n1", rule: "edge",
		},
		{
			name: "beside under tabs: a new pane on its right too",
			mode: ModeTabs, state: panesBase, op: &OpenThread{Thread: "c", Beside: "a", Focus: true},
			shape: "row(p-a[th:a] p-n1[th:c] p-d[t-da])", focus: "p-n1", rule: "edge",
		},
		{
			name: "single refuses beside",
			mode: ModeSingle, state: panesBase, op: &OpenThread{Thread: "c", Beside: "p-a", Focus: true}, err: ErrFailedPrecondition,
		},
		{
			name: "beside nothing open in the space",
			mode: ModePanes, state: panesBase, op: &OpenThread{Thread: "c", Beside: "zz", Focus: true}, err: ErrNotFound,
		},
		{
			name: "a child opened from its parent opens beside the parent's pane",
			mode: ModePanes, state: panesBase, op: &OpenThread{Thread: "c", Parent: "a", Focus: true},
			shape: "row(p-a[th:a] p-n1[th:c] p-d[t-da])", focus: "p-n1", rule: "edge",
		},
		{
			name: "single: a child replaces its parent (Back returns to it)",
			mode: ModeSingle, state: panesBase, op: &OpenThread{Thread: "c", Parent: "a", Focus: true},
			shape: "p-a[th:c]", focus: "p-a", closed: []string{"t-a"}, kept: []string{"t-da"}, rule: "replace",
		},
		{
			name: "a parent that is not open: the child replaces as any open",
			mode: ModePanes, state: panesBase, op: &OpenThread{Thread: "c", Parent: "zz", Focus: true},
			shape: "p-a[th:c]", focus: "p-a", closed: []string{"t-a"}, kept: []string{"t-da"}, rule: "replace",
		},
		{
			name: "tabs: the parent is not read",
			mode: ModeTabs, state: panesBase, op: &OpenThread{Thread: "c", Parent: "a", Focus: true},
			shape: "row(p-a[th:a th:c] p-d[t-da])", focus: "p-a",
		},
		{
			name: "no room for a new thread pane: it opens folded",
			mode: ModePanes,
			state: func(t *testing.T) *State {
				return mstate(t, msplit("s-r", Row, mpane("p-a", mth("t-a", "a")), mpane("p-f", mfile("t-f"))), "p-a", "t-a")
			},
			op:    &OpenThread{Thread: "c", Beside: "a", Focus: true, W: 1000, H: 800},
			shape: "row(p-a[th:a] p-n1~[th:c] p-f[t-f])", focus: "p-n1", rule: "edge",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			st := tt.state(t)
			if tt.op.W == 0 {
				tt.op.W, tt.op.H = wideW, wideH
			}
			next, res, err := ApplyWith(st, tt.op, &SeqIDs{}, Options{Mode: tt.mode})
			if tt.err != nil {
				if !errors.Is(err, tt.err) {
					t.Fatalf("err %v, want %v", err, tt.err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			sp := next.Spaces[0]
			if got := bare(sp.Root); got != tt.shape {
				t.Errorf("shape %s, want %s", got, tt.shape)
			}
			if sp.Focus != tt.focus {
				t.Errorf("focus %s, want %s", sp.Focus, tt.focus)
			}
			if got := tabIDs(res.Closed); !slices.Equal(got, tt.closed) && !(len(got) == 0 && len(tt.closed) == 0) {
				t.Errorf("closed %v, want %v", got, tt.closed)
			}
			if got := tabIDs(res.Kept); !slices.Equal(got, tt.kept) && !(len(got) == 0 && len(tt.kept) == 0) {
				t.Errorf("kept %v, want %v", got, tt.kept)
			}
			if tt.rule != "" && res.Rule != tt.rule {
				t.Errorf("rule %q, want %q", res.Rule, tt.rule)
			}
			if tt.mode.Panes() {
				checkMode(t, next, tt.mode, tt.name)
			}
		})
	}
}

// Replacing goes both ways: a thread's linked tabs leave with it and come back with it, into
// the panes they were in, and its terminals keep running (Kept, not Ended).
func TestPanesReplaceRoundTrip(t *testing.T) {
	term := &Tab{ID: "t-ta", Kind: "terminal", Thread: "a", Params: map[string]string{"terminal": "term-a"}}
	st := mstate(t, msplit("s-r", Row, mpane("p-a", mth("t-a", "a")), mpane("p-d", mdiff("t-da", "a"), term)), "p-a", "t-a")
	opts := Options{Mode: ModePanes}
	b, res, err := ApplyWith(st, &OpenThread{Thread: "b", Focus: true}, &SeqIDs{}, opts)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Ended) != 0 || !slices.Equal(tabIDs(res.Kept), []string{"t-da", "t-ta"}) {
		t.Fatalf("kept %v ended %v", tabIDs(res.Kept), tabIDs(res.Ended))
	}
	if got := bare(b.Spaces[0].Root); got != "p-a[th:b]" {
		t.Fatalf("after b: %s", got)
	}
	a, res, err := ApplyWith(b, &OpenThread{Thread: "a", Focus: true}, &SeqIDs{}, opts)
	if err != nil {
		t.Fatal(err)
	}
	if got := bare(a.Spaces[0].Root); got != "row(p-a[th:a] p-d[t-da t-ta])" {
		t.Errorf("a again: %s", got)
	}
	if !slices.Equal(res.Back, []string{"t-da", "t-ta"}) {
		t.Errorf("back %v", res.Back)
	}
}

// Smart swap is forced on under Panes and Single, whatever the stored setting (NoSmartSwap)
// says; under Tabs the setting holds.
func TestPanesForceSmartSwap(t *testing.T) {
	st := mstate(t, msplit("s-r", Row, mpane("p-a", mth("t-a", "a")), mpane("p-b", mth("t-b", "b")), mpane("p-d", mdiff("t-da", "a"), mdiff("t-db", "b"))), "p-a", "t-a")
	for _, tt := range []struct {
		mode Mode
		want []string
	}{{ModeTabs, nil}, {ModePanes, []string{"p-d"}}, {ModeSingle, []string{"p-d"}}} {
		in := st
		if tt.mode == ModeSingle {
			// Single shows one thread pane: b opens in a's place, beside a dormant diff of c.
			in = mstate(t, msplit("s-r", Row, mpane("p-a", mth("t-a", "a")), mpane("p-d", mdiff("t-dc", "c"), mdiff("t-db", "b"))), "p-a", "t-a")
		}
		var op Op = &FocusTab{Tab: "t-b"}
		if tt.mode == ModeSingle {
			op = &OpenThread{Thread: "b", Focus: true, W: wideW, H: wideH}
		}
		_, res, err := ApplyWith(in, op, &SeqIDs{}, Options{Mode: tt.mode, NoSmartSwap: true})
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(res.Swapped, tt.want) {
			t.Errorf("%s: swapped %v, want %v", tt.mode, res.Swapped, tt.want)
		}
	}
}

// A composer is a thread pane's content while it is written: New thread and a draft's row
// replace the target thread pane's thread with it, and sending turns it into the thread in
// place.
func TestPanesComposer(t *testing.T) {
	draft := &Tab{ID: "t-dr", Kind: "compose", Params: map[string]string{DraftParam: "d-1"}}
	base := func(t *testing.T) *State {
		st := mstate(t, msplit("s-r", Row, mpane("p-a", mth("t-a", "a")), mpane("p-f", mfile("t-f"), mdiff("t-da", "a"))), "p-f", "t-f", "t-a")
		st.Spaces[0].Drafts = []*Draft{{ID: "d-1", Label: "x"}}
		return st
	}
	tests := []struct {
		name  string
		mode  Mode
		state func(t *testing.T) *State
		op    Op
		shape string
	}{
		{"new thread replaces the target thread pane's thread", ModePanes, base, &NewThread{Focus: true}, "row(p-a[compose] p-f[t-f])"},
		{"single too", ModeSingle, base, &NewThread{Focus: true}, "row(p-a[compose] p-f[t-f])"},
		{"a pane's + on a pane of other tabs: a thread pane on its left", ModePanes, base, &NewThread{Pane: "p-f", Focus: true},
			"row(p-a[th:a] p-n1[compose] p-f[t-f t-da])"},
		{"a draft's row replaces too", ModePanes, base, &OpenDraft{Draft: "d-1", Focus: true}, "row(p-a[compose] p-f[t-f])"},
		{"tabs: as before", ModeTabs, base, &NewThread{Focus: true}, "row(p-a[th:a compose] p-f[t-f t-da])"},
		{"sending turns it into the thread in place", ModePanes, func(t *testing.T) *State {
			st := mstate(t, msplit("s-r", Row, mpane("p-c", draft), mpane("p-f", mfile("t-f"))), "p-c", "t-dr")
			st.Spaces[0].Drafts = []*Draft{{ID: "d-1"}}
			return st
		}, &OpenThread{Thread: "n", Compose: "t-dr", Focus: true}, "row(p-c[th:n] p-f[t-f])"},
		{"replacing a draft's tab keeps the draft listed", ModePanes, func(t *testing.T) *State {
			st := mstate(t, mpane("p-c", draft), "p-c", "t-dr")
			st.Spaces[0].Drafts = []*Draft{{ID: "d-1"}}
			return st
		}, &OpenThread{Thread: "b", Focus: true}, "p-c[th:b]"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			WithArea(tt.op, wideW, wideH)
			next, _, err := ApplyWith(tt.state(t), tt.op, &SeqIDs{}, Options{Mode: tt.mode})
			if err != nil {
				t.Fatal(err)
			}
			if got := bare(next.Spaces[0].Root); got != tt.shape {
				t.Errorf("shape %s, want %s", got, tt.shape)
			}
			if tt.mode.Panes() {
				checkMode(t, next, tt.mode, tt.name)
			}
			if strings.HasPrefix(tt.name, "replacing a draft") && len(next.Spaces[0].Drafts) != 1 {
				t.Errorf("drafts %v", next.Spaces[0].Drafts)
			}
		})
	}
}

// Under Panes no other tab joins a thread's pane: the placement rules pass those panes over
// and, where a rule would put a tab there, it goes to the most recently focused pane of other
// tabs or a new pane on the right (folded without room).
func TestPanesSurfacesStayOut(t *testing.T) {
	alone := func(t *testing.T) *State { return mstate(t, mpane("p-a", mth("t-a", "a")), "p-a", "t-a") }
	withPrs := func(t *testing.T) *State {
		return mstate(t, msplit("s-r", Row, mpane("p-a", mth("t-a", "a")), mpane("p-p", &Tab{ID: "t-p", Kind: "prs"})), "p-a", "t-a", "t-p")
	}
	tests := []struct {
		name  string
		state func(t *testing.T) *State
		op    Op
		shape string
		fold  bool
	}{
		{"a linked surface: rule 5, a new pane on the right", alone, &OpenSurface{Tab: mdiff("", "a"), Focus: true}, "row(p-a[th:a] p-n1[t-n1])", false},
		{"no room: a folded pane on the right instead of the thread's own pane", alone,
			&OpenSurface{Tab: mdiff("", "a"), Focus: true, W: 600, H: 800}, "row(p-a[th:a] p-n1~[t-n1])", true},
		{"a page from a focused thread pane: the pane of other tabs", withPrs, &OpenSurface{Tab: mfile(""), Focus: true}, "row(p-a[th:a] p-p[t-p t-n1])", false},
		{"a pane's + on a thread pane: placed by the rules", withPrs, &OpenSurface{Pane: "p-a", Tab: mfile(""), Focus: true}, "row(p-a[th:a] p-p[t-p t-n1])", false},
		{"add_tab to a thread pane goes elsewhere", alone, &AddTab{Pane: "p-a", Tab: mfile(""), Focus: true}, "row(p-a[th:a] p-n1[t-n1])", false},
		{"a tab dragged into a thread pane moves out to its right", withPrs, &MoveTab{Tab: "t-p", Pane: "p-a"}, "row(p-a[th:a] p-n1[t-p])", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			next, res, err := ApplyWith(tt.state(t), tt.op, &SeqIDs{}, Options{Mode: ModePanes})
			if err != nil {
				t.Fatal(err)
			}
			if got := bare(next.Spaces[0].Root); got != tt.shape {
				t.Errorf("shape %s, want %s", got, tt.shape)
			}
			if res.Collapsed != tt.fold {
				t.Errorf("collapsed %v, want %v", res.Collapsed, tt.fold)
			}
			checkMode(t, next, ModePanes, tt.name)
		})
	}
}

// Dragging a thread's tab: onto a thread pane it replaces that pane's thread; into a pane of
// other tabs it opens in its own pane on that pane's left.
func TestPanesThreadTabDrops(t *testing.T) {
	base := func(t *testing.T) *State {
		return mstate(t, msplit("s-r", Row, mpane("p-a", mth("t-a", "a")), mpane("p-b", mth("t-b", "b")), mpane("p-f", mfile("t-f"))), "p-a", "t-a", "t-b")
	}
	tests := []struct {
		name   string
		mode   Mode
		op     Op
		shape  string
		closed []string
	}{
		{"onto a thread pane's strip: replaces", ModePanes, &MoveTab{Tab: "t-a", Pane: "p-b"}, "row(p-b[th:a] p-f[t-f])", []string{"t-b"}},
		{"into a pane of other tabs: a thread pane on its left", ModePanes, &MoveTab{Tab: "t-a", Pane: "p-f"}, "row(p-b[th:b] p-n1[th:a] p-f[t-f])", nil},
		{"onto an edge: a second thread pane", ModePanes, &MoveTab{Tab: "t-a", Pane: "p-f", Edge: Bottom}, "row(p-b[th:b] col(p-f[t-f] p-n1[th:a]))", nil},
		{"a pane merged into a thread pane: replaces", ModePanes, &MergePane{Pane: "p-a", Target: "p-b"}, "row(p-b[th:a] p-f[t-f])", []string{"t-b"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			WithArea(tt.op, wideW, wideH)
			next, res, err := ApplyWith(base(t), tt.op, &SeqIDs{}, Options{Mode: tt.mode})
			if err != nil {
				t.Fatal(err)
			}
			if got := bare(next.Spaces[0].Root); got != tt.shape {
				t.Errorf("shape %s, want %s", got, tt.shape)
			}
			var threads []string
			for _, tb := range res.Closed {
				threads = append(threads, tb.ID)
			}
			if !slices.Equal(threads, tt.closed) {
				t.Errorf("closed %v, want %v", threads, tt.closed)
			}
			checkMode(t, next, tt.mode, tt.name)
		})
	}
}

// Reopen closed tab restores a closed thread by replacing, as an open does.
func TestPanesReopenReplaces(t *testing.T) {
	for _, mode := range []Mode{ModePanes, ModeSingle} {
		t.Run(string(mode), func(t *testing.T) {
			opts := Options{Mode: mode}
			st := mstate(t, msplit("s-r", Row, mpane("p-a", mth("t-a", "a")), mpane("p-f", mfile("t-f"))), "p-a", "t-a")
			closed, _, err := ApplyWith(st, &CloseThread{Thread: "a", Record: true}, &SeqIDs{}, opts)
			if err != nil {
				t.Fatal(err)
			}
			b, _, err := ApplyWith(closed, &OpenThread{Thread: "b", Focus: true}, &SeqIDs{}, opts)
			if err != nil {
				t.Fatal(err)
			}
			if got := bare(b.Spaces[0].Root); got != "row(p-n1[th:b] p-f[t-f])" {
				t.Fatalf("b: %s", got)
			}
			back, res, err := ApplyWith(b, &ReopenClosed{}, &SeqIDs{}, opts)
			if err != nil {
				t.Fatal(err)
			}
			if got := bare(back.Spaces[0].Root); got != "row(p-n1[th:a] p-f[t-f])" {
				t.Errorf("reopened: %s", got)
			}
			if !slices.ContainsFunc(res.Closed, func(tb *Tab) bool { return tb.Thread == "b" }) {
				t.Errorf("closed %v: b was not replaced", tabIDs(res.Closed))
			}
		})
	}
}

// Moving a thread to another space opens it there as an open does: in place of the thread
// of that space's thread pane.
func TestPanesMoveThread(t *testing.T) {
	st := mstate(t, mpane("p-a", mth("t-a", "a")), "p-a", "t-a")
	st.Spaces = append(st.Spaces, &Space{ID: "sp-b", Name: "B", Root: mpane("p-b", mth("t-b", "b")), Focus: "p-b"})
	st.Spaces[1].Root.Tabs[0].Key = "thread:b"
	st.Threads = map[string]*ThreadState{"b": {Space: "sp-b"}}
	next, res, err := ApplyWith(st, &MoveThreadToSpace{Thread: "a", Space: "sp-b"}, &SeqIDs{}, Options{Mode: ModePanes})
	if err != nil {
		t.Fatal(err)
	}
	if got := bare(next.Space("sp-b").Root); got != "p-b[th:a]" {
		t.Errorf("sp-b: %s", got)
	}
	if !slices.Equal(tabIDs(res.Closed), []string{"t-b"}) {
		t.Errorf("closed %v", tabIDs(res.Closed))
	}
}

// The conversions: tabs to panes and panes to single, with their counts, which
// ConformPreview reports without changing anything; toward tabs nothing changes.
func TestConformConversions(t *testing.T) {
	tabsLayout := func(t *testing.T) *State {
		st := mstate(t, msplit("s-r", Row,
			mpane("p-a", mth("t-a", "a"), mth("t-b", "b"), mfile("t-f")),
			mpane("p-c", mth("t-c", "c")),
			mpane("p-d", mdiff("t-da", "a"), mdiff("t-db", "b"))), "p-a", "t-b", "t-c", "t-a")
		st.Spaces[0].Root.Kids[0].Active = "t-b"
		two := &Space{ID: "sp-b", Name: "B", Root: mpane("p-x", mth("t-x", "x"), mcompose("t-cx")), Focus: "p-x", MRU: []string{"t-x"}}
		for _, tb := range two.Root.Tabs {
			_, tb.Key, _ = Identify(tb)
		}
		st.Spaces = append(st.Spaces, two)
		st.Threads = map[string]*ThreadState{"x": {Space: "sp-b"}}
		return st
	}
	tests := []struct {
		name   string
		mode   Mode
		state  func(t *testing.T) *State
		want   Conformed
		shapes []string
	}{
		{"tabs to panes", ModePanes, tabsLayout, Conformed{ThreadTabs: 1, Composers: 1, Moved: 1, Spaces: 2},
			[]string{"row(p-a[th:b] p-n1[t-f] p-c[th:c] p-d[t-db])", "p-x[th:x]"}},
		{"tabs to single", ModeSingle, tabsLayout, Conformed{ThreadTabs: 2, Composers: 1, Moved: 1, Panes: 1, Spaces: 2},
			[]string{"row(p-a[th:b] p-n1[t-f] p-d[t-db])", "p-x[th:x]"}},
		{"panes to single keeps the thread pane focused most recently", ModeSingle, func(t *testing.T) *State {
			return mstate(t, msplit("s-r", Row, mpane("p-a", mth("t-a", "a")), mpane("p-c", mth("t-c", "c")), mpane("p-f", mfile("t-f"))), "p-f", "t-f", "t-c", "t-a")
		}, Conformed{ThreadTabs: 1, Panes: 1, Spaces: 1}, []string{"row(p-c[th:c] p-f[t-f])"}},
		{"toward tabs nothing changes", ModeTabs, tabsLayout, Conformed{},
			[]string{"row(p-a[th:a th:b t-f] p-c[th:c] p-d[t-da t-db])", "p-x[th:x compose]"}},
		{"a layout in form already", ModePanes, panesBase, Conformed{}, []string{"row(p-a[th:a] p-d[t-da])"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			st := tt.state(t)
			before, _ := Encode(st)
			got, err := ConformPreview(st, tt.mode, DefaultW, DefaultH)
			if err != nil {
				t.Fatal(err)
			}
			if after, _ := Encode(st); string(after) != string(before) {
				t.Fatal("the preview changed the state")
			}
			if got != tt.want {
				t.Errorf("preview %+v, want %+v", got, tt.want)
			}
			next, res, err := ApplyWith(st, &Conform{}, &SeqIDs{}, Options{Mode: tt.mode})
			if err != nil {
				t.Fatal(err)
			}
			var conformed Conformed
			if res.Conformed != nil {
				conformed = *res.Conformed
			}
			if conformed != tt.want {
				t.Errorf("conformed %+v, want %+v", conformed, tt.want)
			}
			for i, want := range tt.shapes {
				if got := bare(next.Spaces[i].Root); got != want {
					t.Errorf("space %d: %s, want %s", i, got, want)
				}
			}
			if tt.mode.Panes() {
				checkMode(t, next, tt.mode, tt.name)
				// Nothing is deleted: each closed thread's linked tabs are remembered.
				for _, tb := range res.Closed {
					if tb.Kind != "thread" {
						continue
					}
					for _, k := range res.Kept {
						if k.Thread == tb.Thread && next.Threads[tb.Thread].Remembered == nil {
							t.Errorf("thread %s's linked tabs were not remembered", tb.Thread)
						}
					}
				}
			}
		})
	}
}

// Every op under Panes and Single leaves the layout in the mode's form, in normal form.
func TestModeOpSequences(t *testing.T) {
	for _, mode := range []Mode{ModePanes, ModeSingle} {
		t.Run(string(mode), func(t *testing.T) {
			r := rand.New(rand.NewPCG(13, uint64(len(mode))))
			for range 200 {
				data := make([]byte, 240)
				for i := range data {
					data[i] = byte(r.UintN(256))
				}
				st, _, err := Decode([]byte(seedState), &SeqIDs{})
				if err != nil {
					t.Fatal(err)
				}
				ids := &SeqIDs{}
				if st, _, err = ApplyWith(st, &Conform{}, ids, Options{Mode: mode}); err != nil {
					t.Fatal(err)
				}
				checkMode(t, st, mode, "seed")
				s := &bytesrc{b: data}
				for step := 0; step < 60 && !s.done(); step++ {
					op := randomOp(s, st)
					if s.n(8) == 0 {
						_, panes, _, _ := stateIDs(st)
						op = &NewThread{Beside: pick(s, append(panes, "th-1", "th-2")...), Focus: s.n(2) == 0}
					}
					if o, ok := op.(*OpenThread); ok {
						_, panes, _, _ := stateIDs(st)
						switch s.n(4) {
						case 0:
							o.Beside, o.Pane, o.Edge, o.Index, o.Compose, o.Preview = pick(s, append(panes, "th-1", "th-2")...), "", "", nil, "", false
						case 1:
							o.Parent = pick(s, "th-1", "th-2", "th-3")
						case 2:
							o.Edge = pick(s, Left, Right, Bottom)
						}
					}
					opts := Options{Mode: mode, NoSmartSwap: s.n(2) == 0, KeepFocus: s.n(3) == 0, W: DefaultW, H: DefaultH}
					next, _, err := ApplyWith(st, op, ids, opts)
					opJSON, _ := EncodeOp(op)
					if err != nil {
						if errors.Is(err, ErrBroken) {
							t.Fatalf("step %d %s: %v", step, opJSON, err)
						}
						continue
					}
					checkMode(t, next, mode, "step "+string(opJSON))
					st = next
				}
			}
		})
	}
}

// A thread's model opening a thread keeps the user's focus (Options.KeepFocus): under Panes it
// still replaces the target thread pane's thread, and the focus stays on that pane.
func TestPanesOpenKeepsFocus(t *testing.T) {
	st := mstate(t, msplit("s-r", Row, mpane("p-a", mth("t-a", "a")), mpane("p-f", mfile("t-f"))), "p-f", "t-f", "t-a")
	next, _, err := ApplyWith(st, &OpenThread{Thread: "b", W: wideW, H: wideH}, &SeqIDs{}, Options{Mode: ModePanes, KeepFocus: true})
	if err != nil {
		t.Fatal(err)
	}
	if got := bare(next.Spaces[0].Root); got != "row(p-a[th:b] p-f[t-f])" {
		t.Errorf("shape %s", got)
	}
	if sp := next.Spaces[0]; sp.Focus != "p-f" || focusedTab(sp) != "t-f" {
		t.Errorf("focus %s/%s, want p-f/t-f", sp.Focus, focusedTab(sp))
	}
}

// New thread beside (new_thread with Beside, a thread pane's "+" under Panes): a composer in a
// new pane on the right of the pane, which keeps its thread; the space's empty composer moves
// there when open elsewhere; folded without room; refused under Single as open_thread's beside.
func TestNewThreadBeside(t *testing.T) {
	twoThreads := func(t *testing.T) *State {
		return mstate(t, msplit("s-r", Row, mpane("p-a", mth("t-a", "a")), mpane("p-b", mth("t-b", "b")), mpane("p-f", mfile("t-f"))), "p-a", "t-a")
	}
	composerRight := func(t *testing.T) *State {
		return mstate(t, msplit("s-r", Row, mpane("p-a", mth("t-a", "a")), mpane("p-c", mcompose("t-c")), mpane("p-f", mfile("t-f"))), "p-a", "t-a")
	}
	tests := []struct {
		name     string
		mode     Mode
		state    func(t *testing.T) *State
		op       *NewThread
		shape    string
		focus    string
		existing bool
		folded   bool
		err      error
	}{
		{
			name: "panes: a composer in a new pane on the pane's right, its thread kept",
			mode: ModePanes, state: twoThreads, op: &NewThread{Beside: "p-a", Focus: true},
			shape: "row(p-a[th:a] p-n1[compose] p-b[th:b] p-f[t-f])", focus: "p-n1",
		},
		{
			name: "beside a thread names its pane",
			mode: ModePanes, state: twoThreads, op: &NewThread{Beside: "b", Focus: true},
			shape: "row(p-a[th:a] p-b[th:b] p-n1[compose] p-f[t-f])", focus: "p-n1",
		},
		{
			name: "the space's empty composer open elsewhere moves there, its pane closing",
			mode: ModePanes, state: composerRight, op: &NewThread{Beside: "p-f", Focus: true},
			shape: "row(p-a[th:a] p-f[t-f] p-n1[compose])", focus: "p-n1",
		},
		{
			name: "beside the empty composer's own pane: it is focused where it is",
			mode: ModePanes, state: composerRight, op: &NewThread{Beside: "p-c", Focus: true},
			shape: "row(p-a[th:a] p-c[compose] p-f[t-f])", focus: "p-c", existing: true,
		},
		{
			name: "tabs: a new pane on its right too",
			mode: ModeTabs, state: twoThreads, op: &NewThread{Beside: "p-a", Focus: true},
			shape: "row(p-a[th:a] p-n1[compose] p-b[th:b] p-f[t-f])", focus: "p-n1",
		},
		{
			name: "no room: it opens folded",
			mode: ModePanes,
			state: func(t *testing.T) *State {
				return mstate(t, msplit("s-r", Row, mpane("p-a", mth("t-a", "a")), mpane("p-f", mfile("t-f"))), "p-a", "t-a")
			},
			op:    &NewThread{Beside: "p-a", Focus: true, W: 1000, H: 800},
			shape: "row(p-a[th:a] p-n1~[compose] p-f[t-f])", focus: "p-n1", folded: true,
		},
		{
			name: "single refuses beside",
			mode: ModeSingle, state: twoThreads, op: &NewThread{Beside: "p-a", Focus: true}, err: ErrFailedPrecondition,
		},
		{
			name: "beside is a place of its own: no pane",
			mode: ModePanes, state: twoThreads, op: &NewThread{Beside: "p-a", Pane: "p-b", Focus: true}, err: ErrInvalidArgument,
		},
		{
			name: "beside nothing open in the space",
			mode: ModePanes, state: twoThreads, op: &NewThread{Beside: "zz", Focus: true}, err: ErrNotFound,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.op.W == 0 {
				tt.op.W, tt.op.H = wideW, wideH
			}
			next, res, err := ApplyWith(tt.state(t), tt.op, &SeqIDs{}, Options{Mode: tt.mode})
			if tt.err != nil {
				if !errors.Is(err, tt.err) {
					t.Fatalf("err %v, want %v", err, tt.err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			sp := next.Spaces[0]
			if got := bare(sp.Root); got != tt.shape {
				t.Errorf("shape %s, want %s", got, tt.shape)
			}
			if sp.Focus != tt.focus {
				t.Errorf("focus %s, want %s", sp.Focus, tt.focus)
			}
			if res.Existing != tt.existing || res.Collapsed != tt.folded {
				t.Errorf("existing %v collapsed %v, want %v %v", res.Existing, res.Collapsed, tt.existing, tt.folded)
			}
			if tt.mode.Panes() {
				checkMode(t, next, tt.mode, tt.name)
			}
		})
	}
}
