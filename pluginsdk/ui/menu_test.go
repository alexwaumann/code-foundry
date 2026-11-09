package ui

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
)

// Every validation branch of menus (docs/notes/plugin-menu.md).
func TestValidateMenus(t *testing.T) {
	item := func(k string) MenuItem { return EventItem(k, "Item "+k, "pick", k) }
	items := func(n int) []MenuItem {
		out := make([]MenuItem, n)
		for i := range out {
			out[i] = item("i" + strconv.Itoa(i))
		}
		return out
	}
	row := func(m *Menu, actions ...Button) View {
		return View{Nodes: []Node{{Key: "list", List: &List{Rows: []Row{{Key: "r", Title: "Build #3", Actions: actions, Menu: m}}}}}}
	}
	menu := func(its ...MenuItem) View { return row(NewMenu(its...)) }
	long := strings.Repeat("x", MaxMenuLabel+1)
	moveTo := Submenu("move", "Move to", PickGroup("status", "s-review",
		item("s-todo"), item("s-progress"), item("s-review"), item("s-done"))...)
	tests := []struct {
		name string
		view View
		want string // a problem Validate must name; "" when the view is fine
	}{
		// What a menu holds.
		{"every kind of item", menu(
			EventItem("rebuild", "Rebuild", "rebuild", "1287"),
			CommandItem("send", "Send to thread", "thread.send", map[string]string{"text": "x"}),
			Separator(),
			moveTo,
			URLItem("open", "Open in Jenkins", "https://ci.example.com/1287"),
			CopyItem("copy", "Copy link", "https://ci.example.com/1287"),
			Separator(),
			EventItem("abort", "Abort", "abort", "").AsDisabled().AsDanger(),
		), ""},
		{"most items", menu(items(MaxMenuItems)...), ""},
		{"no items", row(NewMenu()), "rows[0].menu.items: 0 items, want 1 to 24"},
		{"too many items", menu(items(MaxMenuItems + 1)...), "rows[0].menu.items: 25 items, want 1 to 24"},
		{"too many submenu items", menu(Submenu("s", "More", items(MaxMenuItems+1)...)), "menu.items[0].submenu: 25 items"},
		{"an empty submenu", menu(MenuItem{Key: "s", Label: "More", Submenu: []MenuItem{}}), "menu.items[0].submenu: 0 items"},

		// One kind each.
		{"no kind", menu(MenuItem{Key: "k", Label: "Nothing"}), "exactly one of an action, a submenu or a separator"},
		{"an action and a submenu", menu(MenuItem{Key: "k", Label: "Both", Action: EventAction("x", ""), Submenu: []MenuItem{item("a")}}), "exactly one of"},
		{"a separator with a label", menu(item("a"), MenuItem{Separator: true, Label: "x"}, item("b")), "a separator has nothing else set"},
		{"a separator with an action", menu(item("a"), MenuItem{Separator: true, Action: EventAction("x", "")}, item("b")), "exactly one of"},
		{"an action that is two", menu(MenuItem{Key: "k", Label: "Two", Action: &Action{Event: "x", OpenURL: "https://e.com"}}), "exactly one of event, command, openUrl or copy"},
		{"data without an event", menu(MenuItem{Key: "k", Label: "Copy", Action: &Action{Copy: "x", Data: "d"}}), "only an event carries data"},
		{"too much data", menu(EventItem("k", "Big", "x", strings.Repeat("d", MaxEventData+1))), "action.data: 1025 bytes"},

		// Keys and labels.
		{"no key", menu(EventItem("", "Rebuild", "x", "")), "menu.items[0].key"},
		{"a key used by the row", menu(EventItem("r", "Rebuild", "x", "")), `"r" is already used by nodes[0].list.rows[0]`},
		{"a key used twice in a submenu", menu(item("a"), Submenu("s", "More", item("a"))), `"a" is already used`},
		{"a host key", menu(EventItem("cf-x", "Rebuild", "x", "")), "are the host's"},
		{"no label", menu(EventItem("k", " ", "x", "")), "menu.items[0].label: required"},
		{"a long label", menu(EventItem("k", long, "x", "")), "menu.items[0].label: 61 characters, at most 60"},
		{"a long submenu label", menu(Submenu("s", long, item("a"))), "menu.items[0].label: 61 characters"},

		// Separators.
		{"a leading separator", menu(Separator(), item("a")), "a separator does not start a menu"},
		{"a trailing separator", menu(item("a"), Separator()), "a separator does not end a menu"},
		{"two separators", menu(item("a"), Separator(), Separator(), item("b")), "two separators in a row"},
		{"only a separator", menu(Separator()), "does not start a menu"},
		{"a submenu's separators", menu(Submenu("s", "More", item("a"), Separator(), item("b"))), ""},
		{"a submenu ending in a separator", menu(Submenu("s", "More", item("a"), Separator())), "submenu[1]: a separator does not end a menu"},

		// One level.
		{"a submenu in a submenu", menu(Submenu("s", "More", Submenu("s2", "Even more", item("a")))), "submenu[0].submenu: a submenu's items have no submenus"},
		{"a danger submenu", menu(Submenu("s", "More", item("a")).AsDanger()), "a submenu is not danger, grouped or checked"},
		{"a disabled submenu", menu(Submenu("s", "More", item("a")).AsDisabled()), ""},

		// One-pick groups.
		{"a group in a submenu", menu(moveTo), ""},
		{"a group at the top", menu(PickGroup("g", "b", item("a"), item("b"))...), ""},
		{"a group with nothing checked", menu(PickGroup("g", "", item("a"), item("b"))...), ""},
		{"two checked", menu(append(PickGroup("g", "a", item("a")), PickGroup("g", "b", item("b"))...)...), `group "g" already has a checked item`},
		{"two groups each checked", menu(append(PickGroup("g", "a", item("a")), PickGroup("h", "b", item("b"))...)...), ""},
		{"a group split", menu(append(append(PickGroup("g", "", item("a")), item("x")), PickGroup("g", "", item("b"))...)...), `"g": a group's items sit next to each other`},
		{"a group split by a separator", menu(append(append(PickGroup("g", "", item("a")), Separator()), PickGroup("g", "", item("b"))...)...), "sit next to each other"},
		{"checked without a group", menu(MenuItem{Key: "k", Label: "On", Action: EventAction("x", ""), Checked: true}), "only a group's item is checked"},
		{"a bad group name", menu(PickGroup("bad group", "", item("a"))...), `"bad group" must match`},
		{"a grouped submenu", menu(MenuItem{Key: "s", Label: "More", Submenu: []MenuItem{item("a")}, Group: "g"}), "a submenu is not danger, grouped or checked"},
		{"a grouped separator", menu(item("a"), MenuItem{Separator: true, Group: "g"}, item("b")), "a separator has nothing else set"},

		// Where menus go.
		{"a header menu", View{Header: &Header{Title: "Jenkins", Menu: NewMenu(item("a"))}}, ""},
		{"a header menu with a problem", View{Header: &Header{Title: "Jenkins", Menu: NewMenu()}}, "header.menu.items: 0 items"},
		{"a menu button in a bar", View{Nodes: []Node{NewActions("bar", EventButton("rebuild", "Rebuild", "").WithMenu(NewMenu(item("a"))))}}, ""},
		{"a menu button in the toolbar", View{Toolbar: []Node{NewActions("bar", Button{Key: "b", Label: "Rebuild", Menu: NewMenu(item("a"))})}}, ""},
		{"a menu button in a section", View{Nodes: []Node{{Key: "s", Section: &Section{Actions: []Button{{Key: "b", Label: "More", Menu: NewMenu(item("a"))}}}}}}, ""},
		{"a menu button with an action", View{Nodes: []Node{NewActions("bar", Button{Key: "b", Label: "Both", Action: EventAction("x", ""), Menu: NewMenu(item("a"))})}}, "a button acts or opens a menu, not both"},
		{"a button with neither", View{Nodes: []Node{NewActions("bar", Button{Key: "b", Label: "Neither"})}}, "buttons[0].action: required (or a menu)"},
		{"a menu button's bad menu", View{Nodes: []Node{NewActions("bar", Button{Key: "b", Label: "More", Menu: NewMenu(Separator())})}}, "buttons[0].menu.items[0]"},
		{"a menu button in a header", View{Header: &Header{Actions: []Button{{Key: "b", Label: "More", Icon: "ellipsis", IconOnly: true, Menu: NewMenu(item("a"))}}}}, "header.actions[0].menu: these buttons do not open menus: give the header a menu"},
		{"a menu button in a row", row(nil, Button{Key: "b", Label: "More", Menu: NewMenu(item("a"))}), "rows[0].actions[0].menu: these buttons do not open menus: give the row a menu"},
		{"a menu submit", View{Nodes: []Node{{Key: "f", Form: &Form{Submit: &Button{Key: "s", Label: "Go", Menu: NewMenu(item("a"))}}}}}, "a form's submit acts"},
		{"a menu secondary", View{Nodes: []Node{{Key: "f", Form: &Form{Secondary: []Button{{Key: "s", Label: "More", Menu: NewMenu(item("a"))}}}}}}, "form.secondary[0].menu"},
		{"a master-detail row's menu", View{Nodes: []Node{NewMasterDetail("md", List{Rows: []Row{{Key: "r", Title: "Run", Menu: NewMenu(item("a"))}}}, "")}}, ""},
		{"a master-detail row's bad menu", View{Nodes: []Node{NewMasterDetail("md", List{Rows: []Row{{Key: "r", Title: "Run", Menu: NewMenu()}}}, "")}}, "masterDetail.list.rows[0].menu.items"},
		{"a row with actions and a menu", row(NewMenu(item("a")), EventButton("rerun", "Rerun", "rerun"), EventButton("log", "Open log", "log")), ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.view.Nodes == nil {
				tt.view.Nodes = []Node{}
			}
			err := tt.view.Validate()
			switch {
			case tt.want == "" && err != nil:
				t.Fatalf("Validate() = %v, want nil", err)
			case tt.want != "" && (err == nil || !strings.Contains(err.Error(), tt.want)):
				t.Fatalf("Validate() = %v, want it to name %q", err, tt.want)
			}
		})
	}
}

// Menu items count toward MaxElements, separators too.
func TestMenuItemsAreElements(t *testing.T) {
	var rows []Row
	for i := range 17 {
		its := make([]MenuItem, 0, MaxMenuItems)
		for j := range MaxMenuItems / 2 {
			its = append(its, EventItem("m"+strconv.Itoa(i)+"-"+strconv.Itoa(j), "Item", "x", ""))
			if j < MaxMenuItems/2-1 {
				its = append(its, Separator())
			}
		}
		rows = append(rows, Row{Key: "r" + strconv.Itoa(i), Title: "Row", Menu: NewMenu(its...)})
	}
	err := View{Nodes: []Node{NewList("l", rows...)}}.Validate()
	if err == nil || !strings.Contains(err.Error(), "elements, at most 400") {
		t.Fatalf("Validate() = %v, want the element limit", err)
	}
}

// A menu's JSON: lowerCamel, a separator as {"separator": true}, Menu nil on a plain row.
func TestMenuJSON(t *testing.T) {
	r := Row{Key: "r", Title: "CF-407", Menu: NewMenu(
		EventItem("start", "Start a thread on this", "start", "CF-407"),
		Separator(),
		Submenu("move", "Move to", PickGroup("status", "s-review", EventItem("s-todo", "To do", "move", "todo"), EventItem("s-review", "In review", "move", "review"))...),
		CommandItem("del", "Delete", "plugin.jira.delete", map[string]string{"key": "CF-407"}).AsDanger(),
	)}
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"key":"r","title":"CF-407","menu":{"items":[` +
		`{"key":"start","label":"Start a thread on this","action":{"event":"start","data":"CF-407"}},` +
		`{"separator":true},` +
		`{"key":"move","label":"Move to","submenu":[{"key":"s-todo","label":"To do","action":{"event":"move","data":"todo"},"group":"status"},` +
		`{"key":"s-review","label":"In review","action":{"event":"move","data":"review"},"group":"status","checked":true}]},` +
		`{"key":"del","label":"Delete","action":{"command":{"name":"plugin.jira.delete","args":{"key":"CF-407"}}},"danger":true}]}}`
	if string(b) != want {
		t.Fatalf("got  %s\nwant %s", b, want)
	}
	if b, _ := json.Marshal(Row{Key: "r", Title: "t"}); strings.Contains(string(b), "menu") {
		t.Fatalf("a row without a menu: %s", b)
	}
	if got := EventButton("b", "Rebuild", "rebuild").WithMenu(NewMenu(EventItem("a", "A", "a", ""))); got.Action != nil || got.Menu == nil {
		t.Fatalf("WithMenu: %+v", got)
	}
}

// AllItems lists a menu's items and its submenus' items, in order, without separators.
func TestMenuAllItems(t *testing.T) {
	m := NewMenu(EventItem("a", "A", "a", ""), Separator(), Submenu("s", "S", EventItem("s1", "1", "x", ""), Separator(), EventItem("s2", "2", "x", "")), EventItem("b", "B", "b", ""))
	var keys []string
	for _, it := range m.AllItems() {
		keys = append(keys, it.Key)
	}
	if got := strings.Join(keys, ","); got != "a,s,s1,s2,b" {
		t.Fatalf("AllItems = %s", got)
	}
	if (*Menu)(nil).AllItems() != nil {
		t.Fatal("a nil menu has items")
	}
}
