package layout

import (
	"fmt"
	"slices"
)

// A thread's own tab and its linked set (docs/notes/shell-model.md, "Linked surfaces"):
// opening a thread, closing it with its linked tabs remembered, restoring them, moving it to
// another space, archiving and snoozing it. Decisions are in docs/notes/shell-2-placement.md
// and docs/notes/snooze-without-teardown.md.

func init() {
	register("open_thread", func() Op { return &OpenThread{} })
	register("close_thread", func() Op { return &CloseThread{} })
	register("move_thread", func() Op { return &MoveThreadToSpace{} })
	register("archive_thread", func() Op { return &ArchiveThread{} })
	register("snooze_thread", func() Op { return &SnoozeThread{} })
}

// OpenThread opens a thread's own tab, or focuses it when it is open. It opens in the
// thread's space:
//   - Compose: in place of that composer tab, which it replaces (sending from the composer);
//     the thread then lives in the composer's space. Sending from a draft ends the draft
//     (Result.Draft);
//   - Pane: in that pane, which must be in the thread's space;
//   - otherwise in place of the space's empty composer when that is the space's only tab (an
//     ephemeral composer; a draft is never replaced), else after the active tab of the pane a
//     thread's own tab opens in (place.go threadHost: with smart placement, the focused pane
//     when it holds a thread, else the nearest pane that does, else the focused pane), else as
//     the first pane of an empty space.
//
// A place in the pane can be given with it, so a sidebar row dropped on the grid is one op:
//   - Pane and Index: at that place in Pane's strip (default: after its active tab);
//   - Pane and Edge: in a new pane on that edge of Pane, which it splits in half;
//   - Edge alone: in a new pane on that edge of the space's whole pane area, at the thread
//     kind's default size (unless the space shows only its empty composer, which it replaces).
//
// Archived says the thread is archived, which the layout cannot tell (an archived thread has
// no record, as a thread of the default space has none): it lives in no space, so its tab
// opens in the current space (Pane's, when given), which it then lives in.
//
// Room (fit.go): a new pane on an edge whose result would not fit the pane area is refused,
// and so is a Pane of terminals the thread would not fit in (ErrNoRoom); a focused pane of
// terminals that cannot take it gives way to the nearest pane holding a thread that can (smart
// placement), else to the most recently focused pane that can.
//
// Then the thread's remembered set comes back (Restore), unless the thread is snoozed
// (Snoozed, or ThreadState.Snoozed): then it waits for the thread to wake (preview.go). W and
// H are the pane area for placement (default DefaultW x DefaultH).
//
// Preview opens it as a preview tab (preview.go) when the thread is archived, snoozed or a
// child, and as a kept tab otherwise; it takes no place in a pane and no composer. The space's previous
// preview goes: in the pane the new one opens in, the new one takes its place in the strip;
// elsewhere it closes (Result.Closed; its linked tabs are remembered, Result.Kept). It is not
// recorded for reopen_closed. An open thread is focused where it is: a preview stays one
// when Preview asks again, and is kept otherwise.
//
// Snoozed says the thread is snoozed, as Archived says it is archived; the layout remembers
// it (ThreadState.Snoozed) until set_snoozed wakes it. Opening the tab forgets where a
// snooze closed it (ThreadState.SnoozedTab): the wake finds it open.
//
// Child says another thread created the thread and that creator still exists (the sidebar
// rule; its lead manages it). Only a preview reads it: a child's preview shows only its
// conversation, as a snoozed thread's does; its remembered set waits for a kept open.
//
// Under Panes and Single (Options.Mode, modes.go openPanes) a thread pane holds one thread:
// the thread replaces the thread (or composer) of the target thread pane, which closes as
// closing its tab closes it, unless a place asks for a new pane: an Edge (with or without
// Pane), Beside (a pane, or a thread whose tab is open: a new pane on its right), Parent (the
// thread it was opened from, which created it: a new pane on the right of Parent's pane), or a
// Pane of other tabs (a new pane on its left). A Pane that holds a thread is the target. Index
// is not read. Under Single every open replaces, Beside is refused, and a new pane is made only
// when the space has no thread pane. A new pane that does not fit opens folded
// (Result.Collapsed). Under Tabs, Beside opens in a new pane on the right of that pane and
// Parent is not read.
type OpenThread struct {
	Thread   string  `json:"thread"`
	Pane     string  `json:"pane,omitempty"`
	Index    *int    `json:"index,omitempty"`
	Edge     Edge    `json:"edge,omitempty"`
	Compose  string  `json:"compose,omitempty"`
	Archived bool    `json:"archived,omitempty"`
	Snoozed  bool    `json:"snoozed,omitempty"`
	Child    bool    `json:"child,omitempty"`
	Preview  bool    `json:"preview,omitempty"`
	Beside   string  `json:"beside,omitempty"`
	Parent   string  `json:"parent,omitempty"`
	Focus    bool    `json:"focus,omitempty"`
	W        float64 `json:"w,omitempty"`
	H        float64 `json:"h,omitempty"`
}

// OpName implements Op.
func (*OpenThread) OpName() string { return "open_thread" }

func (o *OpenThread) apply(t *tx) (Result, error) {
	if o.Thread == "" {
		return Result{}, fmt.Errorf("no thread given: %w", ErrInvalidArgument)
	}
	if o.Preview && (o.Pane != "" || o.Edge != "" || o.Index != nil || o.Compose != "" || o.Beside != "") {
		return Result{}, fmt.Errorf("a preview opens where a thread's tab opens: no pane, edge, index, beside or composer: %w", ErrInvalidArgument)
	}
	if o.Beside != "" && (o.Pane != "" || o.Edge != "" || o.Index != nil || o.Compose != "") {
		return Result{}, fmt.Errorf("beside is a place of its own: no pane, edge, index or composer: %w", ErrInvalidArgument)
	}
	if o.Snoozed && o.Compose == "" {
		threadState(t.st, o.Thread).Snoozed = true
	}
	snoozed := t.snoozed(o.Thread)
	preview := o.Preview && (o.Archived || snoozed || o.Child)
	if id := threadTabID(t.st, o.Thread); id != "" {
		if o.Compose != "" {
			return Result{}, fmt.Errorf("thread %s is already open as %s: %w", o.Thread, id, ErrFailedPrecondition)
		}
		sp, p, tb := t.st.FindTab(id)
		if !o.Preview {
			keepTab(tb)
		}
		t.show(sp, p, id, o.Focus)
		return Result{Space: sp.ID, Pane: p.ID, Tab: id, Existing: true, Rule: "1"}, nil
	}
	switch {
	case o.Edge != "" && !o.Edge.Valid():
		return Result{}, fmt.Errorf("edge %q: %w", o.Edge, ErrInvalidArgument)
	case o.Index != nil && (o.Pane == "" || o.Edge != ""):
		return Result{}, fmt.Errorf("an index is a place in a pane's strip: give the pane and no edge: %w", ErrInvalidArgument)
	case o.Compose != "" && (o.Edge != "" || o.Index != nil):
		return Result{}, fmt.Errorf("a thread sent from a composer takes its place: %w", ErrInvalidArgument)
	}
	if t.opts.Mode.Panes() && o.Compose == "" {
		return o.openPanes(t, preview, snoozed)
	}
	if o.Beside != "" {
		// Tabs: a new pane on the right of that pane, as a drop on its edge.
		sp, err := t.space(t.st.SpaceOf(o.Thread))
		if o.Archived {
			sp, err = t.space("")
		}
		if err != nil {
			return Result{}, err
		}
		p, err := t.paneFor(sp, o.Beside)
		if err != nil {
			return Result{}, err
		}
		next := *o
		next.Beside, next.Pane, next.Edge = "", p.ID, Right
		return next.apply(t)
	}
	w, h := viewport(o.W, o.H)
	var sp *Space
	var pane *Node
	var compose *Tab
	var kept []*Tab
	var closed *Tab // the space's previous preview, closed in another pane than the new one's
	rule := "focused"
	switch {
	case o.Compose != "":
		csp, cp, ct, err := t.tab(o.Compose)
		if err != nil {
			return Result{}, err
		}
		if ct.Kind != "compose" {
			return Result{}, fmt.Errorf("tab %s is a %s tab, not a composer: %w", ct.ID, ct.Kind, ErrInvalidArgument)
		}
		if o.Pane != "" && o.Pane != cp.ID {
			return Result{}, fmt.Errorf("the thread replaces composer %s in pane %s, not pane %s: %w", ct.ID, cp.ID, o.Pane, ErrInvalidArgument)
		}
		t.setThreadSpace(o.Thread, csp.ID)
		sp, pane, compose, rule = csp, cp, ct, "compose"
	case o.Pane != "":
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
		if o.Edge == "" && !canTake(psp, p, w, h, &Tab{Kind: "thread"}) {
			return Result{}, ErrNoRoom
		}
		sp, pane, rule = psp, p, "pane"
	default:
		if o.Archived {
			t.setThreadSpace(o.Thread, t.st.CurrentSpace)
		}
		var err error
		if sp, err = t.space(t.st.SpaceOf(o.Thread)); err != nil {
			return Result{}, err
		}
		var old *Tab
		if preview {
			var op *Node
			if op, old = previewIn(sp); old != nil {
				kept = t.putAway(sp, old.Thread, op.ID, w, h)
			}
		}
		if ps := Panes(sp.Root); len(ps) == 1 && len(ps[0].Tabs) == 1 && ps[0].Tabs[0].Kind == "compose" && draftOf(ps[0].Tabs[0]) == "" {
			pane, compose, rule = ps[0], ps[0].Tabs[0], "compose"
		} else {
			var near bool
			if pane, near = t.threadHost(sp, w, h, &Tab{Kind: "thread"}); near {
				rule = "near"
			}
		}
		switch {
		case old == nil:
		case pane != nil && pane.TabIndex(old.ID) >= 0:
			compose, rule = old, "preview"
		default:
			_, op, _ := t.st.FindTab(old.ID)
			wasFocused := focusedTab(sp) == old.ID
			detach(sp, op, old.ID)
			forget(sp, old.ID)
			if wasFocused {
				refocus(sp)
			}
			closed = old
		}
	}
	tb := &Tab{Kind: "thread", Thread: o.Thread}
	if _, err := t.prepare(sp, tb); err != nil {
		return Result{}, err
	}
	tb.Preview = preview
	if ts := t.st.Threads[o.Thread]; ts != nil {
		ts.SnoozedTab = nil // open now: the snooze's place is old news
	}
	res := Result{Space: sp.ID, Tab: tb.ID, Rule: rule, Kept: kept}
	if closed != nil {
		res.Closed = []*Tab{closed}
	}
	switch {
	case compose != nil:
		i := pane.TabIndex(compose.ID)
		pane.Tabs[i] = tb
		if pane.Active == compose.ID {
			pane.Active = tb.ID
		}
		forget(sp, compose.ID)
		res.Closed = []*Tab{compose}
		if id := draftOf(compose); id != "" {
			unlistDraft(t.st, id)
			res.Draft = id
		}
	case pane != nil && o.Edge != "":
		np := &Node{T: NodePane, ID: t.newID("p-"), Tabs: []*Tab{tb}, Active: tb.ID}
		var err error
		if o.Pane != "" {
			err = insertBeside(sp, pane.ID, o.Edge, np, 0, t.newID("s-"))
		} else {
			err = toOuter(t, sp, np, o.Edge, 0, w, h)
		}
		if err != nil {
			return Result{}, err
		}
		if err := needRoom(sp, w, h); err != nil {
			return Result{}, err
		}
		res.Rule = "edge"
	case pane != nil:
		at := pane.TabIndex(pane.Active) + 1
		if o.Index != nil {
			at = clampIndex(*o.Index, len(pane.Tabs))
		}
		pane.Tabs = slices.Insert(pane.Tabs, at, tb)
	default:
		// An empty space: the thread's first pane takes back the id of the pane the thread
		// was in when it closed, if that is free, so its remembered set goes back in place.
		id := ""
		if ts := t.st.Threads[o.Thread]; ts != nil && ts.Remembered != nil && ts.Remembered.Pane != "" {
			if _, old := t.st.FindPane(ts.Remembered.Pane); old == nil {
				id = ts.Remembered.Pane
			}
		}
		if id == "" {
			id = t.newID("p-")
		}
		pane = &Node{T: NodePane, ID: id, Tabs: []*Tab{tb}, Active: tb.ID}
		sp.Root = pane
	}
	// A child's preview leaves its set put away: a surface placed beside it would keep it.
	if !snoozed && !(preview && o.Child) {
		if err := t.restore(sp, o.Thread, w, h, &res); err != nil {
			return Result{}, err
		}
		t.freshQuick(o.Thread, &res)
	}
	_, pane, _ = t.st.FindTab(tb.ID)
	t.show(sp, pane, tb.ID, o.Focus)
	res.Pane = pane.ID
	return res, nil
}

// setThreadSpace makes thread live in space.
func (t *tx) setThreadSpace(thread, space string) {
	if t.st.SpaceOf(thread) != space {
		threadState(t.st, thread).Space = space
	}
}

// restore brings back thread's remembered set into space sp, where the thread's tab is open
// (docs/notes/shell-model.md: "into their old panes when the thread is back in the pane it was
// in, otherwise placed fresh beside it"). Records are put back last first, the inverse of the
// order closing took them out, so a pane that went away is rebuilt beside the neighbours it
// had at that moment; the rest are placed by the placement rules, in their old order. A record
// whose identity is open again is dropped.
func (t *tx) restore(sp *Space, thread string, w, h float64, res *Result) error {
	ts := t.st.Threads[thread]
	if ts == nil || ts.Remembered == nil {
		return nil
	}
	rem := ts.Remembered
	ts.Remembered = nil
	tid := threadTabID(t.st, thread)
	_, tp, _ := t.st.FindTab(tid)
	same := tp != nil && tp.ID == rem.Pane
	type item struct {
		rec RememberedTab
		tab *Tab
	}
	var rest []item
	for i := len(rem.Tabs) - 1; i >= 0; i-- {
		rec := rem.Tabs[i]
		tb := rec.Tab.Clone()
		if rec.Fresh != nil {
			tb.Name = rec.Fresh.Name
			if rec.Fresh.Ran != "" {
				if tb.Params == nil {
					tb.Params = map[string]string{}
				}
				tb.Params["ran"] = rec.Fresh.Ran
			}
		}
		// A tab that was in another space (a snooze took it from there, in a layout saved
		// before snoozes left terminals running) goes back there when its pane, or a
		// neighbour to rebuild it beside, is still there.
		home := sp
		if rec.Space != "" && rec.Space != sp.ID {
			if other := t.st.Space(rec.Space); other != nil {
				home = other
			}
		}
		k, key, err := Identify(tb)
		if err != nil || t.sameTab(home, k, key, "") != nil || (home != sp && t.sameTab(sp, k, key, "") != nil) {
			continue
		}
		tb.Key = key
		if !k.Renameable {
			tb.Name = ""
		}
		if tb.ID == "" || usedIDs(t.st)[tb.ID] {
			tb.ID = t.newID("t-")
		}
		if home != sp && t.putBack(home, rec, tb, "", w, h) {
			res.Back = append([]string{tb.ID}, res.Back...)
			if rec.Fresh != nil {
				res.Fresh = append(res.Fresh, tb.ID)
			}
			continue
		}
		if same && home == sp && t.putBack(sp, rec, tb, tid, w, h) {
			res.Back = append([]string{tb.ID}, res.Back...)
			if rec.Fresh != nil {
				res.Fresh = append(res.Fresh, tb.ID)
			}
			continue
		}
		rest = append([]item{{rec, tb}}, rest...)
	}
	// Each pane the rest land in shows the tab that was active when the set was remembered,
	// else the first that landed there (placing one by one would leave the last). The pane the
	// user was in keeps its tab: what lands there waits behind it.
	userPane := sp.Focus
	shows := map[string]string{}
	wasActive := map[string]bool{}
	var order []string
	for _, it := range rest {
		r, err := t.place(sp, nil, it.tab, false, w, h)
		if err != nil {
			return err
		}
		res.Placed = append(res.Placed, r.Tab)
		if it.rec.Fresh != nil {
			res.Fresh = append(res.Fresh, r.Tab)
		}
		if _, ok := shows[r.Pane]; !ok {
			order = append(order, r.Pane)
		}
		if _, ok := shows[r.Pane]; !ok || (it.rec.Active && !wasActive[r.Pane]) {
			shows[r.Pane], wasActive[r.Pane] = r.Tab, it.rec.Active
		}
	}
	for _, id := range order {
		if _, p := t.st.FindPane(id); p != nil && id != userPane && p.TabIndex(shows[id]) >= 0 {
			p.Active = shows[id]
		}
	}
	return nil
}

// putBack puts a remembered tab back where it was: into its old pane at its old index when
// that pane is still there and can take it (fit.go canTake), else into its old pane rebuilt
// beside the neighbours it had, at its old share and folded if it was (Collapsed), when the
// result fits the pane area. A tab that sat in or beside the thread's pane (Adjacent) goes back only where
// it is still beside it. It reports whether it put the tab back; when not, nothing changed.
func (t *tx) putBack(sp *Space, rec RememberedTab, tb *Tab, threadTab string, w, h float64) bool {
	besideThread := func() bool {
		if !rec.Adjacent {
			return true
		}
		_, tp, _ := t.st.FindTab(threadTab)
		return tp != nil && Rects(sp.Root, w, h).Adjacent(rec.Pane, tp.ID)
	}
	psp, p := t.st.FindPane(rec.Pane)
	if p != nil {
		if psp != sp || !besideThread() || !t.admits(p, tb) {
			return false
		}
		if !canTake(sp, p, w, h, tb) {
			return false
		}
		p.Tabs = slices.Insert(p.Tabs, clampIndex(rec.Index, len(p.Tabs)), tb)
		if rec.Active && p.ID != sp.Focus {
			p.Active = tb.ID
		}
		return true
	}
	if rec.Beside == nil || !rec.Beside.Edge.Valid() {
		return false
	}
	have := PaneIDs(sp.Root)
	ids := slices.DeleteFunc(slices.Clone(rec.Beside.Neighbours), func(id string) bool { return !slices.Contains(have, id) })
	if len(ids) == 0 {
		return false
	}
	saved := sp.Root.clone()
	target := groupRun(Lca(sp.Root, ids), ids, rec.Beside.Edge, func() string { return t.newID("s-") })
	// A pane the user had folded comes back folded: it is rebuilt as it was, and costs the
	// tree only its rail, so it fits where it would not open.
	np := &Node{T: NodePane, ID: rec.Pane, Tabs: []*Tab{tb}, Active: tb.ID, Collapsed: rec.Collapsed}
	if err := insertBeside(sp, target.ID, rec.Beside.Edge, np, rec.Beside.Frac, t.newID("s-")); err != nil || !besideThread() || !Fits(sp.Root, w, h) {
		sp.Root = saved
		return false
	}
	return true
}

// groupRun is the node a pane goes back beside when its old neighbours ids are no longer one
// node of their own: removing the pane let normalising merge their split into its parent of
// the same direction (row(col(row(a, b), c), d) loses c and becomes row(a, b, d)). When ids
// are exactly a run of two or more, but not all, of the children of split lca, and the pane
// goes back across that split's direction, the run is grouped again under a new split
// at the run's share (its id from newID), so the pane wraps the group as it did before.
// Otherwise it is lca.
func groupRun(lca *Node, ids []string, edge Edge, newID func() string) *Node {
	if lca == nil || lca.IsPane() || edge.dir() == lca.Dir {
		return lca
	}
	first, last, n := -1, -1, 0
	for i, k := range lca.Kids {
		have := PaneIDs(k)
		in := 0
		for _, p := range have {
			if slices.Contains(ids, p) {
				in++
			}
		}
		switch {
		case in == 0:
			continue
		case in < len(have) || (last >= 0 && last != i-1):
			return lca // a child only partly in the group, or a gap in the run
		}
		if first < 0 {
			first = i
		}
		last, n = i, n+in
	}
	if first < 0 || n != len(ids) || last-first < 1 || last-first+1 == len(lca.Kids) {
		return lca
	}
	run := slices.Clone(lca.Kids[first : last+1])
	share := sum(lca.Sizes[first : last+1])
	sizes := make([]float64, len(run))
	for i := range run {
		sizes[i] = lca.Sizes[first+i] / share
	}
	g := &Node{T: NodeSplit, ID: newID(), Dir: lca.Dir, Kids: run, Sizes: sizes}
	lca.Kids = slices.Replace(lca.Kids, first, last+1, g)
	lca.Sizes = slices.Replace(lca.Sizes, first, last+1, share)
	return g
}

// dropRemembered forgets the remembered tab of thread with that key: it was opened again by
// itself, so the thread's next open must not bring a second copy.
func (t *tx) dropRemembered(thread, key string) {
	ts := t.st.Threads[thread]
	if ts == nil || ts.Remembered == nil {
		return
	}
	ts.Remembered.Tabs = slices.DeleteFunc(ts.Remembered.Tabs, func(rt RememberedTab) bool {
		_, k, err := Identify(rt.Tab)
		return err == nil && k == key
	})
	if len(ts.Remembered.Tabs) == 0 {
		ts.Remembered = nil
	}
}

// putAway takes thread's linked tabs in space sp out of the layout into its remembered set,
// in layout order, recording where each was: its pane and index, whether it was active,
// whether its pane was the thread's pane or beside it (threadPane, measured in a w x h pane
// area before anything moves), and, when it was its pane's last tab, where that pane sat.
// Records already remembered are kept before the new ones. It returns the tabs it took.
func (t *tx) putAway(sp *Space, thread, threadPane string, w, h float64) []*Tab {
	L := Rects(sp.Root, w, h)
	var linked []*Tab
	for _, p := range Panes(sp.Root) {
		for _, tb := range p.Tabs {
			if tb.IsLinked() && tb.Thread == thread {
				linked = append(linked, tb)
			}
		}
	}
	if len(linked) == 0 {
		return nil
	}
	ts := threadState(t.st, thread)
	if ts.Remembered == nil {
		ts.Remembered = &Remembered{}
	}
	if threadPane != "" {
		ts.Remembered.Pane = threadPane
	}
	wasFocused := false
	for _, tb := range linked {
		_, p, _ := t.st.FindTab(tb.ID)
		rec := RememberedTab{
			Tab:      tb,
			Pane:     p.ID,
			Index:    p.TabIndex(tb.ID),
			Active:   p.Active == tb.ID,
			Adjacent: threadPane != "" && L.Adjacent(p.ID, threadPane),
		}
		if len(p.Tabs) == 1 {
			rec.Beside, rec.Collapsed = BesideInfo(sp.Root, p.ID), p.Collapsed
		}
		ts.Remembered.Tabs = append(ts.Remembered.Tabs, rec)
		wasFocused = wasFocused || focusedTab(sp) == tb.ID
		detach(sp, p, tb.ID)
		forget(sp, tb.ID)
	}
	if wasFocused {
		refocus(sp)
	}
	return linked
}

// CloseThread closes a thread's tab and the linked tabs in its space, remembering which were
// open and where; opening the thread again restores them. Terminals closed this way keep
// running (Result.Kept). The focus returns as close_tab's. Record puts the thread's tab in its
// space's reopen history (reopen.go): the user closed it; reopening it opens the thread.
type CloseThread struct {
	Thread string  `json:"thread"`
	W      float64 `json:"w,omitempty"`
	H      float64 `json:"h,omitempty"`
	Record bool    `json:"record,omitempty"`
}

// OpName implements Op.
func (*CloseThread) OpName() string { return "close_thread" }

func (o *CloseThread) apply(t *tx) (Result, error) {
	id := threadTabID(t.st, o.Thread)
	if id == "" {
		return Result{}, fmt.Errorf("thread %q has no open tab: %w", o.Thread, ErrNotFound)
	}
	w, h := viewport(o.W, o.H)
	res := t.closeThread(o.Thread, id, w, h, o.Record)
	return res, nil
}

// closeThread closes thread's open tab id with its linked tabs (putAway); record puts the tab,
// where it is once they are put away, in its space's reopen history.
func (t *tx) closeThread(thread, id string, w, h float64, record bool) Result {
	sp, p, tb := t.st.FindTab(id)
	kept := t.putAway(sp, thread, p.ID, w, h)
	_, p, _ = t.st.FindTab(id)
	if record {
		recordTab(sp, p, tb)
	}
	wasFocused := focusedTab(sp) == id
	detach(sp, p, id)
	forget(sp, id)
	if wasFocused {
		refocus(sp)
	}
	return Result{Space: sp.ID, Pane: p.ID, Tab: id, Closed: []*Tab{tb}, Kept: kept}
}

// MoveThreadToSpace moves a thread to another space with the linked tabs that are in its
// space; linked tabs dragged to some other space stay there. An open thread's tab opens in
// the target space's focused pane (as its active tab, without switching spaces) and its linked
// tabs are placed by the rules beside it; a thread with no tab open takes its linked tabs to
// the target's focused pane. A linked tab whose identity is already open in the target is
// closed in favour of that one. A remembered set is kept (its panes are in the old space, so
// it comes back placed fresh).
type MoveThreadToSpace struct {
	Thread string  `json:"thread"`
	Space  string  `json:"space"`
	W      float64 `json:"w,omitempty"`
	H      float64 `json:"h,omitempty"`
}

// OpName implements Op.
func (*MoveThreadToSpace) OpName() string { return "move_thread" }

func (o *MoveThreadToSpace) apply(t *tx) (Result, error) {
	if o.Thread == "" {
		return Result{}, fmt.Errorf("no thread given: %w", ErrInvalidArgument)
	}
	to, err := t.spaceByID(o.Space)
	if err != nil {
		return Result{}, err
	}
	from := t.st.Space(t.st.SpaceOf(o.Thread))
	if from == to {
		return Result{}, fmt.Errorf("thread %s already lives in space %s: %w", o.Thread, to.ID, ErrInvalidArgument)
	}
	w, h := viewport(o.W, o.H)
	res := Result{Space: to.ID}

	// Take the linked tabs that are in the old space, in layout order, and the thread's tab.
	var linked []*Tab
	if from != nil {
		wasFocused := false
		for _, p := range Panes(from.Root) {
			for _, tb := range p.Tabs {
				if tb.IsLinked() && tb.Thread == o.Thread {
					linked = append(linked, tb)
				}
			}
		}
		id := threadTabID(t.st, o.Thread)
		for _, tb := range linked {
			_, p, _ := t.st.FindTab(tb.ID)
			wasFocused = wasFocused || focusedTab(from) == tb.ID
			detach(from, p, tb.ID)
			forget(from, tb.ID)
		}
		if id != "" {
			_, p, tb := t.st.FindTab(id)
			wasFocused = wasFocused || focusedTab(from) == id
			detach(from, p, id)
			forget(from, id)
			res.Tab = tb.ID
		}
		if wasFocused {
			refocus(from)
		}
	}
	t.setThreadSpace(o.Thread, to.ID)

	if res.Tab != "" {
		// A moved tab is kept: no Preview on the new one.
		tb := &Tab{ID: res.Tab, Kind: "thread", Thread: o.Thread}
		if _, err := t.prepare(to, tb); err != nil {
			return Result{}, err
		}
		var pane *Node
		if t.opts.Mode.Panes() {
			// Panes and Single: it opens there as a thread opens (modes.go seat), replacing
			// the thread of the space's thread pane.
			var r Result
			if pane, err = t.seat(to, tb, nil, nil, "", w, h, &r); err != nil {
				return Result{}, err
			}
			res.Closed, res.Kept, res.Collapsed = append(res.Closed, r.Closed...), append(res.Kept, r.Kept...), r.Collapsed
		} else if pane = focusedPane(to); pane == nil {
			pane = &Node{T: NodePane, ID: t.newID("p-"), Tabs: []*Tab{tb}}
			to.Root = pane
		} else {
			pane.Tabs = slices.Insert(pane.Tabs, pane.TabIndex(pane.Active)+1, tb)
		}
		pane.Active = tb.ID
		to.Focus = pane.ID
		res.Pane = pane.ID
	}
	for _, tb := range linked {
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
	return res, nil
}

// ArchiveThread closes a thread's tab and its linked tabs in every space (Result.Closed: the
// caller ends the terminals among them) and forgets what the layout stored for it. A pane
// whose only tab was the thread's stays, the space's empty composer in its place
// (keep_pane.go). Terminals of its remembered set, which kept running, are in Result.Ended.
// An archived thread lives in no space: it falls back to the default space, and unarchiving
// moves it where it belongs.
type ArchiveThread struct {
	Thread string `json:"thread"`
}

// OpName implements Op.
func (*ArchiveThread) OpName() string { return "archive_thread" }

func (o *ArchiveThread) apply(t *tx) (Result, error) {
	if o.Thread == "" {
		return Result{}, fmt.Errorf("no thread given: %w", ErrInvalidArgument)
	}
	res := Result{}
	for _, sp := range t.st.Spaces {
		// Its linked tabs first, then its own: a pane left holding only the thread's own tab
		// stays, with New thread in its place (keep_pane.go).
		var gone, linked, own []*Tab
		for _, p := range Panes(sp.Root) {
			for _, tb := range p.Tabs {
				switch {
				case tb.Thread != o.Thread:
					continue
				case tb.Kind == "thread":
					own = append(own, tb)
				default:
					linked = append(linked, tb)
				}
				gone = append(gone, tb)
			}
		}
		wasFocused := false
		for _, tb := range append(linked, own...) {
			_, p, _ := t.st.FindTab(tb.ID)
			if tb.Kind == "thread" && t.composerInPlace(sp, p, tb.ID) != nil {
				continue
			}
			wasFocused = wasFocused || focusedTab(sp) == tb.ID
			detach(sp, p, tb.ID)
			forget(sp, tb.ID)
		}
		if wasFocused {
			refocus(sp)
		}
		res.Closed = append(res.Closed, gone...)
	}
	if ts := t.st.Threads[o.Thread]; ts != nil {
		res.Ended = runningTerminals(ts.Remembered)
		delete(t.st.Threads, o.Thread)
	}
	return res, nil
}

// runningTerminals lists the terminal tabs of a remembered set that are still running (not
// already ended by a snooze, in a layout saved before snoozes left terminals running).
func runningTerminals(r *Remembered) []*Tab {
	if r == nil {
		return nil
	}
	var out []*Tab
	for _, rt := range r.Tabs {
		if rt.Tab.Kind == "terminal" && rt.Fresh == nil {
			out = append(out, rt.Tab)
		}
	}
	return out
}

// SnoozeThread closes a thread as close_thread does: its tab when open, and its linked tabs
// in its space, remembered (Result.Kept); their terminals and its quick terminal keep
// running. It is not recorded for reopen_closed. A pane whose only tab it was stays, the
// space's empty composer in its place (keep_pane.go). Where its tab was is remembered
// (ThreadState.SnoozedTab), so the snooze ending puts it back there (set_snoozed). The
// layout then knows the thread is snoozed (ThreadState.Snoozed): its tab, opened before
// then, shows only its conversation (docs/notes/snooze-without-teardown.md).
type SnoozeThread struct {
	Thread string  `json:"thread"`
	W      float64 `json:"w,omitempty"`
	H      float64 `json:"h,omitempty"`
}

// OpName implements Op.
func (*SnoozeThread) OpName() string { return "snooze_thread" }

func (o *SnoozeThread) apply(t *tx) (Result, error) {
	if o.Thread == "" {
		return Result{}, fmt.Errorf("no thread given: %w", ErrInvalidArgument)
	}
	w, h := viewport(o.W, o.H)
	var res Result
	var away *SnoozedTab
	if id := threadTabID(t.st, o.Thread); id != "" {
		sp, p, tb := t.st.FindTab(id)
		active := p.Active == id
		kept := t.putAway(sp, o.Thread, p.ID, w, h)
		_, p, _ = t.st.FindTab(id)
		// Its place once its linked tabs are out, as close_thread records it for reopening.
		away = &SnoozedTab{Space: sp.ID, Pane: p.ID, Index: p.TabIndex(id), Active: active}
		if len(p.Tabs) == 1 {
			away.Beside = BesideInfo(sp.Root, p.ID)
		}
		if c := t.composerInPlace(sp, p, id); c != nil {
			away.Composer = c.ID // the pane stays, showing New thread (keep_pane.go)
		} else {
			wasFocused := focusedTab(sp) == id
			detach(sp, p, id)
			forget(sp, id)
			if wasFocused {
				refocus(sp)
			}
		}
		res = Result{Space: sp.ID, Pane: p.ID, Tab: id, Closed: []*Tab{tb}, Kept: kept}
	} else if sp := t.st.Space(t.st.SpaceOf(o.Thread)); sp != nil {
		res = Result{Space: sp.ID, Kept: t.putAway(sp, o.Thread, "", w, h)}
	}
	ts := threadState(t.st, o.Thread)
	ts.Snoozed = true
	if away != nil {
		ts.SnoozedTab = away
	}
	return res, nil
}
