package pluginsdk

// SurfaceAct kinds of a list's interactive rows (ui.List's Checkable, Reorderable and
// Add, ui.Row's Editable; docs/notes/plugin-list-rows.md). The host shapes them from its
// copy of the view, like a tab or a select: Action is the kind's own name, Node is the
// list's key, and they carry no Data and no form values. The host shows the change at
// once and goes back when the plugin returns an error; answer with a view that has it.
const (
	// ActCheck: the user ticked or unticked a row's checkbox. Key is the row's key, Value
	// the new state (a bool; SurfaceAct.Checked).
	ActCheck = "check"
	// ActMove: the user dragged a row to a new place (or moved it with alt+↑/↓). Key is the
	// row's key, Value the key of the row now directly above it among the list's rows, ""
	// when it is now first (SurfaceAct.After). In a filtered list, place it after that
	// row in the full list (or before the first row shown).
	ActMove = "move"
	// ActAdd: the user entered a new row in the list's add input. Key is the list's key
	// (as is Node), Value the text: trimmed, one line, not empty, at most ui.MaxRowText
	// characters (SurfaceAct.Text).
	ActAdd = "add"
	// ActEdit: the user renamed an editable row in place. Key is the row's key, Value the
	// new title, as an add's text (SurfaceAct.Text).
	ActEdit = "edit"
)

// Checked returns a check act's new state.
func (a SurfaceAct) Checked() bool {
	b, _ := a.Value.(bool)
	return b
}

// After returns a move act's new upper neighbour: the key of the row now directly above
// the moved one, "" when it is now first.
func (a SurfaceAct) After() string {
	s, _ := a.Value.(string)
	return s
}

// Text returns an add's or an edit's text.
func (a SurfaceAct) Text() string {
	s, _ := a.Value.(string)
	return s
}
