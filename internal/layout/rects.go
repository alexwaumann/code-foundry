package layout

import (
	"math"
	"slices"
	"strings"
)

// Gutter is the gap between panes, in layout px.
const Gutter = 12.0

// edgeTolerance is how far two pane edges may be from one gutter apart and still touch.
const edgeTolerance = 2.0

// Rect is a rectangle in layout px, from the pane area's top left.
type Rect struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

// GutterRect is the gap after child I of a split: a column gap in a row, a row gap in a column.
type GutterRect struct {
	Split string `json:"split"`
	I     int    `json:"i"`
	Row   bool   `json:"row"`
	Rect
}

// Layout is a tree laid out in a pane area: each pane's rectangle and each gutter's.
type Layout struct {
	W       float64         `json:"w"`
	H       float64         `json:"h"`
	Rects   map[string]Rect `json:"rects"`
	Gutters []GutterRect    `json:"gutters,omitempty"`
}

// Rail is the thickness of a pane the user collapsed, in layout px (the GUI's RAIL).
const Rail = 36.0

// Rects lays the tree out in a w x h pane area by its proportions alone: no minimum sizes and
// no automatic rails (those are the GUI's, per frame). A pane the user collapsed is a rail: a
// child of a split that is all collapsed panes takes its rail thickness along the split, and the
// others share what is left (when every child is all collapsed, they share by their sizes).
// Each split shares its length minus its gutters by its sizes; edges are rounded to whole px,
// and the last child runs to the split's far edge, so panes and gutters tile the area exactly.
// This is the layout placement measures; the GUI's plainRects gives the same px.
func Rects(root *Node, w, h float64) *Layout {
	l := &Layout{W: w, H: h, Rects: map[string]Rect{}}
	if root != nil {
		l.lay(root, 0, 0, w, h)
	}
	return l
}

// round is JavaScript's Math.round, so the GUI's port gives the same px.
func round(x float64) float64 { return math.Floor(x + 0.5) }

func (l *Layout) lay(n *Node, x, y, w, h float64) {
	if n.IsPane() {
		l.Rects[n.ID] = Rect{X: x, Y: y, W: w, H: h}
		return
	}
	row := n.Dir == Row
	count := len(n.Kids)
	length := h
	if row {
		length = w
	}
	free := max(0, length-Gutter*float64(count-1))
	fixed := make([]bool, count)
	all := true
	for i, k := range n.Kids {
		fixed[i] = allCollapsed(k)
		all = all && fixed[i]
	}
	if all {
		fixed = make([]bool, count)
	}
	sizes := make([]float64, count)
	ws := 0.0
	for i, k := range n.Kids {
		if fixed[i] {
			sizes[i] = min(railLength(k, n.Dir), free)
			free -= sizes[i]
		} else {
			ws += n.Sizes[i]
		}
	}
	p, end := y, y+h
	if row {
		p, end = x, x+w
	}
	for i, k := range n.Kids {
		sz := sizes[i]
		if !fixed[i] && ws > 0 {
			sz = max(0, free*n.Sizes[i]/ws)
		}
		a, b := round(p), round(p+sz)
		if i == count-1 {
			b = end
		}
		if row {
			l.lay(k, a, y, b-a, h)
		} else {
			l.lay(k, x, a, w, b-a)
		}
		if i < count-1 {
			a2 := round(p + sz + Gutter)
			g := GutterRect{Split: n.ID, I: i, Row: row, Rect: Rect{X: x, Y: b, W: w, H: a2 - b}}
			if row {
				g.Rect = Rect{X: b, Y: y, W: a2 - b, H: h}
			}
			l.Gutters = append(l.Gutters, g)
		}
		p += sz + Gutter
	}
}

// allCollapsed reports whether every pane under n is one the user collapsed.
func allCollapsed(n *Node) bool {
	if n.IsPane() {
		return n.Collapsed
	}
	for _, k := range n.Kids {
		if !allCollapsed(k) {
			return false
		}
	}
	return true
}

// railLength is the length along dir of a subtree of collapsed panes: its rails and gutters.
func railLength(n *Node, dir Dir) float64 {
	if n.IsPane() {
		return Rail
	}
	out := 0.0
	for _, k := range n.Kids {
		l := railLength(k, dir)
		if n.Dir == dir {
			out += l
		} else {
			out = max(out, l)
		}
	}
	if n.Dir == dir {
		out += Gutter * float64(len(n.Kids)-1)
	}
	return out
}

// overlap is the length two spans [a, a+al) and [b, b+bl) share.
func overlap(a, al, b, bl float64) float64 { return min(a+al, b+bl) - max(a, b) }

// SideNeighbours lists the panes that touch pane on that side, across one gutter, the one
// sharing the longest stretch of edge first (ties by id).
func (l *Layout) SideNeighbours(pane string, side Edge) []string {
	r, ok := l.Rects[pane]
	if !ok || !side.Valid() {
		return nil
	}
	type hit struct {
		id string
		ov float64
	}
	var hits []hit
	for id, o := range l.Rects {
		if id == pane {
			continue
		}
		var gap, ov float64
		switch side {
		case Right:
			gap, ov = o.X-(r.X+r.W+Gutter), overlap(o.Y, o.H, r.Y, r.H)
		case Left:
			gap, ov = o.X+o.W+Gutter-r.X, overlap(o.Y, o.H, r.Y, r.H)
		case Top:
			gap, ov = o.Y+o.H+Gutter-r.Y, overlap(o.X, o.W, r.X, r.W)
		case Bottom:
			gap, ov = o.Y-(r.Y+r.H+Gutter), overlap(o.X, o.W, r.X, r.W)
		default:
			return nil
		}
		if math.Abs(gap) <= edgeTolerance && ov > 0 {
			hits = append(hits, hit{id, ov})
		}
	}
	slices.SortFunc(hits, func(a, b hit) int {
		if a.ov != b.ov {
			if a.ov > b.ov {
				return -1
			}
			return 1
		}
		return strings.Compare(a.id, b.id)
	})
	out := make([]string, len(hits))
	for i, h := range hits {
		out[i] = h.id
	}
	return out
}

// Adjacent reports whether two panes share an edge across one gutter (a pane is adjacent to
// itself).
func (l *Layout) Adjacent(a, b string) bool {
	if a == b {
		return true
	}
	r, ok1 := l.Rects[a]
	o, ok2 := l.Rects[b]
	if !ok1 || !ok2 {
		return false
	}
	ox, oy := overlap(r.X, r.W, o.X, o.W), overlap(r.Y, r.H, o.Y, o.H)
	gx := max(o.X-(r.X+r.W), r.X-(o.X+o.W))
	gy := max(o.Y-(r.Y+r.H), r.Y-(o.Y+o.H))
	return (oy > 0 && math.Abs(gx-Gutter) <= edgeTolerance) || (ox > 0 && math.Abs(gy-Gutter) <= edgeTolerance)
}
