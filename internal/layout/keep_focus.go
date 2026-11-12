package layout

import "slices"

// A call from inside a thread never moves the user's focus (docs/notes/shell-plan.md section
// 2.6): Options.KeepFocus runs any op so. The op does what it does to the tree, and then the
// focus is put back as it was: the current space, and in each space the tab that had the
// focus (or, when that tab went, the pane that had it) and the order of the recently focused
// tabs. A tab the op moved or opened stays active in its own pane, except in the focused pane,
// where it waits behind the focused tab.

// keepFocus puts before's focus back into after, which is in normal form and stays so.
func keepFocus(before, after *State) {
	if after.Space(before.CurrentSpace) != nil {
		after.CurrentSpace = before.CurrentSpace
	}
	for _, sp := range after.Spaces {
		old := before.Space(sp.ID)
		if old == nil {
			continue
		}
		if p := paneOf(sp, focusedTab(old)); p != nil {
			sp.Focus, p.Active = p.ID, focusedTab(old)
		} else if slices.Contains(PaneIDs(sp.Root), old.Focus) {
			sp.Focus = old.Focus
		}
		open := map[string]bool{}
		for _, p := range Panes(sp.Root) {
			for _, tb := range p.Tabs {
				open[tb.ID] = true
			}
		}
		sp.MRU = slices.DeleteFunc(slices.Clone(old.MRU), func(id string) bool { return !open[id] })
		if len(sp.MRU) == 0 {
			sp.MRU = nil
		}
	}
}

// paneOf is the pane of space sp holding tab id, or nil.
func paneOf(sp *Space, id string) *Node {
	if id == "" {
		return nil
	}
	for _, p := range Panes(sp.Root) {
		if p.TabIndex(id) >= 0 {
			return p
		}
	}
	return nil
}
