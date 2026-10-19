package ui

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// nodeKinds are Node's kind fields by JSON name (every field but key), in order.
func nodeKinds() []string {
	t := reflect.TypeFor[Node]()
	var out []string
	for i := range t.NumField() {
		if name, _, _ := strings.Cut(t.Field(i).Tag.Get("json"), ","); name != "key" {
			out = append(out, name)
		}
	}
	return out
}

// nodeKindOf is n's one kind field's JSON name ("" for none, the first for several).
func nodeKindOf(n Node) string {
	v, t := reflect.ValueOf(n), reflect.TypeFor[Node]()
	for i := range t.NumField() {
		if f := v.Field(i); f.Kind() == reflect.Pointer && !f.IsNil() {
			name, _, _ := strings.Cut(t.Field(i).Tag.Get("json"), ",")
			return name
		}
	}
	return ""
}

// withKind returns a node keyed key with kind k set to its type's zero value.
func withKind(key, k string) Node {
	n := Node{Key: key}
	v, t := reflect.ValueOf(&n).Elem(), reflect.TypeFor[Node]()
	for i := range t.NumField() {
		if name, _, _ := strings.Cut(t.Field(i).Tag.Get("json"), ","); name == k {
			v.Field(i).Set(reflect.New(t.Field(i).Type.Elem()))
		}
	}
	return n
}

// Every kind field of Node counts in "exactly one kind": a kind the check forgot would
// pass as a second kind, or fail alone.
func TestEveryKindIsOneKind(t *testing.T) {
	kinds := nodeKinds()
	if len(kinds) != 23 {
		t.Errorf("%d kinds: %v (a new kind needs its validation, GUI renderer and docs)", len(kinds), kinds)
	}
	for _, k := range kinds {
		alone := View{Nodes: []Node{withKind("n", k)}}
		if err := alone.Validate(); err != nil && strings.Contains(err.Error(), "exactly one kind") {
			t.Errorf("%s alone: %v", k, err)
		}
		if err := alone.Validate(); err != nil && !strings.Contains(err.Error(), "exactly one kind ("+strings.Join(kinds, ", ")+")") &&
			strings.Contains(err.Error(), "exactly one kind") {
			t.Errorf("%s: the message does not list every kind: %v", k, err)
		}
		two := withKind("n", k)
		if k == "text" {
			two.Markdown = &Markdown{}
		} else {
			two.Text = &Text{Content: Plain("x")}
		}
		if err := (View{Nodes: []Node{two}}).Validate(); err == nil || !strings.Contains(err.Error(), "this one has 2") {
			t.Errorf("%s with a second kind: %v", k, err)
		}
	}
}

// containers builds each container kind around one child; every kind whose data holds a
// []Node (directly or in a slice of structs) must be here or in lineKinds.
var containers = map[string]func(key string, child Node) Node{
	"section": func(key string, child Node) Node { return NewSection(key, "", child) },
	"columns": func(key string, child Node) Node {
		return NewColumns(key, NewColumn(key+"-a", child), NewColumn(key+"-b"))
	},
	"pane":      func(key string, child Node) Node { return NewPane(key, HeightAuto, child) },
	"container": func(key string, child Node) Node { return NewContainer(key, ContainerNarrow, child) },
	"masterDetail": func(key string, child Node) Node {
		return NewMasterDetail(key, List{Rows: []Row{NewRow(key+"-r", "Run")}}, key+"-r", child)
	},
	"tabs": func(key string, child Node) Node {
		return NewTabsNode(key, NewTabs(key+"-a", NewTab(key+"-a", "A"), NewTab(key+"-b", "B")), child)
	},
	"grid": func(key string, child Node) Node {
		return NewGrid(key, NewGridItem(key+"-a", child), NewGridItem(key+"-b"))
	},
}

// lineKinds hold nodes but are not containers: their items are leaves at their own depth.
var lineKinds = map[string]func(key string, leaf Node) Node{
	"group": func(key string, leaf Node) Node { return NewGroup(key, AlignStart, leaf) },
}

// holdsNodes reports whether t (a struct) has a []Node field, or a slice of structs that do.
func holdsNodes(t reflect.Type) bool {
	for i := range t.NumField() {
		f := t.Field(i).Type
		if f == reflect.TypeFor[[]Node]() {
			return true
		}
		if f.Kind() == reflect.Slice && f.Elem().Kind() == reflect.Struct && f.Elem() != reflect.TypeFor[Node]() && holdsNodes(f.Elem()) {
			return true
		}
	}
	return false
}

// Every container counts one level of MaxDepth, alone and mixed, and Children lists its
// nodes for the host's walks.
func TestContainerDepth(t *testing.T) {
	nt := reflect.TypeFor[Node]()
	var kinds []string
	for i := range nt.NumField() {
		f := nt.Field(i)
		if f.Type.Kind() == reflect.Pointer && holdsNodes(f.Type.Elem()) {
			name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
			if lineKinds[name] != nil {
				continue
			}
			kinds = append(kinds, name)
			if containers[name] == nil {
				t.Errorf("container %s: add it to containers or lineKinds (depth, walks, the GUI's childLists)", name)
			}
		}
	}
	if len(kinds) != len(containers) {
		t.Errorf("containers %v, the test knows %d", kinds, len(containers))
	}
	nest := func(levels []string) Node {
		n := NewText("leaf", Plain("x"))
		for i := len(levels) - 1; i >= 0; i-- {
			n = containers[levels[i]](fmt.Sprintf("c%d", i), n)
		}
		return n
	}
	for _, k := range kinds {
		t.Run(k, func(t *testing.T) {
			at := make([]string, MaxDepth)
			for i := range at {
				at[i] = k
			}
			if err := (View{Nodes: []Node{nest(at)}}).Validate(); err != nil {
				t.Errorf("%d %s deep: %v", MaxDepth, k, err)
			}
			err := (View{Nodes: []Node{nest(append(at, k))}}).Validate()
			if err == nil || !strings.Contains(err.Error(), fmt.Sprintf("inside %d containers (section, columns, pane, grid, container, masterDetail, tabs), at most %d", MaxDepth+1, MaxDepth)) {
				t.Errorf("%d %s deep: %v", MaxDepth+1, k, err)
			}
			// Children reaches the leaf through every level.
			n, levels := nest(at), 0
			for {
				ch := n.Children()
				if ch == nil {
					break
				}
				levels++
				n = ch[0][0]
			}
			if levels != MaxDepth || n.Key != "leaf" {
				t.Errorf("Children walked %d levels to %q", levels, n.Key)
			}
		})
	}
	// A group is no level: one at the deepest container holds its leaves there, and
	// Children walks into it.
	for name, line := range lineKinds {
		at := []string{"section", "grid", "columns", "pane"}
		n := line("line", NewText("leaf", Plain("x")))
		for i := len(at) - 1; i >= 0; i-- {
			n = containers[at[i]](fmt.Sprintf("c%d", i), n)
		}
		if err := (View{Nodes: []Node{n}}).Validate(); err != nil {
			t.Errorf("a %s inside %d containers: %v", name, MaxDepth, err)
		}
		if ch := line("line", NewText("leaf", Plain("x"))).Children(); len(ch) != 1 || len(ch[0]) != 1 || ch[0][0].Key != "leaf" {
			t.Errorf("%s: Children = %v", name, ch)
		}
	}
	// The planned page layout: section > columns > pane > leaf, and one spare level.
	if err := (View{Nodes: []Node{nest([]string{"section", "columns", "pane", "section"})}}).Validate(); err != nil {
		t.Errorf("section > columns > pane > section > leaf: %v", err)
	}
	// A page's container takes the spare level.
	if err := (View{Nodes: []Node{nest([]string{"container", "columns", "pane", "section"})}}).Validate(); err != nil {
		t.Errorf("container > columns > pane > section > leaf: %v", err)
	}
	if (Node{Key: "t", Text: &Text{}}).Children() != nil {
		t.Error("a text node has children")
	}
}

func TestValidateLayout(t *testing.T) {
	text := func(k string) Node { return NewText(k, Plain("x")) }
	two := func(a, b Column) Node { return NewColumns("cols", a, b) }
	pane := func(p Pane) Node { return Node{Key: "pane", Pane: &p} }
	tests := []struct {
		name string
		node Node
		want string // "" = valid
	}{
		{"two columns", two(NewColumn("a", text("t1")), NewColumn("b", text("t2"))), ""},
		{"four columns, weights and widths", NewColumns("cols", NewColumn("a").WithWeight(1), NewColumn("b").WithWeight(MaxColumnWeight),
			NewColumn("c").WithWidth(MinColumnWidth), NewColumn("d").WithWidth(MaxColumnWidth)), ""},
		{"empty columns", two(NewColumn("a"), NewColumn("b")), ""},
		{"collapse stack", Node{Key: "cols", Columns: &Columns{Collapse: CollapseStack, Items: []Column{NewColumn("a"), NewColumn("b")}}}, ""},
		{"collapse first", Node{Key: "cols", Columns: &Columns{Collapse: CollapseFirst, Items: []Column{NewColumn("a"), NewColumn("b")}}}, ""},
		{"no columns", NewColumns("cols"), "nodes[0].columns.items: 0 columns, want 2 to 4"},
		{"one column", NewColumns("cols", NewColumn("a")), "nodes[0].columns.items: 1 columns, want 2 to 4"},
		{"five columns", NewColumns("cols", NewColumn("a"), NewColumn("b"), NewColumn("c"), NewColumn("d"), NewColumn("e")), "5 columns, want 2 to 4"},
		{"unknown collapse", Node{Key: "cols", Columns: &Columns{Collapse: "hide", Items: []Column{NewColumn("a"), NewColumn("b")}}}, `nodes[0].columns.collapse: unknown collapse "hide" (stack or first)`},
		{"weight too big", two(Column{Key: "a", Weight: 7}, NewColumn("b")), "nodes[0].columns.items[0].weight: 7 is outside 1..6 (0 is 1)"},
		{"negative weight", two(NewColumn("a"), Column{Key: "b", Weight: -1}), "items[1].weight: -1 is outside 1..6"},
		{"width too small", two(Column{Key: "a", Width: 159}, NewColumn("b")), "items[0].width: 159 px is outside 160..640"},
		{"width too big", two(Column{Key: "a", Width: 641}, NewColumn("b")), "items[0].width: 641 px is outside 160..640"},
		{"negative width", two(Column{Key: "a", Width: -5}, NewColumn("b")), "items[0].width: -5 px is outside 160..640"},
		{"weight and width", two(Column{Key: "a", Weight: 2, Width: 200}, NewColumn("b")), "nodes[0].columns.items[0]: a column has a weight or a width, not both"},
		{"bad column key", two(NewColumn("a b"), NewColumn("b")), `items[0].key: "a b" must match`},
		{"duplicate column key", two(NewColumn("a"), NewColumn("a")), `nodes[0].columns.items[1].key: "a" is already used by nodes[0].columns.items[0]`},
		{"column key used by a node", two(NewColumn("cols"), NewColumn("b")), `items[0].key: "cols" is already used by nodes[0]`},
		{"duplicate key across columns", two(NewColumn("a", text("t")), NewColumn("b", text("t"))), `nodes[0].columns.items[1].children[0].key: "t" is already used by nodes[0].columns.items[0].children[0]`},
		{"bad child in a column", two(NewColumn("a", Node{Key: "x"}), NewColumn("b")), "nodes[0].columns.items[0].children[0]: a node has exactly one kind"},
		{"auto pane", NewPane("pane", HeightAuto, text("t")), ""},
		{"unset pane height", pane(Pane{Children: []Node{text("t")}}), ""},
		{"fill pane", pane(Pane{Height: HeightFill, MinHeight: 300}), ""},
		{"px pane at the bounds", pane(Pane{Height: HeightPx(MinHeightPx), MinHeight: MinHeightPx}), ""},
		{"px pane at the top", pane(Pane{Height: HeightPx(MaxHeightPx), NoScroll: true}), ""},
		{"pane too short", pane(Pane{Height: HeightPx(119)}), "nodes[0].pane.height: 119 px is outside 120..1600"},
		{"pane too tall", pane(Pane{Height: HeightPx(1601)}), "nodes[0].pane.height: 1601 px is outside 120..1600"},
		{"min height too small", pane(Pane{MinHeight: 100}), "nodes[0].pane.minHeight: 100 px is outside 120..1600"},
		{"min height too big", pane(Pane{Height: HeightFill, MinHeight: 2000}), "nodes[0].pane.minHeight: 2000 px is outside 120..1600"},
		{"negative min height", pane(Pane{MinHeight: -1}), "minHeight: -1 px is outside"},
		{"min height above the px height", pane(Pane{Height: HeightPx(300), MinHeight: 400}), "nodes[0].pane.minHeight: 400 px is above the pane's height (300 px)"},
		{"bad child in a pane", pane(Pane{Children: []Node{{Key: "x"}}}), "nodes[0].pane.children[0]: a node has exactly one kind"},
		{"live nodes in a pane in a column", two(NewColumn("a", NewPane("p", HeightPx(600), Node{Key: "th", Thread: &Thread{ThreadID: "s-1", Height: HeightFill}})),
			NewColumn("b", NewTerminal("te", "t-1"))), ""},
		{"thread too short in a pane", pane(Pane{Children: []Node{{Key: "th", Thread: &Thread{ThreadID: "s-1", Height: HeightPx(50)}}}}), "nodes[0].pane.children[0].thread.height: 50 px is outside"},
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

// A column is an element: 2 columns and 397 other elements are 400, one more is refused.
func TestColumnsCountAsElements(t *testing.T) {
	build := func(n int) View {
		var rest []Node
		for i := range n {
			rest = append(rest, NewChips("ch"+strconv.Itoa(i)))
		}
		return View{Nodes: append([]Node{NewColumns("cols", NewColumn("a"), NewColumn("b"))}, rest...)}
	}
	if err := build(MaxElements - 3).Validate(); err != nil {
		t.Errorf("400 elements: %v", err)
	}
	if err := build(MaxElements - 2).Validate(); err == nil || !strings.Contains(err.Error(), "view: 401 elements, at most 400") {
		t.Errorf("401 elements: %v", err)
	}
	// Panes and their nodes count as nodes do.
	var many []Node
	for i := range MaxElements - 1 {
		many = append(many, NewChips("p"+strconv.Itoa(i)))
	}
	if err := (View{Nodes: []Node{NewPane("pane", HeightAuto, many...)}}).Validate(); err != nil {
		t.Errorf("a pane of 399: %v", err)
	}
	if err := (View{Nodes: []Node{NewPane("pane", HeightAuto, append(many, NewChips("one-more"))...)}}).Validate(); err == nil {
		t.Error("a pane of 400 (401 elements) passed")
	}
}

func TestLayoutJSON(t *testing.T) {
	n := NewColumns("cols", NewColumn("a", NewPane("p", HeightFill)).WithWeight(2), NewColumn("b").WithWidth(320))
	n.Columns.Collapse = CollapseFirst
	b, err := json.Marshal(n)
	if err != nil {
		t.Fatal(err)
	}
	// Nil lists encode as null here; the host's canonical form makes them [] (fillLists).
	const want = `{"key":"cols","columns":{"items":[{"key":"a","weight":2,"children":[{"key":"p","pane":{"height":"fill","children":null}}]},{"key":"b","width":320,"children":null}],"collapse":"first"}}`
	if string(b) != want {
		t.Errorf("JSON\n got %s\nwant %s", b, want)
	}
	var back Node
	if err := json.Unmarshal([]byte(want), &back); err != nil {
		t.Fatal(err)
	}
	if back.Columns.Items[0].Weight != 2 || !back.Columns.Items[0].Children[0].Pane.Height.Fill() || back.Columns.Items[1].Width != 320 {
		t.Errorf("decoded %+v", back.Columns)
	}
	// WithWeight and WithWidth replace each other; a pane's unset height is left out.
	if c := NewColumn("c").WithWidth(200).WithWeight(3); c.Width != 0 || c.Weight != 3 {
		t.Errorf("WithWeight after WithWidth: %+v", c)
	}
	if c := NewColumn("c").WithWeight(3).WithWidth(200); c.Weight != 0 || c.Width != 200 {
		t.Errorf("WithWidth after WithWeight: %+v", c)
	}
	if b, _ := json.Marshal(Pane{}); string(b) != `{"children":null}` {
		t.Errorf("empty pane: %s", b)
	}
	p := NewPane("p", HeightPx(400))
	p.Pane.MinHeight, p.Pane.NoScroll = 200, true
	if b, _ := json.Marshal(p); string(b) != `{"key":"p","pane":{"height":400,"minHeight":200,"noScroll":true,"children":null}}` {
		t.Errorf("pane: %s", b)
	}
}

// The GUI draws columns, grids, spacers, groups and the live budget with the numbers the
// SDK documents (gui/frontend/src/components/plugin/layout.ts, live.ts).
func TestLayoutNumbersMatchTheGUI(t *testing.T) {
	read := func(name string) string {
		b, err := os.ReadFile("../../gui/frontend/src/components/plugin/" + name)
		if os.IsNotExist(err) {
			t.Skip("no GUI in this tree")
		}
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	layout, live := read("layout.ts"), read("live.ts")
	for _, c := range []struct {
		src, name string
		want      int
	}{
		{layout, "COLUMN_MIN_WIDTH", ColumnMinWidth},
		{layout, "COLUMN_GAP", ColumnGap},
		{live, "INLINE_LIVE_MAX", MaxLiveNodes},
		{layout, "GRID_MIN_WIDTH", GridMinWidth},
		{layout, "GRID_MAX_COLUMNS", MaxGridColumns},
		{layout, "GRID_GAP", GridGap},
		{layout, "GRID_MAX_SPAN", MaxGridSpan},
		{layout, "SPACER_SIZE", SpacerSize},
		{layout, "GROUP_GAP", GroupGap},
		{layout, "MASTER_DETAIL_LIST_WIDTH", MasterDetailListWidth},
		{layout, "MASTER_DETAIL_MIN_DETAIL", MasterDetailMinDetail},
		{layout, "MASTER_DETAIL_GAP", MasterDetailGap},
	} {
		m := regexp.MustCompile(`export const ` + c.name + ` = (\d+);`).FindStringSubmatch(c.src)
		if m == nil {
			t.Errorf("the GUI has no %s", c.name)
			continue
		}
		if got, _ := strconv.Atoi(m[1]); got != c.want {
			t.Errorf("the GUI's %s is %d, the SDK's %d", c.name, got, c.want)
		}
	}
	if want := fmt.Sprintf("export const GRID_MIN_WIDTH_RANGE = [%d, %d] as const;", MinGridMinWidth, MaxGridMinWidth); !strings.Contains(layout, want) {
		t.Errorf("the GUI's grid min width range is not %q", want)
	}
	if want := fmt.Sprintf("export const MASTER_DETAIL_LIST_WIDTH_RANGE = [%d, %d] as const;", MinListWidth, MaxListWidth); !strings.Contains(layout, want) {
		t.Errorf("the GUI's master-detail list width range is not %q", want)
	}
	if want := fmt.Sprintf("s >= %d && s <= %d ? s : SPACER_SIZE", MinSpacer, MaxSpacer); !strings.Contains(layout, want) {
		t.Errorf("the GUI's spacer range is not %q", want)
	}
}
