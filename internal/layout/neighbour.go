package layout

import (
	"slices"
	"strings"
)

// Neighbour is the pane a direction key goes to from pane: of the panes touching it on that
// side (SideNeighbours), the one focused most recently (the first to hold a tab of mru, a
// space's MRU), else the one sharing the longest stretch of edge, else the one nearer the top
// (for left and right) or the left (for top and bottom), else by id. "" when nothing touches
// that side. The GUI's neighbour (gui/frontend/src/shell/geometry/neighbours.ts) is the same
// rule on the frame it renders (rails, minimums); the CLI's runs on Rects in the stored
// viewport. testdata/neighbour.json holds both to it (docs/notes/shell-25b-audits.md).
func (l *Layout) Neighbour(root *Node, pane string, side Edge, mru []string) string {
	ids := l.SideNeighbours(pane, side)
	if len(ids) == 0 {
		return ""
	}
	r := l.Rects[pane]
	recent := map[string]int{}
	for _, p := range Panes(root) {
		if !slices.Contains(ids, p.ID) {
			continue
		}
		for _, tb := range p.Tabs {
			if at := slices.Index(mru, tb.ID); at >= 0 {
				if cur, ok := recent[p.ID]; !ok || at < cur {
					recent[p.ID] = at
				}
			}
		}
	}
	rank := func(id string) (int, float64, float64) {
		o := l.Rects[id]
		rec, ok := recent[id]
		if !ok {
			rec = len(mru)
		}
		if side == Left || side == Right {
			return rec, overlap(o.Y, o.H, r.Y, r.H), o.Y
		}
		return rec, overlap(o.X, o.W, r.X, r.W), o.X
	}
	return slices.MinFunc(ids, func(a, b string) int {
		ra, oa, pa := rank(a)
		rb, ob, pb := rank(b)
		switch {
		case ra != rb:
			return ra - rb
		case oa != ob:
			if oa > ob {
				return -1
			}
			return 1
		case pa != pb:
			if pa < pb {
				return -1
			}
			return 1
		}
		return strings.Compare(a, b)
	})
}
