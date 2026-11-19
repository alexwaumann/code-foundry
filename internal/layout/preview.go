package layout

import (
	"fmt"
	"slices"
)

// Preview tabs (docs/notes/shell-model.md, "Preview tabs"; decisions in
// docs/notes/preview-tabs-1-daemon.md). A thread tab opened with OpenThread.Preview to look at
// an archived or snoozed thread is a preview (Tab.Preview): the next preview opened in its
// space replaces it, taking its place when it opens in the same pane, and nothing else does.
// Whatever shows the user means to stay keeps it, for good: an explicit keep (keep_tab), its
// tab moved alone or with its pane (move_tab, move_pane, merge_pane, swap_pane, move_thread),
// one of its thread's surfaces opened (placement, add_tab, split_pane, set_quick open), and,
// through the daemon's glue, the thread unarchived, woken, renamed or pinned (a sent message
// unarchives and wakes). Reading never keeps it. A preview is never recorded for
// reopen_closed: replaced or closed by hand, it leaves no trace.
//
// A snoozed thread (ThreadState.Snoozed) whose tab opens shows only its conversation: its
// remembered set and its quick terminal stay put away until it wakes (set_snoozed off), when
// they come back beside its open tab as an open restores them; with no tab open they wait for
// its next open.

func init() {
	register("keep_tab", func() Op { return &KeepTab{} })
	register("set_snoozed", func() Op { return &SetSnoozed{} })
}

// previewIn is space sp's preview tab and its pane, or nils.
func previewIn(sp *Space) (*Node, *Tab) {
	for _, p := range Panes(sp.Root) {
		for _, tb := range p.Tabs {
			if tb.Preview {
				return p, tb
			}
		}
	}
	return nil, nil
}

// keepTab makes tb a kept tab; it reports whether tb was a preview.
func keepTab(tb *Tab) bool {
	if tb == nil || !tb.Preview {
		return false
	}
	tb.Preview = false
	return true
}

// keepPane keeps every preview in pane p (a pane moved keeps the tabs it carries).
func keepPane(p *Node) {
	if p == nil {
		return
	}
	for _, tb := range p.Tabs {
		keepTab(tb)
	}
}

// keepThread keeps thread's tab when it is a preview.
func (t *tx) keepThread(thread string) bool {
	if thread == "" {
		return false
	}
	_, _, tb := t.st.FindTab(threadTabID(t.st, thread))
	return keepTab(tb)
}

// snoozed reports whether the layout knows thread to be snoozed.
func (t *tx) snoozed(thread string) bool {
	ts := t.st.Threads[thread]
	return ts != nil && ts.Snoozed
}

// KeepTab keeps a preview tab: Tab, or Thread's tab. It is a normal tab from then on. A tab
// that is no preview is left as it is.
type KeepTab struct {
	Tab    string `json:"tab,omitempty"`
	Thread string `json:"thread,omitempty"`
}

// OpName implements Op.
func (*KeepTab) OpName() string { return "keep_tab" }

func (o *KeepTab) apply(t *tx) (Result, error) {
	id := o.Tab
	switch {
	case (o.Tab == "") == (o.Thread == ""):
		return Result{}, fmt.Errorf("keep_tab takes a tab or a thread: %w", ErrInvalidArgument)
	case o.Thread != "":
		if id = threadTabID(t.st, o.Thread); id == "" {
			return Result{}, fmt.Errorf("thread %q has no open tab: %w", o.Thread, ErrNotFound)
		}
	}
	sp, p, tb, err := t.tab(id)
	if err != nil {
		return Result{}, err
	}
	keepTab(tb)
	return Result{Space: sp.ID, Pane: p.ID, Tab: tb.ID}, nil
}

// SetSnoozed tells the layout whether a thread is snoozed, as the daemon's glue sees it
// (snooze_thread marks it too). Marking one changes nothing else. Waking one keeps its tab
// when that is a preview; when its tab is not open and a snooze closed it
// (ThreadState.SnoozedTab), the tab goes back where it was: into its pane at its old place
// while that pane is in the thread's space and can take it (in place of the empty composer
// the snooze left there while nothing was typed in it, keep_pane.go), into its pane rebuilt beside its
// old neighbours when it was the pane's only tab, else where open_thread puts a thread's tab.
// It goes back without the focus, the active tab of its pane again if it was then, except in
// the focused pane, whose tab stays in front. Then its remembered set comes back beside it
// as open_thread restores it (Result.Back, Placed, Fresh) and a quick terminal a snooze ended
// (Result.FreshQuick); with no tab open, they come back when it next opens. W and H are the
// pane area (default DefaultW x DefaultH).
type SetSnoozed struct {
	Thread  string  `json:"thread"`
	Snoozed bool    `json:"snoozed,omitempty"`
	W       float64 `json:"w,omitempty"`
	H       float64 `json:"h,omitempty"`
}

// OpName implements Op.
func (*SetSnoozed) OpName() string { return "set_snoozed" }

func (o *SetSnoozed) setArea(w, h float64) { area(&o.W, &o.H, w, h) }

func (o *SetSnoozed) apply(t *tx) (Result, error) {
	if o.Thread == "" {
		return Result{}, fmt.Errorf("no thread given: %w", ErrInvalidArgument)
	}
	if o.Snoozed {
		threadState(t.st, o.Thread).Snoozed = true
		return Result{}, nil
	}
	var away *SnoozedTab
	if ts := t.st.Threads[o.Thread]; ts != nil {
		ts.Snoozed = false
		away, ts.SnoozedTab = ts.SnoozedTab, nil
		prune(t.st, o.Thread)
	}
	w, h := viewport(o.W, o.H)
	id := threadTabID(t.st, o.Thread)
	if id == "" {
		if away == nil {
			return Result{}, nil
		}
		return t.snoozedBack(o.Thread, away, w, h)
	}
	sp, p, tb := t.st.FindTab(id)
	keepTab(tb)
	res := Result{Space: sp.ID, Pane: p.ID, Tab: id}
	if err := t.restore(sp, o.Thread, w, h, &res); err != nil {
		return Result{}, err
	}
	t.freshQuick(o.Thread, &res)
	return res, nil
}

// snoozedBack opens thread's tab again where a snooze closed it (SetSnoozed), with its
// remembered set, without the focus.
func (t *tx) snoozedBack(thread string, a *SnoozedTab, w, h float64) (Result, error) {
	sp := t.st.Space(t.st.SpaceOf(thread))
	if sp == nil {
		return Result{}, nil
	}
	tb := &Tab{Kind: "thread", Thread: thread}
	var res Result
	if a.Space != sp.ID {
		a = nil // it moved to another space meanwhile: it opens as a thread's tab opens there
	}
	switch p := t.snoozedPane(sp, a, w, h); {
	case p != nil:
		if _, err := t.prepare(sp, tb); err != nil {
			return Result{}, err
		}
		// In place of the composer the snooze left, while nothing was typed in it (keep_pane.go).
		if !threadInPlace(sp, p, a.Composer, tb) {
			p.Tabs = slices.Insert(p.Tabs, clampIndex(a.Index, len(p.Tabs)), tb)
		}
		res = Result{Space: sp.ID, Tab: tb.ID}
	case a != nil && a.Beside != nil:
		if _, err := t.prepare(sp, tb); err != nil {
			return Result{}, err
		}
		np := &Node{T: NodePane, ID: t.paneID(a.Pane), Tabs: []*Tab{tb}, Active: tb.ID}
		if t.rebuild(sp, a.Beside, np) {
			np.Collapsed = !Fits(sp.Root, w, h)
			res = Result{Space: sp.ID, Tab: tb.ID, Collapsed: np.Collapsed}
			break
		}
		fallthrough
	default:
		r, err := (&OpenThread{Thread: thread, W: w, H: h}).apply(t)
		if err != nil {
			return Result{}, err
		}
		return r, nil
	}
	if err := t.restore(sp, thread, w, h, &res); err != nil {
		return Result{}, err
	}
	t.freshQuick(thread, &res)
	_, p, _ := t.st.FindTab(tb.ID)
	if a.Active {
		t.show(sp, p, tb.ID, false)
	} else if sp.Focus == "" {
		sp.Focus = p.ID
	}
	prune(t.st, thread)
	res.Pane = p.ID
	return res, nil
}

// snoozedPane is the pane a snoozed thread's tab goes back into (snoozedBack): its old pane,
// while it is in space sp and has room for the tab; nil otherwise.
func (t *tx) snoozedPane(sp *Space, a *SnoozedTab, w, h float64) *Node {
	if a == nil {
		return nil
	}
	p := paneByID(sp, a.Pane)
	if p == nil || !canTake(sp, p, w, h, &Tab{Kind: "thread"}) {
		return nil
	}
	return p
}

// freshQuick opens thread's quick terminal again when a snooze ended it (Quick.Fresh): the
// caller starts a fresh shell for it (Result.FreshQuick).
func (t *tx) freshQuick(thread string, res *Result) {
	if ts := t.st.Threads[thread]; ts != nil && ts.Quick != nil && ts.Quick.Fresh {
		ts.Quick.Fresh, ts.Quick.Open = false, true
		res.FreshQuick = thread
	}
}
