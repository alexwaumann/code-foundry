package layout

import (
	"cmp"
	"fmt"
	"math"
	"slices"
)

// Placement (docs/notes/shell-model.md, "Linked surfaces"; decisions in
// docs/notes/shell-2-placement.md). A surface opened by a key, a menu or the palette lands:
//
//  1. where it is already open in this space (focused, no second copy);
//  2. in a pane holding this thread's linked tabs, after the last of them;
//  3. in a pane next to the thread's pane holding linked surfaces of any thread;
//  4. in any pane of the space holding linked surfaces;
//  5. in a new pane to the right of the thread's pane, at the kind's default size, when the
//     result fits the pane area (fit.go: every open pane keeps its minimum);
//  6. in the thread's own pane, right after the thread's tab.
//
// In 2 to 4 a pane that holds a linked tab of this thread ranks first, then (rule 3) the side
// in the order right, left, below, above, then the nearest by centre distance; a pane of
// terminals the tab would not fit in (canTake) is no candidate. A joined pane is never
// resized. The caller's pane ("+") wins over 2 to 6, and is refused when it cannot take the
// tab; a tab whose thread has no tab in the space, and a tab of no thread, go to the focused
// pane, or the most recently focused pane that can take it (hostPane).

// The pane area placement measures when the op names none (plan section 2.4), and the width
// the rest keeps when a new pane's size is raised to its kind's floor: a pane's minimum.
const (
	DefaultW = 1180.0
	DefaultH = 820.0
	KeepPx   = PaneMinW
)

func init() {
	register("open_surface", func() Op { return &OpenSurface{} })
}

// viewport is (w, h), or the default pane area when either is not a positive number.
func viewport(w, h float64) (float64, float64) {
	if !(w > 0) || !(h > 0) || math.IsInf(w, 0) || math.IsInf(h, 0) {
		return DefaultW, DefaultH
	}
	return w, h
}

// OpenSurface opens a surface other than a thread's own tab (that is open_thread) by the
// placement rules. Space is where it opens: by default its thread's space for a linked tab,
// the current space otherwise. Pane is the pane whose "+" asked: the tab opens there, except
// that a linked tab already open is focused where it is (an unlinked one already open in the
// space moves there). W and H are the pane area in layout px (default DefaultW x DefaultH).
// Behind is a tab the user is working in (typing in its editor): when the tab lands in the
// pane showing it, it waits behind it there, as in the focused pane; anywhere else it shows as
// usual. Focus overrides it.
type OpenSurface struct {
	Space  string  `json:"space,omitempty"`
	Pane   string  `json:"pane,omitempty"`
	Tab    *Tab    `json:"tab"`
	Focus  bool    `json:"focus,omitempty"`
	Behind string  `json:"behind,omitempty"`
	W      float64 `json:"w,omitempty"`
	H      float64 `json:"h,omitempty"`
}

// OpName implements Op.
func (*OpenSurface) OpName() string { return "open_surface" }

func (o *OpenSurface) apply(t *tx) (Result, error) {
	if o.Tab == nil {
		return Result{}, fmt.Errorf("no tab given: %w", ErrInvalidArgument)
	}
	tb := o.Tab.Clone()
	if tb.Kind == "thread" {
		return Result{}, fmt.Errorf("a thread's own tab opens with open_thread: %w", ErrInvalidArgument)
	}
	var sp *Space
	var pane *Node
	var err error
	switch {
	case o.Pane != "":
		if sp, pane, err = t.pane(o.Pane); err != nil {
			return Result{}, err
		}
		if o.Space != "" && sp.ID != o.Space {
			return Result{}, fmt.Errorf("pane %s is not in space %s: %w", o.Pane, o.Space, ErrInvalidArgument)
		}
	case o.Space != "":
		if sp, err = t.space(o.Space); err != nil {
			return Result{}, err
		}
	case tb.IsLinked():
		if sp, err = t.space(t.st.SpaceOf(tb.Thread)); err != nil {
			return Result{}, err
		}
	default:
		if sp, err = t.space(""); err != nil {
			return Result{}, err
		}
	}
	w, h := viewport(o.W, o.H)
	var keep *Node
	if _, bp, _ := t.st.FindTab(o.Behind); o.Behind != "" && !o.Focus && bp != nil && bp.Active == o.Behind {
		keep = bp
	}
	res, err := t.place(sp, pane, tb, o.Focus, w, h)
	if err == nil && keep != nil && res.Pane == keep.ID && keep.TabIndex(o.Behind) >= 0 {
		keep.Active = o.Behind
	}
	return res, err
}

// place opens tab tb in space sp by the rules above; chosen is the caller's pane or nil.
func (t *tx) place(sp *Space, chosen *Node, tb *Tab, focus bool, w, h float64) (Result, error) {
	same, err := t.prepare(sp, tb)
	if err != nil {
		return Result{}, err
	}
	if tb.IsLinked() {
		t.dropRemembered(tb.Thread, tb.Key)
	}
	if same != nil {
		return t.placeExisting(sp, chosen, same, tb, focus), nil
	}
	put := func(p *Node, at int, rule string) (Result, error) {
		p.Tabs = slices.Insert(p.Tabs, clampIndex(at, len(p.Tabs)), tb)
		t.show(sp, p, tb.ID, focus)
		return Result{Space: sp.ID, Pane: p.ID, Tab: tb.ID, Rule: rule}, nil
	}
	if chosen != nil {
		if !canTake(sp, chosen, w, h, tb) {
			return Result{}, ErrNoRoom
		}
		return put(chosen, chosen.TabIndex(chosen.Active)+1, "pane")
	}
	tsp, tp, _ := t.st.FindTab(threadTabID(t.st, tb.Thread))
	if !tb.IsLinked() || tp == nil || tsp != sp {
		fp := hostPane(sp, w, h, tb)
		if fp == nil {
			fp = &Node{T: NodePane, ID: t.newID("p-"), Tabs: []*Tab{tb}, Active: tb.ID}
			sp.Root = fp
			t.show(sp, fp, tb.ID, focus)
			return Result{Space: sp.ID, Pane: fp.ID, Tab: tb.ID, Rule: "focused"}, nil
		}
		return put(fp, fp.TabIndex(fp.Active)+1, "focused")
	}
	L := Rects(sp.Root, w, h)

	// Rule 2: a pane holding this thread's linked tabs, after the last of them.
	var mine []*Node
	for _, p := range Panes(sp.Root) {
		if lastLinkedOf(p, tb.Thread) >= 0 && canTake(sp, p, w, h, tb) {
			mine = append(mine, p)
		}
	}
	if len(mine) > 0 {
		p := rank(L, tp, tb.Thread, mine, false)[0]
		return put(p, lastLinkedOf(p, tb.Thread)+1, "2")
	}

	// Rule 3: a pane next to the thread's pane holding linked surfaces.
	var next []*Node
	for _, side := range sideOrder {
		for _, id := range L.SideNeighbours(tp.ID, side) {
			if _, p := t.st.FindPane(id); p != nil && holdsLinked(p) && !slices.Contains(next, p) && canTake(sp, p, w, h, tb) {
				next = append(next, p)
			}
		}
	}
	if len(next) > 0 {
		p := rank(L, tp, tb.Thread, next, true)[0]
		return put(p, len(p.Tabs), "3")
	}

	// Rule 4: any pane of the space holding linked surfaces.
	var holding []*Node
	for _, p := range Panes(sp.Root) {
		if holdsLinked(p) && canTake(sp, p, w, h, tb) {
			holding = append(holding, p)
		}
	}
	if len(holding) > 0 {
		p := rank(L, tp, tb.Thread, holding, false)[0]
		return put(p, len(p.Tabs), "4")
	}

	// Rule 5: room for a new pane to the right of the thread's pane.
	if frac, ok := roomBeside(L.Rects[tp.ID].W, tb.Kind); ok && fitsBeside(sp, tp.ID, Right, w, h, tb) {
		np := &Node{T: NodePane, ID: t.newID("p-"), Tabs: []*Tab{tb}, Active: tb.ID}
		if err := insertBeside(sp, tp.ID, Right, np, frac, t.newID("s-")); err != nil {
			return Result{}, err
		}
		t.show(sp, np, tb.ID, focus)
		return Result{Space: sp.ID, Pane: np.ID, Tab: tb.ID, Rule: "5"}, nil
	}

	// Rule 6: the thread's own pane, right after the thread's tab.
	return put(tp, tp.TabIndex(threadTabID(t.st, tb.Thread))+1, "6")
}

// placeExisting is rule 1: the identity is already open. The caller's pane takes an unlinked
// tab open elsewhere in its space; otherwise the tab is focused where it is. Params and title
// given with the request replace the open tab's, as add_tab does.
func (t *tx) placeExisting(sp *Space, chosen *Node, same, req *Tab, focus bool) Result {
	if req.Params != nil {
		same.Params = req.Params
	}
	if req.Title != "" {
		same.Title = req.Title
	}
	ssp, sp2, _ := t.st.FindTab(same.ID)
	if chosen != nil && !same.IsLinked() && ssp == sp && sp2 != chosen {
		detach(sp, sp2, same.ID)
		chosen.Tabs = slices.Insert(chosen.Tabs, chosen.TabIndex(chosen.Active)+1, same)
		sp2 = chosen
	}
	t.show(ssp, sp2, same.ID, focus)
	return Result{Space: ssp.ID, Pane: sp2.ID, Tab: same.ID, Existing: true, Rule: "1"}
}

// sideOrder is the order rule 3 tries the thread pane's sides in.
var sideOrder = []Edge{Right, Left, Bottom, Top}

// rank orders candidate panes for rules 2 to 4: a pane holding a linked tab of thread first;
// then, with bySide, the side of the thread's pane it touches in sideOrder; then the nearest
// by the distance between centres (|dx| + |dy|); then layout order.
func rank(L *Layout, tp *Node, thread string, cands []*Node, bySide bool) []*Node {
	r := L.Rects[tp.ID]
	cx, cy := r.X+r.W/2, r.Y+r.H/2
	side := func(p *Node) int {
		if !bySide {
			return 0
		}
		for i, s := range sideOrder {
			if slices.Contains(L.SideNeighbours(tp.ID, s), p.ID) {
				return i
			}
		}
		return len(sideOrder)
	}
	dist := func(p *Node) float64 {
		o := L.Rects[p.ID]
		return math.Abs(o.X+o.W/2-cx) + math.Abs(o.Y+o.H/2-cy)
	}
	mineFirst := func(p *Node) int {
		if lastLinkedOf(p, thread) >= 0 {
			return 0
		}
		return 1
	}
	out := slices.Clone(cands) // cands are in layout order; the sort is stable
	slices.SortStableFunc(out, func(a, b *Node) int {
		return cmp.Or(
			cmp.Compare(mineFirst(a), mineFirst(b)),
			cmp.Compare(side(a), side(b)),
			cmp.Compare(dist(a), dist(b)),
		)
	})
	return out
}

// roomBeside is the share of a pane width wide that a new pane of kind to its right takes
// (rule 5): the kind's default share, raised to its floor when the rest still keeps KeepPx.
// Whether there is room is not its question: the tree after the split must fit (fitsBeside).
func roomBeside(width float64, kind string) (float64, bool) {
	k, ok := KindOf(kind)
	if !ok {
		return 0, false
	}
	room := width - Gutter
	if room <= 0 {
		return 0, false
	}
	return k.sizeIn(room) / room, true
}

// sizeIn is the px a new pane of kind k takes of room px: its default share, raised to its
// floor when the rest still keeps KeepPx.
func (k *Kind) sizeIn(room float64) float64 {
	px := k.DefaultFrac * room
	if k.FloorPx > 0 && px < k.FloorPx && room-k.FloorPx >= KeepPx {
		px = k.FloorPx
	}
	return px
}

// lastLinkedOf is the index of the last linked tab of thread in pane p, or -1.
func lastLinkedOf(p *Node, thread string) int {
	for i := len(p.Tabs) - 1; i >= 0; i-- {
		if tb := p.Tabs[i]; tb.IsLinked() && tb.Thread == thread {
			return i
		}
	}
	return -1
}

// holdsLinked reports whether pane p holds a linked surface of any thread.
func holdsLinked(p *Node) bool {
	return slices.ContainsFunc(p.Tabs, (*Tab).IsLinked)
}

// hostPane is the pane a tab goes to when it goes to the focused pane: the focused pane when it
// can take tb (canTake), else the most recently focused pane that can, else the focused pane
// all the same (no pane can: automatic folding copes, as for a small window). Nil in an empty
// space.
func hostPane(sp *Space, w, h float64, tb *Tab) *Node {
	fp := focusedPane(sp)
	if fp == nil || canTake(sp, fp, w, h, tb) {
		return fp
	}
	if p := recentTaker(sp, w, h, tb); p != nil {
		return p
	}
	return fp
}

// recentTaker is the most recently focused open pane of sp that can take tb (by the space's
// MRU, then layout order for panes never focused), or nil.
func recentTaker(sp *Space, w, h float64, tb *Tab) *Node {
	panes := Panes(sp.Root)
	order := make([]*Node, 0, len(panes))
	for _, id := range sp.MRU {
		for _, p := range panes {
			if p.TabIndex(id) >= 0 && !slices.Contains(order, p) {
				order = append(order, p)
			}
		}
	}
	for _, p := range panes {
		if !slices.Contains(order, p) {
			order = append(order, p)
		}
	}
	for _, p := range order {
		if !p.Collapsed && canTake(sp, p, w, h, tb) {
			return p
		}
	}
	return nil
}

// focusedPane is the space's focused pane, or nil when it has none.
func focusedPane(sp *Space) *Node {
	for _, p := range Panes(sp.Root) {
		if p.ID == sp.Focus {
			return p
		}
	}
	return nil
}

// threadTabID is the id of thread's own tab, or "" when it is not open (or thread is "").
func threadTabID(st *State, thread string) string {
	if thread == "" {
		return ""
	}
	key := "thread:" + thread
	for _, sp := range st.Spaces {
		for _, p := range Panes(sp.Root) {
			for _, tb := range p.Tabs {
				if tb.Key == key {
					return tb.ID
				}
			}
		}
	}
	return ""
}
