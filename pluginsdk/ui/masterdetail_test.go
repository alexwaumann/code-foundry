package ui

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
)

// Every validation branch of masterDetail and tabs
// (docs/notes/plugins-layout-4-master-detail.md).
func TestValidateMasterDetailAndTabs(t *testing.T) {
	text := func(k string) Node { return NewText(k, Plain("x")) }
	rows := func(keys ...string) List {
		l := List{}
		for _, k := range keys {
			l.Rows = append(l.Rows, NewRow(k, "Run "+k))
		}
		return l
	}
	md := func(m MasterDetail) Node { return Node{Key: "md", MasterDetail: &m} }
	tabs := func(n int) []Tab {
		out := make([]Tab, n)
		for i := range out {
			out[i] = NewTab("t"+strconv.Itoa(i), "Tab "+strconv.Itoa(i))
		}
		return out
	}
	tn := func(active string, items []Tab, children ...Node) Node {
		return NewTabsNode("tabs", &Tabs{Items: items, Active: active}, children...)
	}
	tests := []struct {
		name string
		node Node
		want string // "" = valid
	}{
		// masterDetail
		{"nothing selected", NewMasterDetail("md", rows("a", "b"), ""), ""},
		{"a row selected with detail", NewMasterDetail("md", rows("a", "b"), "b", text("d1"), NewPane("dp", HeightPx(240), NewLog("dl", "x"))), ""},
		{"no rows", NewMasterDetail("md", List{EmptyText: "No runs"}, ""), ""},
		{"list width at the bounds", md(MasterDetail{List: rows("a"), ListWidth: MinListWidth}), ""},
		{"list width at the top", md(MasterDetail{List: rows("a"), ListWidth: MaxListWidth}), ""},
		{"list width too small", md(MasterDetail{List: rows("a"), ListWidth: 199}), "nodes[0].masterDetail.listWidth: 199 px is outside 200..400 (0 is 280)"},
		{"list width too big", md(MasterDetail{List: rows("a"), ListWidth: 401}), "nodes[0].masterDetail.listWidth: 401 px is outside 200..400"},
		{"negative list width", md(MasterDetail{List: rows("a"), ListWidth: -1}), "listWidth: -1 px is outside"},
		{"selected is not a row", NewMasterDetail("md", rows("a", "b"), "c"), `nodes[0].masterDetail.selected: "c" is not a row of the list`},
		{"selected without rows", NewMasterDetail("md", List{}, "a"), `selected: "a" is not a row of the list`},
		{"duplicate row key", NewMasterDetail("md", rows("a", "a"), "a"), `nodes[0].masterDetail.list.rows[1].key: "a" is already used by nodes[0].masterDetail.list.rows[0]`},
		{"row key used by the node", NewMasterDetail("md", rows("md"), ""), `nodes[0].masterDetail.list.rows[0].key: "md" is already used by nodes[0]`},
		{"row key used in the detail", NewMasterDetail("md", rows("a"), "a", text("a")), `nodes[0].masterDetail.detail[0].key: "a" is already used by nodes[0].masterDetail.list.rows[0]`},
		{"bad row key", NewMasterDetail("md", rows("a b"), ""), `nodes[0].masterDetail.list.rows[0].key: "a b" must match`},
		{"row without a title", md(MasterDetail{List: List{Rows: []Row{{Key: "a"}}}}), "nodes[0].masterDetail.list.rows[0].title: required"},
		{"row with its own action", md(MasterDetail{List: List{Rows: []Row{{Key: "a", Title: "A", Action: EventAction("open", "a")}}}, Selected: "a"}), ""},
		{"bad row action", md(MasterDetail{List: List{Rows: []Row{{Key: "a", Title: "A", Action: &Action{}}}}}), "nodes[0].masterDetail.list.rows[0].action: an action is exactly one of"},
		{"unknown glyph style", md(MasterDetail{List: List{GlyphStyle: "star", Rows: rows("a").Rows}}), `nodes[0].masterDetail.list.glyphStyle: unknown style "star"`},
		{"empty detail", md(MasterDetail{List: rows("a"), EmptyDetail: &Empty{Glyph: IconGlyph("list", ToneMuted), Title: "No run", Body: Plain("Choose one"),
			Actions: []Button{EventButton("e1", "New", "new"), EventButton("e2", "Import", "import")}}}), ""},
		{"empty detail title too long", md(MasterDetail{List: rows("a"), EmptyDetail: &Empty{Title: strings.Repeat("x", MaxLabel+1)}}), "nodes[0].masterDetail.emptyDetail.title: 201 characters, at most 200"},
		{"empty detail with three buttons", md(MasterDetail{List: rows("a"), EmptyDetail: &Empty{Actions: []Button{EventButton("e1", "A", "a"), EventButton("e2", "B", "b"), EventButton("e3", "C", "c")}}}),
			"nodes[0].masterDetail.emptyDetail.actions: 3 buttons, at most 2"},
		{"empty detail button key taken", md(MasterDetail{List: rows("a"), EmptyDetail: &Empty{Actions: []Button{EventButton("a", "A", "a")}}}), `emptyDetail.actions[0].key: "a" is already used`},
		{"empty detail bad glyph", md(MasterDetail{List: rows("a"), EmptyDetail: &Empty{Glyph: &Glyph{}}}), "nodes[0].masterDetail.emptyDetail.glyph: a glyph needs a status or an icon"},
		{"empty detail body too long", md(MasterDetail{List: rows("a"), EmptyDetail: &Empty{Body: Plain(strings.Repeat("x", MaxTextContent+1))}}), "nodes[0].masterDetail.emptyDetail.body.text: 4097 characters"},
		{"reset token", md(MasterDetail{List: rows("a"), ResetToken: "3"}), ""},
		{"reset token too long", md(MasterDetail{List: rows("a"), ResetToken: strings.Repeat("x", MaxLabel+1)}), "nodes[0].masterDetail.resetToken: 201 characters, at most 200"},
		{"bad node in the detail", NewMasterDetail("md", rows("a"), "a", Node{Key: "x"}), "nodes[0].masterDetail.detail[0]: a node has exactly one kind"},
		{"live nodes in the detail", NewMasterDetail("md", rows("a"), "a", NewThread("th", "s-1"), NewTerminal("te", "t-1")), ""},
		// tabs
		{"two tabs", tn("t0", tabs(2), text("c")), ""},
		{"most tabs", tn("t7", tabs(MaxTabs)), ""},
		{"one tab", tn("t0", tabs(1)), "nodes[0].tabs.items: 1 tabs, want 2 to 8"},
		{"no tabs", tn("", nil), "nodes[0].tabs.items: 0 tabs, want 2 to 8"},
		{"nine tabs", tn("t0", tabs(MaxTabs+1)), "nodes[0].tabs.items: 9 tabs, want 2 to 8"},
		{"active is not a tab", tn("t9", tabs(2)), `nodes[0].tabs.active: "t9" is not one of the tabs`},
		{"no active", tn("", tabs(2)), `nodes[0].tabs.active: "" is not one of the tabs`},
		{"tab without a label", tn("a", []Tab{{Key: "a"}, NewTab("b", "B")}), "nodes[0].tabs.items[0].label: required"},
		{"tab label too long", tn("a", []Tab{NewTab("a", strings.Repeat("x", MaxTabTitle+1)), NewTab("b", "B")}), "nodes[0].tabs.items[0].label: 41 characters, at most 40"},
		{"tab badge", tn("a", []Tab{{Key: "a", Label: "A", Badge: NewPill("3", ToneAttention)}, NewTab("b", "B")}), ""},
		{"bad tab badge", tn("a", []Tab{{Key: "a", Label: "A", Badge: &Pill{}}, NewTab("b", "B")}), "nodes[0].tabs.items[0].badge.label: required"},
		{"duplicate tab key", tn("a", []Tab{NewTab("a", "A"), NewTab("a", "B")}), `nodes[0].tabs.items[1].key: "a" is already used by nodes[0].tabs.items[0]`},
		{"tab key used by the node", tn("tabs", []Tab{NewTab("tabs", "A"), NewTab("b", "B")}), `nodes[0].tabs.items[0].key: "tabs" is already used by nodes[0]`},
		{"bad tab key", tn("a b", []Tab{NewTab("a b", "A"), NewTab("b", "B")}), `nodes[0].tabs.items[0].key: "a b" must match`},
		{"bad child", tn("t0", tabs(2), Node{Key: "x"}), "nodes[0].tabs.children[0]: a node has exactly one kind"},
		{"tabs in the detail", NewMasterDetail("md", rows("a"), "a", tn("t0", tabs(2), NewPane("p", HeightPx(200), NewLog("lg", "x")))), ""},
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
	// A view-level tab and a node's tab share the namespace.
	v := View{Tabs: NewTabs("a", NewTab("a", "A")), Nodes: []Node{tn("t0", []Tab{NewTab("t0", "T"), NewTab("a", "A")})}}
	if err := v.Validate(); err == nil || !strings.Contains(err.Error(), `nodes[0].tabs.items[1].key: "a" is already used by tabs.items[0]`) {
		t.Errorf("a node tab keyed like a view tab: %v", err)
	}
	// A tab node's invalid UTF-8 is named by its JSON path (the embedded Tabs is flat).
	bad := tn("t0", []Tab{NewTab("t0", "T\xff"), NewTab("t1", "U")})
	if err := (View{Nodes: []Node{bad}}).Validate(); err == nil || !strings.Contains(err.Error(), "nodes[0].tabs.items[0].label: not valid UTF-8") {
		t.Errorf("invalid UTF-8 in a node tab: %v", err)
	}
}

// Rows, the empty detail's buttons and a tabs node's tabs count as elements: with the
// node itself, 400 pass and 401 are refused.
func TestMasterDetailAndTabsCountAsElements(t *testing.T) {
	list := func(n int) List {
		l := List{}
		for i := range n {
			l.Rows = append(l.Rows, NewRow("r"+strconv.Itoa(i), "Run"))
		}
		return l
	}
	if err := (View{Nodes: []Node{NewMasterDetail("md", list(MaxElements-1), "")}}).Validate(); err != nil {
		t.Errorf("a master-detail of 399 rows: %v", err)
	}
	if err := (View{Nodes: []Node{NewMasterDetail("md", list(MaxElements), "")}}).Validate(); err == nil || !strings.Contains(err.Error(), "view: 401 elements, at most 400") {
		t.Errorf("a master-detail of 400 rows: %v", err)
	}
	empty := Node{Key: "md", MasterDetail: &MasterDetail{List: list(MaxElements - 2), EmptyDetail: &Empty{Actions: []Button{EventButton("e1", "A", "a")}}}}
	if err := (View{Nodes: []Node{empty}}).Validate(); err != nil {
		t.Errorf("398 rows and an empty detail's button: %v", err)
	}
	empty.MasterDetail.EmptyDetail.Actions = append(empty.MasterDetail.EmptyDetail.Actions, EventButton("e2", "B", "b"))
	if err := (View{Nodes: []Node{empty}}).Validate(); err == nil || !strings.Contains(err.Error(), "view: 401 elements") {
		t.Errorf("398 rows and two buttons: %v", err)
	}
	var many []Node
	for i := range MaxElements - 3 {
		many = append(many, NewChips("c"+strconv.Itoa(i)))
	}
	tabs := NewTabsNode("tabs", NewTabs("a", NewTab("a", "A"), NewTab("b", "B")), many...)
	if err := (View{Nodes: []Node{tabs}}).Validate(); err != nil {
		t.Errorf("a tabs node of 2 tabs and 397 nodes: %v", err)
	}
	tabs.Tabs.Children = append(tabs.Tabs.Children, NewChips("one-more"))
	if err := (View{Nodes: []Node{tabs}}).Validate(); err == nil || !strings.Contains(err.Error(), "view: 401 elements") {
		t.Errorf("one more: %v", err)
	}
}

func TestMasterDetailAndTabsJSON(t *testing.T) {
	list := List{Rows: []Row{NewRow("r1", "Build #1")}}
	n := NewMasterDetail("md", list, "r1", NewTabsNode("tabs", NewTabs("ov", NewTab("ov", "Overview"), NewTab("lg", "Log")), NewText("t", Plain("x"))))
	n.MasterDetail.ListWidth = 240
	n.MasterDetail.EmptyDetail = &Empty{Title: "None"}
	n.MasterDetail.ResetToken = "1"
	b, err := json.Marshal(n)
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"key":"md","masterDetail":{"list":{"rows":[{"key":"r1","title":"Build #1"}]},"selected":"r1","detail":[{"key":"tabs","tabs":{"items":[{"key":"ov","label":"Overview"},{"key":"lg","label":"Log"}],"active":"ov","children":[{"key":"t","text":{"content":"x"}}]}}],"listWidth":240,"emptyDetail":{"title":"None"},"resetToken":"1"}}`
	if string(b) != want {
		t.Errorf("JSON\n got %s\nwant %s", b, want)
	}
	var back Node
	if err := json.Unmarshal([]byte(want), &back); err != nil {
		t.Fatal(err)
	}
	md := back.MasterDetail
	if md == nil || md.Selected != "r1" || md.ListWidth != 240 || md.ResetToken != "1" || md.EmptyDetail.Title != "None" || len(md.List.Rows) != 1 {
		t.Fatalf("decoded %+v", md)
	}
	if tb := md.Detail[0].Tabs; tb == nil || tb.Active != "ov" || len(tb.Items) != 2 || tb.Children[0].Key != "t" {
		t.Errorf("decoded tabs %+v", tb)
	}
	// Unset fields are left out; a nil detail and children encode as null here (the
	// host's canonical form makes them []).
	if b, _ := json.Marshal(NewMasterDetail("md", List{}, "")); string(b) != `{"key":"md","masterDetail":{"list":{"rows":null},"detail":null}}` {
		t.Errorf("bare master-detail: %s", b)
	}
	if b, _ := json.Marshal(NewTabsNode("tb", nil)); string(b) != `{"key":"tb","tabs":{"items":null,"active":"","children":null}}` {
		t.Errorf("bare tabs node: %s", b)
	}
	// Children walks a master-detail's detail and a tabs node's children.
	if ch := n.Children(); len(ch) != 1 || ch[0][0].Key != "tabs" || ch[0][0].Children()[0][0].Key != "t" {
		t.Errorf("Children = %v", ch)
	}
}
