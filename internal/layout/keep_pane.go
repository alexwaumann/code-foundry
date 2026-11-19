package layout

import "slices"

// A pane whose only tab is a thread put away (archived or snoozed) stays: the space's empty
// composer takes the tab's place instead of the pane closing, so the window keeps its panes and
// shows New thread where the thread was (docs/notes/put-away-undo.md). A pane with other tabs
// shows its next one, as closing a tab does. A user's close (close_thread, close_tab) still
// closes the pane.

// composerInPlace puts the space's empty composer in place of tab id, its pane p's only tab,
// and returns it; tab id is then out of the layout (the caller forgets nothing more). A new
// composer is made when the space has none; one open in another pane moves here, unless it is
// that pane's only tab: then the space already shows New thread, and it returns nil, leaving
// the tab for the caller to close as before. The composer is in front where the tab was, and
// takes its place in the focus history, so a focused tab's pane keeps the focus.
func (t *tx) composerInPlace(sp *Space, p *Node, id string) *Tab {
	i := p.TabIndex(id)
	if i < 0 || len(p.Tabs) != 1 {
		return nil
	}
	c := &Tab{Kind: "compose"}
	if q, open := emptyComposer(sp); open != nil {
		if len(q.Tabs) == 1 {
			return nil
		}
		focused := focusedTab(sp) == open.ID
		detach(sp, q, open.ID)
		if focused {
			sp.Focus = p.ID
		}
		c = open
	} else if _, err := t.prepare(sp, c); err != nil {
		return nil
	}
	p.Tabs[i] = c
	if p.Active == id || p.Active == "" {
		p.Active = c.ID
	}
	sp.MRU = slices.DeleteFunc(sp.MRU, func(m string) bool { return m == c.ID })
	if k := slices.Index(sp.MRU, id); k >= 0 {
		sp.MRU[k] = c.ID
	}
	return c
}

// threadInPlace puts thread tab tb back in place of composer tab id in pane p (a put-away
// undone, keep_pane.go) while that is still the empty composer the put-away left; it reports
// whether it did. The thread's tab takes the composer's place in the strip, in front when it
// was, and in the focus history.
func threadInPlace(sp *Space, p *Node, id string, tb *Tab) bool {
	i := p.TabIndex(id)
	if id == "" || i < 0 || p.Tabs[i].Kind != "compose" || draftOf(p.Tabs[i]) != "" {
		return false
	}
	p.Tabs[i] = tb
	if p.Active == id {
		p.Active = tb.ID
	}
	if k := slices.Index(sp.MRU, id); k >= 0 {
		sp.MRU[k] = tb.ID
	}
	return true
}
