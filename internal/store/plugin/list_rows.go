package plugin

import (
	"fmt"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// A list's interactive rows (docs/notes/plugin-list-rows.md): a checkable list's row
// checks, a reorderable list's row moves, a list's add input and an editable row's edits
// are acts the host shapes, like a tab or a select. Each is indexed under its kind and
// key (a row's key, or the list's for an add), apart from the view's elements: a row can
// both act on a click and be checked, moved and renamed. An act names one with its key
// and its kind as the action (the GUI always sends both).

// The host renders them: plugins may ask before using them (initialize's capabilities).
func init() { hostCapabilities = append(hostCapabilities, ListRowsCapability) }

// ListRowsCapability is the capability of a list's interactive rows.
const ListRowsCapability = "view.list.rows"

// rowOpKinds are the kinds of a list's row acts.
var rowOpKinds = []string{pluginsdk.ActCheck, pluginsdk.ActMove, pluginsdk.ActAdd, pluginsdk.ActEdit}

func isRowOp(kind string) bool { return slices.Contains(rowOpKinds, kind) }

// rowOp is one row act of a view version: its element (the row's key, or the list's for
// an add; node is the list), and for a move the list's row keys.
type rowOp struct {
	element
	rows []string
}

func rowOpKey(kind, key string) string { return kind + "\x00" + key }

// indexRowOps adds the view's row acts to idx, in the view's order.
func (idx *actionIndex) indexRowOps(v *ui.View) {
	idx.ops = map[string]rowOp{}
	add := func(op rowOp) {
		k := rowOpKey(op.kind, op.key)
		if _, dup := idx.ops[k]; dup || op.key == "" {
			return
		}
		idx.ops[k] = op
		idx.opOrder = append(idx.opOrder, k)
	}
	walkView(v, func(n *ui.Node) {
		l := n.List
		if l == nil {
			return
		}
		if l.Add != nil {
			add(rowOp{element: element{key: n.Key, kind: pluginsdk.ActAdd, label: l.Add.Placeholder, node: n.Key}})
		}
		var keys []string
		if l.Reorderable {
			keys = make([]string, len(l.Rows))
			for i, r := range l.Rows {
				keys[i] = r.Key
			}
		}
		for _, r := range l.Rows {
			if l.Checkable {
				add(rowOp{element: element{key: r.Key, kind: pluginsdk.ActCheck, label: r.Title, node: n.Key}})
			}
			if l.Reorderable {
				add(rowOp{element: element{key: r.Key, kind: pluginsdk.ActMove, label: r.Title, node: n.Key}, rows: keys})
			}
			if r.Editable {
				add(rowOp{element: element{key: r.Key, kind: pluginsdk.ActEdit, label: r.Title, node: n.Key}})
			}
		}
	})
}

// rowOp finds the row act of kind action on key.
func (idx *actionIndex) rowOp(key, action string) (rowOp, bool) {
	if key == "" || !isRowOp(action) {
		return rowOp{}, false
	}
	op, ok := idx.ops[rowOpKey(action, key)]
	return op, ok
}

// rowOpValue checks a row act's value and returns what the plugin gets: a check's state
// as a bool; a move's upper neighbour, "" or another row of the list; an add's or edit's
// text, trimmed, one line, not empty, at most ui.MaxRowText characters.
func (idx *actionIndex) rowOpValue(el element, value *string) (any, error) {
	if value == nil {
		return nil, fmt.Errorf("%w: a %s act needs a value", ErrInvalidArgument, el.kind)
	}
	v := *value
	switch el.kind {
	case pluginsdk.ActCheck:
		b, err := strconv.ParseBool(v)
		if err != nil {
			return nil, fmt.Errorf("%w: a check's value is true or false, not %q", ErrInvalidArgument, v)
		}
		return b, nil
	case pluginsdk.ActMove:
		op := idx.ops[rowOpKey(el.kind, el.key)]
		if v == el.key || (v != "" && !slices.Contains(op.rows, v)) {
			return nil, fmt.Errorf("%w: a move's value is \"\" (first) or the key of another row of list %q, not %q", ErrInvalidArgument, el.node, v)
		}
		return v, nil
	}
	if !utf8.ValidString(v) {
		return nil, fmt.Errorf("%w: the text is not UTF-8", ErrInvalidArgument)
	}
	v = strings.TrimSpace(v)
	switch {
	case v == "":
		return nil, fmt.Errorf("%w: the text is empty", ErrInvalidArgument)
	case strings.ContainsAny(v, "\r\n"):
		return nil, fmt.Errorf("%w: the text is one line", ErrInvalidArgument)
	case utf8.RuneCountInString(v) > ui.MaxRowText:
		return nil, fmt.Errorf("%w: the text is over %d characters", ErrInvalidArgument, ui.MaxRowText)
	}
	return v, nil
}

// rowOpElements lists the view's row acts (SurfaceElements).
func (idx *actionIndex) rowOpElements() []SurfaceElement {
	out := make([]SurfaceElement, 0, len(idx.opOrder))
	for _, k := range idx.opOrder {
		op := idx.ops[k]
		out = append(out, SurfaceElement{Key: op.key, Kind: op.kind, Action: op.kind, Label: op.label, Node: op.node})
	}
	return out
}
