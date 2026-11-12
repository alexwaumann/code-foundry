package layout

import (
	"bytes"
	"encoding/json"
	"math"
	"math/rand/v2"
	"os"
	"reflect"
	"slices"
	"testing"
)

// rectCase is one entry of testdata/rects.json (docs/notes/shell-1-layout-model.md).
type rectCase struct {
	Doc        string                       `json:"doc"`
	Root       *Node                        `json:"root"`
	W          float64                      `json:"w"`
	H          float64                      `json:"h"`
	Rects      map[string]Rect              `json:"rects"`
	Gutters    []GutterRect                 `json:"gutters,omitempty"`
	Neighbours map[string]map[Edge][]string `json:"neighbours,omitempty"`
	Adjacent   [][2]string                  `json:"adjacent,omitempty"`
}

var sides = []Edge{Right, Left, Bottom, Top}

func (c *rectCase) compute() {
	l := Rects(c.Root, c.W, c.H)
	c.Rects, c.Gutters = l.Rects, l.Gutters
	c.Neighbours, c.Adjacent = nil, nil
	ids := PaneIDs(c.Root)
	for _, id := range ids {
		for _, side := range sides {
			if ns := l.SideNeighbours(id, side); len(ns) > 0 {
				if c.Neighbours == nil {
					c.Neighbours = map[string]map[Edge][]string{}
				}
				if c.Neighbours[id] == nil {
					c.Neighbours[id] = map[Edge][]string{}
				}
				c.Neighbours[id][side] = ns
			}
		}
	}
	for i, a := range ids {
		for _, b := range ids[i+1:] {
			if l.Adjacent(a, b) {
				c.Adjacent = append(c.Adjacent, [2]string{a, b})
			}
		}
	}
}

func TestRectCases(t *testing.T) {
	raw, err := os.ReadFile("testdata/rects.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []*rectCase
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cases); err != nil {
		t.Fatal(err)
	}
	if *update {
		for _, c := range cases {
			c.compute()
		}
		b, err := json.Marshal(cases)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile("testdata/rects.json", append(pretty(b), '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	for _, want := range cases {
		t.Run(want.Doc, func(t *testing.T) {
			got := *want
			got.compute()
			if !reflect.DeepEqual(got.Rects, want.Rects) {
				t.Errorf("rects %v, want %v", got.Rects, want.Rects)
			}
			if !reflect.DeepEqual(got.Gutters, want.Gutters) {
				t.Errorf("gutters %v, want %v", got.Gutters, want.Gutters)
			}
			if !reflect.DeepEqual(got.Neighbours, want.Neighbours) {
				t.Errorf("neighbours %v, want %v", got.Neighbours, want.Neighbours)
			}
			if !reflect.DeepEqual(got.Adjacent, want.Adjacent) {
				t.Errorf("adjacent %v, want %v", got.Adjacent, want.Adjacent)
			}
			assertTiles(t, Rects(want.Root, want.W, want.H))
		})
	}
}

// assertTiles checks that panes and gutters cover the area exactly: inside it, no overlaps,
// areas summing to w*h, every gutter Gutter thick.
func assertTiles(t *testing.T, l *Layout) {
	t.Helper()
	type box struct {
		id string
		r  Rect
	}
	var boxes []box
	for id, r := range l.Rects {
		boxes = append(boxes, box{id, r})
	}
	for _, g := range l.Gutters {
		thick := g.H
		if g.Row {
			thick = g.W
		}
		if math.Abs(thick-Gutter) > 1.01 {
			t.Errorf("gutter %s:%d is %v thick", g.Split, g.I, thick)
		}
		boxes = append(boxes, box{"gutter " + g.Split, g.Rect})
	}
	area := 0.0
	for i, a := range boxes {
		area += a.r.W * a.r.H
		if a.r.X < 0 || a.r.Y < 0 || a.r.X+a.r.W > l.W+1e-9 || a.r.Y+a.r.H > l.H+1e-9 || a.r.W < 0 || a.r.H < 0 {
			t.Errorf("%s %+v leaves the %vx%v area", a.id, a.r, l.W, l.H)
		}
		for _, b := range boxes[i+1:] {
			if overlap(a.r.X, a.r.W, b.r.X, b.r.W) > 1e-9 && overlap(a.r.Y, a.r.H, b.r.Y, b.r.H) > 1e-9 {
				t.Errorf("%s %+v overlaps %s %+v", a.id, a.r, b.id, b.r)
			}
		}
	}
	if math.Abs(area-l.W*l.H) > 1e-6 {
		t.Errorf("panes and gutters cover %v of %v", area, l.W*l.H)
	}
}

// TestRectsTileRandomTrees lays random trees in random areas large enough for them and checks
// the tiling.
func TestRectsTileRandomTrees(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	for i := range 500 {
		n := 0
		root := randomTree(r, 0, &n, Dir(""))
		w := float64(n*40 + r.IntN(2000))
		h := float64(n*40 + r.IntN(1200))
		if i%7 == 0 {
			w += 0.5 // a page zoom gives fractional layout px
		}
		l := Rects(root, w, h)
		if len(l.Rects) != n {
			t.Fatalf("%d rects for %d panes", len(l.Rects), n)
		}
		assertTiles(t, l)
	}
}

func randomTree(r *rand.Rand, depth int, n *int, parent Dir) *Node {
	if depth > 3 || r.IntN(3) == 0 {
		*n++
		id := "p-" + string(rune('a'+*n))
		return &Node{T: NodePane, ID: id, Tabs: []*Tab{{ID: "t" + id, Kind: "prs"}}, Active: "t" + id}
	}
	dir := Row
	if parent == Row {
		dir = Col
	}
	s := &Node{T: NodeSplit, ID: "s-" + string(rune('a'+depth)) + string(rune('a'+*n)), Dir: dir}
	k := 2 + r.IntN(3)
	for range k {
		s.Kids = append(s.Kids, randomTree(r, depth+1, n, dir))
		s.Sizes = append(s.Sizes, 0.05+r.Float64())
	}
	tot := sum(s.Sizes)
	for i := range s.Sizes {
		s.Sizes[i] /= tot
	}
	return s
}

func TestRectsEmpty(t *testing.T) {
	if l := Rects(nil, 800, 600); len(l.Rects) != 0 || len(l.Gutters) != 0 {
		t.Errorf("an empty tree laid out %v", l)
	}
}

func TestSideNeighboursUnknown(t *testing.T) {
	l := Rects(&Node{T: NodePane, ID: "p-a"}, 100, 100)
	if got := l.SideNeighbours("p-x", Right); got != nil {
		t.Errorf("unknown pane has neighbours %v", got)
	}
	if got := l.SideNeighbours("p-a", Edge("up")); got != nil {
		t.Errorf("unknown side has neighbours %v", got)
	}
	if !l.Adjacent("p-a", "p-a") || l.Adjacent("p-a", "p-x") {
		t.Error("Adjacent: a pane is adjacent to itself and to no unknown pane")
	}
	if !slices.Equal(PaneIDs(nil), nil) {
		t.Error("PaneIDs(nil) is empty")
	}
}
