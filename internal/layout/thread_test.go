package layout

import (
	"fmt"
	"math"
	"math/rand/v2"
	"slices"
	"strings"
	"testing"
)

// layoutShape is a space's tree as text: each pane with its tabs, each split with its sizes rounded
// to 1e-9, in layout order. A thread tab is named by its thread (reopening gives it a new id).
// Two trees with one shape are the same layout.
func layoutShape(n *Node) string {
	if n == nil {
		return "-"
	}
	if n.IsPane() {
		name := func(tb *Tab) string {
			if tb.Kind == "thread" {
				return "thread:" + tb.Thread
			}
			return tb.ID
		}
		ids := make([]string, len(n.Tabs))
		for i, tb := range n.Tabs {
			ids[i] = name(tb)
		}
		return n.ID + "[" + strings.Join(ids, " ") + "]*" + name(n.ActiveTab())
	}
	kids := make([]string, len(n.Kids))
	for i, k := range n.Kids {
		kids[i] = fmt.Sprintf("%s:%.9f", layoutShape(k), n.Sizes[i])
	}
	return string(n.Dir) + "(" + strings.Join(kids, ", ") + ")"
}

// roundTrip closes thread th and opens it again in pane, with focus, and returns the state.
func roundTrip(t *testing.T, st *State, th, pane string, w, h float64) *State {
	t.Helper()
	closed, _, err := Apply(st, &CloseThread{Thread: th, W: w, H: h}, &SeqIDs{})
	if err != nil {
		t.Fatalf("close: %v", err)
	}
	opened, _, err := Apply(closed, &OpenThread{Thread: th, Pane: pane, Focus: true, W: w, H: h}, &SeqIDs{})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	return opened
}

// TestCloseOpenRoundTrip: a thread closed and opened again in the pane it was in brings every
// linked tab back to its old pane, index and active state, and a pane that went away comes
// back beside its old neighbours at its old share. The thread's tab is the last and active tab
// of its pane, so it lands where it was too.
func TestCloseOpenRoundTrip(t *testing.T) {
	thread := func(id string) *Tab { return &Tab{ID: id, Kind: "thread", Thread: "th-a"} }
	diff := func(id, wt string) *Tab {
		return &Tab{ID: id, Kind: "diff", Thread: "th-a", Params: map[string]string{"project": "pj", "worktree": wt}}
	}
	term := func(id string) *Tab {
		return &Tab{ID: id, Kind: "terminal", Thread: "th-a", Params: map[string]string{"terminal": "term-" + id}}
	}
	prs := &Tab{ID: "t-p", Kind: "prs"}
	pane := func(id string, active string, tabs ...*Tab) *Node {
		return &Node{T: NodePane, ID: id, Tabs: tabs, Active: active}
	}
	split := func(id string, dir Dir, sizes []float64, kids ...*Node) *Node {
		return &Node{T: NodeSplit, ID: id, Dir: dir, Kids: kids, Sizes: sizes}
	}
	tests := []struct {
		name string
		root *Node
	}{
		{"a diff pane to the right", split("s-1", Row, []float64{0.6, 0.4},
			pane("p-a", "t-a", prs, thread("t-a")), pane("p-b", "t-d", diff("t-d", "w")))},
		{"a column of linked panes to the right", split("s-1", Row, []float64{0.55, 0.45},
			pane("p-a", "t-a", prs, thread("t-a")),
			split("s-2", Col, []float64{0.7, 0.3}, pane("p-b", "t-e", diff("t-d", "w"), diff("t-e", "w2")), pane("p-c", "t-x", term("t-x"))))},
		{"a diff to the right and a terminal under both", split("s-1", Col, []float64{0.65, 0.35},
			split("s-2", Row, []float64{0.5, 0.5}, pane("p-a", "t-a", prs, thread("t-a")), pane("p-b", "t-d", diff("t-d", "w"))),
			pane("p-c", "t-x", term("t-x")))},
		{"linked tabs in the thread's own pane and a pane that keeps another thread's tab", split("s-1", Row, []float64{0.5, 0.5},
			pane("p-a", "t-a", diff("t-d", "w"), prs, thread("t-a")),
			pane("p-b", "t-x", &Tab{ID: "t-o", Kind: "file", Thread: "th-b", Params: map[string]string{"path": "/o"}}, term("t-x")))},
		{"a pane under a row that closing merges into its parent row", split("s-1", Row, []float64{0.55, 0.45},
			split("s-2", Col, []float64{0.6, 0.4},
				split("s-3", Row, []float64{0.5, 0.5}, pane("p-a", "t-a", prs, thread("t-a")), pane("p-n", "t-q", &Tab{ID: "t-q", Kind: "projects"})),
				pane("p-t", "t-x", term("t-x"))),
			pane("p-b", "t-d", diff("t-d", "w")))},
		{"three panes in a row, the middle one linked", split("s-1", Row, []float64{0.3, 0.4, 0.3},
			pane("p-q", "t-q", &Tab{ID: "t-q", Kind: "projects"}), pane("p-b", "t-d", diff("t-d", "w")), pane("p-a", "t-a", prs, thread("t-a")))},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			st := &State{V: Version, Spaces: []*Space{{ID: "sp-a", Name: "Main", Root: tc.root, Focus: "p-a"}}, CurrentSpace: "sp-a", DefaultSpace: "sp-a"}
			Sanitize(st, &SeqIDs{})
			if err := Check(st); err != nil {
				t.Fatal(err)
			}
			got := roundTrip(t, st, "th-a", "p-a", 1600, 1000)
			if want := layoutShape(st.Spaces[0].Root); layoutShape(got.Spaces[0].Root) != want {
				t.Errorf("after close and open:\n got %s\nwant %s", layoutShape(got.Spaces[0].Root), want)
			}
		})
	}
}

// TestCloseOpenRoundTripRandom runs the round trip on states from random op sequences: every
// thread tab that is the last and active tab of a pane that keeps a tab of something else is
// closed and opened again there. Every tab comes back to its pane; the tree comes back exactly when no
// pane had to be rebuilt beside a split that normalising merged away (see the step note).
func TestCloseOpenRoundTripRandom(t *testing.T) {
	r := rand.New(rand.NewPCG(3, 5))
	trips, exact := 0, 0
	for range 150 {
		data := make([]byte, 160)
		for i := range data {
			data[i] = byte(r.UintN(256))
		}
		st, _, err := Decode([]byte(seedState), &SeqIDs{})
		if err != nil {
			t.Fatal(err)
		}
		ids := &SeqIDs{}
		s := &bytesrc{b: data}
		for step := 0; step < 40 && !s.done(); step++ {
			if next, _, err := Apply(st, randomOp(s, st), ids); err == nil {
				st = next
			}
		}
		for _, sp := range st.Spaces {
			for _, p := range Panes(sp.Root) {
				for _, th := range p.Tabs {
					stays := slices.ContainsFunc(p.Tabs, func(tb *Tab) bool { return tb.Thread != th.Thread })
					if th.Kind != "thread" || !stays {
						continue
					}
					// Make the thread's tab the last and active tab of its pane, then go there and back.
					end := len(p.Tabs)
					at, _, err := Apply(st, &MoveTab{Tab: th.ID, Pane: p.ID, Index: &end}, &SeqIDs{})
					if err != nil {
						t.Fatal(err)
					}
					got := roundTrip(t, at, th.Thread, p.ID, DefaultW, DefaultH)
					trips++
					asp, gsp := at.Space(sp.ID), got.Space(sp.ID)
					for _, q := range Panes(asp.Root) {
						for _, tb := range q.Tabs {
							if tb.Kind == "thread" {
								continue
							}
							if _, gp, _ := got.FindTab(tb.ID); gp == nil || gp.ID != q.ID {
								t.Errorf("thread %s: tab %s was in %s, came back in %v\nbefore %s\nafter  %s", th.Thread, tb.ID, q.ID, gp, layoutShape(asp.Root), layoutShape(gsp.Root))
							}
						}
					}
					if layoutShape(gsp.Root) == layoutShape(asp.Root) {
						exact++
					} else {
						t.Logf("not exact:\nbefore %s\nafter  %s", layoutShape(asp.Root), layoutShape(gsp.Root))
					}
				}
			}
		}
	}
	if trips < 50 {
		t.Fatalf("only %d round trips: the generator no longer makes this case", trips)
	}
	t.Logf("%d round trips, %d exact", trips, exact)
}

// TestRankMineFirst pins the first tie-break of rules 3 and 4, which rule 2 makes unreachable
// through open_surface (any pane holding this thread's linked tab is taken by rule 2): a pane
// holding a linked tab of this thread ranks before a better side and a nearer pane.
func TestRankMineFirst(t *testing.T) {
	ta := &Tab{ID: "t-a", Kind: "thread", Thread: "th-a"}
	other := func(id string) *Tab {
		return &Tab{ID: id, Kind: "file", Thread: "th-b", Params: map[string]string{"path": "/" + id}}
	}
	mine := &Tab{ID: "t-m", Kind: "file", Thread: "th-a", Params: map[string]string{"path": "/m"}}
	pl := &Node{T: NodePane, ID: "p-l", Tabs: []*Tab{mine}, Active: "t-m"}
	pa := &Node{T: NodePane, ID: "p-a", Tabs: []*Tab{ta}, Active: "t-a"}
	pr := &Node{T: NodePane, ID: "p-r", Tabs: []*Tab{other("t-r")}, Active: "t-r"}
	root := &Node{T: NodeSplit, ID: "s-1", Dir: Row, Kids: []*Node{pl, pa, pr}, Sizes: []float64{0.4, 0.3, 0.3}}
	L := Rects(root, DefaultW, DefaultH)
	for _, bySide := range []bool{true, false} {
		got := rank(L, pa, "th-a", []*Node{pr, pl}, bySide)
		if got[0] != pl {
			t.Errorf("bySide %v: first %s, want p-l (holds this thread's tab)", bySide, got[0].ID)
		}
	}
	// Without a tab of this thread anywhere: right before left by side, nearest without.
	pl.Tabs, pl.Active = []*Tab{other("t-l")}, "t-l"
	if got := rank(L, pa, "th-a", []*Node{pl, pr}, true); got[0] != pr {
		t.Errorf("by side: first %s, want p-r", got[0].ID)
	}
	root.Sizes = []float64{0.2, 0.3, 0.5}
	L = Rects(root, DefaultW, DefaultH)
	if got := rank(L, pa, "th-a", []*Node{pr, pl}, false); got[0] != pl {
		t.Errorf("nearest: first %s, want p-l", got[0].ID)
	}
}

// TestRoomBeside pins rule 5's arithmetic: the default share, the floor, and "room" as the
// conversation keeping KeepPx.
func TestRoomBeside(t *testing.T) {
	tests := []struct {
		name  string
		width float64
		kind  string
		frac  float64
		ok    bool
	}{
		{"diff at its default share", 1180, "diff", 0.45, true},
		{"diff raised to its 480px floor", 1012, "diff", 0.48, true},
		{"diff below the floor, no room at the floor: 45%", 900, "diff", 0.45, true},
		{"diff in a narrow pane: 45% all the same (room is the fit's question)", 800, "diff", 0.45, true},
		{"terminal at 30%", 700, "terminal", 0.3, true},
		{"file at 35%", 1180, "file", 0.35, true},
		{"a pane narrower than a gutter", 10, "file", 0, false},
		{"unknown kind", 1180, "nope", 0, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			frac, ok := roomBeside(tc.width, tc.kind)
			if ok != tc.ok || math.Abs(frac-tc.frac) > 1e-9 {
				t.Fatalf("roomBeside(%v, %s) = %v, %v; want %v, %v", tc.width, tc.kind, frac, ok, tc.frac, tc.ok)
			}
		})
	}
}

// TestOpenThreadSwapSetting pins that smart swap is on by default and that Options turns it
// off for any op, here open_thread.
func TestOpenThreadSwapSetting(t *testing.T) {
	data := `{"v":1,"spaces":[{"id":"sp-a","name":"Main","root":{"t":"split","id":"s-1","dir":"row","sizes":[0.5,0.5],"kids":[
	 {"t":"pane","id":"p-a","tabs":[{"id":"t-a","kind":"thread","thread":"th-a"},{"id":"t-b","kind":"thread","thread":"th-b"}],"active":"t-a"},
	 {"t":"pane","id":"p-b","tabs":[{"id":"t-da","kind":"diff","thread":"th-a","params":{"project":"p","worktree":"w"}},{"id":"t-db","kind":"diff","thread":"th-b","params":{"project":"p","worktree":"w"}}],"active":"t-da"}]},
	 "focus":"p-a"}],"current_space":"sp-a","default_space":"sp-a"}`
	st, _, err := Decode([]byte(data), &SeqIDs{})
	if err != nil {
		t.Fatal(err)
	}
	for _, off := range []bool{false, true} {
		next, res, err := ApplyWith(st, &OpenThread{Thread: "th-b", Focus: true}, &SeqIDs{}, Options{NoSmartSwap: off})
		if err != nil {
			t.Fatal(err)
		}
		_, pb := next.FindPane("p-b")
		want := "t-db"
		if off {
			want = "t-da"
		}
		if pb.Active != want || (len(res.Swapped) > 0) == off {
			t.Errorf("swap off %v: p-b shows %s (swapped %v), want %s", off, pb.Active, res.Swapped, want)
		}
	}
	if slices.Contains(OpNames(), "smart_swap") {
		t.Error("smart swap is not an op of its own: it runs inside ApplyWith")
	}
}
