package ui_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// wrap builds each container kind around child (keys from key).
var wrap = map[string]func(key string, child ui.Node) ui.Node{
	"section": func(key string, child ui.Node) ui.Node { return ui.NewSection(key, "", child) },
	"columns": func(key string, child ui.Node) ui.Node {
		return ui.NewColumns(key, ui.NewColumn(key+"-a", child), ui.NewColumn(key+"-b"))
	},
	"pane":      func(key string, child ui.Node) ui.Node { return ui.NewPane(key, ui.HeightAuto, child) },
	"container": func(key string, child ui.Node) ui.Node { return ui.NewContainer(key, ui.ContainerNarrow, child) },
	"masterDetail": func(key string, child ui.Node) ui.Node {
		return ui.NewMasterDetail(key, ui.List{Rows: []ui.Row{ui.NewRow(key+"-r", "Run")}}, key+"-r", child)
	},
	"tabs": func(key string, child ui.Node) ui.Node {
		return ui.NewTabsNode(key, ui.NewTabs(key+"-a", ui.NewTab(key+"-a", "A"), ui.NewTab(key+"-b", "B")), child)
	},
	"grid": func(key string, child ui.Node) ui.Node {
		return ui.NewGrid(key, ui.NewGridItem(key+"-a", child), ui.NewGridItem(key+"-b"))
	},
}

var wrapKinds = []string{"section", "columns", "pane", "container", "masterDetail", "tabs", "grid"}

// nestLevels wraps a text leaf in levels (outermost first); group in 0..len(levels)-1
// puts a group around that level's container, len(levels) around the leaf.
func nestLevels(levels []string, group int) ui.Node {
	n := ui.NewText("leaf", ui.Plain("x"))
	if group == len(levels) {
		n = ui.NewGroup("g-leaf", ui.AlignStart, n)
	}
	for i := len(levels) - 1; i >= 0; i-- {
		n = wrap[levels[i]](fmt.Sprintf("c%d", i), n)
		if i == group {
			n = ui.NewGroup(fmt.Sprintf("g%d", i), ui.AlignStart, n)
		}
	}
	return n
}

func combos(n int) [][]string {
	if n == 0 {
		return [][]string{nil}
	}
	var out [][]string
	for _, c := range combos(n - 1) {
		for _, k := range wrapKinds {
			out = append(out, append(append([]string(nil), c...), k))
		}
	}
	return out
}

// Every mix of MaxDepth containers holds a leaf; every mix of MaxDepth+1 refuses it with
// one problem, at the leaf's path. A group around the leaf is no level, and a group around
// a container is refused by kind, not by depth.
func TestDepthEveryMix(t *testing.T) {
	for _, levels := range combos(ui.MaxDepth) {
		if err := (ui.View{Nodes: []ui.Node{nestLevels(levels, -1)}}).Validate(); err != nil {
			t.Errorf("%v: %v", levels, err)
		}
		// A group holding the leaf at the deepest level.
		if err := (ui.View{Nodes: []ui.Node{nestLevels(levels, len(levels))}}).Validate(); err != nil {
			t.Errorf("%v > group > leaf: %v", levels, err)
		}
	}
	for _, levels := range combos(ui.MaxDepth + 1) {
		v := ui.View{Nodes: []ui.Node{nestLevels(levels, -1)}}
		msgs := problems(v.Validate())
		// The message names the containers around the leaf, outermost first.
		if len(msgs) != 1 || !strings.HasSuffix(msgs[0], ": inside 5 containers ("+strings.Join(levels, " > ")+"), at most 4") {
			t.Fatalf("%v: %q", levels, msgs)
		}
		if p, _, _ := strings.Cut(msgs[0], ": "); !pathExists(v, p) || !strings.HasSuffix(p, "]") {
			t.Fatalf("%v: the depth problem's path %q", levels, p)
		}
	}
	// The brief's chain: a master-detail's detail in a tabs node in columns in a section.
	chain := []string{"section", "columns", "tabs", "masterDetail"}
	if err := (ui.View{Nodes: []ui.Node{nestLevels(chain, -1)}}).Validate(); err != nil {
		t.Errorf("%v > leaf: %v", chain, err)
	}
	for g := range len(chain) + 1 {
		v := ui.View{Nodes: []ui.Node{nestLevels(chain, g)}}
		msgs := problems(v.Validate())
		if g == len(chain) {
			if len(msgs) != 0 {
				t.Errorf("%v with a group at %d: %q", chain, g, msgs)
			}
			continue
		}
		if len(msgs) != 1 || !strings.Contains(msgs[0], "a group holds text, chips, actions, progress nodes, not ") {
			t.Errorf("%v with a group at %d: %q", chain, g, msgs)
		}
	}
	// A container at the deepest level with no children is fine (empty lists).
	for _, k := range wrapKinds {
		empty := map[string]ui.Node{
			"section":      ui.NewSection("e", ""),
			"columns":      ui.NewColumns("e", ui.NewColumn("e-a"), ui.NewColumn("e-b")),
			"pane":         ui.NewPane("e", ui.HeightAuto),
			"container":    ui.NewContainer("e", ui.ContainerFull),
			"masterDetail": ui.NewMasterDetail("e", ui.List{}, ""),
			"tabs":         ui.NewTabsNode("e", ui.NewTabs("e-a", ui.NewTab("e-a", "A"), ui.NewTab("e-b", "B"))),
			"grid":         ui.NewGrid("e", ui.NewGridItem("e-a")),
		}[k]
		n := empty
		for i := ui.MaxDepth - 1; i >= 0; i-- {
			n = wrap[wrapKinds[i%len(wrapKinds)]](fmt.Sprintf("w%d", i), n)
		}
		if err := (ui.View{Nodes: []ui.Node{n}}).Validate(); err != nil {
			t.Errorf("an empty %s inside %d containers: %v", k, ui.MaxDepth, err)
		}
	}
}

// pad returns a pairs node of n pairs (n+1 elements) keyed from prefix.
func pad(prefix string, n int) ui.Node {
	p := ui.Node{Key: prefix, Pairs: &ui.Pairs{}}
	for i := range n {
		p.Pairs.Items = append(p.Pairs.Items, ui.Pair{Key: fmt.Sprintf("%s-%d", prefix, i), Label: "L"})
	}
	return p
}

// padChips returns a chips node of n chips (n+1 elements): a strip kind.
func padChips(prefix string, n int) ui.Node {
	c := ui.Node{Key: prefix, Chips: &ui.Chips{}}
	for i := range n {
		c.Chips.Chips = append(c.Chips.Chips, ui.Chip{Key: fmt.Sprintf("%s-%d", prefix, i), Label: "c"})
	}
	return c
}

// Each container and strip at exactly MaxElements passes and one over fails, with the
// count the notes describe (a column, a grid item, a row, a node tab, an empty-detail
// button and a group item each count one).
func TestElementsAtTheLimitEverywhere(t *testing.T) {
	type build func(fill int) ui.View // fill: elements to add inside
	cases := map[string]build{
		"section": func(fill int) ui.View {
			return ui.View{Nodes: []ui.Node{ui.NewSection("s", "", pad("p", fill-2))}} // s, p
		},
		"columns": func(fill int) ui.View {
			return ui.View{Nodes: []ui.Node{ui.NewColumns("c", ui.NewColumn("c1", pad("p", fill-4)), ui.NewColumn("c2"))}} // c, c1, c2, p
		},
		"pane": func(fill int) ui.View {
			return ui.View{Nodes: []ui.Node{ui.NewPane("pn", ui.HeightPx(200), pad("p", fill-2))}}
		},
		"grid": func(fill int) ui.View {
			items := []ui.GridItem{}
			for i := range ui.MaxGridItems {
				items = append(items, ui.NewGridItem(fmt.Sprintf("gi%d", i)))
			}
			items[0].Children = []ui.Node{pad("p", fill-2-ui.MaxGridItems)}
			return ui.View{Nodes: []ui.Node{ui.NewGrid("g", items...)}}
		},
		"group": func(fill int) ui.View {
			items := []ui.Node{}
			for i := range ui.MaxGroupItems - 1 {
				items = append(items, ui.NewText(fmt.Sprintf("gt%d", i), ui.Plain("x")))
			}
			items = append(items, padChips("ch", fill-1-ui.MaxGroupItems))
			return ui.View{Nodes: []ui.Node{ui.NewGroup("g", ui.AlignStart, items...)}}
		},
		"container": func(fill int) ui.View {
			return ui.View{Nodes: []ui.Node{ui.NewContainer("ct", ui.ContainerWide, pad("p", fill-2))}}
		},
		"masterDetail rows": func(fill int) ui.View {
			rows := []ui.Row{}
			for i := range fill - 3 { // md, empty-detail button, pairs node
				rows = append(rows, ui.NewRow(fmt.Sprintf("r%d", i), "Run"))
			}
			md := ui.NewMasterDetail("md", ui.List{Rows: rows}, "r0", pad("p", 0))
			md.MasterDetail.EmptyDetail = &ui.Empty{Title: "none", Actions: []ui.Button{ui.EventButton("eb", "Go", "go")}}
			return ui.View{Nodes: []ui.Node{md}}
		},
		"tabs node": func(fill int) ui.View {
			tabs := ui.NewTabs("t0")
			for i := range ui.MaxTabs {
				tabs.Items = append(tabs.Items, ui.NewTab(fmt.Sprintf("t%d", i), "T"))
			}
			return ui.View{Nodes: []ui.Node{ui.NewTabsNode("tn", tabs, pad("p", fill-2-ui.MaxTabs))}}
		},
		"toolbar": func(fill int) ui.View {
			return ui.View{Nodes: []ui.Node{}, Toolbar: []ui.Node{padChips("ch", fill-1)}}
		},
		"footer": func(fill int) ui.View {
			return ui.View{Nodes: []ui.Node{}, Footer: []ui.Node{padChips("ch", fill-1)}}
		},
		"everything": func(fill int) ui.View {
			tabs := ui.NewTabs("vt0", ui.NewTab("vt0", "A"))
			v := ui.View{Header: &ui.Header{Actions: []ui.Button{ui.EventButton("hb", "H", "h").WithIcon("x")}}, Tabs: tabs,
				Toolbar: []ui.Node{padChips("tb", 2)}, Footer: []ui.Node{padChips("ft", 2)}}
			// hb, vt0, tb+2, ft+2 = 8
			v.Nodes = []ui.Node{pad("p", fill-8-1)}
			return v
		},
	}
	for name, b := range cases {
		t.Run(name, func(t *testing.T) {
			at := b(ui.MaxElements)
			if got := elementsOf(at); got != ui.MaxElements {
				t.Fatalf("the test's view has %d elements, want %d", got, ui.MaxElements)
			}
			if err := at.Validate(); err != nil {
				t.Errorf("at %d: %v", ui.MaxElements, err)
			}
			over := b(ui.MaxElements + 1)
			msgs := problems(over.Validate())
			if len(msgs) != 1 || msgs[0] != fmt.Sprintf("view: %d elements, at most %d", ui.MaxElements+1, ui.MaxElements) {
				t.Errorf("at %d: %q", ui.MaxElements+1, msgs)
			}
		})
	}
}

// The validator's height rules match ui-layout.md ("What fill fills", pane's table).
func TestHeightAndFillRules(t *testing.T) {
	thread := func(h ui.Height) ui.Node { return ui.Node{Key: "th", Thread: &ui.Thread{ThreadID: "s-1", Height: h}} }
	pane := func(key string, h ui.Height, minH int, kids ...ui.Node) ui.Node {
		return ui.Node{Key: key, Pane: &ui.Pane{Height: h, MinHeight: minH, Children: kids}}
	}
	cases := []struct {
		name string
		node ui.Node
		want string // "" valid
	}{
		{"fill pane in a px pane", pane("o", ui.HeightPx(600), 0, pane("i", ui.HeightFill, 0, thread(ui.HeightFill))), ""},
		{"fill pane in a column in an auto pane", pane("o", ui.HeightAuto, 0, ui.NewColumns("c", ui.NewColumn("c1", pane("i", ui.HeightFill, 0)), ui.NewColumn("c2"))), ""},
		{"fill thread in a grid item", ui.NewGrid("g", ui.NewGridItem("gi", thread(ui.HeightFill))), ""},
		{"fill thread in a master-detail's detail", ui.NewMasterDetail("md", ui.List{Rows: []ui.Row{ui.NewRow("r", "R")}}, "r", thread(ui.HeightFill)), ""},
		{"fill pane, minHeight above its box's px height", pane("o", ui.HeightPx(200), 0, pane("i", ui.HeightFill, 1600)), ""},
		{"px pane, minHeight equal", pane("p", ui.HeightPx(300), 300), ""},
		{"px pane, minHeight above", pane("p", ui.HeightPx(300), 301), "nodes[0].pane.minHeight: 301 px is above the pane's height (300 px)"},
		{"auto pane, minHeight 120", pane("p", ui.HeightAuto, 120), ""},
		{"fill pane, minHeight 119", pane("p", ui.HeightFill, 119), "nodes[0].pane.minHeight: 119 px is outside 120..1600"},
		{"px pane at 120", pane("p", ui.HeightPx(120), 0), ""},
		{"px pane at 1600", pane("p", ui.HeightPx(1600), 0), ""},
		{"px pane at 119", pane("p", ui.HeightPx(119), 0), "nodes[0].pane.height: 119 px is outside 120..1600"},
		{"px pane at 1601", pane("p", ui.HeightPx(1601), 0), "nodes[0].pane.height: 1601 px is outside 120..1600"},
		{"px pane at 0", pane("p", ui.HeightPx(0), 0), "nodes[0].pane.height: 0 px is outside 120..1600"},
		{"px pane at -5, minHeight 200", pane("p", ui.HeightPx(-5), 200), "nodes[0].pane.height: -5 px is outside 120..1600"},
	}
	for _, c := range cases {
		msgs := problems((ui.View{Nodes: []ui.Node{c.node}}).Validate())
		switch {
		case c.want == "" && len(msgs) != 0:
			t.Errorf("%s: %q", c.name, msgs)
		case c.want != "" && (len(msgs) != 1 || msgs[0] != c.want):
			t.Errorf("%s: %q, want %q", c.name, msgs, c.want)
		}
	}
	// JSON heights the docs promise: "auto", "fill", whole pixels; "" and null are auto.
	for in, want := range map[string]string{`"auto"`: "auto", `"fill"`: "fill", `320`: "320", `""`: "auto", `null`: "auto", `320.0`: "320"} {
		var p ui.Pane
		if err := json.Unmarshal([]byte(`{"height":`+in+`,"children":[]}`), &p); err != nil || p.Height.String() != want {
			t.Errorf("height %s: %v %v", in, p.Height, err)
		}
	}
	for _, in := range []string{`"320"`, `320.5`, `1e400`, `true`, `[]`, `"FILL"`} {
		var p ui.Pane
		if err := json.Unmarshal([]byte(`{"height":`+in+`}`), &p); err == nil {
			t.Errorf("height %s decoded as %v", in, p.Height)
		}
	}
}

// Every strip rule of ui-layout.md, each refusal with one problem at a path in the view.
func TestStripRules(t *testing.T) {
	text := ui.NewText("t", ui.Plain("x"))
	formWith := func(f ui.Field) ui.Node { return ui.NewForm("f", nil, f) }
	cases := []struct {
		name string
		node ui.Node
		want string // a substring of the one problem; "" valid
	}{
		{"divider without a label", ui.NewDivider("d", ""), ""},
		{"divider with a label", ui.NewDivider("d", "L"), "toolbar[0].divider.label: a divider in the toolbar has no label"},
		{"spacer flex", ui.NewFlexSpacer("s"), ""},
		{"spacer 65", ui.NewSpacer("s", 65), "toolbar[0].spacer.size: 65 px is outside 4..64"},
		{"group of text", ui.NewGroup("g", ui.AlignEnd, text), ""},
		{"group in a group", ui.NewGroup("g", ui.AlignEnd, ui.NewGroup("g2", ui.AlignStart, text)), "toolbar[0].group.items[0]: a group holds text, chips, actions, progress nodes, not group"},
		{"group of a divider", ui.NewGroup("g", ui.AlignEnd, ui.NewDivider("d", "L")), "not divider"},
		{"form with a fieldset", formWith(ui.NewFieldset("fs", "S", ui.TextField("q", "q", "Q"))), "toolbar[0].form.fields[0]: a form in the toolbar has no fieldsets"},
		{"form with a list select", formWith(ui.Field{Key: "s", Name: "s", Select: &ui.Select{Style: ui.SelectList}}), "toolbar[0].form.fields[0].select.style: a select in the toolbar is a dropdown"},
		{"form with a dropdown multiple select", formWith(ui.Field{Key: "s", Name: "s", Select: &ui.Select{Multiple: true}}), ""},
		{"masterDetail", ui.NewMasterDetail("md", ui.List{}, ""), "toolbar[0]: a masterDetail node cannot be in the toolbar"},
		{"tabs node", ui.NewTabsNode("tn", ui.NewTabs("a", ui.NewTab("a", "A"), ui.NewTab("b", "B"))), "toolbar[0]: a tabs node cannot be in the toolbar"},
		{"container", ui.NewContainer("c", ui.ContainerFull), "toolbar[0]: a container node cannot be in the toolbar"},
	}
	for _, c := range cases {
		for _, strip := range []string{"toolbar", "footer"} {
			v := ui.View{Nodes: []ui.Node{}}
			if strip == "toolbar" {
				v.Toolbar = []ui.Node{c.node}
			} else {
				v.Footer = []ui.Node{c.node}
			}
			msgs := problems(v.Validate())
			want := strings.ReplaceAll(c.want, "toolbar", strip)
			switch {
			case c.want == "" && len(msgs) != 0:
				t.Errorf("%s in the %s: %q", c.name, strip, msgs)
			case c.want != "" && (len(msgs) != 1 || !strings.Contains(msgs[0], want)):
				t.Errorf("%s in the %s: %q, want %q", c.name, strip, msgs, want)
			}
			for _, m := range msgs {
				if p, _, _ := strings.Cut(m, ": "); !pathExists(v, p) {
					t.Errorf("%s in the %s: path %q", c.name, strip, p)
				}
			}
		}
	}
}
