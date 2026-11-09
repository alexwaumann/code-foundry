package plugin

import (
	"fmt"
	"strings"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// A table's sortable column headers (ui.Table; docs/notes/plugin-table.md) are acting
// elements whose acts the host shapes, like a tab or a select: kind pluginsdk.ActSort, the
// column's key, the table as the node, and a direction as the value.

// sortElements are a table node's sortable columns, each with the direction a click asks
// for in this version of the view (ui.NextSort).
func sortElements(n *ui.Node) []element {
	var out []element
	for _, c := range n.Table.Columns {
		if !c.Sortable {
			continue
		}
		label := c.Label
		if label == "" {
			label = c.Key
		}
		out = append(out, element{key: c.Key, kind: pluginsdk.ActSort, label: label, node: n.Key, sort: string(ui.NextSort(c, n.Table.Sort))})
	}
	return out
}

// sortValue is a sort act's direction: the client's, "asc" or "desc", or without one the
// direction the header asks for (the sorted column's other one, else the column's first).
func sortValue(el element, v *string) (string, error) {
	if v == nil || *v == "" {
		return el.sort, nil
	}
	switch d := ui.SortDir(*v); d {
	case ui.SortAsc, ui.SortDesc:
		return string(d), nil
	}
	return "", fmt.Errorf("%w: a sort's value is asc or desc, not %q", ErrInvalidArgument, *v)
}

// tableRowLabel names a table row in the element list: its first cell's text, else its
// key.
func tableRowLabel(t *ui.Table, r ui.TableRow) string {
	for _, c := range t.Columns {
		cell, ok := r.Cells[c.Key]
		if !ok || cell.Value == nil {
			continue
		}
		var b strings.Builder
		b.WriteString(cell.Value.Text)
		for _, s := range cell.Value.Spans {
			b.WriteString(s.Text)
		}
		if s := strings.TrimSpace(b.String()); s != "" {
			return s
		}
	}
	return r.Key
}
