package ui

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
)

// Every validation branch of grid, divider, spacer and group
// (docs/notes/plugins-layout-2-grid-inline.md).
func TestValidateGridAndInline(t *testing.T) {
	text := func(k string) Node { return NewText(k, Plain("x")) }
	items := func(n int) []GridItem {
		out := make([]GridItem, n)
		for i := range out {
			out[i] = NewGridItem("i" + strconv.Itoa(i))
		}
		return out
	}
	grid := func(g Grid) Node { return Node{Key: "grid", Grid: &g} }
	leaves := func(n int) []Node {
		out := make([]Node, n)
		for i := range out {
			out[i] = text("l" + strconv.Itoa(i))
		}
		return out
	}
	group := func(g Group) Node { return Node{Key: "grp", Group: &g} }
	bar := NewActions("bar", EventButton("go", "Go", "go"))
	tests := []struct {
		name string
		node Node
		want string // "" = valid
	}{
		// grid
		{"one item", NewGrid("grid", NewGridItem("a", text("t"))), ""},
		{"most items", grid(Grid{Items: items(MaxGridItems)}), ""},
		{"no items", NewGrid("grid"), "nodes[0].grid.items: 0 items, want 1 to 24"},
		{"too many items", grid(Grid{Items: items(MaxGridItems + 1)}), "nodes[0].grid.items: 25 items, want 1 to 24"},
		{"min width at the bounds", grid(Grid{MinWidth: MinGridMinWidth, Items: items(1)}), ""},
		{"min width at the top", grid(Grid{MinWidth: MaxGridMinWidth, Items: items(1)}), ""},
		{"min width too small", grid(Grid{MinWidth: 159, Items: items(1)}), "nodes[0].grid.minWidth: 159 px is outside 160..480 (0 is 240)"},
		{"min width too big", grid(Grid{MinWidth: 481, Items: items(1)}), "nodes[0].grid.minWidth: 481 px is outside 160..480"},
		{"negative min width", grid(Grid{MinWidth: -1, Items: items(1)}), "minWidth: -1 px is outside"},
		{"span 1 and 2", NewGrid("grid", NewGridItem("a").WithSpan(1), NewGridItem("b").WithSpan(MaxGridSpan)), ""},
		{"span too big", NewGrid("grid", NewGridItem("a").WithSpan(3)), "nodes[0].grid.items[0].span: 3 is outside 1..2 (0 is 1)"},
		{"negative span", NewGrid("grid", NewGridItem("a"), NewGridItem("b").WithSpan(-1)), "nodes[0].grid.items[1].span: -1 is outside 1..2"},
		{"bad item key", NewGrid("grid", NewGridItem("a b")), `nodes[0].grid.items[0].key: "a b" must match`},
		{"duplicate item key", NewGrid("grid", NewGridItem("a"), NewGridItem("a")), `nodes[0].grid.items[1].key: "a" is already used by nodes[0].grid.items[0]`},
		{"item key used by the grid", NewGrid("grid", NewGridItem("grid")), `items[0].key: "grid" is already used by nodes[0]`},
		{"duplicate key across items", NewGrid("grid", NewGridItem("a", text("t")), NewGridItem("b", text("t"))), `nodes[0].grid.items[1].children[0].key: "t" is already used by nodes[0].grid.items[0].children[0]`},
		{"bad child in an item", NewGrid("grid", NewGridItem("a", Node{Key: "x"})), "nodes[0].grid.items[0].children[0]: a node has exactly one kind"},
		{"cards with live nodes", NewGrid("grid", NewGridItem("a", NewSection("s", "Card", NewThread("th", "s-1"))), NewGridItem("b", NewTerminal("te", "t-1"))), ""},
		// divider
		{"bare divider", NewDivider("d", ""), ""},
		{"labelled divider", NewDivider("d", strings.Repeat("x", MaxLabel)), ""},
		{"divider label too long", NewDivider("d", strings.Repeat("x", MaxLabel+1)), "nodes[0].divider.label: 201 characters, at most 200"},
		// spacer
		{"default spacer", NewSpacer("s", 0), ""},
		{"spacer at the bounds", NewSpacer("s", MinSpacer), ""},
		{"spacer at the top", NewSpacer("s", MaxSpacer), ""},
		{"flex spacer", NewFlexSpacer("s"), ""},
		{"flex spacer with a size", Node{Key: "s", Spacer: &Spacer{Size: 24, Flex: true}}, ""},
		{"spacer too small", NewSpacer("s", 3), "nodes[0].spacer.size: 3 px is outside 4..64 (0 is 12)"},
		{"spacer too big", NewSpacer("s", 65), "nodes[0].spacer.size: 65 px is outside 4..64"},
		{"negative spacer", NewSpacer("s", -4), "nodes[0].spacer.size: -4 px is outside"},
		// group
		{"group of every kind it holds", NewGroup("grp", AlignBetween, text("t"), NewChips("c", NewChip("c1", "Build", StatusOK)), bar,
			NewProgress("p", "Deploy", frac(0.5))), ""},
		{"most items", group(Group{Items: leaves(MaxGroupItems)}), ""},
		{"no items", NewGroup("grp", AlignStart), "nodes[0].group.items: 0 items, want 1 to 8"},
		{"too many items", group(Group{Items: leaves(MaxGroupItems + 1)}), "nodes[0].group.items: 9 items, want 1 to 8"},
		{"align start", NewGroup("grp", AlignStart, text("t")), ""},
		{"align center", NewGroup("grp", AlignCenter, text("t")), ""},
		{"align end", NewGroup("grp", AlignEnd, text("t")), ""},
		{"align unset", NewGroup("grp", "", text("t")), ""},
		{"unknown align", NewGroup("grp", "middle", text("t")), `nodes[0].group.align: unknown align "middle" (start, center, end or between)`},
		{"no wrap", group(Group{Items: leaves(2), NoWrap: true}), ""},
		{"a markdown item", NewGroup("grp", AlignStart, NewMarkdown("md", "x")), "nodes[0].group.items[0]: a group holds text, chips, actions, progress nodes, not markdown"},
		{"a section item", NewGroup("grp", AlignStart, text("t"), NewSection("s", "S", text("in"))), "nodes[0].group.items[1]: a group holds text, chips, actions, progress nodes, not section"},
		{"a group item", NewGroup("grp", AlignStart, NewGroup("inner", AlignStart, text("t"))), "nodes[0].group.items[0]: a group holds text, chips, actions, progress nodes, not group"},
		{"a spacer item", NewGroup("grp", AlignStart, NewSpacer("sp", 0)), "not spacer"},
		{"a divider item", NewGroup("grp", AlignStart, NewDivider("dv", "")), "not divider"},
		{"a thread item", NewGroup("grp", AlignStart, NewThread("th", "s-1")), "not thread"},
		{"an item without a kind", NewGroup("grp", AlignStart, Node{Key: "x"}), "nodes[0].group.items[0]: a node has exactly one kind"},
		{"an item of two kinds", NewGroup("grp", AlignStart, Node{Key: "x", Text: &Text{Content: Plain("x")}, Chips: &Chips{}}), "this one has 2"},
		{"a refused item's key still counts", NewGroup("grp", AlignStart, NewMarkdown("grp", "x")), `nodes[0].group.items[0].key: "grp" is already used by nodes[0]`},
		{"a bad item", NewGroup("grp", AlignStart, NewProgress("p", "", frac(2))), "nodes[0].group.items[0].progress.value: 2 is outside 0..1"},
		{"duplicate item keys", NewGroup("grp", AlignStart, text("t"), text("t")), `nodes[0].group.items[1].key: "t" is already used by nodes[0].group.items[0]`},
		{"a group in a grid item", NewGrid("grid", NewGridItem("a", NewGroup("grp", AlignEnd, bar))), ""},
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

// Actions bars still take start and end only; center and between are a group's.
func TestActionsAlign(t *testing.T) {
	for _, a := range []Align{AlignCenter, AlignBetween} {
		n := NewActions("bar", EventButton("go", "Go", "go"))
		n.Actions.Align = a
		if err := (View{Nodes: []Node{n}}).Validate(); err == nil || !strings.Contains(err.Error(), `unknown align "`+string(a)+`" (start or end)`) {
			t.Errorf("actions align %s: %v", a, err)
		}
	}
}

// Grid items and group items count as elements: with the grid (or group) node itself,
// 400 pass and 401 are refused.
func TestGridAndGroupCountAsElements(t *testing.T) {
	chips := func(n int) []Node {
		out := make([]Node, n)
		for i := range out {
			out[i] = NewChips("ch" + strconv.Itoa(i))
		}
		return out
	}
	gridOf := func(rest int) View {
		return View{Nodes: append([]Node{NewGrid("grid", NewGridItem("a"), NewGridItem("b"), NewGridItem("c"))}, chips(rest)...)}
	}
	if err := gridOf(MaxElements - 4).Validate(); err != nil {
		t.Errorf("400 elements: %v", err)
	}
	if err := gridOf(MaxElements - 3).Validate(); err == nil || !strings.Contains(err.Error(), "view: 401 elements, at most 400") {
		t.Errorf("401 elements: %v", err)
	}
	groupOf := func(rest int) View {
		g := NewGroup("grp", AlignStart, NewText("t1", Plain("a")), NewText("t2", Plain("b")))
		return View{Nodes: append([]Node{g}, chips(rest)...)}
	}
	if err := groupOf(MaxElements - 3).Validate(); err != nil {
		t.Errorf("400 elements: %v", err)
	}
	if err := groupOf(MaxElements - 2).Validate(); err == nil || !strings.Contains(err.Error(), "view: 401 elements, at most 400") {
		t.Errorf("401 elements: %v", err)
	}
	// Dividers and spacers are one node each.
	var many []Node
	for i := range MaxElements / 2 {
		many = append(many, NewDivider("d"+strconv.Itoa(i), ""), NewSpacer("s"+strconv.Itoa(i), 0))
	}
	if err := (View{Nodes: many}).Validate(); err != nil {
		t.Errorf("200 dividers and 200 spacers: %v", err)
	}
	if err := (View{Nodes: append(many, NewDivider("one-more", ""))}).Validate(); err == nil {
		t.Error("401 dividers and spacers passed")
	}
}

func TestGridAndInlineJSON(t *testing.T) {
	g := NewGrid("cards", NewGridItem("a", NewText("at", Plain("A"))).WithSpan(2), NewGridItem("b"))
	g.Grid.MinWidth = 200
	cases := []struct {
		node Node
		want string
	}{
		// Nil lists encode as null here; the host's canonical form makes them [] (fillLists).
		{g, `{"key":"cards","grid":{"minWidth":200,"items":[{"key":"a","span":2,"children":[{"key":"at","text":{"content":"A"}}]},{"key":"b","children":null}]}}`},
		{NewDivider("d", ""), `{"key":"d","divider":{}}`},
		{NewDivider("d", "Checks"), `{"key":"d","divider":{"label":"Checks"}}`},
		{NewSpacer("s", 0), `{"key":"s","spacer":{}}`},
		{NewSpacer("s", 24), `{"key":"s","spacer":{"size":24}}`},
		{NewFlexSpacer("s"), `{"key":"s","spacer":{"flex":true}}`},
		{NewGroup("g", AlignBetween, NewText("t", Plain("x"))), `{"key":"g","group":{"items":[{"key":"t","text":{"content":"x"}}],"align":"between"}}`},
		{Node{Key: "g", Group: &Group{NoWrap: true}}, `{"key":"g","group":{"items":null,"noWrap":true}}`},
	}
	for _, c := range cases {
		b, err := json.Marshal(c.node)
		if err != nil {
			t.Fatal(err)
		}
		if string(b) != c.want {
			t.Errorf("JSON\n got %s\nwant %s", b, c.want)
		}
		var back Node
		if err := json.Unmarshal([]byte(c.want), &back); err != nil {
			t.Fatal(err)
		}
		if again, _ := json.Marshal(back); string(again) != c.want {
			t.Errorf("round trip\n got %s\nwant %s", again, c.want)
		}
	}
	var back Node
	if err := json.Unmarshal([]byte(cases[0].want), &back); err != nil || back.Grid.MinWidth != 200 || back.Grid.Items[0].Span != 2 || len(back.Children()) != 2 {
		t.Errorf("decoded %+v (%v)", back.Grid, err)
	}
}

func frac(v float64) *float64 { return &v }
