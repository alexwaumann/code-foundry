package layout

import (
	"math"
	"testing"
)

func TestOuterFrac(t *testing.T) {
	pane := func(kind string) *Node {
		return &Node{T: NodePane, ID: "p-n", Tabs: []*Tab{{ID: "t-n", Kind: kind}}, Active: "t-n"}
	}
	one := &Space{Root: &Node{T: NodePane, ID: "p-a"}}
	row := &Space{Root: &Node{T: NodeSplit, ID: "s-r", Dir: Row, Kids: []*Node{{T: NodePane, ID: "p-a"}, {T: NodePane, ID: "p-b"}}, Sizes: []float64{0.5, 0.5}}}
	tests := []struct {
		name       string
		sp         *Space
		node       *Node
		edge       Edge
		frac, w, h float64
		want       float64
	}{
		{"a given share wins", one, pane("diff"), Right, 0.2, 1000, 800, 0.2},
		{"no area: the kind's share", one, pane("terminal"), Right, 0, 0, 0, 0.3},
		{"no area: no floor", one, pane("diff"), Right, 0, 0, 0, 0.45},
		{"an unknown kind: half", one, pane("someday"), Right, 0, 1000, 800, 0.5},
		{"a pane with no active tab: half", one, &Node{T: NodePane, ID: "p-n"}, Right, 0, 1000, 800, 0.5},
		{"above the floor: the share", one, pane("diff"), Right, 0, 1412, 800, 0.45},
		{"raised to the floor", one, pane("diff"), Right, 0, 1012, 800, 0.48},
		{"no floor when the rest keeps too little", one, pane("diff"), Right, 0, 912, 800, 0.45},
		{"top and bottom measure the height", one, pane("diff"), Bottom, 0, 400, 1012, 0.48},
		{"joining a row counts its gutters", row, pane("diff"), Left, 0, 1024, 400, 0.48},
		{"a column beside a row has one gutter", row, pane("diff"), Top, 0, 400, 1012, 0.48},
		{"a negative area: the kind's share", one, pane("diff"), Right, 0, -5, -5, 0.45},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := outerFrac(tt.sp, tt.node, tt.edge, tt.frac, tt.w, tt.h); math.Abs(got-tt.want) > 1e-9 {
				t.Errorf("outerFrac = %v, want %v", got, tt.want)
			}
		})
	}
}
