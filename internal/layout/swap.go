package layout

import "slices"

// Smart swap (docs/notes/shell-model.md, "Linked surfaces"): when a thread tab gains focus,
// every pane of its space whose active tab is another thread's surface of the same kind
// switches to this thread's, when one is already open in that pane. Nothing is opened, moved
// or closed. ApplyWith runs it after any op that leaves a thread tab newly focused.

// focusPoint is what has the focus: the current space, its focused tab, and that tab's thread
// when it is a thread tab.
type focusPoint struct {
	space, tab, thread string
}

// focusedThreadTab is the focus point of st; thread is set only for a thread tab.
func focusedThreadTab(st *State) focusPoint {
	sp := st.Space(st.CurrentSpace)
	if sp == nil {
		return focusPoint{}
	}
	fp := focusPoint{space: sp.ID}
	for _, p := range Panes(sp.Root) {
		if p.ID != sp.Focus {
			continue
		}
		fp.tab = p.Active
		if tb := p.ActiveTab(); tb != nil && tb.Kind == "thread" {
			fp.thread = tb.Thread
		}
	}
	return fp
}

// smartSwap switches the panes of space spaceID to thread's surfaces and returns their ids.
// In each pane whose active tab is a linked tab of another thread, the candidates are this
// thread's tabs of the same kind in that pane; the one this thread last showed there (Last)
// wins, then the most recently focused (the space's MRU), then the first in the strip. The
// thread whose tab is swapped away remembers it as its Last of that kind.
func smartSwap(st *State, spaceID, thread string) []string {
	sp := st.Space(spaceID)
	if sp == nil {
		return nil
	}
	var swapped []string
	for _, p := range Panes(sp.Root) {
		act := p.ActiveTab()
		if act == nil || !act.IsLinked() || act.Thread == thread {
			continue
		}
		var mine []*Tab
		for _, tb := range p.Tabs {
			if tb.IsLinked() && tb.Thread == thread && tb.Kind == act.Kind {
				mine = append(mine, tb)
			}
		}
		if len(mine) == 0 {
			continue
		}
		pick := pickLast(st, sp, thread, act.Kind, mine)
		setLast(st, act.Thread, act.Kind, act.ID)
		p.Active = pick.ID
		swapped = append(swapped, p.ID)
	}
	return swapped
}

// pickLast chooses among a thread's tabs of one kind: its Last, else the newest in MRU, else
// the first.
func pickLast(st *State, sp *Space, thread, kind string, tabs []*Tab) *Tab {
	if ts := st.Threads[thread]; ts != nil {
		if id := ts.Last[kind]; id != "" {
			if i := slices.IndexFunc(tabs, func(t *Tab) bool { return t.ID == id }); i >= 0 {
				return tabs[i]
			}
		}
	}
	for _, id := range sp.MRU {
		if i := slices.IndexFunc(tabs, func(t *Tab) bool { return t.ID == id }); i >= 0 {
			return tabs[i]
		}
	}
	return tabs[0]
}

// setLast records tab as the thread's last shown tab of kind.
func setLast(st *State, thread, kind, tab string) {
	ts := threadState(st, thread)
	if ts.Last == nil {
		ts.Last = map[string]string{}
	}
	ts.Last[kind] = tab
}

// threadState is thread's stored state, made (in the space it lives in) when it has none.
func threadState(st *State, thread string) *ThreadState {
	if ts := st.Threads[thread]; ts != nil {
		return ts
	}
	if st.Threads == nil {
		st.Threads = map[string]*ThreadState{}
	}
	ts := &ThreadState{Space: st.SpaceOf(thread)}
	st.Threads[thread] = ts
	return ts
}
