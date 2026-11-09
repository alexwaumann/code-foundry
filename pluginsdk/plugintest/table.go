package plugintest

import (
	"context"
	"fmt"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// Sort clicks a sortable column's header of a table (ui.Table) in the instance's latest
// view, as the user would: the host sends a sort act (pluginsdk.ActSort) with the column's
// key, the table as its node and dir as its value; with dir "" the direction the header
// asks for (ui.NextSort: the sorted column's other direction, else the column's first).
// The plugin's answer (its rows in that order, Table.Sort naming it) is in the next view.
func (h *Host) Sort(ctx context.Context, instance, column string, dir ui.SortDir) error {
	v, err := h.latest(instance)
	if err != nil {
		return err
	}
	n, col, ok := findColumn(v, column)
	if !ok {
		return fmt.Errorf("plugintest: no table column %q in the view of %s", column, instance)
	}
	if !col.Sortable {
		return fmt.Errorf("plugintest: column %q of table %q is not sortable (the host sends no sort for it)", column, n.Key)
	}
	switch dir {
	case "":
		dir = ui.NextSort(col, n.Table.Sort)
	case ui.SortAsc, ui.SortDesc:
	default:
		return fmt.Errorf("plugintest: a sort is asc or desc, not %q", dir)
	}
	return h.Act(ctx, pluginsdk.SurfaceAct{Instance: instance, Kind: pluginsdk.ActSort, Action: pluginsdk.ActSort, Key: column, Node: n.Key, Value: string(dir)})
}

// TableRows returns the keys of a table's rows (its groups' rows in order) in the
// instance's latest view, as the host draws them; ok is false without such a table.
func (h *Host) TableRows(instance, table string) (keys []string, ok bool) {
	v, err := h.latest(instance)
	if err != nil {
		return nil, false
	}
	n, found := findNode(v, func(n ui.Node) bool { return n.Key == table && n.Table != nil })
	if !found {
		return nil, false
	}
	for _, r := range n.Table.AllRows() {
		keys = append(keys, r.Key)
	}
	return keys, true
}

// findColumn finds the table that has a column keyed column, and the column.
func findColumn(v ui.View, column string) (ui.Node, ui.TableColumn, bool) {
	var col ui.TableColumn
	n, ok := findNode(v, func(n ui.Node) bool {
		if n.Table == nil {
			return false
		}
		for _, c := range n.Table.Columns {
			if c.Key == column {
				col = c
				return true
			}
		}
		return false
	})
	return n, col, ok
}

// findNode finds the first node (in any list, at any depth) that match accepts.
func findNode(v ui.View, match func(ui.Node) bool) (ui.Node, bool) {
	var walk func(ns []ui.Node) (ui.Node, bool)
	walk = func(ns []ui.Node) (ui.Node, bool) {
		for _, n := range ns {
			if match(n) {
				return n, true
			}
			for _, l := range n.Children() {
				if f, ok := walk(l); ok {
					return f, true
				}
			}
		}
		return ui.Node{}, false
	}
	for _, l := range v.NodeLists() {
		if n, ok := walk(l); ok {
			return n, true
		}
	}
	return ui.Node{}, false
}
