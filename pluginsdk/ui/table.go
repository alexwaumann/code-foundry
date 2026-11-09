package ui

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
)

// Table is rows of values under column headers, drawn like the app's own Pull Requests
// tables: a bordered box, an overline header row, 28 px rows (24 px Dense) with a hover
// tint, each cell one line cut with "…" (its tooltip then shows it whole), end-aligned
// columns for numbers (every cell has tabular figures). Title and Count put a heading
// over it ("Builds (1288)").
//
// Narrowing: the host never squeezes a column under its floor and never scrolls the table
// sideways. As the table narrows it drops columns, least important first (see
// TableColumn.Priority), until the rest fit; the most important column always shows. A
// row's buttons (Actions) fold into its ⋯ menu before any column drops.
//
// Sorting: the host never sorts. A Sortable column's header is a button; a click sends an
// act of kind pluginsdk.ActSort with Key the column's key, Node the table's key and Value
// the direction asked for ("asc" or "desc": the sorted column's other direction, else the
// column's SortFirst). The plugin answers with a view whose rows are in that order and
// whose Sort names the column and direction; the host draws the arrow.
//
// Groups: rows go in Rows, or in Groups (not both), each under a label row with a chevron,
// the label and a count. Collapsing a group is the user's, kept for the instance's life
// (per view tab, like a collapsed section); Collapsed is how it starts. A group's rows are
// sent even while it is collapsed.
//
// Long tables are drawn lazily (only the rows near the screen), as long lists are. Use a
// List for things that read as a sentence (a title over a second line, buttons under it);
// use a Table when the rows share the same few short facts the user compares down a
// column. In JSON: {"key": "builds", "table": {"columns": [{"key": "b-num", "label": "#"}],
// "rows": [{"key": "b-1288", "cells": {"b-num": "#1288"}}]}}.
type Table struct {
	Title string `json:"title,omitempty"`
	// Count is shown after the title in brackets ("(1288)"), when set: the plugin's total,
	// which may be more than the rows it sends.
	Count     *int          `json:"count,omitempty"`
	Columns   []TableColumn `json:"columns"`
	Rows      []TableRow    `json:"rows,omitempty"`
	Groups    []TableGroup  `json:"groups,omitempty"`
	Sort      *TableSort    `json:"sort,omitempty"`
	Dense     bool          `json:"dense,omitempty"`
	EmptyText string        `json:"emptyText,omitempty"` // shown in the box when there are no rows
}

// TableColumn is one column: a key (in the view's namespace; it counts as an element and
// names the column's cells in each row) and a Label (an overline header, at most
// MaxTableLabel characters; "" for a column of icons or pills that needs none).
//
// Width: Weight (1..MaxColumnWeight, 0 = 1) shares the table's free width, never less than
// MinWidth px (MinTableColumnWidth..MaxTableColumnWidth, 0 = TableColumnMinWidth); Width
// fixes it in px (MinTableColumnWidth..MaxTableColumnWidth: a status glyph needs 16, "#1288"
// about 64). Set Width or a weight, not both, and MinWidth only with a weight.
//
// Priority (0..MaxColumnPriority) is how long the column stays as the table narrows: the
// lowest drops first, and among equal priorities the rightmost. The column ranked first
// (the highest priority, then the leftmost) never drops. Without priorities, columns drop
// from the right.
//
// Align AlignEnd right-aligns the column (numbers, durations, ages). Style draws its
// cells: CellNormal, CellMuted, CellMono (code: branches, hashes) or CellCaption (small and
// muted: ages); a span's own tone wins.
type TableColumn struct {
	Key       string    `json:"key"`
	Label     string    `json:"label,omitempty"`
	Align     Align     `json:"align,omitempty"`
	Weight    int       `json:"weight,omitempty"`
	Width     int       `json:"width,omitempty"`
	MinWidth  int       `json:"minWidth,omitempty"`
	Priority  int       `json:"priority,omitempty"`
	Style     CellStyle `json:"style,omitempty"`
	Sortable  bool      `json:"sortable,omitempty"`
	SortFirst SortDir   `json:"sortFirst,omitempty"` // the first click's direction ("" is asc)
}

// CellStyle is how a column draws its cells.
type CellStyle string

const (
	CellNormal  CellStyle = ""
	CellMuted   CellStyle = "muted"
	CellMono    CellStyle = "mono"
	CellCaption CellStyle = "caption"
)

// SortDir is a sort's direction.
type SortDir string

const (
	SortAsc  SortDir = "asc"
	SortDesc SortDir = "desc"
)

// TableSort is the order the plugin sent the rows in: a sortable column and a direction.
type TableSort struct {
	Column string  `json:"column"`
	Dir    SortDir `json:"dir"`
}

// TableRow is one row: a key (in the view's namespace), its Cells by column key (a column
// without a cell is empty), and like a list row: Action (the whole row), up to
// MaxRowButtons Actions (drawn at the row's end while there is room, else folded into its
// ⋯), a Menu (its ⋯ on hover and focus, and its right-click) and Selected.
type TableRow struct {
	Key      string          `json:"key"`
	Cells    map[string]Cell `json:"cells,omitempty"`
	Action   *Action         `json:"action,omitempty"`
	Actions  []Button        `json:"actions,omitempty"`
	Menu     *Menu           `json:"menu,omitempty"`
	Selected bool            `json:"selected,omitempty"`
}

// TableGroup is a run of rows under a label row (a key in the view's namespace, a Label of
// at most MaxSectionTitle characters, and Count, shown after it: the plugin's total when
// set, else the group's row count). Collapsed is how it starts; the user's toggle wins.
type TableGroup struct {
	Key       string     `json:"key"`
	Label     string     `json:"label"`
	Count     *int       `json:"count,omitempty"`
	Collapsed bool       `json:"collapsed,omitempty"`
	Rows      []TableRow `json:"rows"`
}

// Cell is one value: an Inline (text, tones, times, durations, links) after an optional
// Glyph (a status or an icon: a build's state) and before an optional Pill. A cell with
// only a value encodes as that Inline (a bare string when it is plain text); otherwise as
// {"value": …, "glyph": …, "pill": …}.
type Cell struct {
	Value *Inline `json:"value,omitempty"`
	Glyph *Glyph  `json:"glyph,omitempty"`
	Pill  *Pill   `json:"pill,omitempty"`
}

type cellJSON struct {
	Value *Inline `json:"value,omitempty"`
	Glyph *Glyph  `json:"glyph,omitempty"`
	Pill  *Pill   `json:"pill,omitempty"`
}

// MarshalJSON encodes a cell with only a value as that value.
func (c Cell) MarshalJSON() ([]byte, error) {
	if c.Glyph == nil && c.Pill == nil && c.Value != nil {
		return json.Marshal(c.Value)
	}
	return json.Marshal(cellJSON(c))
}

// UnmarshalJSON accepts an Inline (a string or {text, spans}) or {value, glyph, pill}.
func (c *Cell) UnmarshalJSON(b []byte) error {
	var probe map[string]json.RawMessage
	if json.Unmarshal(b, &probe) == nil {
		_, text := probe["text"]
		_, spans := probe["spans"]
		if !text && !spans {
			var j cellJSON
			if err := json.Unmarshal(b, &j); err != nil {
				return err
			}
			*c = Cell(j)
			return nil
		}
	}
	var in Inline
	if err := in.UnmarshalJSON(b); err != nil {
		return errors.New("cell: want a string, {text, spans} or {value, glyph, pill}")
	}
	*c = Cell{Value: &in}
	return nil
}

// Tables' numbers, which the GUI uses too.
const (
	MaxTableColumns   = 10
	MaxTableLabel     = 40
	MaxTableGroups    = 20
	MaxTableRows      = 300 // all groups' together; rows count toward MaxElements too
	MaxColumnPriority = 9
	// A column's fixed width or least width, in px.
	MinTableColumnWidth = 16
	MaxTableColumnWidth = 480
	// TableColumnMinWidth is a weighted column's least width when MinWidth is 0.
	TableColumnMinWidth = 80
)

// NewTable returns a table of columns and rows.
func NewTable(key string, columns []TableColumn, rows ...TableRow) Node {
	return Node{Key: key, Table: &Table{Columns: columns, Rows: rows}}
}

// NewGroupedTable returns a table whose rows are in groups.
func NewGroupedTable(key string, columns []TableColumn, groups ...TableGroup) Node {
	return Node{Key: key, Table: &Table{Columns: columns, Groups: groups}}
}

// TableCol returns a table column with a header label (weighted, weight 1).
func TableCol(key, label string) TableColumn { return TableColumn{Key: key, Label: label} }

// WithWidth returns c fixed at px wide.
func (c TableColumn) WithWidth(px int) TableColumn { c.Width, c.Weight, c.MinWidth = px, 0, 0; return c }

// WithWeight returns c sharing the free width by weight, never under minWidth px (0 for the
// default).
func (c TableColumn) WithWeight(weight, minWidth int) TableColumn {
	c.Weight, c.MinWidth, c.Width = weight, minWidth, 0
	return c
}

// WithPriority returns c staying longer (higher) or dropping sooner (lower) as the table
// narrows.
func (c TableColumn) WithPriority(p int) TableColumn { c.Priority = p; return c }

// AlignEnd returns c right-aligned (numbers, durations, ages).
func (c TableColumn) AlignEnd() TableColumn { c.Align = AlignEnd; return c }

// WithStyle returns c drawing its cells in style s.
func (c TableColumn) WithStyle(s CellStyle) TableColumn { c.Style = s; return c }

// AsSortable returns c with a header that asks the plugin to sort by it, first in dir.
func (c TableColumn) AsSortable(first SortDir) TableColumn {
	c.Sortable = true
	if first == SortAsc {
		first = ""
	}
	c.SortFirst = first
	return c
}

// NewTableRow returns a row with its cells by column key.
func NewTableRow(key string, cells map[string]Cell) TableRow {
	return TableRow{Key: key, Cells: cells}
}

// WithAction returns r doing a when clicked (or Enter on it).
func (r TableRow) WithAction(a *Action) TableRow { r.Action = a; return r }

// WithMenu returns r with a ⋯ and right-click menu.
func (r TableRow) WithMenu(m *Menu) TableRow { r.Menu = m; return r }

// WithButtons returns r with buttons at its end (folded into its ⋯ when the table is narrow).
func (r TableRow) WithButtons(bs ...Button) TableRow { r.Actions = bs; return r }

// AsSelected returns r drawn selected.
func (r TableRow) AsSelected() TableRow { r.Selected = true; return r }

// NewTableGroup returns a group of rows under label.
func NewTableGroup(key, label string, rows ...TableRow) TableGroup {
	return TableGroup{Key: key, Label: label, Rows: rows}
}

// AsCollapsed returns g starting collapsed.
func (g TableGroup) AsCollapsed() TableGroup { g.Collapsed = true; return g }

// WithCount returns g showing n after its label instead of its row count.
func (g TableGroup) WithCount(n int) TableGroup { g.Count = &n; return g }

// TextCell returns a cell of plain text.
func TextCell(text string) Cell { return Cell{Value: Plain(text)} }

// InlineCell returns a cell of in (tones, times, durations, links).
func InlineCell(in *Inline) Cell { return Cell{Value: in} }

// StatusCell returns a cell of text after a status glyph.
func StatusCell(s Status, text string) Cell { return Cell{Glyph: &Glyph{Status: s}, Value: Plain(text)} }

// PillCell returns a cell of a pill alone.
func PillCell(label string, tone Tone) Cell { return Cell{Pill: &Pill{Label: label, Tone: tone}} }

// WithGlyph returns c after glyph g.
func (c Cell) WithGlyph(g *Glyph) Cell { c.Glyph = g; return c }

// WithPill returns c before pill p.
func (c Cell) WithPill(p *Pill) Cell { c.Pill = p; return c }

// NextSort is the direction a click on column's header asks for while the table is sorted
// by sort (nil: unsorted): the other direction of the sorted column, else the column's
// first. The host and the GUI ask with it.
func NextSort(column TableColumn, sort *TableSort) SortDir {
	if sort != nil && sort.Column == column.Key {
		if sort.Dir == SortDesc {
			return SortAsc
		}
		return SortDesc
	}
	if column.SortFirst == SortDesc {
		return SortDesc
	}
	return SortAsc
}

// AllRows returns t's rows in order: its Rows, or each group's.
func (t *Table) AllRows() []TableRow {
	if t == nil {
		return nil
	}
	if len(t.Groups) == 0 {
		return t.Rows
	}
	var out []TableRow
	for _, g := range t.Groups {
		out = append(out, g.Rows...)
	}
	return out
}

// table checks a table: its heading, 1..MaxTableColumns columns (keys, labels, widths,
// priority, style, sorting), its sort, rows or groups (not both) and each row: cells only
// of its columns, an action, buttons and a menu as a list row's.
func (c *checker) table(path string, t *Table) {
	c.str(path+".title", t.Title, MaxSectionTitle)
	if t.Count != nil && *t.Count < 0 {
		c.bad(path+".count", "negative")
	}
	c.str(path+".emptyText", t.EmptyText, MaxLabel)
	if n := len(t.Columns); n < 1 || n > MaxTableColumns {
		c.bad(path+".columns", "%d columns, want 1 to %d", n, MaxTableColumns)
	}
	cols := map[string]TableColumn{}
	for i, col := range t.Columns {
		p := fmt.Sprintf("%s.columns[%d]", path, i)
		c.key(p, col.Key)
		cols[col.Key] = col
		c.str(p+".label", col.Label, MaxTableLabel)
		if strings.ContainsAny(col.Label, "\n\r") {
			c.bad(p+".label", "one line")
		}
		if !slices.Contains([]Align{"", AlignStart, AlignEnd}, col.Align) {
			c.bad(p+".align", "unknown align %q (start or end)", col.Align)
		}
		if col.Weight < 0 || col.Weight > MaxColumnWeight {
			c.bad(p+".weight", "%d is outside 1..%d (0 is 1)", col.Weight, MaxColumnWeight)
		}
		if w := col.Width; w != 0 && (w < MinTableColumnWidth || w > MaxTableColumnWidth) {
			c.bad(p+".width", "%d px is outside %d..%d", w, MinTableColumnWidth, MaxTableColumnWidth)
		}
		if w := col.MinWidth; w != 0 && (w < MinTableColumnWidth || w > MaxTableColumnWidth) {
			c.bad(p+".minWidth", "%d px is outside %d..%d (0 is %d)", w, MinTableColumnWidth, MaxTableColumnWidth, TableColumnMinWidth)
		}
		if col.Width != 0 && (col.Weight != 0 || col.MinWidth != 0) {
			c.bad(p, "a column has a fixed width, or a weight and a least width, not both")
		}
		if col.Priority < 0 || col.Priority > MaxColumnPriority {
			c.bad(p+".priority", "%d is outside 0..%d", col.Priority, MaxColumnPriority)
		}
		if !slices.Contains([]CellStyle{CellNormal, CellMuted, CellMono, CellCaption}, col.Style) {
			c.bad(p+".style", "unknown style %q (muted, mono or caption)", col.Style)
		}
		switch {
		case !slices.Contains([]SortDir{"", SortAsc, SortDesc}, col.SortFirst):
			c.bad(p+".sortFirst", "unknown direction %q (asc or desc)", col.SortFirst)
		case col.SortFirst != "" && !col.Sortable:
			c.bad(p+".sortFirst", "only a sortable column has a first direction")
		}
	}
	if s := t.Sort; s != nil {
		col, ok := cols[s.Column]
		switch {
		case !ok:
			c.bad(path+".sort.column", "%q is not a column of the table", s.Column)
		case !col.Sortable:
			c.bad(path+".sort.column", "%q is not sortable", s.Column)
		}
		if s.Dir != SortAsc && s.Dir != SortDesc {
			c.bad(path+".sort.dir", "%q, want asc or desc", s.Dir)
		}
	}
	if len(t.Rows) > 0 && len(t.Groups) > 0 {
		c.bad(path, "rows or groups, not both")
	}
	if n := len(t.Groups); n > MaxTableGroups {
		c.bad(path+".groups", "%d groups, at most %d", n, MaxTableGroups)
	}
	total := len(t.Rows)
	for i, r := range t.Rows {
		c.tableRow(fmt.Sprintf("%s.rows[%d]", path, i), r, cols)
	}
	for i, g := range t.Groups {
		p := fmt.Sprintf("%s.groups[%d]", path, i)
		c.key(p, g.Key)
		c.required(p+".label", g.Label)
		c.str(p+".label", g.Label, MaxSectionTitle)
		if g.Count != nil && *g.Count < 0 {
			c.bad(p+".count", "negative")
		}
		total += len(g.Rows)
		for j, r := range g.Rows {
			c.tableRow(fmt.Sprintf("%s.rows[%d]", p, j), r, cols)
		}
	}
	if total > MaxTableRows {
		c.bad(path, "%d rows, at most %d", total, MaxTableRows)
	}
}

// tableRow checks one row: its key, its cells (each of a column, a value, glyph and pill
// as elsewhere), its action, buttons and menu.
func (c *checker) tableRow(path string, r TableRow, cols map[string]TableColumn) {
	c.key(path, r.Key)
	for _, k := range slices.Sorted(maps.Keys(r.Cells)) {
		p := path + ".cells." + k
		if _, ok := cols[k]; !ok {
			c.bad(p, "%q is not a column of the table", k)
			continue
		}
		cell := r.Cells[k]
		c.inline(p+".value", cell.Value, MaxLabel)
		if cell.Value != nil && strings.ContainsAny(cell.Value.Text, "\n\r") {
			c.bad(p+".value", "one line")
		}
		c.glyph(p+".glyph", cell.Glyph)
		c.pill(p+".pill", cell.Pill)
	}
	c.action(path+".action", r.Action)
	c.buttons(path+".actions", r.Actions, MaxRowButtons)
	c.noMenus(path+".actions", r.Actions, "give the row a menu")
	c.menu(path+".menu", r.Menu)
}
