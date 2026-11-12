package layout

import (
	"math"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

func pn(id string) *Node {
	return &Node{T: NodePane, ID: id, Tabs: []*Tab{{ID: "t" + id, Kind: "prs", Key: "prs"}}, Active: "t" + id}
}

func sp(id string, dir Dir, sizes []float64, kids ...*Node) *Node {
	return &Node{T: NodeSplit, ID: id, Dir: dir, Kids: kids, Sizes: sizes}
}

// shape writes a tree as "s-1:row(p-a .6, p-b .4)" with sizes rounded to 4 places.
func shape(n *Node) string {
	if n == nil {
		return "nil"
	}
	if n.IsPane() {
		return n.ID
	}
	parts := make([]string, len(n.Kids))
	for i, k := range n.Kids {
		size := strconv.FormatFloat(math.Round(n.Sizes[i]*1e4)/1e4, 'f', -1, 64)
		parts[i] = shape(k) + " " + strings.TrimPrefix(size, "0")
	}
	return n.ID + ":" + string(n.Dir) + "(" + strings.Join(parts, ", ") + ")"
}

func TestNorm(t *testing.T) {
	empty := &Node{T: NodePane, ID: "p-x"}
	tests := []struct {
		name string
		in   *Node
		want string
	}{
		{"a pane stays", pn("p-a"), "p-a"},
		{"an empty pane goes", empty, "nil"},
		{"a one-child split collapses", sp("s-1", Row, []float64{1}, pn("p-a")), "p-a"},
		{"an empty pane's room goes to the others", sp("s-1", Row, []float64{0.5, 0.25, 0.25}, pn("p-a"), &Node{T: NodePane, ID: "p-x"}, pn("p-b")), "s-1:row(p-a .6667, p-b .3333)"},
		{"a same-direction child is spliced in at its share", sp("s-1", Row, []float64{0.5, 0.5}, pn("p-a"), sp("s-2", Row, []float64{0.6, 0.4}, pn("p-b"), pn("p-c"))), "s-1:row(p-a .5, p-b .3, p-c .2)"},
		{"a cross-direction child stays", sp("s-1", Row, []float64{0.5, 0.5}, pn("p-a"), sp("s-2", Col, []float64{0.6, 0.4}, pn("p-b"), pn("p-c"))), "s-1:row(p-a .5, s-2:col(p-b .6, p-c .4) .5)"},
		{"sizes are scaled to sum to 1", sp("s-1", Col, []float64{2, 6}, pn("p-a"), pn("p-b")), "s-1:col(p-a .25, p-b .75)"},
		{"a bad size becomes tiny", sp("s-1", Col, []float64{-1, 1}, pn("p-a"), pn("p-b")), "s-1:col(p-a .0001, p-b .9999)"},
		{"missing sizes become equal", sp("s-1", Col, nil, pn("p-a"), pn("p-b")), "s-1:col(p-a .5, p-b .5)"},
		{"a collapsed middle split joins its grandparent", sp("s-1", Row, []float64{0.5, 0.5}, pn("p-a"), sp("s-2", Col, []float64{0.5, 0.5}, sp("s-3", Row, []float64{1}, pn("p-b")), &Node{T: NodePane, ID: "p-x"})), "s-1:row(p-a .5, p-b .5)"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shape(norm(tt.in)); got != tt.want {
				t.Errorf("got %s, want %s", got, tt.want)
			}
		})
	}
	n := pn("p-a")
	n.Active = "gone"
	if norm(n).Active != "tp-a" {
		t.Error("a pane whose active tab is gone activates its first")
	}
}

func TestLca(t *testing.T) {
	root := sp("s-1", Col, []float64{0.5, 0.5},
		sp("s-2", Row, []float64{0.5, 0.5}, sp("s-3", Col, []float64{0.5, 0.5}, pn("p-a"), pn("p-b")), pn("p-c")),
		pn("p-d"))
	tests := []struct {
		ids  []string
		want string
	}{
		{[]string{"p-a"}, "p-a"},
		{[]string{"p-a", "p-b"}, "s-3"},
		{[]string{"p-a", "p-c"}, "s-2"},
		{[]string{"p-b", "p-d"}, "s-1"},
		{[]string{"p-a", "p-zz"}, "s-1"},
	}
	for _, tt := range tests {
		if got := Lca(root, tt.ids); got.ID != tt.want {
			t.Errorf("Lca(%v) = %s, want %s", tt.ids, got.ID, tt.want)
		}
	}
	if Lca(nil, []string{"p-a"}) != nil {
		t.Error("Lca of an empty tree is nil")
	}
}

func TestBesideInfo(t *testing.T) {
	root := sp("s-1", Row, []float64{0.5, 0.2, 0.3},
		pn("p-a"), pn("p-b"), sp("s-2", Col, []float64{0.6, 0.4}, pn("p-c"), pn("p-d")))
	tests := []struct {
		pane string
		want *Beside
	}{
		{"p-a", &Beside{Neighbours: []string{"p-b"}, Edge: Left, Frac: 0.5 / 0.7}},
		{"p-b", &Beside{Neighbours: []string{"p-a"}, Edge: Right, Frac: 0.2 / 0.7}},
		{"p-c", &Beside{Neighbours: []string{"p-d"}, Edge: Top, Frac: 0.6}},
		{"p-d", &Beside{Neighbours: []string{"p-c"}, Edge: Bottom, Frac: 0.4}},
		{"p-zz", nil},
	}
	for _, tt := range tests {
		got := BesideInfo(root, tt.pane)
		if got != nil && tt.want != nil && math.Abs(got.Frac-tt.want.Frac) < 1e-12 {
			got.Frac = tt.want.Frac
		}
		if !reflect.DeepEqual(got, tt.want) {
			t.Errorf("BesideInfo(%s) = %+v, want %+v", tt.pane, got, tt.want)
		}
	}
	if BesideInfo(pn("p-a"), "p-a") != nil {
		t.Error("the root has no beside")
	}
}

// TestRemoveThenInsertBesideRestores pins the property restore depends on: a pane removed and
// put back beside the sibling that took its room, at its old share, gets its old sizes back.
var splitIDs = regexp.MustCompile(`s-[a-z0-9]+:`)

func TestRemoveThenInsertBesideRestores(t *testing.T) {
	trees := []func() *Node{
		func() *Node { return sp("s-1", Row, []float64{0.6, 0.4}, pn("p-a"), pn("p-b")) },
		func() *Node {
			return sp("s-1", Row, []float64{0.3, 0.3, 0.4}, pn("p-a"), pn("p-b"), pn("p-c"))
		},
		func() *Node {
			return sp("s-1", Col, []float64{0.55, 0.45}, sp("s-2", Row, []float64{0.62, 0.38}, pn("p-a"), pn("p-b")), pn("p-c"))
		},
	}
	for _, mk := range trees {
		for _, id := range PaneIDs(mk()) {
			space := &Space{Root: mk()}
			want := shape(space.Root)
			b := BesideInfo(space.Root, id)
			_, _, node := parentOf(space.Root, id)
			removeNode(space, id)
			target := Lca(space.Root, b.Neighbours)
			if err := insertBeside(space, target.ID, b.Edge, node, b.Frac, "s-new"); err != nil {
				t.Fatal(err)
			}
			// A split left with one child collapses and comes back with a new id.
			got, want := splitIDs.ReplaceAllString(shape(space.Root), "s:"), splitIDs.ReplaceAllString(want, "s:")
			if got != want {
				t.Errorf("remove and put back %s: %s, want %s", id, got, want)
			}
		}
	}
}
