package ui_test

// viewgen builds random views over every node kind, both strips, the view's tabs and the
// header, nested up to genMaxDepth containers, with key collisions (a small pool shared
// by every keyed thing), empty and oversized lists, and zero, negative, boundary and huge
// numbers. Each seed picks a hostility: 0 builds only valid views (so accepted views are
// deep and varied), higher values break a rule at that rate at every choice. It is
// deterministic in its seed. The same file is copied, with only its package line
// changed, to internal/store/plugin (viewgen_test.go there) so the daemon's walks see the
// same views.

import (
	"fmt"
	"math"
	"math/rand/v2"
	"strings"

	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

const genMaxDepth = 6

type viewGen struct {
	r      *rand.Rand
	p      float64  // the rate of broken choices
	n      int      // unique key counter
	names  int      // unique field name counter
	pool   []string // colliding keys
	budget int      // nodes left: keeps views small enough to run thousands
	logs   int
}

func newViewGen(seed uint64) *viewGen {
	r := rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15))
	return &viewGen{
		r:      r,
		p:      []float64{0, 0, 0.01, 0.05, 0.3}[r.IntN(5)],
		pool:   []string{"dup", "a", "tab-a", "row-1", "col", "x.y"},
		budget: 30 + r.IntN(60),
	}
}

// genKinds are the node kinds the generator picks from (its JSON names).
var genKinds = []string{"text", "markdown", "pairs", "list", "chips", "log", "actions", "progress",
	"notice", "empty", "section", "form", "thread", "terminal", "columns", "pane", "grid",
	"divider", "spacer", "group", "container", "masterDetail", "tabs"}

// genContainers hold nodes (group too: it is no level, but it nests).
var genContainers = map[string]bool{"section": true, "columns": true, "pane": true, "grid": true,
	"container": true, "masterDetail": true, "tabs": true, "group": true}

var genStripKinds = []string{"text", "chips", "actions", "progress", "form", "divider", "spacer", "group"}

func (g *viewGen) chance(p float64) bool { return g.r.Float64() < p }

// bad reports whether this choice breaks a rule.
func (g *viewGen) bad() bool { return g.p > 0 && g.chance(g.p) }

func (g *viewGen) pick(xs ...string) string { return xs[g.r.IntN(len(xs))] }

func (g *viewGen) key() string {
	if g.bad() {
		switch g.r.IntN(4) {
		case 0:
			return ""
		case 1:
			return "bad key!"
		case 2:
			return strings.Repeat("k", 65)
		}
		return g.pool[g.r.IntN(len(g.pool))]
	}
	g.n++
	return fmt.Sprintf("k%d", g.n)
}

// num picks a number in lo..hi (0 too when zero means the default), or when broken a
// boundary neighbour or something absurd.
func (g *viewGen) num(lo, hi int, zeroOK bool) int {
	if g.bad() {
		return []int{-1, lo - 1, hi + 1, math.MaxInt32, math.MinInt32, math.MaxInt64}[g.r.IntN(6)]
	}
	if zeroOK && g.chance(0.2) {
		return 0
	}
	switch g.r.IntN(4) {
	case 0:
		return lo
	case 1:
		return hi
	}
	return lo + g.r.IntN(hi-lo+1)
}

// count picks a list length in lo..hi (usually small), or when broken one outside.
func (g *viewGen) count(lo, hi int) int {
	if g.bad() {
		if lo > 0 && g.chance(0.5) {
			return lo - 1
		}
		return hi + 1
	}
	if g.chance(0.1) {
		return hi
	}
	return lo + g.r.IntN(min(hi, lo+3)-lo+1)
}

func (g *viewGen) label() string {
	if g.bad() {
		return g.pick("", "  ", strings.Repeat("x", ui.MaxLabel+1))
	}
	return fmt.Sprintf("Label %d", g.r.IntN(100))
}

func (g *viewGen) action() *ui.Action {
	if g.bad() {
		switch g.r.IntN(3) {
		case 0:
			return nil
		case 1:
			return &ui.Action{}
		}
		return &ui.Action{Event: "e", OpenURL: "https://example.com"}
	}
	switch g.r.IntN(8) {
	case 0:
		return &ui.Action{Command: &ui.Command{Name: "plugin.p.run", Args: map[string]string{"id": "1"}}}
	case 1:
		return &ui.Action{OpenURL: "https://example.com"}
	case 2:
		return &ui.Action{Copy: "text"}
	case 3:
		return &ui.Action{Event: g.pick("select", "tab", "click")} // events named like act kinds
	}
	return &ui.Action{Event: "ev", Data: "d"}
}

func (g *viewGen) button() ui.Button {
	b := ui.Button{Key: g.key(), Label: g.label(), Action: g.action()}
	if g.chance(0.1) {
		b.IconOnly, b.Icon = true, "search"
		if g.bad() {
			b.Icon = ""
		}
	}
	return b
}

func (g *viewGen) buttons(max int) []ui.Button {
	n := g.count(0, max)
	if n == 0 && g.chance(0.5) {
		return nil
	}
	out := make([]ui.Button, n)
	for i := range out {
		out[i] = g.button()
	}
	return out
}

func (g *viewGen) row() ui.Row {
	r := ui.Row{Key: g.key(), Title: g.label()}
	if r.Title == "" && !g.bad() {
		r.Title = "Row"
	}
	if g.chance(0.3) {
		r.Action = g.action()
	}
	if g.chance(0.2) {
		r.Actions = g.buttons(ui.MaxRowButtons)
	}
	if g.chance(0.1) {
		r.Selected = true
	}
	return r
}

func (g *viewGen) list() ui.List {
	n := g.count(0, 5)
	if g.bad() && g.chance(0.1) {
		n = ui.MaxElements + 1
	}
	l := ui.List{}
	if n > 0 || g.chance(0.5) {
		l.Rows = make([]ui.Row, n)
	}
	for i := range l.Rows {
		l.Rows[i] = g.row()
	}
	return l
}

func (g *viewGen) tabs(minTabs int) ui.Tabs {
	n := g.count(minTabs, ui.MaxTabs)
	t := ui.Tabs{}
	if n > 0 || g.chance(0.5) {
		t.Items = make([]ui.Tab, n)
	}
	for i := range t.Items {
		t.Items[i] = ui.Tab{Key: g.key(), Label: g.label()}
	}
	switch {
	case g.bad():
		t.Active = "missing"
	case n > 0:
		t.Active = t.Items[g.r.IntN(n)].Key
	}
	return t
}

func (g *viewGen) height() ui.Height {
	switch g.r.IntN(5) {
	case 0:
		return ui.Height{}
	case 1:
		return ui.HeightAuto
	case 2:
		return ui.HeightFill
	}
	return ui.HeightPx(g.num(ui.MinHeightPx, ui.MaxHeightPx, false))
}

func (g *viewGen) field(inStrip bool, depth int) ui.Field {
	g.names++
	f := ui.Field{Key: g.key(), Name: fmt.Sprintf("f%d", g.names), Label: g.label()}
	if g.bad() {
		f.Name = "f0" // a duplicate name in the form, or none
	}
	switch g.r.IntN(5) {
	case 0:
		f.Toggle = &ui.Toggle{Value: g.chance(0.5)}
	case 1:
		s := &ui.Select{}
		if (!inStrip || g.bad()) && g.chance(0.3) {
			s.Style = ui.SelectList
		}
		for range g.count(0, 3) {
			s.Options = append(s.Options, ui.Option{Key: g.key(), Value: "v", Label: "Option"})
		}
		f.Select = s
	case 2:
		if depth == 0 && (!inStrip || g.bad()) {
			fs := &ui.Fieldset{Label: "set"}
			for range g.count(1, 3) {
				fs.Fields = append(fs.Fields, g.field(inStrip, 1))
			}
			f.Fieldset = fs
			f.Name = ""
			break
		}
		f.Input = &ui.Input{}
	default:
		f.Input = &ui.Input{Placeholder: "p"}
	}
	if g.chance(0.1) {
		f.Change = &ui.Action{Event: "changed"}
	}
	return f
}

func (g *viewGen) form(inStrip bool) *ui.Form {
	f := &ui.Form{}
	for range g.count(0, 4) {
		f.Fields = append(f.Fields, g.field(inStrip, 0))
	}
	if g.chance(0.7) {
		b := g.button()
		f.Submit = &b
	}
	return f
}

func (g *viewGen) children(depth int, max int) []ui.Node {
	n := g.count(0, max)
	if n == 0 && g.chance(0.5) {
		return nil
	}
	out := make([]ui.Node, 0, n)
	for range n {
		out = append(out, g.node(depth))
	}
	return out
}

// node returns a random node that sits inside depth containers. A valid choice puts a
// container only where its children stay within MaxDepth (one at MaxDepth then holds
// none: the exact boundary).
func (g *viewGen) node(depth int) ui.Node {
	g.budget--
	kind := genKinds[g.r.IntN(len(genKinds))]
	if genContainers[kind] && (depth >= genMaxDepth || g.budget <= 0) {
		kind = "text"
	}
	if kind == "log" && g.logs >= ui.MaxLogNodes && !g.bad() {
		kind = "text"
	}
	return g.nodeOf(kind, depth)
}

// inner is the depth of a container's children, or -1 when a valid view cannot have any
// there.
func (g *viewGen) inner(depth int) int {
	if depth+1 > ui.MaxDepth && !g.bad() {
		return -1
	}
	return depth + 1
}

func (g *viewGen) kids(depth, max int) []ui.Node {
	d := g.inner(depth)
	if d < 0 {
		if g.chance(0.5) {
			return nil
		}
		return []ui.Node{}
	}
	return g.children(d, max)
}

func (g *viewGen) nodeOf(kind string, depth int) ui.Node {
	n := ui.Node{Key: g.key()}
	switch kind {
	case "text":
		n.Text = &ui.Text{Content: ui.Plain("t")}
		if g.bad() {
			n.Text.Content = nil
		}
	case "markdown":
		n.Markdown = &ui.Markdown{Source: "**m**"}
	case "pairs":
		n.Pairs = &ui.Pairs{}
		for range g.count(0, 3) {
			n.Pairs.Items = append(n.Pairs.Items, ui.Pair{Key: g.key(), Label: "L"})
		}
	case "list":
		l := g.list()
		n.List = &l
	case "chips":
		n.Chips = &ui.Chips{}
		for range g.count(0, 3) {
			ch := ui.Chip{Key: g.key(), Label: "c"}
			if g.chance(0.5) {
				ch.Action = g.action()
			}
			n.Chips.Chips = append(n.Chips.Chips, ch)
		}
	case "log":
		g.logs++
		n.Log = &ui.Log{Text: "line\n"}
	case "actions":
		n.Actions = &ui.Actions{Buttons: g.buttons(ui.MaxBarButtons)}
		if g.bad() {
			n.Actions.Align = ui.AlignBetween
		}
	case "progress":
		v := 0.5
		if g.bad() {
			v = g.r.Float64()*4 - 2
		}
		n.Progress = &ui.Progress{Value: &v, Label: "p"}
	case "notice":
		n.Notice = &ui.Notice{Title: "n", Actions: g.buttons(ui.MaxNoticeButtons)}
	case "empty":
		n.Empty = &ui.Empty{Title: "e", Actions: g.buttons(ui.MaxEmptyButtons)}
	case "section":
		n.Section = &ui.Section{Title: "s", Actions: g.buttons(ui.MaxSectionButton), Children: g.kids(depth, 3)}
	case "form":
		n.Form = g.form(false)
	case "thread":
		n.Thread = &ui.Thread{ThreadID: "s-1", Height: g.height()}
	case "terminal":
		n.Terminal = &ui.Terminal{TerminalID: "t-1", Height: g.height(), Actions: g.buttons(ui.MaxTerminalButtons)}
		if g.chance(0.3) {
			n.Terminal.Rows = g.num(4, 60, true)
		}
	case "columns":
		c := &ui.Columns{}
		d := g.inner(depth)
		for range g.count(ui.MinColumns, ui.MaxColumns) {
			col := ui.Column{Key: g.key()}
			if d >= 0 {
				col.Children = g.children(d, 2)
			}
			switch g.r.IntN(4) {
			case 0:
				col.Weight = g.num(1, ui.MaxColumnWeight, true)
			case 1:
				col.Width = g.num(ui.MinColumnWidth, ui.MaxColumnWidth, true)
			case 2:
				if g.bad() {
					col.Weight, col.Width = 1, ui.MinColumnWidth
				}
			}
			c.Items = append(c.Items, col)
		}
		if g.chance(0.3) {
			c.Collapse = ui.ColumnsCollapse(g.pick("stack", "first"))
			if g.bad() {
				c.Collapse = "bogus"
			}
		}
		n.Columns = c
	case "pane":
		n.Pane = &ui.Pane{Height: g.height(), Children: g.kids(depth, 3), NoScroll: g.chance(0.3)}
		if g.chance(0.3) {
			n.Pane.MinHeight = g.num(ui.MinHeightPx, ui.MaxHeightPx, true)
			if px := n.Pane.Height.Px(); px > 0 && n.Pane.MinHeight > px && !g.bad() {
				n.Pane.MinHeight = px
			}
		}
	case "grid":
		gr := &ui.Grid{}
		if g.chance(0.4) {
			gr.MinWidth = g.num(ui.MinGridMinWidth, ui.MaxGridMinWidth, true)
		}
		d := g.inner(depth)
		for range g.count(1, ui.MaxGridItems) {
			it := ui.GridItem{Key: g.key()}
			if d >= 0 {
				it.Children = g.children(d, 2)
			}
			if g.chance(0.3) {
				it.Span = g.num(1, ui.MaxGridSpan, true)
			}
			gr.Items = append(gr.Items, it)
		}
		n.Grid = gr
	case "divider":
		n.Divider = &ui.Divider{}
		if g.chance(0.4) {
			n.Divider.Label = g.label()
		}
	case "spacer":
		n.Spacer = &ui.Spacer{Flex: g.chance(0.3)}
		if g.chance(0.6) {
			n.Spacer.Size = g.num(ui.MinSpacer, ui.MaxSpacer, true)
		}
	case "group":
		gp := &ui.Group{}
		for range g.count(1, ui.MaxGroupItems) {
			k := g.pick("text", "chips", "actions", "progress")
			if g.bad() {
				k = genKinds[g.r.IntN(len(genKinds))] // a nested group, a container, a block
				if genContainers[k] && depth >= genMaxDepth {
					k = "markdown"
				}
			}
			g.budget--
			gp.Items = append(gp.Items, g.nodeOf(k, depth))
		}
		if g.chance(0.3) {
			gp.Align = ui.Align(g.pick("start", "center", "end", "between"))
			if g.bad() {
				gp.Align = "middle"
			}
		}
		gp.NoWrap = g.chance(0.2)
		n.Group = gp
	case "container":
		n.Container = &ui.Container{Children: g.kids(depth, 3)}
		if g.chance(0.4) {
			n.Container.Width = ui.ContainerWidth(g.pick("narrow", "wide", "full"))
			if g.bad() {
				n.Container.Width = "huge"
			}
		}
	case "masterDetail":
		md := &ui.MasterDetail{List: g.list(), Detail: g.kids(depth, 3)}
		switch {
		case g.bad():
			md.Selected = "not-a-row"
		case len(md.List.Rows) > 0 && g.chance(0.6):
			md.Selected = md.List.Rows[g.r.IntN(len(md.List.Rows))].Key
		}
		if g.chance(0.4) {
			md.ListWidth = g.num(ui.MinListWidth, ui.MaxListWidth, true)
		}
		if g.chance(0.4) {
			md.EmptyDetail = &ui.Empty{Title: "none", Actions: g.buttons(ui.MaxEmptyButtons)}
		}
		if g.chance(0.2) {
			md.ResetToken = "r1"
		}
		n.MasterDetail = md
	case "tabs":
		n.Tabs = &ui.TabsNode{Tabs: g.tabs(ui.MinNodeTabs), Children: g.kids(depth, 3)}
	}
	if g.bad() && g.chance(0.1) { // a second kind
		n.Markdown = &ui.Markdown{Source: "two"}
	}
	return n
}

// stripNode is a node for a toolbar or footer: a strip kind, or when broken any.
func (g *viewGen) stripNode() ui.Node {
	g.budget--
	k := g.pick(genStripKinds...)
	if g.bad() {
		k = genKinds[g.r.IntN(len(genKinds))]
	}
	switch k {
	case "form":
		return ui.Node{Key: g.key(), Form: g.form(true)}
	case "divider":
		n := ui.Node{Key: g.key(), Divider: &ui.Divider{}}
		if g.bad() {
			n.Divider.Label = "Label"
		}
		return n
	}
	return g.nodeOf(k, 0)
}

func (g *viewGen) strip() []ui.Node {
	if g.chance(0.4) {
		return nil
	}
	n := g.count(1, ui.MaxStripNodes)
	out := make([]ui.Node, 0, n)
	for range n {
		out = append(out, g.stripNode())
	}
	return out
}

// view returns a random view.
func (g *viewGen) view() ui.View {
	v := ui.View{}
	if g.chance(0.5) {
		v.Header = &ui.Header{Title: "H", Actions: g.buttons(ui.MaxHeaderButtons)}
	}
	if g.chance(0.3) {
		t := g.tabs(1)
		v.Tabs = &t
	}
	v.Toolbar = g.strip()
	for range g.count(1, 6) {
		v.Nodes = append(v.Nodes, g.node(0))
	}
	v.Footer = g.strip()
	return v
}

// genView is the view for seed.
func genView(seed uint64) ui.View { return newViewGen(seed).view() }
