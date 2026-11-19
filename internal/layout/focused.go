package layout

// FocusedThread is the thread whose own tab (kind "thread") is the active tab of the
// focused pane of the current space: the thread the user looks at in the window. ""
// when that tab is anything else, or there is none.
func FocusedThread(st *State) string {
	if st == nil {
		return ""
	}
	sp := st.Space(st.CurrentSpace)
	if sp == nil {
		return ""
	}
	for _, p := range Panes(sp.Root) {
		if p.ID != sp.Focus {
			continue
		}
		if tb := p.ActiveTab(); tb != nil && tb.Kind == "thread" {
			return tb.Thread
		}
		return ""
	}
	return ""
}
