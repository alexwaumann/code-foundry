package layout

import (
	"fmt"
	"maps"
	"math"
	"slices"
	"strings"
)

func init() {
	register("add_tab", func() Op { return &AddTab{} })
	register("split_pane", func() Op { return &SplitPane{} })
	register("move_tab", func() Op { return &MoveTab{} })
	register("move_pane", func() Op { return &MovePane{} })
	register("merge_pane", func() Op { return &MergePane{} })
	register("swap_pane", func() Op { return &SwapPane{} })
	register("close_tab", func() Op { return &CloseTab{} })
	register("close_pane", func() Op { return &ClosePane{} })
	register("set_sizes", func() Op { return &SetSizes{} })
	register("focus_tab", func() Op { return &FocusTab{} })
	register("focus_pane", func() Op { return &FocusPane{} })
	register("set_tab_params", func() Op { return &SetTabParams{} })
	register("rename_tab", func() Op { return &RenameTab{} })
}

// AddTab adds a tab to a pane: Pane, else the focused pane of Space ("" is the current
// space), else a new pane when the space is empty. It lands at Index, else right after the
// pane's active tab. A tab whose identity is already open in its scope is not added: that one
// is used (with Params and Title replaced when given) and Result.Existing is set.
type AddTab struct {
	Space string `json:"space,omitempty"`
	Pane  string `json:"pane,omitempty"`
	Tab   *Tab   `json:"tab"`
	Index *int   `json:"index,omitempty"`
	// Focus moves the focus to the tab. Without it the tab becomes active in its pane unless
	// that pane has the focus, where it waits behind the active tab.
	Focus bool `json:"focus,omitempty"`
}

// OpName implements Op.
func (*AddTab) OpName() string { return "add_tab" }

func (o *AddTab) apply(t *tx) (Result, error) {
	sp, err := t.space(o.Space)
	if err != nil {
		return Result{}, err
	}
	var pane *Node
	if o.Pane != "" {
		psp, p, err := t.pane(o.Pane)
		if err != nil {
			return Result{}, err
		}
		if o.Space != "" && psp != sp {
			return Result{}, fmt.Errorf("pane %s is not in space %s: %w", o.Pane, sp.ID, ErrInvalidArgument)
		}
		sp, pane = psp, p
	}
	tb := o.Tab.Clone()
	same, err := t.prepare(sp, tb)
	if err != nil {
		return Result{}, err
	}
	if same != nil {
		ssp, sp2, _ := t.st.FindTab(same.ID)
		if tb.Params != nil {
			same.Params = tb.Params
		}
		if tb.Title != "" {
			same.Title = tb.Title
		}
		t.show(ssp, sp2, same.ID, o.Focus)
		return Result{Space: ssp.ID, Pane: sp2.ID, Tab: same.ID, Existing: true}, nil
	}
	if pane == nil {
		for _, p := range Panes(sp.Root) {
			if p.ID == sp.Focus {
				pane = p
			}
		}
	}
	if pane == nil {
		pane = &Node{T: NodePane, ID: t.newID("p-"), Tabs: []*Tab{tb}, Active: tb.ID}
		sp.Root = pane
	} else {
		at := pane.TabIndex(pane.Active) + 1
		if o.Index != nil {
			at = *o.Index
		}
		pane.Tabs = slices.Insert(pane.Tabs, clampIndex(at, len(pane.Tabs)), tb)
	}
	t.show(sp, pane, tb.ID, o.Focus)
	return Result{Space: sp.ID, Pane: pane.ID, Tab: tb.ID}, nil
}

func clampIndex(i, n int) int { return max(0, min(i, n)) }

// SplitPane opens a new tab in a new pane on an edge of Pane, taking Frac of its room
// (0 is half; it is kept between 0.05 and 0.95). A tab whose identity is already open in its
// scope is refused: move that one with move_tab.
type SplitPane struct {
	Pane  string  `json:"pane"`
	Edge  Edge    `json:"edge"`
	Tab   *Tab    `json:"tab"`
	Frac  float64 `json:"frac,omitempty"`
	Focus bool    `json:"focus,omitempty"`
}

// OpName implements Op.
func (*SplitPane) OpName() string { return "split_pane" }

func (o *SplitPane) apply(t *tx) (Result, error) {
	if !o.Edge.Valid() {
		return Result{}, fmt.Errorf("edge %q: %w", o.Edge, ErrInvalidArgument)
	}
	sp, target, err := t.pane(o.Pane)
	if err != nil {
		return Result{}, err
	}
	tb := o.Tab.Clone()
	same, err := t.prepare(sp, tb)
	if err != nil {
		return Result{}, err
	}
	if same != nil {
		return Result{}, fmt.Errorf("%s is already open as %s: %w", same.Key, same.ID, ErrAlreadyExists)
	}
	np := &Node{T: NodePane, ID: t.newID("p-"), Tabs: []*Tab{tb}, Active: tb.ID}
	if err := insertBeside(sp, target.ID, o.Edge, np, o.Frac, t.newID("s-")); err != nil {
		return Result{}, err
	}
	t.show(sp, np, tb.ID, o.Focus)
	return Result{Space: sp.ID, Pane: np.ID, Tab: tb.ID}, nil
}

// MoveTab moves a tab, which then has the focus in the space it lands in:
//   - Pane and Edge: into a new pane on that edge of Pane, at Frac of its room. A pane's only
//     tab dropped on its own edge stays where it is.
//   - Pane: into that pane's strip at Index (default: the end); in its own pane, a reorder.
//   - Edge alone: into a new pane on that edge of the whole pane area of Space ("" is the
//     tab's own space), at Frac of it (default: the tab's kind's size, outerFrac).
//   - Space alone: into that space's focused pane after its active tab, or a new pane.
//
// A thread tab never changes space here (moving a thread is its own op); a tab whose identity
// is already open in the target space is refused.
type MoveTab struct {
	Tab   string  `json:"tab"`
	Space string  `json:"space,omitempty"`
	Pane  string  `json:"pane,omitempty"`
	Index *int    `json:"index,omitempty"`
	Edge  Edge    `json:"edge,omitempty"`
	Frac  float64 `json:"frac,omitempty"`
	// W and H are the pane area in layout px, which an outer edge's default size measures.
	W float64 `json:"w,omitempty"`
	H float64 `json:"h,omitempty"`
}

// OpName implements Op.
func (*MoveTab) OpName() string { return "move_tab" }

func (o *MoveTab) apply(t *tx) (Result, error) {
	from, src, tb, err := t.tab(o.Tab)
	if err != nil {
		return Result{}, err
	}
	if o.Edge != "" && !o.Edge.Valid() {
		return Result{}, fmt.Errorf("edge %q: %w", o.Edge, ErrInvalidArgument)
	}
	to := from
	if o.Space != "" {
		if to, err = t.space(o.Space); err != nil {
			return Result{}, err
		}
	}
	var target *Node
	if o.Pane != "" {
		psp, p, err := t.pane(o.Pane)
		if err != nil {
			return Result{}, err
		}
		if o.Space != "" && psp != to {
			return Result{}, fmt.Errorf("pane %s is not in space %s: %w", o.Pane, to.ID, ErrInvalidArgument)
		}
		to, target = psp, p
	}
	if to != from {
		if tb.Kind == "thread" {
			return Result{}, fmt.Errorf("thread tab %s: a thread moves to another space with its linked tabs: %w", tb.ID, ErrFailedPrecondition)
		}
		k, _ := KindOf(tb.Kind)
		if same := t.sameTab(to, k, tb.Key, tb.ID); same != nil {
			return Result{}, fmt.Errorf("%s is already open in space %s as %s: %w", tb.Key, to.ID, same.ID, ErrAlreadyExists)
		}
	}
	wasFocused := focusedTab(from) == tb.ID

	switch {
	case target != nil && o.Edge != "":
		if target == src && len(src.Tabs) == 1 {
			focusTab(to, src, tb.ID)
			return Result{Space: to.ID, Pane: src.ID, Tab: tb.ID}, nil
		}
		detach(from, src, tb.ID)
		np := &Node{T: NodePane, ID: t.newID("p-"), Tabs: []*Tab{tb}, Active: tb.ID}
		if err := insertBeside(to, target.ID, o.Edge, np, o.Frac, t.newID("s-")); err != nil {
			return Result{}, err
		}
		target = np
	case target != nil:
		at := len(target.Tabs)
		if o.Index != nil {
			at = *o.Index
		}
		if target == src {
			i := src.TabIndex(tb.ID)
			if i < at {
				at--
			}
			src.Tabs = slices.Delete(src.Tabs, i, i+1)
			src.Tabs = slices.Insert(src.Tabs, clampIndex(at, len(src.Tabs)), tb)
			break
		}
		detach(from, src, tb.ID)
		target.Tabs = slices.Insert(target.Tabs, clampIndex(at, len(target.Tabs)), tb)
	case o.Edge != "":
		detach(from, src, tb.ID)
		target = &Node{T: NodePane, ID: t.newID("p-"), Tabs: []*Tab{tb}, Active: tb.ID}
		if err := toOuter(t, to, target, o.Edge, o.Frac, o.W, o.H); err != nil {
			return Result{}, err
		}
	default:
		if to == from {
			return Result{}, fmt.Errorf("move_tab needs a pane, an edge or another space: %w", ErrInvalidArgument)
		}
		detach(from, src, tb.ID)
		for _, p := range Panes(to.Root) {
			if p.ID == to.Focus {
				target = p
			}
		}
		if target == nil {
			target = &Node{T: NodePane, ID: t.newID("p-"), Tabs: []*Tab{tb}}
			to.Root = target
		} else {
			target.Tabs = slices.Insert(target.Tabs, target.TabIndex(target.Active)+1, tb)
		}
	}
	if to != from {
		forget(from, tb.ID)
		if wasFocused {
			refocus(from)
		}
	}
	focusTab(to, target, tb.ID)
	return Result{Space: to.ID, Pane: target.ID, Tab: tb.ID}, nil
}

// outerFrac is the share pane node takes on an edge of the whole pane area of sp: frac when
// one is given; otherwise the default size of the kind of its active tab, as a share of the
// area along that edge's axis less its gutters, raised to the kind's floor when the area
// (w x h; 0 when unknown) is known and the rest still keeps KeepPx. A drop beside a pane splits
// it in half; only the outer edge takes a kind's size (docs/notes/shell-14b-outer-edge-size.md).
func outerFrac(sp *Space, node *Node, edge Edge, frac, w, h float64) float64 {
	if frac != 0 {
		return frac
	}
	var k *Kind
	if i := node.TabIndex(node.Active); i >= 0 {
		k, _ = KindOf(node.Tabs[i].Kind)
	}
	if k == nil {
		return defaultFrac
	}
	length := w
	if edge.dir() == Col {
		length = h
	}
	// The panes along the axis once node is in: it joins a root split that runs that way.
	count := 2
	if r := sp.Root; r != nil && !r.IsPane() && r.Dir == edge.dir() {
		count = len(r.Kids) + 1
	}
	room := length - Gutter*float64(count-1)
	if !(room > 0) || math.IsInf(room, 0) {
		return k.DefaultFrac
	}
	return k.sizeIn(room) / room
}

// toOuter puts node on an edge of the whole pane area of sp (w x h), at frac of it or, for
// 0, its kind's size (outerFrac).
func toOuter(t *tx, sp *Space, node *Node, edge Edge, frac, w, h float64) error {
	if sp.Root == nil {
		sp.Root = node
		return nil
	}
	return insertBeside(sp, sp.Root.ID, edge, node, outerFrac(sp, node, edge, frac, w, h), t.newID("s-"))
}

// MovePane moves a whole pane, which then has the focus:
//   - Target and Edge: beside Target on that edge, at Frac of its room.
//   - Edge alone: on that edge of the whole pane area, at Frac of it (default: the size of
//     its active tab's kind, outerFrac).
//   - Space: to the right of that space's focused pane (or as its only pane), whole, in one
//     step. Each thread whose tab it holds then lives in that space and takes its other linked
//     tabs in the old space along, placed by the rules beside it, as move_thread does (one of
//     those whose identity is open there already is closed in favour of it: Result.Closed).
type MovePane struct {
	Pane   string  `json:"pane"`
	Target string  `json:"target,omitempty"`
	Edge   Edge    `json:"edge,omitempty"`
	Frac   float64 `json:"frac,omitempty"`
	Space  string  `json:"space,omitempty"`
	// W and H are the pane area in layout px, which an outer edge's default size measures.
	W float64 `json:"w,omitempty"`
	H float64 `json:"h,omitempty"`
}

// OpName implements Op.
func (*MovePane) OpName() string { return "move_pane" }

func (o *MovePane) apply(t *tx) (Result, error) {
	from, pane, err := t.pane(o.Pane)
	if err != nil {
		return Result{}, err
	}
	if o.Space != "" {
		if o.Target != "" || o.Edge != "" {
			return Result{}, fmt.Errorf("move_pane takes a space or a target and edge, not both: %w", ErrInvalidArgument)
		}
		return o.toSpace(t, from, pane)
	}
	if !o.Edge.Valid() {
		return Result{}, fmt.Errorf("edge %q: %w", o.Edge, ErrInvalidArgument)
	}
	if o.Target == "" {
		removeNode(from, pane.ID)
		if err := toOuter(t, from, pane, o.Edge, o.Frac, o.W, o.H); err != nil {
			return Result{}, err
		}
	} else {
		tsp, target, err := t.pane(o.Target)
		if err != nil {
			return Result{}, err
		}
		if tsp != from || target == pane {
			return Result{}, fmt.Errorf("pane %s cannot move beside %s: %w", pane.ID, target.ID, ErrInvalidArgument)
		}
		removeNode(from, pane.ID)
		if err := insertBeside(from, target.ID, o.Edge, pane, o.Frac, t.newID("s-")); err != nil {
			return Result{}, err
		}
	}
	focusTab(from, pane, pane.Active)
	return Result{Space: from.ID, Pane: pane.ID, Tab: pane.Active}, nil
}

func (o *MovePane) toSpace(t *tx, from *Space, pane *Node) (Result, error) {
	to, err := t.space(o.Space)
	if err != nil {
		return Result{}, err
	}
	if to == from {
		return Result{}, fmt.Errorf("pane %s is already in space %s: %w", pane.ID, to.ID, ErrInvalidArgument)
	}
	ids := make([]string, 0, len(pane.Tabs))
	var threads []string
	for _, tb := range pane.Tabs {
		if tb.Kind == "thread" {
			threads = append(threads, tb.Thread)
		}
		k, _ := KindOf(tb.Kind)
		if same := t.sameTab(to, k, tb.Key, tb.ID); same != nil {
			return Result{}, fmt.Errorf("%s is already open in space %s as %s: %w", tb.Key, to.ID, same.ID, ErrAlreadyExists)
		}
		ids = append(ids, tb.ID)
	}
	wasFocused := from.Focus == pane.ID
	dropPane(from, pane.ID)
	forget(from, ids...)
	// The threads' other linked tabs in the old space go with them.
	var follow []*Tab
	for _, th := range threads {
		if t.st.SpaceOf(th) != from.ID {
			continue // a thread living elsewhere: its tab was dragged here by hand
		}
		for _, p := range Panes(from.Root) {
			for _, tb := range slices.Clone(p.Tabs) {
				if tb.IsLinked() && tb.Thread == th {
					wasFocused = wasFocused || focusedTab(from) == tb.ID
					detach(from, p, tb.ID)
					forget(from, tb.ID)
					follow = append(follow, tb)
				}
			}
		}
		t.setThreadSpace(th, to.ID)
	}
	if wasFocused {
		refocus(from)
	}
	if to.Root == nil {
		to.Root = pane
	} else if err := insertBeside(to, to.Focus, Right, pane, defaultFrac, t.newID("s-")); err != nil {
		return Result{}, err
	}
	focusTab(to, pane, pane.Active)
	res := Result{Space: to.ID, Pane: pane.ID, Tab: pane.Active}
	w, h := viewport(o.W, o.H)
	for _, tb := range follow {
		k, _ := KindOf(tb.Kind)
		if t.sameTab(to, k, tb.Key, tb.ID) != nil {
			res.Closed = append(res.Closed, tb)
			continue
		}
		r, err := t.place(to, nil, tb, false, w, h)
		if err != nil {
			return Result{}, err
		}
		res.Placed = append(res.Placed, r.Tab)
	}
	focusTab(to, pane, pane.Active)
	return res, nil
}

// MergePane moves every tab of Pane into Target's strip at Index (default: the end). Pane's
// active tab stays active, and Target takes the focus.
type MergePane struct {
	Pane   string `json:"pane"`
	Target string `json:"target"`
	Index  *int   `json:"index,omitempty"`
}

// OpName implements Op.
func (*MergePane) OpName() string { return "merge_pane" }

func (o *MergePane) apply(t *tx) (Result, error) {
	sp, pane, err := t.pane(o.Pane)
	if err != nil {
		return Result{}, err
	}
	tsp, target, err := t.pane(o.Target)
	if err != nil {
		return Result{}, err
	}
	if tsp != sp || target == pane {
		return Result{}, fmt.Errorf("pane %s cannot merge into %s: %w", pane.ID, target.ID, ErrInvalidArgument)
	}
	removeNode(sp, pane.ID)
	at := len(target.Tabs)
	if o.Index != nil {
		at = clampIndex(*o.Index, len(target.Tabs))
	}
	target.Tabs = slices.Insert(target.Tabs, at, pane.Tabs...)
	focusTab(sp, target, pane.Active)
	return Result{Space: sp.ID, Pane: target.ID, Tab: pane.Active}, nil
}

// SwapPane swaps two panes of one space: each takes the other's place and share. The focus
// stays where it was.
type SwapPane struct {
	Pane   string `json:"pane"`
	Target string `json:"target"`
}

// OpName implements Op.
func (*SwapPane) OpName() string { return "swap_pane" }

func (o *SwapPane) apply(t *tx) (Result, error) {
	sp, a, err := t.pane(o.Pane)
	if err != nil {
		return Result{}, err
	}
	tsp, b, err := t.pane(o.Target)
	if err != nil {
		return Result{}, err
	}
	if tsp != sp || a == b {
		return Result{}, fmt.Errorf("pane %s cannot swap with %s: %w", a.ID, b.ID, ErrInvalidArgument)
	}
	pa, ia, _ := parentOf(sp.Root, a.ID)
	pb, ib, _ := parentOf(sp.Root, b.ID)
	pa.Kids[ia], pb.Kids[ib] = b, a
	return Result{Space: sp.ID, Pane: a.ID}, nil
}

// CloseTab takes a tab out of the layout. When it had the focus, the focus returns to the
// newest tab in the space's MRU that is still open. This is the plain close; closing a thread
// with its linked tabs is the thread op built on it.
type CloseTab struct {
	Tab string `json:"tab"`
}

// OpName implements Op.
func (*CloseTab) OpName() string { return "close_tab" }

func (o *CloseTab) apply(t *tx) (Result, error) {
	sp, pane, tb, err := t.tab(o.Tab)
	if err != nil {
		return Result{}, err
	}
	wasFocused := focusedTab(sp) == tb.ID
	detach(sp, pane, tb.ID)
	forget(sp, tb.ID)
	if wasFocused {
		refocus(sp)
	}
	return Result{Space: sp.ID, Closed: []*Tab{tb}}, nil
}

// ClosePane takes a pane and all its tabs out of the layout; the focus returns as CloseTab's.
// Each thread tab in it closes as close_thread closes it, first: the thread's linked tabs in
// its space are remembered (Result.Kept), wherever they are. W and H are the pane area that
// measures where they were (default DefaultW x DefaultH).
type ClosePane struct {
	Pane string  `json:"pane"`
	W    float64 `json:"w,omitempty"`
	H    float64 `json:"h,omitempty"`
}

// OpName implements Op.
func (*ClosePane) OpName() string { return "close_pane" }

func (o *ClosePane) apply(t *tx) (Result, error) {
	sp, pane, err := t.pane(o.Pane)
	if err != nil {
		return Result{}, err
	}
	res := Result{Space: sp.ID}
	w, h := viewport(o.W, o.H)
	for _, tb := range slices.Clone(pane.Tabs) {
		if tb.Kind == "thread" {
			r := t.closeThread(tb.Thread, tb.ID, w, h)
			res.Closed = append(res.Closed, r.Closed...)
			res.Kept = append(res.Kept, r.Kept...)
		}
	}
	if _, pane = t.st.FindPane(o.Pane); pane == nil {
		return res, nil
	}
	wasFocused := sp.Focus == pane.ID
	ids := make([]string, len(pane.Tabs))
	for i, tb := range pane.Tabs {
		ids[i] = tb.ID
	}
	dropPane(sp, pane.ID)
	forget(sp, ids...)
	if wasFocused {
		refocus(sp)
	}
	res.Closed = append(res.Closed, pane.Tabs...)
	return res, nil
}

// SetSizes sets a split's shares, one per child, each positive; they are scaled to sum to 1.
type SetSizes struct {
	Split string    `json:"split"`
	Sizes []float64 `json:"sizes"`
}

// OpName implements Op.
func (*SetSizes) OpName() string { return "set_sizes" }

func (o *SetSizes) apply(t *tx) (Result, error) {
	sp, split := t.st.FindSplit(o.Split)
	if split == nil {
		return Result{}, fmt.Errorf("split %q: %w", o.Split, ErrNotFound)
	}
	if len(o.Sizes) != len(split.Kids) {
		return Result{}, fmt.Errorf("split %s has %d children, got %d sizes: %w", split.ID, len(split.Kids), len(o.Sizes), ErrInvalidArgument)
	}
	tot := 0.0
	for _, s := range o.Sizes {
		if !(s > 0) || math.IsInf(s, 0) {
			return Result{}, fmt.Errorf("size %v: %w", s, ErrInvalidArgument)
		}
		tot += s
	}
	if math.IsInf(tot, 0) {
		return Result{}, fmt.Errorf("sizes too large: %w", ErrInvalidArgument)
	}
	split.Sizes = make([]float64, len(o.Sizes))
	for i, s := range o.Sizes {
		split.Sizes[i] = s / tot
	}
	return Result{Space: sp.ID}, nil
}

// FocusTab makes a tab active, focuses its pane, and switches to its space.
type FocusTab struct {
	Tab string `json:"tab"`
}

// OpName implements Op.
func (*FocusTab) OpName() string { return "focus_tab" }

func (o *FocusTab) apply(t *tx) (Result, error) {
	sp, pane, tb, err := t.tab(o.Tab)
	if err != nil {
		return Result{}, err
	}
	focusTab(sp, pane, tb.ID)
	t.st.CurrentSpace = sp.ID
	return Result{Space: sp.ID, Pane: pane.ID, Tab: tb.ID}, nil
}

// FocusPane focuses a pane (its active tab) and switches to its space.
type FocusPane struct {
	Pane string `json:"pane"`
}

// OpName implements Op.
func (*FocusPane) OpName() string { return "focus_pane" }

func (o *FocusPane) apply(t *tx) (Result, error) {
	sp, pane, err := t.pane(o.Pane)
	if err != nil {
		return Result{}, err
	}
	focusTab(sp, pane, pane.Active)
	t.st.CurrentSpace = sp.ID
	return Result{Space: sp.ID, Pane: pane.ID, Tab: pane.Active}, nil
}

// SetTabParams replaces a tab's params (and its title when given). Its identity follows the
// new params; one that collides with another open tab is refused. A composer's "draft" param
// is the draft ops' own: it is kept when left out, and changing it is refused.
type SetTabParams struct {
	Tab    string            `json:"tab"`
	Params map[string]string `json:"params"`
	Title  *string           `json:"title,omitempty"`
}

// OpName implements Op.
func (*SetTabParams) OpName() string { return "set_tab_params" }

func (o *SetTabParams) apply(t *tx) (Result, error) {
	sp, pane, tb, err := t.tab(o.Tab)
	if err != nil {
		return Result{}, err
	}
	next := tb.Clone()
	next.Params = o.Params
	if id := draftOf(tb); tb.Kind == "compose" && o.Params[DraftParam] != id {
		if o.Params[DraftParam] != "" || id == "" {
			return Result{}, fmt.Errorf("a composer's draft changes only through the draft ops: %w", ErrInvalidArgument)
		}
		next.Params = maps.Clone(o.Params)
		if next.Params == nil {
			next.Params = map[string]string{}
		}
		next.Params[DraftParam] = id
	}
	if o.Title != nil {
		next.Title = *o.Title
	}
	k, key, err := Identify(next)
	if err != nil {
		return Result{}, err
	}
	if same := t.sameTab(sp, k, key, tb.ID); same != nil {
		return Result{}, fmt.Errorf("%s is already open as %s: %w", key, same.ID, ErrAlreadyExists)
	}
	next.Key = key
	*tb = *next
	return Result{Space: sp.ID, Pane: pane.ID, Tab: tb.ID}, nil
}

// RenameTab sets a renameable tab's manual name; "" goes back to the automatic name.
type RenameTab struct {
	Tab  string `json:"tab"`
	Name string `json:"name"`
}

// OpName implements Op.
func (*RenameTab) OpName() string { return "rename_tab" }

func (o *RenameTab) apply(t *tx) (Result, error) {
	sp, pane, tb, err := t.tab(o.Tab)
	if err != nil {
		return Result{}, err
	}
	if k, _ := KindOf(tb.Kind); !k.Renameable {
		return Result{}, fmt.Errorf("a %s tab takes no name: %w", tb.Kind, ErrFailedPrecondition)
	}
	tb.Name = strings.TrimSpace(o.Name)
	return Result{Space: sp.ID, Pane: pane.ID, Tab: tb.ID}, nil
}
