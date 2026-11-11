package ui

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"
)

// tableSeed has a sorted table with every column option (a status glyph column, a pill
// column, mono, muted and caption cells, fixed, weighted and least widths, priorities, an
// unlabelled icon column, a meter column), rows with an action, buttons and a menu, a
// selected row, and a grouped dense table in a section with a collapsed group and a count.
const tableSeed = `{"nodes":[
  {"key":"builds","table":{"title":"Builds","count":1288,"sort":{"column":"b-num","dir":"desc"},"emptyText":"No builds yet",
    "columns":[
      {"key":"b-num","label":"#","width":72,"priority":9,"sortable":true,"sortFirst":"desc"},
      {"key":"b-status","label":"Status","width":80,"priority":3},
      {"key":"b-branch","label":"Branch","weight":2,"minWidth":96,"style":"mono","priority":5,"sortable":true},
      {"key":"b-cause","label":"Cause","priority":1},
      {"key":"b-dur","label":"Duration","width":72,"align":"end","style":"mono","priority":6,"sortable":true,"sortFirst":"desc"},
      {"key":"b-age","label":"Age","width":40,"align":"end","style":"caption","priority":7},
      {"key":"b-icon","width":16,"style":"muted"},
      {"key":"b-rate","label":"Pass rate","weight":2,"minWidth":64,"priority":2}],
    "rows":[
      {"key":"b-1288","cells":{"b-num":{"value":"#1288","glyph":{"status":"running"}},"b-status":{"pill":{"label":"running"}},"b-branch":"main",
        "b-cause":{"spans":[{"text":"push · "},{"text":"1 commit","url":"https://example.com/c"}]},"b-dur":{"spans":[{"duration":{"ms":130000}}]},
        "b-age":{"spans":[{"time":{"at":"2026-11-08T09:00:00Z"}}]},"b-rate":{"meter":{"value":0}}},"action":{"event":"open-build","data":"1288"},"selected":true},
      {"key":"b-1287","cells":{"b-num":{"value":"#1287","glyph":{"status":"failed","hint":"3 failed"}},"b-status":{"pill":{"label":"failed","tone":"error"}},
        "b-cause":{"spans":[{"text":"integration · 3 failed","tone":"error"}]},"b-icon":{"glyph":{"icon":"lock","tone":"muted"}},"b-rate":{"meter":{"value":0.86,"label":"86%","tone":"attention"}}},
        "actions":[{"key":"b-1287-rerun","label":"Rerun","icon":"rotate-cw","action":{"event":"rerun","data":"1287"}}],
        "menu":{"items":[{"key":"b-1287-log","label":"Open console","action":{"event":"log","data":"1287"}},{"separator":true},
          {"key":"b-1287-open","label":"Open in CI","action":{"openUrl":"https://example.com/1287"}}]}}]}},
  {"key":"sec","section":{"title":"Issues","children":[
    {"key":"issues","table":{"dense":true,"columns":[{"key":"i-key","label":"Key","width":64,"style":"muted"},{"key":"i-sum","label":"Summary","weight":3}],
      "groups":[
        {"key":"g-prog","label":"In progress","rows":[{"key":"CF-412","cells":{"i-key":"CF-412","i-sum":"Thread search keeps scroll"}}]},
        {"key":"g-done","label":"Done","count":14,"collapsed":true,"rows":[]}]}}]}}]}`

func TestTableSeedIsValid(t *testing.T) {
	var v View
	if err := json.Unmarshal([]byte(tableSeed), &v); err != nil {
		t.Fatal(err)
	}
	if err := v.Validate(); err != nil {
		t.Fatal(err)
	}
}

// Every validation branch of a table (docs/notes/plugin-table.md).
func TestValidateTable(t *testing.T) {
	cols := func(n int) []TableColumn {
		out := make([]TableColumn, n)
		for i := range out {
			out[i] = TableCol("c"+strconv.Itoa(i), "C")
		}
		return out
	}
	rows := func(prefix string, n int) []TableRow {
		out := make([]TableRow, n)
		for i := range out {
			out[i] = NewTableRow(prefix+strconv.Itoa(i), map[string]Cell{"num": TextCell("#" + strconv.Itoa(i))})
		}
		return out
	}
	num := TableCol("num", "#")
	tbl := func(t Table) Node {
		if t.Columns == nil {
			t.Columns = []TableColumn{num}
		}
		return Node{Key: "t", Table: &t}
	}
	col := func(c TableColumn) Node { return NewTable("t", []TableColumn{c}) }
	row := func(r TableRow) Node { return NewTable("t", []TableColumn{num, TableCol("br", "Branch")}, r) }
	cell := func(c Cell) Node { return row(NewTableRow("r", map[string]Cell{"num": c})) }
	n := func(i int) *int { return &i }
	tests := []struct {
		name string
		node Node
		want string // "" = valid
	}{
		// the table
		{"one column, no rows", NewTable("t", []TableColumn{num}), ""},
		{"most columns", NewTable("t", cols(MaxTableColumns)), ""},
		{"no columns", NewTable("t", nil), "nodes[0].table.columns: 0 columns, want 1 to 10"},
		{"too many columns", NewTable("t", cols(MaxTableColumns+1)), "nodes[0].table.columns: 11 columns, want 1 to 10"},
		{"title and count", tbl(Table{Title: "Builds", Count: n(1288)}), ""},
		{"count of zero", tbl(Table{Title: "Builds", Count: n(0)}), ""},
		{"title too long", tbl(Table{Title: strings.Repeat("x", MaxSectionTitle+1)}), "nodes[0].table.title: 61 characters, at most 60"},
		{"negative count", tbl(Table{Count: n(-1)}), "nodes[0].table.count: negative"},
		{"empty text too long", tbl(Table{EmptyText: strings.Repeat("x", MaxLabel+1)}), "nodes[0].table.emptyText: 201 characters"},
		{"dense", tbl(Table{Dense: true, Rows: rows("r", 3)}), ""},
		{"most rows", tbl(Table{Rows: rows("r", MaxTableRows)}), ""},
		{"too many rows", tbl(Table{Rows: rows("r", MaxTableRows+1)}), "nodes[0].table: 301 rows, at most 300"},
		{"too many rows over groups", tbl(Table{Groups: []TableGroup{NewTableGroup("g1", "A", rows("a", 200)...), NewTableGroup("g2", "B", rows("b", 101)...)}}),
			"nodes[0].table: 301 rows, at most 300"},
		// columns
		{"every option", NewTable("t", []TableColumn{
			TableCol("a", "#").WithWidth(72).WithPriority(MaxColumnPriority).AsSortable(SortDesc),
			TableCol("b", "Branch").WithWeight(MaxColumnWeight, 96).WithStyle(CellMono).AsSortable(SortAsc),
			TableCol("c", "Age").WithWidth(40).AlignEnd().WithStyle(CellCaption),
			TableCol("d", "").WithWidth(MinTableColumnWidth).WithStyle(CellMuted),
			{Key: "e", Label: "Start", Align: AlignStart, Width: MaxTableColumnWidth}}), ""},
		{"bad column key", col(TableCol("a b", "A")), `nodes[0].table.columns[0].key: "a b" must match`},
		{"column key used by the node", col(TableCol("t", "A")), `nodes[0].table.columns[0].key: "t" is already used by nodes[0]`},
		{"label at the limit", col(TableCol("a", strings.Repeat("x", MaxTableLabel))), ""},
		{"label too long", col(TableCol("a", strings.Repeat("x", MaxTableLabel+1))), "nodes[0].table.columns[0].label: 41 characters, at most 40"},
		{"label of two lines", col(TableCol("a", "A\nB")), "nodes[0].table.columns[0].label: one line"},
		{"centred", col(TableColumn{Key: "a", Align: AlignCenter}), `nodes[0].table.columns[0].align: unknown align "center" (start or end)`},
		{"weight too big", col(TableColumn{Key: "a", Weight: MaxColumnWeight + 1}), "nodes[0].table.columns[0].weight: 7 is outside 1..6 (0 is 1)"},
		{"negative weight", col(TableColumn{Key: "a", Weight: -1}), "nodes[0].table.columns[0].weight: -1 is outside 1..6"},
		{"width too small", col(TableColumn{Key: "a", Width: MinTableColumnWidth - 1}), "nodes[0].table.columns[0].width: 15 px is outside 16..480"},
		{"width too big", col(TableColumn{Key: "a", Width: MaxTableColumnWidth + 1}), "nodes[0].table.columns[0].width: 481 px is outside 16..480"},
		{"least width too small", col(TableColumn{Key: "a", MinWidth: 8}), "nodes[0].table.columns[0].minWidth: 8 px is outside 16..480 (0 is 80)"},
		{"width and weight", col(TableColumn{Key: "a", Width: 40, Weight: 2}), "nodes[0].table.columns[0]: a column has a fixed width, or a weight and a least width, not both"},
		{"width and least width", col(TableColumn{Key: "a", Width: 40, MinWidth: 40}), "nodes[0].table.columns[0]: a column has a fixed width"},
		{"priority too high", col(TableColumn{Key: "a", Priority: MaxColumnPriority + 1}), "nodes[0].table.columns[0].priority: 10 is outside 0..9"},
		{"negative priority", col(TableColumn{Key: "a", Priority: -1}), "nodes[0].table.columns[0].priority: -1 is outside 0..9"},
		{"unknown style", col(TableColumn{Key: "a", Style: "bold"}), `nodes[0].table.columns[0].style: unknown style "bold"`},
		{"unknown first direction", col(TableColumn{Key: "a", Sortable: true, SortFirst: "up"}), `nodes[0].table.columns[0].sortFirst: unknown direction "up"`},
		{"first direction, not sortable", col(TableColumn{Key: "a", SortFirst: SortDesc}), "nodes[0].table.columns[0].sortFirst: only a sortable column has a first direction"},
		// sort
		{"sorted", tbl(Table{Columns: []TableColumn{num.AsSortable(SortAsc)}, Sort: &TableSort{Column: "num", Dir: SortAsc}}), ""},
		{"sorted descending", tbl(Table{Columns: []TableColumn{num.AsSortable(SortAsc)}, Sort: &TableSort{Column: "num", Dir: SortDesc}}), ""},
		{"sorted by no column", tbl(Table{Sort: &TableSort{Column: "x", Dir: SortAsc}}), `nodes[0].table.sort.column: "x" is not a column of the table`},
		{"sorted by an unsortable column", tbl(Table{Sort: &TableSort{Column: "num", Dir: SortAsc}}), `nodes[0].table.sort.column: "num" is not sortable`},
		{"sorted without a direction", tbl(Table{Columns: []TableColumn{num.AsSortable(SortAsc)}, Sort: &TableSort{Column: "num"}}), `nodes[0].table.sort.dir: "", want asc or desc`},
		// groups
		{"groups", tbl(Table{Groups: []TableGroup{NewTableGroup("g1", "In progress", rows("a", 2)...), NewTableGroup("g2", "Done").WithCount(14).AsCollapsed()}}), ""},
		{"rows and groups", tbl(Table{Rows: rows("r", 1), Groups: []TableGroup{NewTableGroup("g", "A")}}), "nodes[0].table: rows or groups, not both"},
		{"most groups", tbl(Table{Groups: func() []TableGroup {
			out := make([]TableGroup, MaxTableGroups)
			for i := range out {
				out[i] = NewTableGroup("g"+strconv.Itoa(i), "G")
			}
			return out
		}()}), ""},
		{"too many groups", tbl(Table{Groups: func() []TableGroup {
			out := make([]TableGroup, MaxTableGroups+1)
			for i := range out {
				out[i] = NewTableGroup("g"+strconv.Itoa(i), "G")
			}
			return out
		}()}), "nodes[0].table.groups: 21 groups, at most 20"},
		{"group without a label", tbl(Table{Groups: []TableGroup{NewTableGroup("g", " ")}}), "nodes[0].table.groups[0].label: required"},
		{"group label too long", tbl(Table{Groups: []TableGroup{NewTableGroup("g", strings.Repeat("x", MaxSectionTitle+1))}}), "nodes[0].table.groups[0].label: 61 characters"},
		{"group negative count", tbl(Table{Groups: []TableGroup{NewTableGroup("g", "G").WithCount(-1)}}), "nodes[0].table.groups[0].count: negative"},
		{"group key used by a row", tbl(Table{Groups: []TableGroup{NewTableGroup("g", "G", NewTableRow("g", nil))}}), `nodes[0].table.groups[0].rows[0].key: "g" is already used by nodes[0].table.groups[0]`},
		{"group row's cell of no column", tbl(Table{Groups: []TableGroup{NewTableGroup("g", "G", NewTableRow("r", map[string]Cell{"x": TextCell("1")}))}}),
			`nodes[0].table.groups[0].rows[0].cells.x: "x" is not a column of the table`},
		// rows and cells
		{"row without cells", row(NewTableRow("r", nil)), ""},
		{"bad row key", row(NewTableRow("", nil)), `nodes[0].table.rows[0].key: "" must match`},
		{"row key used by a column", row(NewTableRow("br", nil)), `nodes[0].table.rows[0].key: "br" is already used by nodes[0].table.columns[1]`},
		{"cell of no column", row(NewTableRow("r", map[string]Cell{"x": TextCell("1")})), `nodes[0].table.rows[0].cells.x: "x" is not a column of the table`},
		{"every kind of cell", row(NewTableRow("r", map[string]Cell{
			"num": StatusCell(StatusFailed, "#1287").WithPill(NewPill("failed", ToneError)),
			"br":  InlineCell(Spans(T("main").AsMono(), For(130e9), At(time.Date(2026, 11, 8, 9, 0, 0, 0, time.UTC), TimeRelative), T("log").Link("https://example.com"))),
		})), ""},
		{"a pill alone", cell(PillCell("running", ToneNeutral)), ""},
		{"an icon alone", cell(Cell{Glyph: &Glyph{Icon: "lock"}}), ""},
		{"value at the limit", cell(TextCell(strings.Repeat("x", MaxLabel))), ""},
		{"value too long", cell(TextCell(strings.Repeat("x", MaxLabel+1))), "nodes[0].table.rows[0].cells.num.value.text: 201 characters"},
		{"value of two lines", cell(TextCell("a\nb")), "nodes[0].table.rows[0].cells.num.value: one line"},
		{"bad glyph", cell(Cell{Glyph: &Glyph{}}), "nodes[0].table.rows[0].cells.num.glyph: a glyph needs a status or an icon"},
		{"bad pill", cell(Cell{Pill: &Pill{}}), "nodes[0].table.rows[0].cells.num.pill.label: required"},
		{"bad tone in a span", cell(InlineCell(Spans(Span{Text: "x", Tone: "red"}))), `nodes[0].table.rows[0].cells.num.value.spans[0].tone: unknown tone "red"`},
		{"row action, buttons, menu, selected", row(NewTableRow("r", nil).WithAction(EventAction("open", "1")).AsSelected().
			WithButtons(EventButton("r-a", "A", "a"), EventButton("r-b", "B", "b"), EventButton("r-c", "C", "c").WithIcon("x").AsIconOnly()).
			WithMenu(NewMenu(EventItem("r-m", "M", "m", "1")))), ""},
		{"bad row action", row(NewTableRow("r", nil).WithAction(&Action{})), "nodes[0].table.rows[0].action: an action is exactly one of"},
		{"too many buttons", row(NewTableRow("r", nil).WithButtons(EventButton("a", "A", "a"), EventButton("b", "B", "a"),
			EventButton("c", "C", "a"), EventButton("d", "D", "a"))), "nodes[0].table.rows[0].actions: 4 buttons, at most 3"},
		{"a menu button on a row", row(NewTableRow("r", nil).WithButtons(Button{Key: "a", Label: "A"}.WithMenu(NewMenu(EventItem("m", "M", "m", ""))))),
			"nodes[0].table.rows[0].actions[0].menu: these buttons do not open menus: give the row a menu"},
		{"bad menu", row(NewTableRow("r", nil).WithMenu(NewMenu())), "nodes[0].table.rows[0].menu.items: 0 items, want 1 to 24"},
		{"table in a section", NewSection("s", "S", NewTable("t", []TableColumn{num, TableCol("c1", "C")}, rows("r", 3)...)), ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := (View{Nodes: []Node{tt.node}}).Validate()
			switch {
			case tt.want == "" && err != nil:
				t.Fatalf("Validate: %v", err)
			case tt.want != "" && (err == nil || !strings.Contains(err.Error(), tt.want)):
				t.Fatalf("Validate = %v, want %q", err, tt.want)
			}
		})
	}
}

// A table is a body node: not in a toolbar, a footer or a group.
func TestTableStaysInTheBody(t *testing.T) {
	tb := NewTable("t", []TableColumn{TableCol("a", "A")})
	for _, tt := range []struct {
		name string
		v    View
		want string
	}{
		{"in the toolbar", View{Toolbar: []Node{tb}}, "toolbar[0]: a table node cannot be in the toolbar"},
		{"in the footer", View{Footer: []Node{tb}}, "footer[0]: a table node cannot be in the footer"},
		{"in a group", View{Nodes: []Node{NewGroup("g", AlignStart, tb)}}, "a group holds text, chips, actions, progress nodes, not table"},
	} {
		if err := tt.v.Validate(); err == nil || !strings.Contains(err.Error(), tt.want) {
			t.Errorf("%s: %v, want %q", tt.name, err, tt.want)
		}
	}
}

// Columns, groups, rows, a row's buttons and menu items count as elements; cells do not.
func TestTableCountsAsElements(t *testing.T) {
	cols := []TableColumn{TableCol("a", "A"), TableCol("b", "B")}
	rows := make([]TableRow, 100)
	for i := range rows {
		rows[i] = NewTableRow("r"+strconv.Itoa(i), map[string]Cell{"a": TextCell("1"), "b": TextCell("2")})
	}
	rows[0] = rows[0].WithButtons(EventButton("btn", "B", "b")).WithMenu(NewMenu(EventItem("m1", "M", "m", ""), Separator(), EventItem("m2", "M", "m", "")))
	groups := []TableGroup{NewTableGroup("g1", "A", rows[:50]...), NewTableGroup("g2", "B", rows[50:]...)}
	// The node, 2 columns, 2 groups, 100 rows, a button and 3 menu items: 109.
	base := NewGroupedTable("t", cols, groups...)
	chips := func(n int) []Node {
		out := make([]Node, n)
		for i := range out {
			out[i] = NewChips("ch" + strconv.Itoa(i))
		}
		return out
	}
	if err := (View{Nodes: append([]Node{base}, chips(MaxElements-109)...)}).Validate(); err != nil {
		t.Fatalf("at the limit: %v", err)
	}
	err := (View{Nodes: append([]Node{base}, chips(MaxElements-108)...)}).Validate()
	if err == nil || !strings.Contains(err.Error(), "view: 401 elements, at most 400") {
		t.Fatalf("over the limit: %v", err)
	}
}

// A cell with only a value is that Inline in JSON; with a glyph or a pill it is an object.
// Both decode back to the same cell.
func TestCellJSON(t *testing.T) {
	for _, tt := range []struct {
		name string
		cell Cell
		want string
	}{
		{"text", TextCell("main"), `"main"`},
		{"spans", InlineCell(Spans(T("6m 02s").AsMono())), `{"spans":[{"text":"6m 02s","mono":true}]}`},
		{"glyph", StatusCell(StatusOK, "#1286"), `{"value":"#1286","glyph":{"status":"ok"}}`},
		{"pill", PillCell("failed", ToneError), `{"pill":{"label":"failed","tone":"error"}}`},
		{"empty", Cell{}, `{}`},
	} {
		t.Run(tt.name, func(t *testing.T) {
			b, err := json.Marshal(tt.cell)
			if err != nil || string(b) != tt.want {
				t.Fatalf("Marshal = %s, %v; want %s", b, err, tt.want)
			}
			var back Cell
			if err := json.Unmarshal(b, &back); err != nil {
				t.Fatal(err)
			}
			if b2, _ := json.Marshal(back); string(b2) != tt.want {
				t.Fatalf("round trip %s, want %s", b2, tt.want)
			}
		})
	}
	for _, bad := range []string{`1`, `[]`, `{"value":1}`, `{"glyph":"ok"}`} {
		var c Cell
		if err := json.Unmarshal([]byte(bad), &c); err == nil {
			t.Errorf("Unmarshal(%s) = %+v, want an error", bad, c)
		}
	}
}

// The builders make what the JSON says, and the JSON round-trips.
func TestTableBuilders(t *testing.T) {
	cols := []TableColumn{
		TableCol("b-num", "#").WithWidth(72).WithPriority(9).AsSortable(SortDesc),
		TableCol("b-branch", "Branch").WithWeight(2, 96).WithStyle(CellMono),
		TableCol("b-dur", "Duration").WithWidth(72).AlignEnd().AsSortable(SortAsc),
	}
	tb := NewTable("builds", cols,
		NewTableRow("b-2", map[string]Cell{"b-num": StatusCell(StatusRunning, "#2"), "b-branch": TextCell("main")}).
			WithAction(EventAction("open", "2")).AsSelected(),
		NewTableRow("b-1", map[string]Cell{"b-num": StatusCell(StatusFailed, "#1"), "b-dur": InlineCell(Spans(For(362e9)))}).
			WithMenu(NewMenu(EventItem("b-1-log", "Open console", "log", "1"))))
	count := 1288
	tb.Table.Title, tb.Table.Count = "Builds", &count
	tb.Table.Sort = &TableSort{Column: "b-num", Dir: SortDesc}
	gr := NewGroupedTable("issues", []TableColumn{TableCol("i-key", "Key")},
		NewTableGroup("g-done", "Done", NewTableRow("CF-1", map[string]Cell{"i-key": TextCell("CF-1")})).WithCount(14).AsCollapsed())
	v := View{Nodes: []Node{tb, gr}}
	if err := v.Validate(); err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"nodes":[{"key":"builds","table":{"title":"Builds","count":1288,"columns":[` +
		`{"key":"b-num","label":"#","width":72,"priority":9,"sortable":true,"sortFirst":"desc"},` +
		`{"key":"b-branch","label":"Branch","weight":2,"minWidth":96,"style":"mono"},` +
		`{"key":"b-dur","label":"Duration","align":"end","width":72,"sortable":true}],"rows":[` +
		`{"key":"b-2","cells":{"b-branch":"main","b-num":{"value":"#2","glyph":{"status":"running"}}},"action":{"event":"open","data":"2"},"selected":true},` +
		`{"key":"b-1","cells":{"b-dur":{"spans":[{"duration":{"ms":362000}}]},"b-num":{"value":"#1","glyph":{"status":"failed"}}},` +
		`"menu":{"items":[{"key":"b-1-log","label":"Open console","action":{"event":"log","data":"1"}}]}}],` +
		`"sort":{"column":"b-num","dir":"desc"}}},` +
		`{"key":"issues","table":{"columns":[{"key":"i-key","label":"Key"}],"groups":[` +
		`{"key":"g-done","label":"Done","count":14,"collapsed":true,"rows":[{"key":"CF-1","cells":{"i-key":"CF-1"}}]}]}}]}`
	if string(b) != want {
		t.Fatalf("JSON\n got %s\nwant %s", b, want)
	}
	var back View
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	if b2, _ := json.Marshal(back); string(b2) != want {
		t.Fatalf("round trip\n got %s\nwant %s", b2, want)
	}
	if got := len(back.Nodes[1].Table.AllRows()); got != 1 {
		t.Fatalf("AllRows of the grouped table: %d", got)
	}
}

// The direction a header click asks for.
func TestNextSort(t *testing.T) {
	asc := TableCol("a", "A").AsSortable(SortAsc)
	desc := TableCol("d", "D").AsSortable(SortDesc)
	for _, tt := range []struct {
		name string
		col  TableColumn
		sort *TableSort
		want SortDir
	}{
		{"unsorted table, ascending first", asc, nil, SortAsc},
		{"unsorted table, descending first", desc, nil, SortDesc},
		{"sorted by another column", desc, &TableSort{Column: "a", Dir: SortAsc}, SortDesc},
		{"sorted ascending by it", desc, &TableSort{Column: "d", Dir: SortAsc}, SortDesc},
		{"sorted descending by it", asc, &TableSort{Column: "a", Dir: SortDesc}, SortAsc},
	} {
		if got := NextSort(tt.col, tt.sort); got != tt.want {
			t.Errorf("%s: %q, want %q", tt.name, got, tt.want)
		}
	}
}
