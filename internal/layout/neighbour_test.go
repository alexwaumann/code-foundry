package layout

import (
	"strings"
	"testing"
)

func TestNeighbour(t *testing.T) {
	pane := func(id string, tabs ...string) *Node {
		n := &Node{T: NodePane, ID: id}
		for _, tb := range tabs {
			n.Tabs = append(n.Tabs, &Tab{ID: tb, Kind: "prs"})
		}
		n.Active = tabs[0]
		return n
	}
	// a | (b over c) | d
	root := &Node{T: NodeSplit, ID: "s-r", Dir: Row, Sizes: []float64{0.3, 0.4, 0.3}, Kids: []*Node{
		pane("p-a", "t-a"),
		{T: NodeSplit, ID: "s-c", Dir: Col, Sizes: []float64{0.6, 0.4}, Kids: []*Node{pane("p-b", "t-b"), pane("p-c", "t-c", "t-c2")}},
		pane("p-d", "t-d"),
	}}
	L := Rects(root, 1200, 800)
	tests := []struct {
		name, pane string
		side       Edge
		mru        []string
		want       string
	}{
		{"right of a, no history: the longest shared edge", "p-a", Right, nil, "p-b"},
		{"right of a, c focused last (by a tab that is not active)", "p-a", Right, []string{"t-c2", "t-b"}, "p-c"},
		{"right of a, b focused last", "p-a", Right, []string{"t-b", "t-c"}, "p-b"},
		{"below b", "p-b", Bottom, nil, "p-c"},
		{"above c", "p-c", Top, nil, "p-b"},
		{"left of d", "p-d", Left, []string{"t-c"}, "p-c"},
		{"nothing left of a", "p-a", Left, nil, ""},
		{"nothing above a", "p-a", Top, nil, ""},
		{"an unknown pane", "p-x", Right, nil, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := L.Neighbour(root, tt.pane, tt.side, tt.mru); got != tt.want {
				t.Errorf("Neighbour(%s, %s) = %q, want %q", tt.pane, tt.side, got, tt.want)
			}
		})
	}
}

func TestWithArea(t *testing.T) {
	for _, name := range OpNames() {
		op, _ := NewOp(name)
		WithArea(op, 900, 600)
		if !Measures(op) {
			continue
		}
		raw, err := EncodeOp(op)
		if err != nil {
			t.Fatal(err)
		}
		back, err := DecodeOp(raw)
		if err != nil {
			t.Fatal(err)
		}
		// A second area does not replace the one the op names.
		WithArea(back, 1, 1)
		again, _ := EncodeOp(back)
		if string(again) != string(raw) || !strings.Contains(string(raw), `"w":900,"h":600`) {
			t.Errorf("%s: %s then %s", name, raw, again)
		}
	}
	for _, name := range []string{"open_surface", "open_thread", "close_thread", "move_thread", "snooze_thread", "close_pane", "move_tab", "move_pane"} {
		op, _ := NewOp(name)
		if !Measures(op) {
			t.Errorf("%s does not take the pane area", name)
		}
	}
}
