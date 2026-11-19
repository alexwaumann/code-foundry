package layout

import "testing"

func TestFocusedThread(t *testing.T) {
	thread := func(id, th string) *Tab { return &Tab{ID: id, Kind: "thread", Thread: th} }
	diff := &Tab{ID: "t-d", Kind: "diff", Thread: "s-1"}
	two := func(focus, activeB string) *State {
		a := &Node{T: NodePane, ID: "p-a", Tabs: []*Tab{thread("t-1", "s-1")}, Active: "t-1"}
		b := &Node{T: NodePane, ID: "p-b", Tabs: []*Tab{thread("t-2", "s-2"), diff}, Active: activeB}
		root := &Node{T: NodeSplit, ID: "n-r", Dir: Row, Kids: []*Node{a, b}, Sizes: []float64{0.5, 0.5}}
		return &State{V: Version, Spaces: []*Space{{ID: "sp-a", Name: "Main", Root: root, Focus: focus}, {ID: "sp-b", Name: "Two"}}, CurrentSpace: "sp-a", DefaultSpace: "sp-a"}
	}
	other := two("p-a", "t-2")
	other.CurrentSpace = "sp-b"
	for _, tc := range []struct {
		name string
		st   *State
		want string
	}{
		{"no state", nil, ""},
		{"the focused pane's thread tab", two("p-a", "t-2"), "s-1"},
		{"the other pane focused", two("p-b", "t-2"), "s-2"},
		{"a linked surface in front", two("p-b", "t-d"), ""},
		{"another space current", other, ""},
		{"no focused pane", two("p-z", "t-2"), ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := FocusedThread(tc.st); got != tc.want {
				t.Errorf("FocusedThread = %q, want %q", got, tc.want)
			}
		})
	}
}
