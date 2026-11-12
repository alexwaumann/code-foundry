package layout

import "slices"

// Neighbour is the pane a direction key goes to from pane: of the panes touching it on that
// side (SideNeighbours), the one focused most recently (the first to hold a tab of mru, a
// space's MRU), else the one sharing the longest stretch of edge. "" when nothing touches that
// side. It is the toy's neighbour(dir) over the plain layout of root; the GUI resolves it from
// the frame it renders (rails, minimums), the CLI from Rects in the stored viewport.
func (l *Layout) Neighbour(root *Node, pane string, side Edge, mru []string) string {
	ids := l.SideNeighbours(pane, side)
	if len(ids) == 0 {
		return ""
	}
	best, bestAt := ids[0], len(mru)
	for _, p := range Panes(root) {
		if !slices.Contains(ids, p.ID) {
			continue
		}
		for _, tb := range p.Tabs {
			if at := slices.Index(mru, tb.ID); at >= 0 && at < bestAt {
				best, bestAt = p.ID, at
			}
		}
	}
	return best
}
