package layout

import (
	"fmt"
	"math"
	"slices"
)

// minFrac and maxFrac bound the share a node inserted beside another takes of its room.
const (
	minFrac     = 0.05
	maxFrac     = 0.95
	defaultFrac = 0.5
	// badSize stands in for a size that is not positive and finite before normalising.
	badSize = 0.0001
)

// norm puts the tree under n into normal form and returns its new root (nil when nothing is
// left): no pane without tabs, no split with fewer than two children, no split directly in a
// split of the same direction (its children are spliced into the parent at their share of its
// room), sizes positive and summing to 1, and each pane's active tab one of its tabs.
// Pane nodes keep their identity; a split that collapses is dropped.
func norm(n *Node) *Node {
	if n == nil {
		return nil
	}
	if n.IsPane() {
		n.Tabs = slices.DeleteFunc(n.Tabs, func(t *Tab) bool { return t == nil })
		if len(n.Tabs) == 0 {
			return nil
		}
		if n.TabIndex(n.Active) < 0 {
			n.Active = n.Tabs[0].ID
		}
		return n
	}
	if len(n.Sizes) != len(n.Kids) {
		n.Sizes = make([]float64, len(n.Kids))
		for i := range n.Sizes {
			n.Sizes[i] = 1
		}
	}
	var kids []*Node
	var sizes []float64
	for i, k := range n.Kids {
		c := norm(k)
		if c == nil {
			continue
		}
		s := n.Sizes[i]
		if !(s > 0) || math.IsInf(s, 0) {
			s = badSize
		}
		if c.T == NodeSplit && c.Dir == n.Dir {
			tot := sum(c.Sizes)
			for j, g := range c.Kids {
				kids = append(kids, g)
				sizes = append(sizes, s*c.Sizes[j]/tot)
			}
			continue
		}
		kids = append(kids, c)
		sizes = append(sizes, s)
	}
	switch len(kids) {
	case 0:
		return nil
	case 1:
		return kids[0]
	}
	// Sizes already summing to 1 are left alone, so a stored tree reads back bit for bit.
	if tot := sum(sizes); math.Abs(tot-1) > 1e-12 {
		for i := range sizes {
			sizes[i] /= tot
		}
	}
	n.Kids, n.Sizes = kids, sizes
	return n
}

func sum(xs []float64) float64 {
	var s float64
	for _, x := range xs {
		s += x
	}
	return s
}

// parentOf finds the node with that id under root: its parent (nil for the root) and its
// index in the parent's children.
func parentOf(root *Node, id string) (par *Node, idx int, node *Node) {
	if root == nil {
		return nil, -1, nil
	}
	if root.ID == id {
		return nil, -1, root
	}
	for i, k := range root.Kids {
		if k.ID == id {
			return root, i, k
		}
		if p, j, n := parentOf(k, id); n != nil {
			return p, j, n
		}
	}
	return nil, -1, nil
}

// removeNode takes the node with that id out of the space's tree. Its room goes to the sibling
// before it (after it when it is first), so putting it back beside that sibling at its old
// share restores the sizes.
func removeNode(sp *Space, id string) {
	par, i, node := parentOf(sp.Root, id)
	if node == nil {
		return
	}
	if par == nil {
		sp.Root = nil
		return
	}
	n := i + 1
	if i > 0 {
		n = i - 1
	}
	par.Sizes[n] += par.Sizes[i]
	par.Kids = slices.Delete(par.Kids, i, i+1)
	par.Sizes = slices.Delete(par.Sizes, i, i+1)
	sp.Root = norm(sp.Root)
}

// clampFrac is the share a node inserted beside another takes: 0 means the default (half).
func clampFrac(f float64) float64 {
	if f == 0 || math.IsNaN(f) {
		return defaultFrac
	}
	return max(minFrac, min(maxFrac, f))
}

// insertBeside puts node beside the node with that id, on edge; node takes frac of the room
// that node had. When the target's parent runs the same way, node joins it as a sibling;
// otherwise the target is wrapped in a new split with the id newID.
func insertBeside(sp *Space, id string, edge Edge, node *Node, frac float64, newID string) error {
	par, i, target := parentOf(sp.Root, id)
	if target == nil {
		return fmt.Errorf("node %q: %w", id, ErrNotFound)
	}
	frac = clampFrac(frac)
	dir, before := edge.dir(), edge.before()
	if par != nil && par.Dir == dir {
		s := par.Sizes[i]
		par.Sizes[i] = s * (1 - frac)
		at := i + 1
		if before {
			at = i
		}
		par.Kids = slices.Insert(par.Kids, at, node)
		par.Sizes = slices.Insert(par.Sizes, at, s*frac)
	} else {
		ns := &Node{T: NodeSplit, ID: newID, Dir: dir, Kids: []*Node{target, node}, Sizes: []float64{1 - frac, frac}}
		if before {
			ns.Kids = []*Node{node, target}
			ns.Sizes = []float64{frac, 1 - frac}
		}
		if par == nil {
			sp.Root = ns
		} else {
			par.Kids[i] = ns
		}
	}
	sp.Root = norm(sp.Root)
	return nil
}

// detach takes a tab out of its pane. When it was the pane's active tab, the tab now at its
// index (or the last) becomes active. A pane left empty is removed; when it was the focused
// pane, the pane now at its place in layout order takes the focus. It does not touch MRU.
func detach(sp *Space, pane *Node, tabID string) *Tab {
	i := pane.TabIndex(tabID)
	if i < 0 {
		return nil
	}
	t := pane.Tabs[i]
	pane.Tabs = slices.Delete(pane.Tabs, i, i+1)
	if pane.Active == tabID {
		pane.Active = ""
		if len(pane.Tabs) > 0 {
			pane.Active = pane.Tabs[min(i, len(pane.Tabs)-1)].ID
		}
	}
	if len(pane.Tabs) == 0 {
		dropPane(sp, pane.ID)
	}
	return t
}

// dropPane removes a pane from the tree; when it had the focus, the pane now at its place in
// layout order takes it.
func dropPane(sp *Space, paneID string) {
	at := slices.Index(PaneIDs(sp.Root), paneID)
	removeNode(sp, paneID)
	if sp.Focus == paneID {
		rest := Panes(sp.Root)
		sp.Focus = ""
		if len(rest) > 0 {
			sp.Focus = nearestOpen(rest, min(max(at, 0), len(rest)-1)).ID
		}
	}
}

// Lca is the lowest node under root that contains every pane in ids (root itself when no
// child holds them all; nil for an empty tree).
func Lca(root *Node, ids []string) *Node {
	n := root
	for n != nil && !n.IsPane() {
		var next *Node
		for _, k := range n.Kids {
			have := PaneIDs(k)
			if !slices.ContainsFunc(ids, func(id string) bool { return !slices.Contains(have, id) }) {
				next = k
				break
			}
		}
		if next == nil {
			return n
		}
		n = next
	}
	return n
}

// BesideInfo says where pane sits relative to the sibling that would take its room if it
// were removed (removeNode): that sibling's panes, the edge of them pane is on, and pane's
// share of the room the two have together. Nil for the root or an unknown pane.
func BesideInfo(root *Node, paneID string) *Beside {
	par, i, node := parentOf(root, paneID)
	if node == nil || par == nil {
		return nil
	}
	n := i + 1
	if i > 0 {
		n = i - 1
	}
	var edge Edge
	switch {
	case par.Dir == Row && n < i:
		edge = Right
	case par.Dir == Row:
		edge = Left
	case n < i:
		edge = Bottom
	default:
		edge = Top
	}
	return &Beside{
		Neighbours: PaneIDs(par.Kids[n]),
		Edge:       edge,
		Frac:       par.Sizes[i] / (par.Sizes[i] + par.Sizes[n]),
	}
}
