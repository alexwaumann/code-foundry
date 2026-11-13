package ui

import "fmt"

// Interactive list rows (docs/notes/plugin-list-rows.md). A list node's rows can be
// ticked, dragged into a new order and renamed in place, and the list can take new rows
// from an input above or below them:
//
//   - Checkable: every row has a checkbox in its glyph's place (a checkable list's rows
//     have no glyph), ticked when Row.Checked. A ticked row's title is muted and struck
//     through. Toggling sends pluginsdk.ActCheck with the row's key and the new state.
//   - Reorderable: a grip shows on a row the pointer is over or that has focus; dragging
//     it (or alt+↑/↓ on the focused row) sends pluginsdk.ActMove with the row's key and
//     the key of the row now directly above it ("" when it is now first).
//   - Add: a one-line input above the rows (Bottom: below them); Enter sends
//     pluginsdk.ActAdd with the list's key and the trimmed text, and clears the input
//     once the plugin takes it (the text stays when it refuses). Empty text sends nothing;
//     one add is in flight at a time.
//   - Row.Editable: the title can be renamed in place (double-click it, or F2 on the
//     focused row; Enter too when the row has no Action of its own, which Enter runs
//     otherwise). Enter or leaving the field commits, Escape cancels; an empty or
//     unchanged title commits nothing. A commit sends pluginsdk.ActEdit with the row's
//     key and the trimmed text.
//
// The host shapes these acts from its copy of the view, like a tab or a select (Kind and
// Action are the act's kind, Node is the list's key), shows the change at once and keeps
// showing it until the plugin's next view, or goes back when the plugin refuses the act.
// The plugin answers with a view that has the change (or not). Only a list node's list
// has them: a master-detail's list does not.
//
// At a narrow pane's width (about 360 px) nothing is hidden: the grip and checkbox take
// 36 px at the row's start and the add input is the list's width.

// ListAdd is a list's add-row input.
type ListAdd struct {
	Placeholder string `json:"placeholder,omitempty"`
	// Bottom puts the input under the rows; it is above them by default.
	Bottom bool `json:"bottom,omitempty"`
}

// MaxRowText is how long an add's or an edit's text may be (characters): a row's title.
const MaxRowText = MaxLabel

// AsCheckable returns n with a checkbox on every row of its list (Row.Checked).
func (n Node) AsCheckable() Node {
	return n.withList(func(l *List) { l.Checkable = true })
}

// AsReorderable returns n with its list's rows draggable into a new order.
func (n Node) AsReorderable() Node {
	return n.withList(func(l *List) { l.Reorderable = true })
}

// WithAddRow returns n with an add input above its list's rows (below with bottom).
func (n Node) WithAddRow(placeholder string, bottom bool) Node {
	return n.withList(func(l *List) { l.Add = &ListAdd{Placeholder: placeholder, Bottom: bottom} })
}

// withList returns n with f applied to a copy of its list; a node that is no list stays
// as it is.
func (n Node) withList(f func(l *List)) Node {
	if n.List != nil {
		l := *n.List
		f(&l)
		n.List = &l
	}
	return n
}

// AsChecked returns r with its checkbox ticked or not (a checkable list's row).
func (r Row) AsChecked(on bool) Row { r.Checked = on; return r }

// AsEditable returns r with a title the user can rename in place.
func (r Row) AsEditable() Row { r.Editable = true; return r }

// listRows checks a list node's interactive rows: a checked row needs a checkable list,
// a checkable list's rows draw no glyph (the checkbox takes its place), and the add input
// counts as an element with a placeholder of a label's length.
func (c *checker) listRows(path string, l *List) {
	if a := l.Add; a != nil {
		c.elements++
		c.str(path+".add.placeholder", a.Placeholder, MaxLabel)
	}
	for i, r := range l.Rows {
		p := fmt.Sprintf("%s.rows[%d]", path, i)
		if r.Checked && !l.Checkable {
			c.bad(p+".checked", "the list is not checkable: set the list's checkable")
		}
		if l.Checkable && r.Glyph != nil {
			c.bad(p+".glyph", "a checkable list's checkbox takes the glyph's place")
		}
	}
}

// noListRows refuses interactive rows on a master-detail's list: choosing a row is its
// interaction, and the host draws none of these there.
func (c *checker) noListRows(path string, l *List) {
	const why = "a master-detail's list has no %s (a list node's has)"
	if l.Checkable {
		c.bad(path+".checkable", why, "checkboxes")
	}
	if l.Reorderable {
		c.bad(path+".reorderable", why, "drag to reorder")
	}
	if l.Add != nil {
		c.bad(path+".add", why, "add input")
	}
	for i, r := range l.Rows {
		p := fmt.Sprintf("%s.rows[%d]", path, i)
		if r.Checked {
			c.bad(p+".checked", why, "checkboxes")
		}
		if r.Editable {
			c.bad(p+".editable", why, "editable titles")
		}
	}
}
