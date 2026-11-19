package layout

import (
	"fmt"
	"slices"
)

// Threads open as (docs/notes/shell-model.md, "Threads open as"; decisions in
// docs/notes/threads-open-as-1-rules.md). The setting layout.threads_open_as says how a
// thread's own tab opens:
//
//   - Tabs: as a tab beside the others, by the placement rules (place.go threadHost).
//   - Panes: a pane that shows a thread (a thread pane) holds exactly that thread's tab, or a
//     composer, and nothing else. Opening a thread replaces the thread of the target thread
//     pane (the focused pane when it is one, else the most recently focused one, else a new
//     pane on the left of the pane area): the old thread closes as closing its tab closes it.
//     Only an explicit place makes a second thread pane: an edge, Beside, Parent's pane, a pane
//     of other tabs it is dropped on.
//   - Single: as Panes, with at most one thread pane per space; every open replaces, and
//     Beside is refused.
//
// Under Panes and Single every op ends with conform, which puts any layout into that form, and
// smart swap is on whatever Options.NoSmartSwap says. The op Conform does nothing else: run
// when the setting changes or a layout loads under it, it is the conversion.

// Mode is the setting layout.threads_open_as.
type Mode string

// Modes.
const (
	ModeTabs   Mode = "tabs"
	ModePanes  Mode = "panes"
	ModeSingle Mode = "single"
)

// Modes lists the modes in the setting's order.
var Modes = []Mode{ModeTabs, ModePanes, ModeSingle}

// ParseMode reads a setting value; "" is Tabs.
func ParseMode(s string) (Mode, error) {
	switch m := Mode(s); m {
	case "":
		return ModeTabs, nil
	case ModeTabs, ModePanes, ModeSingle:
		return m, nil
	}
	return "", fmt.Errorf("threads open as %q: not tabs, panes or single: %w", s, ErrInvalidArgument)
}

// Panes reports whether m keeps each thread in a pane of its own (Panes and Single).
func (m Mode) Panes() bool { return m == ModePanes || m == ModeSingle }

// errSingleBeside is Beside refused under Single.
var errSingleBeside = fmt.Errorf("threads open as single (setting layout.threads_open_as): a space shows one thread at a time, "+
	"so a thread cannot open beside another; open it without beside to replace the thread shown, or set layout.threads_open_as "+
	"to panes: %w", ErrFailedPrecondition)

func init() {
	register("conform", func() Op { return &Conform{} })
}

// Conform changes nothing by itself. Under Panes or Single (Options.Mode), ApplyWith conforms
// the layout after it as after every op: it is the conversion run when the setting changes and
// when a layout stored under another mode loads (Result.Conformed counts what it did). Under
// Tabs it is a no-op. W and H are the pane area that measures where closed threads' linked
// tabs were.
type Conform struct {
	W float64 `json:"w,omitempty"`
	H float64 `json:"h,omitempty"`
}

// OpName implements Op.
func (*Conform) OpName() string { return "conform" }

func (o *Conform) setArea(w, h float64) { area(&o.W, &o.H, w, h) }

func (o *Conform) apply(t *tx) (Result, error) {
	if o.W > 0 && o.H > 0 && !(t.opts.W > 0 && t.opts.H > 0) {
		t.opts.W, t.opts.H = o.W, o.H
	}
	return Result{}, nil
}

// Conformed counts what conform changed: the thread tabs it closed (their linked tabs in the
// space joined their remembered sets, their terminals keep running), the composer tabs it closed
// (a draft stays listed), the thread panes that went with them (Single), the other tabs it moved
// out of a thread's pane into a pane of their own, and the spaces it changed.
type Conformed struct {
	ThreadTabs int `json:"thread_tabs"`
	Composers  int `json:"composers"`
	Panes      int `json:"panes"`
	Moved      int `json:"moved"`
	Spaces     int `json:"spaces"`
}

func (c Conformed) any() bool { return c.ThreadTabs+c.Composers+c.Panes+c.Moved > 0 }

// ConformPreview is what switching st to mode would close and move (Conform under mode on a
// copy), in a w x h pane area; nothing changes. A mode the layout already conforms to, and
// Tabs, report zeros.
func ConformPreview(st *State, mode Mode, w, h float64) (Conformed, error) {
	if !mode.Panes() {
		return Conformed{}, nil
	}
	_, res, err := ApplyWith(st, &Conform{W: w, H: h}, &SeqIDs{}, Options{Mode: mode, W: w, H: h})
	if err != nil || res.Conformed == nil {
		return Conformed{}, err
	}
	return *res.Conformed, nil
}

// threadLike reports whether tb is a thread's own tab or a composer (a thread to be): what a
// thread pane holds.
func threadLike(tb *Tab) bool { return tb != nil && (tb.Kind == "thread" || tb.Kind == "compose") }

// recentPanes is sp's panes, the most recently focused first (by the space's MRU), then those
// never focused in layout order.
func recentPanes(sp *Space) []*Node {
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
	return order
}

// threadPane is the target thread pane of sp: the focused pane when it holds a thread (or a
// composer), else the most recently focused pane that does; nil when no pane does.
func threadPane(sp *Space) *Node {
	if fp := focusedPane(sp); fp != nil && holdsThread(fp) {
		return fp
	}
	for _, p := range recentPanes(sp) {
		if holdsThread(p) {
			return p
		}
	}
	return nil
}

// occupant is the thread-like tab pane p shows: its active tab when that is one, else the one
// focused most recently (the space's MRU), else the first; nil when p holds none.
func occupant(sp *Space, p *Node) *Tab {
	if tb := p.ActiveTab(); threadLike(tb) {
		return tb
	}
	for _, id := range sp.MRU {
		if i := p.TabIndex(id); i >= 0 && threadLike(p.Tabs[i]) {
			return p.Tabs[i]
		}
	}
	for _, tb := range p.Tabs {
		if threadLike(tb) {
			return tb
		}
	}
	return nil
}

// admits reports whether placement may add tab tb to pane p under the mode: under Panes and
// Single a pane that holds a thread takes no other tab, and a thread-like tab joins no pane (it
// replaces, seat).
func (t *tx) admits(p *Node, tb *Tab) bool {
	if !t.opts.Mode.Panes() || p == nil {
		return true
	}
	return !threadLike(tb) && !holdsThread(p)
}

// replaceIn puts thread-like tab tb (prepared) in the place of pane p's occupant: a thread
// closes as closing its tab closes it (its linked tabs in sp join its remembered set,
// Result.Kept; its tab is in Result.Closed); a composer's tab closes (a draft stays listed).
// A pane with no occupant takes tb after its active tab.
func (t *tx) replaceIn(sp *Space, p *Node, tb *Tab, w, h float64, res *Result) {
	old := occupant(sp, p)
	if old == nil {
		p.Tabs = slices.Insert(p.Tabs, p.TabIndex(p.Active)+1, tb)
		return
	}
	if old.Kind == "thread" {
		res.Kept = append(res.Kept, t.putAway(sp, old.Thread, p.ID, w, h)...)
		_, p, _ = t.st.FindTab(old.ID)
	}
	p.Tabs[p.TabIndex(old.ID)] = tb
	if p.Active == old.ID {
		p.Active = tb.ID
	}
	forget(sp, old.ID)
	res.Closed = append(res.Closed, old)
}

// newPane puts tb in a new pane of sp: on edge of pane anchor, or of the whole pane area when
// anchor is nil (at the kind's size), or as the first pane of an empty space (with the id
// first when free: a thread's remembered pane). The pane opens folded when the tree no longer
// fits the w x h pane area with it open (fold: the caller collapses it again after showing it,
// refold).
func (t *tx) newPane(sp *Space, anchor *Node, edge Edge, tb *Tab, first string, w, h float64) (*Node, bool, error) {
	if sp.Root == nil {
		id := first
		if _, taken := t.st.FindPane(id); id == "" || taken != nil {
			id = t.newID("p-")
		}
		np := &Node{T: NodePane, ID: id, Tabs: []*Tab{tb}, Active: tb.ID}
		sp.Root = np
		return np, false, nil
	}
	np := &Node{T: NodePane, ID: t.newID("p-"), Tabs: []*Tab{tb}, Active: tb.ID}
	var err error
	if anchor != nil {
		err = insertBeside(sp, anchor.ID, edge, np, 0, t.newID("s-"))
	} else {
		err = toOuter(t, sp, np, edge, 0, w, h)
	}
	if err != nil {
		return nil, false, err
	}
	fold := !Fits(sp.Root, w, h)
	np.Collapsed = fold
	return np, fold, nil
}

// refold collapses pane id again after showing a tab in it opened it (t.focusTab).
func (t *tx) refold(id string) {
	if _, p := t.st.FindPane(id); p != nil {
		p.Collapsed = true
		t.revealed = slices.DeleteFunc(t.revealed, func(r string) bool { return r == id })
	}
}

// seat puts thread-like tab tb (prepared) into space sp under Panes and Single, and returns
// its pane: in place of the occupant of into when given; else in a new pane on edge of anchor
// (or of the whole area when anchor is nil and edge is given); else in place of the occupant
// of the space's thread pane (threadPane); else in a new pane on the left edge of the whole
// pane area, or as the first pane of an empty space. Result.Rule says which ("replace",
// "edge", "new"); Result.Collapsed that a new pane opened folded (fold.go: no room).
func (t *tx) seat(sp *Space, tb *Tab, into, anchor *Node, edge Edge, w, h float64, res *Result) (*Node, error) {
	if into == nil && anchor == nil && edge == "" {
		into = threadPane(sp)
	}
	if into != nil {
		t.replaceIn(sp, into, tb, w, h, res)
		res.Rule = "replace"
		return into, nil
	}
	rule := "edge"
	if anchor == nil && edge == "" {
		edge, rule = Left, "new"
	}
	first := ""
	if ts := t.st.Threads[tb.Thread]; tb.Kind == "thread" && ts != nil && ts.Remembered != nil {
		first = ts.Remembered.Pane
	}
	np, fold, err := t.newPane(sp, anchor, edge, tb, first, w, h)
	if err != nil {
		return nil, err
	}
	res.Rule, res.Collapsed = rule, fold
	return np, nil
}

// paneFor is the pane named by id: a pane of sp, or the pane of a thread whose tab is open in
// sp.
func (t *tx) paneFor(sp *Space, id string) (*Node, error) {
	if p := paneByID(sp, id); p != nil {
		return p, nil
	}
	if tid := threadTabID(t.st, id); tid != "" {
		if p := paneOf(sp, tid); p != nil {
			return p, nil
		}
	}
	return nil, fmt.Errorf("beside %q: no pane of space %s, nor a thread open in it: %w", id, sp.ID, ErrNotFound)
}

// openPanes is open_thread under Panes and Single (OpenThread's doc): the thread is not open
// yet, and it is not sent from a composer.
func (o *OpenThread) openPanes(t *tx, preview, snoozed bool) (Result, error) {
	single := t.opts.Mode == ModeSingle
	w, h := viewport(o.W, o.H)
	var sp *Space
	var given *Node
	if o.Pane != "" {
		psp, p, err := t.pane(o.Pane)
		if err != nil {
			return Result{}, err
		}
		if o.Archived {
			t.setThreadSpace(o.Thread, psp.ID)
		}
		if psp.ID != t.st.SpaceOf(o.Thread) {
			return Result{}, fmt.Errorf("thread %s lives in space %s, pane %s is in %s: %w", o.Thread, t.st.SpaceOf(o.Thread), p.ID, psp.ID, ErrFailedPrecondition)
		}
		sp, given = psp, p
	} else {
		if o.Archived {
			t.setThreadSpace(o.Thread, t.st.CurrentSpace)
		}
		var err error
		if sp, err = t.space(t.st.SpaceOf(o.Thread)); err != nil {
			return Result{}, err
		}
	}
	// Where it goes: into (replace), or a new pane on edge of anchor (or of the whole area).
	var into, anchor *Node
	var edge Edge
	switch {
	case o.Beside != "":
		if single {
			return Result{}, errSingleBeside
		}
		p, err := t.paneFor(sp, o.Beside)
		if err != nil {
			return Result{}, err
		}
		anchor, edge = p, Right
	case o.Edge != "" && single:
		// Single: a drop on an edge replaces the thread shown, as every open does.
	case o.Edge != "":
		anchor, edge = given, o.Edge
	case given != nil && holdsThread(given):
		into = given
	case given != nil && !single:
		// A pane of other tabs: the thread opens in its own pane on its left.
		anchor, edge = given, Left
	case given != nil:
		if threadPane(sp) == nil {
			anchor, edge = given, Left
		}
	case o.Parent != "" && !single:
		if tid := threadTabID(t.st, o.Parent); tid != "" {
			if p := paneOf(sp, tid); p != nil {
				anchor, edge = p, Right
			}
		}
	}
	if into == nil && anchor == nil && edge == "" {
		into = threadPane(sp)
	}
	res := Result{Space: sp.ID}
	if pp, old := previewIn(sp); preview && old != nil && pp != into {
		// The space's previous preview goes (in place, by replaceIn, when it is into's).
		res.Kept = append(res.Kept, t.putAway(sp, old.Thread, pp.ID, w, h)...)
		_, pp, _ = t.st.FindTab(old.ID)
		wasFocused := focusedTab(sp) == old.ID
		detach(sp, pp, old.ID)
		forget(sp, old.ID)
		if wasFocused {
			refocus(sp)
		}
		res.Closed = append(res.Closed, old)
		if anchor != nil && paneByID(sp, anchor.ID) == nil {
			anchor, edge, into = nil, "", threadPane(sp)
		}
	}
	tb := &Tab{Kind: "thread", Thread: o.Thread}
	if _, err := t.prepare(sp, tb); err != nil {
		return Result{}, err
	}
	tb.Preview = preview
	res.Tab = tb.ID
	if _, err := t.seat(sp, tb, into, anchor, edge, w, h, &res); err != nil {
		return Result{}, err
	}
	if !snoozed && !(preview && o.Child) {
		if err := t.restore(sp, o.Thread, w, h, &res); err != nil {
			return Result{}, err
		}
		t.freshQuick(o.Thread, &res)
	}
	_, pane, _ := t.st.FindTab(tb.ID)
	t.show(sp, pane, tb.ID, o.Focus)
	if res.Collapsed {
		t.refold(pane.ID)
	}
	res.Pane = pane.ID
	return res, nil
}

// placeComposer opens composer tab tb (prepared, not open yet) under Panes and Single: it is
// the content of a thread pane while it is written, so it goes where a thread opens (seat): in
// place of the thread of chosen when chosen holds one, beside chosen on its left when it is a
// pane of other tabs (Panes), else in place of the space's thread pane's thread.
func (t *tx) placeComposer(sp *Space, chosen *Node, tb *Tab, focus bool, w, h float64) (Result, error) {
	var into, anchor *Node
	var edge Edge
	switch {
	case chosen != nil && holdsThread(chosen):
		into = chosen
	case chosen != nil && (t.opts.Mode != ModeSingle || threadPane(sp) == nil):
		anchor, edge = chosen, Left
	}
	res := Result{Space: sp.ID, Tab: tb.ID}
	pane, err := t.seat(sp, tb, into, anchor, edge, w, h, &res)
	if err != nil {
		return Result{}, err
	}
	t.show(sp, pane, tb.ID, focus)
	if res.Collapsed {
		t.refold(pane.ID)
	}
	res.Pane = pane.ID
	return res, nil
}

// surfacePane is where a tab other than a thread's goes under Panes and Single when the rules
// would put it in a thread pane (from, the thread's pane or the focused pane): the most
// recently focused open pane of other tabs that can take it; else a new pane on the right of
// from, folded when it does not fit (the second result).
// It adds tb to that pane.
func (t *tx) surfacePane(sp *Space, from *Node, tb *Tab, w, h float64) (*Node, bool, error) {
	for _, p := range recentPanes(sp) {
		if !p.Collapsed && !holdsThread(p) && canTake(sp, p, w, h, tb) {
			p.Tabs = slices.Insert(p.Tabs, p.TabIndex(p.Active)+1, tb)
			return p, false, nil
		}
	}
	return t.newPane(sp, from, Right, tb, "", w, h)
}

// conform puts every space into the mode's form (Options.Mode Panes or Single), adding what it
// closed to res (Closed, Kept) and its counts (Conformed):
//
//  1. a pane holding thread-like tabs keeps one, its occupant (its active one, else the one
//     focused most recently); the other threads close as closing their tabs closes them, and
//     other composers' tabs close (a draft stays listed);
//  2. Single: a space keeps one thread pane, its target (threadPane: the focused one, else the
//     one focused most recently); the threads of the others close likewise, and a pane left
//     empty goes;
//  3. a thread pane holding other tabs keeps the thread (and its id, which remembered sets
//     name); the other tabs move together, in their order with their active tab, into a new
//     pane on its right, at half its room, which takes the focus when one of them had it.
func (t *tx) conform(res *Result) {
	w, h := viewport(t.opts.W, t.opts.H)
	var all Conformed
	for _, sp := range t.st.Spaces {
		var c Conformed
		t.conformSpace(sp, w, h, res, &c)
		if c.any() {
			c.Spaces = 1
		}
		all.ThreadTabs += c.ThreadTabs
		all.Composers += c.Composers
		all.Panes += c.Panes
		all.Moved += c.Moved
		all.Spaces += c.Spaces
	}
	if all.any() {
		res.Conformed = &all
	}
}

func (t *tx) conformSpace(sp *Space, w, h float64, res *Result, c *Conformed) {
	shut := func(tb *Tab) {
		_, p, _ := t.st.FindTab(tb.ID)
		if p == nil {
			return
		}
		if tb.Kind == "thread" {
			r := t.closeThread(tb.Thread, tb.ID, w, h, false)
			res.Closed = append(res.Closed, r.Closed...)
			res.Kept = append(res.Kept, r.Kept...)
			c.ThreadTabs++
			return
		}
		wasFocused := focusedTab(sp) == tb.ID
		detach(sp, p, tb.ID)
		forget(sp, tb.ID)
		if wasFocused {
			refocus(sp)
		}
		res.Closed = append(res.Closed, tb)
		c.Composers++
	}
	// 1. One thread per pane.
	for _, p := range Panes(sp.Root) {
		keep := occupant(sp, p)
		if keep == nil {
			continue
		}
		for _, tb := range slices.Clone(p.Tabs) {
			if tb != keep && threadLike(tb) {
				shut(tb)
			}
		}
	}
	// 2. Single: one thread pane per space.
	if t.opts.Mode == ModeSingle {
		keep := threadPane(sp)
		for _, p := range Panes(sp.Root) {
			if p == keep || !holdsThread(p) {
				continue
			}
			only := len(p.Tabs) == 1
			for _, tb := range slices.Clone(p.Tabs) {
				if threadLike(tb) {
					shut(tb)
				}
			}
			if only {
				c.Panes++
			}
		}
	}
	// 3. A thread pane holds nothing else.
	focused := focusedTab(sp)
	for _, p := range Panes(sp.Root) {
		if !holdsThread(p) || len(p.Tabs) < 2 {
			continue
		}
		keep := occupant(sp, p)
		others := slices.DeleteFunc(slices.Clone(p.Tabs), func(tb *Tab) bool { return tb == keep })
		active := others[0].ID
		if p.Active != keep.ID {
			active = p.Active
		} else {
			for _, id := range sp.MRU {
				if slices.ContainsFunc(others, func(tb *Tab) bool { return tb.ID == id }) {
					active = id
					break
				}
			}
		}
		p.Tabs, p.Active = []*Tab{keep}, keep.ID
		np := &Node{T: NodePane, ID: t.newID("p-"), Tabs: others, Active: active}
		if err := insertBeside(sp, p.ID, Right, np, 0, t.newID("s-")); err != nil {
			// p is in the tree: insertBeside cannot miss it. Leave the tabs where they were.
			p.Tabs, p.Active = append([]*Tab{keep}, others...), keep.ID
			continue
		}
		if slices.ContainsFunc(others, func(tb *Tab) bool { return tb.ID == focused }) {
			sp.Focus, np.Active = np.ID, focused
		}
		c.Moved += len(others)
	}
}
