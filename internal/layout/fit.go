package layout

import (
	"errors"
	"fmt"
	"slices"
)

// Room for panes (docs/notes/shell-model.md, "Small windows" and "Room for panes"; decisions in
// docs/notes/shell-25f-sizes.md). Every pane has one minimum size, whatever its tabs are; a pane
// all of whose tabs are terminals has a smaller one. A space holds only as many open panes as
// fit: an op that would add an open pane, or raise a pane's minimum, goes ahead only when the
// tree still fits the pane area. The GUI's geometry (gui/frontend/src/shell/geometry/rects.ts
// paneMinimum, minimumOf, treeFits) is the same function; testdata/fits.json holds the two to
// the same answer.

// The minimum size of a pane in layout px: every pane's, and that of a pane holding only
// terminals.
const (
	PaneMinW     = 480.0
	PaneMinH     = 400.0
	TerminalMinW = 300.0
	TerminalMinH = 220.0
)

// NoRoom is the reason an op that would add an open pane where none fits gives.
const NoRoom = "no room for another pane here: collapse or close one first"

// ErrNoRoom is the refusal of an op whose result would not fit the pane area. It is a
// failed precondition.
var ErrNoRoom = fmt.Errorf("%s: %w", NoRoom, ErrFailedPrecondition)

// Size is a width and a height in layout px.
type Size struct {
	W float64 `json:"w"`
	H float64 `json:"h"`
}

// terminalsOnly reports whether p has tabs and every one of them is a terminal.
func terminalsOnly(tabs []*Tab) bool {
	return len(tabs) > 0 && !slices.ContainsFunc(tabs, func(tb *Tab) bool { return tb.Kind != "terminal" })
}

// PaneMinimum is the size an open pane needs: TerminalMinW x TerminalMinH when every tab of it
// is a terminal, else PaneMinW x PaneMinH (an empty pane too).
func PaneMinimum(p *Node) Size {
	if terminalsOnly(p.Tabs) {
		return Size{TerminalMinW, TerminalMinH}
	}
	return Size{PaneMinW, PaneMinH}
}

// MinimumOf is the smallest pane area root fits in with no pane folded automatically: each open
// pane at its minimum, each collapsed pane a Rail square, and the Gutters, summed along each
// split and the largest across it. The proportions play no part. A nil tree needs nothing.
func MinimumOf(root *Node) Size {
	if root == nil {
		return Size{}
	}
	if root.IsPane() {
		if root.Collapsed {
			return Size{Rail, Rail}
		}
		return PaneMinimum(root)
	}
	var out Size
	for _, k := range root.Kids {
		m := MinimumOf(k)
		if root.Dir == Row {
			out.W += m.W
			out.H = max(out.H, m.H)
		} else {
			out.H += m.H
			out.W = max(out.W, m.W)
		}
	}
	gutters := Gutter * float64(max(0, len(root.Kids)-1))
	if root.Dir == Row {
		out.W += gutters
	} else {
		out.H += gutters
	}
	return out
}

// Fits reports whether root fits a w x h pane area with no pane folded automatically: every
// open pane keeps its minimum and every collapsed pane its rail (MinimumOf). A tree with at
// most one pane always fits: a space's first pane is never refused.
func Fits(root *Node, w, h float64) bool {
	if root == nil || root.IsPane() {
		return true
	}
	m := MinimumOf(root)
	return m.W <= w && m.H <= h
}

// needRoom is nil when sp's tree fits the pane area w x h (unknown: the default, viewport),
// else ErrNoRoom.
func needRoom(sp *Space, w, h float64) error {
	w, h = viewport(w, h)
	if Fits(sp.Root, w, h) {
		return nil
	}
	return ErrNoRoom
}

// raises reports whether adding tabs to pane p raises its minimum: p holds only terminals and
// a tab added is not one.
func raises(p *Node, tabs ...*Tab) bool {
	return terminalsOnly(p.Tabs) && !terminalsOnly(tabs)
}

// canTake reports whether open pane p of sp can take tabs without the tree no longer fitting
// w x h: true unless they raise its minimum and the tree would then not fit. A collapsed pane
// can always take them (opening a collapsed pane is always allowed).
func canTake(sp *Space, p *Node, w, h float64, tabs ...*Tab) bool {
	if p.Collapsed || !raises(p, tabs...) {
		return true
	}
	saved := p.Tabs
	p.Tabs = append(slices.Clone(p.Tabs), tabs...)
	ok := Fits(sp.Root, w, h)
	p.Tabs = saved
	return ok
}

// fitsBeside reports whether sp's tree would fit w x h with a pane holding tabs put on that
// edge of pane target (Root, for the whole area's edge). Nothing changes.
func fitsBeside(sp *Space, target string, edge Edge, w, h float64, tabs ...*Tab) bool {
	if sp.Root == nil {
		return true
	}
	c := &Space{Root: sp.Root.clone()}
	np := &Node{T: NodePane, ID: "p-probe", Tabs: tabs}
	if target == "" {
		target = c.Root.ID
	}
	if err := insertBeside(c, target, edge, np, defaultFrac, "s-probe"); err != nil {
		return false
	}
	return Fits(c.Root, w, h)
}

// IsNoRoom reports whether err is a refusal for want of room.
func IsNoRoom(err error) bool { return errors.Is(err, ErrNoRoom) }
