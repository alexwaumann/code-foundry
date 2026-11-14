package layout

import (
	"fmt"
	"slices"
)

// The reopen history (docs/notes/shell-model.md, "Reopening closed tabs"; decisions in
// docs/notes/shell-25c-keys-drafts.md). A close the user makes (close_tab, close_pane and
// close_thread with Record) puts an entry first in its space's Closed list: the tab with its
// pane and place, or the whole pane with its tabs, active tab and where it sat. reopen_closed
// takes the newest entry that can still be reopened and puts it back. Closes that follow from
// something else (archive, snooze, a thread's linked tabs, a space removed, a shell that
// exited) never record: only the ops a user's close runs carry Record.

func init() {
	register("reopen_closed", func() Op { return &ReopenClosed{} })
}

// record puts e first in sp's reopen history, without the space's empty composer (New thread
// makes one); an entry left with no tab is not recorded. The tabs are copies without their
// keys, which reopening computes again.
func record(sp *Space, e *Closed) {
	var tabs []*Tab
	for _, tb := range e.Tabs {
		if tb.Kind == "compose" && draftOf(tb) == "" {
			continue
		}
		c := tb.Clone()
		c.Key = ""
		tabs = append(tabs, c)
	}
	if len(tabs) == 0 {
		return
	}
	e.Tabs = tabs
	sp.Closed = slices.Insert(sp.Closed, 0, e)
	if len(sp.Closed) > MaxClosed {
		sp.Closed = sp.Closed[:MaxClosed]
	}
}

// recordTab records tab tb, about to close in pane p: its place in the strip and, when it is
// the pane's only tab, where the pane sits.
func recordTab(sp *Space, p *Node, tb *Tab) {
	e := &Closed{Pane: p.ID, Tabs: []*Tab{tb}, Index: p.TabIndex(tb.ID)}
	if len(p.Tabs) == 1 {
		e.Beside = BesideInfo(sp.Root, p.ID)
	}
	record(sp, e)
}

// recordPane records pane p, about to close, with the tabs it holds now and active, the tab
// that was active when the close began.
func recordPane(sp *Space, p *Node, active string) {
	record(sp, &Closed{Pane: p.ID, Whole: true, Tabs: slices.Clone(p.Tabs), Active: active, Beside: BesideInfo(sp.Root, p.ID)})
}

// ReopenClosed reopens the newest entry of a space's reopen history ("" is the current space)
// that can still be reopened, and drops it with the entries before it that cannot. A tab
// cannot be reopened when Gone names it (the caller found its thread archived or removed, or
// its file gone), when its identity is no longer valid, when it is a thread's tab and the
// thread now lives in another space, or when it is a draft's tab and the space no longer lists
// the draft. In a pane's entry only those tabs are left out.
//
// A tab goes back into its pane at its old index while that pane is in the space; when the
// pane is gone and the tab was its only tab, the pane is rebuilt where it sat; otherwise it
// is placed as it would open now: a thread's tab as open_thread puts it, anything else by the
// placement rules (place). A pane is rebuilt beside the panes it sat beside that are still
// there, at its old share, else put on the right edge of the whole pane area at its active
// tab's kind's size (toOuter), or as the only pane of an empty space. A pane or tab takes its
// old id back while it is free. A thread's tab brings its remembered set back (restore); a
// terminal's tab comes back as a fresh shell the caller starts (Result.Fresh), without a "Run
// again" line. An entry whose tabs are all open again (the same identity) focuses the open
// one instead (Result.Existing). The reopened tab (a pane's active tab) takes the focus.
//
// Room (fit.go): a pane rebuilt (a pane's entry, or a tab that was its pane's only tab) that
// would not fit the pane area open comes back collapsed, still with the focus
// (Result.Collapsed); a tab whose old pane cannot take it (a pane of terminals it would not
// fit in) is placed as it would open now.
// With nothing left to reopen it changes nothing but the dropped entries, and Result.Tab is "".
// W and H are the pane area (default DefaultW x DefaultH).
type ReopenClosed struct {
	Space string   `json:"space,omitempty"`
	Gone  []string `json:"gone,omitempty"`
	W     float64  `json:"w,omitempty"`
	H     float64  `json:"h,omitempty"`
}

// OpName implements Op.
func (*ReopenClosed) OpName() string { return "reopen_closed" }

func (o *ReopenClosed) apply(t *tx) (Result, error) {
	sp, err := t.space(o.Space)
	if err != nil {
		return Result{}, err
	}
	w, h := viewport(o.W, o.H)
	for len(sp.Closed) > 0 {
		e := sp.Closed[0]
		sp.Closed = slices.Clone(sp.Closed[1:])
		if len(sp.Closed) == 0 {
			sp.Closed = nil
		}
		tabs := t.reopenable(sp, e, o.Gone)
		if len(tabs) == 0 {
			continue
		}
		return t.reopen(sp, e, tabs, w, h)
	}
	return Result{Space: sp.ID}, nil
}

// reopenable is the tabs of entry e that can come back into space sp, as copies with their
// keys, a terminal's without its "Run again" command.
func (t *tx) reopenable(sp *Space, e *Closed, gone []string) []*Tab {
	var out []*Tab
	for _, tb := range e.Tabs {
		if slices.Contains(gone, tb.ID) {
			continue
		}
		c := tb.Clone()
		if c.Kind == "terminal" && c.Params != nil {
			delete(c.Params, RanParam)
		}
		_, key, err := Identify(c)
		if err != nil {
			continue
		}
		c.Key = key
		switch {
		case c.Kind == "thread" && t.st.SpaceOf(c.Thread) != sp.ID:
			continue
		case c.Kind == "compose":
			if dsp, _ := findDraft(t.st, draftOf(c)); dsp != sp {
				continue
			}
		}
		out = append(out, c)
	}
	return out
}

// openCopy is the open tab with tb's identity, or nil.
func (t *tx) openCopy(sp *Space, tb *Tab) *Tab {
	if tb.Kind == "thread" {
		_, _, open := t.st.FindTab(threadTabID(t.st, tb.Thread))
		return open
	}
	k, _ := KindOf(tb.Kind)
	return t.sameTab(sp, k, tb.Key, "")
}

// reopen puts entry e's tabs (reopenable's) back into space sp.
func (t *tx) reopen(sp *Space, e *Closed, tabs []*Tab, w, h float64) (Result, error) {
	var fresh []*Tab
	var first *Tab // the open copy of the tab to show, when every tab is open already
	for _, tb := range tabs {
		open := t.openCopy(sp, tb)
		switch {
		case open == nil:
			fresh = append(fresh, tb)
		case first == nil || tb.ID == e.Active:
			first = open
		}
	}
	if len(fresh) == 0 {
		osp, p, _ := t.st.FindTab(first.ID)
		t.show(osp, p, first.ID, true)
		return Result{Space: osp.ID, Pane: p.ID, Tab: first.ID, Existing: true, Rule: "1"}, nil
	}
	for _, tb := range fresh {
		if tb.ID != "" && usedIDs(t.st)[tb.ID] {
			tb.ID = ""
		}
	}
	if e.Whole {
		return t.reopenPane(sp, e, fresh, w, h)
	}
	return t.reopenTab(sp, e, fresh[0], w, h)
}

// reopenTab puts one closed tab back: into its pane, into its pane rebuilt, or placed fresh.
func (t *tx) reopenTab(sp *Space, e *Closed, tb *Tab, w, h float64) (Result, error) {
	_, p := t.st.FindPane(e.Pane)
	if p != nil && !slices.Contains(PaneIDs(sp.Root), p.ID) {
		p = nil
	}
	if p != nil && !canTake(sp, p, w, h, tb) {
		// Its pane is there but has no room for it: it opens as it would now.
		p, e = nil, &Closed{Pane: e.Pane, Tabs: e.Tabs, Index: e.Index}
	}
	if tb.Kind == "thread" && (p != nil || e.Beside == nil) {
		op := &OpenThread{Thread: tb.Thread, Focus: true, W: w, H: h}
		if p != nil {
			op.Pane, op.Index = p.ID, &e.Index
		}
		res, err := op.apply(t)
		if err != nil {
			return Result{}, err
		}
		res.Rule = ""
		return res, nil
	}
	if p == nil && e.Beside != nil {
		if _, err := t.prepare(sp, tb); err != nil {
			return Result{}, err
		}
		np := &Node{T: NodePane, ID: t.paneID(e.Pane), Tabs: []*Tab{tb}, Active: tb.ID}
		if t.rebuild(sp, e.Beside, np) {
			return t.reopenedFolded(sp, np, []*Tab{tb}, tb.ID, "", w, h)
		}
		if tb.Kind == "thread" {
			tb.ID = ""
			return t.reopenTab(sp, &Closed{Pane: e.Pane, Tabs: e.Tabs, Index: e.Index}, tb, w, h)
		}
		tb.Key = ""
	}
	if p != nil {
		if _, err := t.prepare(sp, tb); err != nil {
			return Result{}, err
		}
		if tb.IsLinked() {
			t.dropRemembered(tb.Thread, tb.Key)
		}
		p.Tabs = slices.Insert(p.Tabs, clampIndex(e.Index, len(p.Tabs)), tb)
		return t.reopened(sp, []*Tab{tb}, tb.ID, "", w, h)
	}
	res, err := t.place(sp, nil, tb, true, w, h)
	if err != nil {
		return Result{}, err
	}
	if tb.Kind == "terminal" {
		res.Fresh = []string{res.Tab}
	}
	res.Rule = ""
	return res, nil
}

// reopenPane puts a closed pane back with tabs, beside where it sat or on the right edge.
func (t *tx) reopenPane(sp *Space, e *Closed, tabs []*Tab, w, h float64) (Result, error) {
	ids := map[string]string{} // a tab's id in the entry -> its id now
	for _, tb := range tabs {
		old := tb.ID
		if _, err := t.prepare(sp, tb); err != nil {
			return Result{}, err
		}
		if tb.IsLinked() {
			t.dropRemembered(tb.Thread, tb.Key)
		}
		if old != "" {
			ids[old] = tb.ID
		}
	}
	np := &Node{T: NodePane, ID: t.paneID(e.Pane), Tabs: tabs, Active: tabs[0].ID}
	if !t.rebuild(sp, e.Beside, np) {
		if err := toOuter(t, sp, np, Right, 0, w, h); err != nil {
			return Result{}, err
		}
	}
	show, prefer := tabs[0].ID, e.Active
	if id, ok := ids[e.Active]; ok {
		show, prefer = id, ""
	}
	return t.reopenedFolded(sp, np, tabs, show, prefer, w, h)
}

// reopenedFolded is reopened for a pane np just rebuilt: when the tree does not fit the pane
// area with it open, it comes back collapsed (the space's other panes keep their room) and
// keeps the focus (focus may rest on a collapsed pane), and Result.Collapsed says so. A
// thread's remembered set coming back is placed with np collapsed.
func (t *tx) reopenedFolded(sp *Space, np *Node, tabs []*Tab, show, prefer string, w, h float64) (Result, error) {
	fold := !Fits(sp.Root, w, h)
	np.Collapsed = fold
	res, err := t.reopened(sp, tabs, show, prefer, w, h)
	if err != nil || !fold {
		return res, err
	}
	np.Collapsed = true
	t.revealed = slices.DeleteFunc(t.revealed, func(id string) bool { return id == np.ID })
	res.Collapsed = true
	return res, nil
}

// reopened finishes a reopen of tabs: each thread's tab brings its remembered set back,
// terminals come back as fresh shells, and tab show takes the focus, or prefer when that is a
// tab a thread's set brought back into show's pane (the pane's active tab when it closed).
func (t *tx) reopened(sp *Space, tabs []*Tab, show, prefer string, w, h float64) (Result, error) {
	res := Result{Space: sp.ID}
	for _, tb := range tabs {
		switch tb.Kind {
		case "thread":
			if err := t.restore(sp, tb.Thread, w, h, &res); err != nil {
				return Result{}, err
			}
			if ts := t.st.Threads[tb.Thread]; ts != nil && ts.Quick != nil && ts.Quick.Fresh {
				ts.Quick.Fresh, ts.Quick.Open = false, true
				res.FreshQuick = tb.Thread
			}
		case "terminal":
			res.Fresh = append(res.Fresh, tb.ID)
		}
	}
	// A thread's set coming back into this pane may have ended up behind the shown tab, and a
	// tab restored after it may not be the reopened one: the reopened one shows.
	_, now, _ := t.st.FindTab(show)
	if now == nil {
		return Result{}, fmt.Errorf("reopened tab %s went missing: %w", show, ErrBroken)
	}
	if prefer != "" && now.TabIndex(prefer) >= 0 {
		show = prefer
	}
	t.show(sp, now, show, true)
	res.Pane, res.Tab = now.ID, show
	return res, nil
}

// paneID is id when nothing open uses it (a space, a node, a tab or a draft), else a new pane
// id. A thread's remembered set may name it: it is the pane its tabs go back into.
func (t *tx) paneID(id string) string {
	if id == "" {
		return t.newID("p-")
	}
	for _, sp := range t.st.Spaces {
		taken := sp.ID == id || slices.ContainsFunc(sp.Drafts, func(d *Draft) bool { return d.ID == id })
		walk(sp.Root, func(n *Node) {
			taken = taken || n.ID == id || n.TabIndex(id) >= 0
		})
		if taken {
			return t.newID("p-")
		}
	}
	return id
}

// rebuild puts pane np where b says a pane sat: beside those of its neighbours still in sp,
// on the same edge, at its old share (as putBack rebuilds a remembered tab's pane). False when
// none of them is left, and nothing changed.
func (t *tx) rebuild(sp *Space, b *Beside, np *Node) bool {
	if b == nil || !b.Edge.Valid() || sp.Root == nil {
		return false
	}
	have := PaneIDs(sp.Root)
	ids := slices.DeleteFunc(slices.Clone(b.Neighbours), func(id string) bool { return !slices.Contains(have, id) })
	if len(ids) == 0 {
		return false
	}
	saved := sp.Root.clone()
	target := groupRun(Lca(sp.Root, ids), ids, b.Edge, func() string { return t.newID("s-") })
	if err := insertBeside(sp, target.ID, b.Edge, np, b.Frac, t.newID("s-")); err != nil {
		sp.Root = saved
		return false
	}
	return true
}
