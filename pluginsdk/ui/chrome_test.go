package ui

import (
	"encoding/json"
	"os"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// Every []Node field of View is one of NodeLists, so the host's walks (logs, acting
// elements, owned nodes, [] lists) reach a new slot the day it is added.
func TestNodeListsHasEveryViewList(t *testing.T) {
	vt := reflect.TypeFor[View]()
	var v View
	rv := reflect.ValueOf(&v).Elem()
	want := 0
	for i := range vt.NumField() {
		if vt.Field(i).Type == reflect.TypeFor[[]Node]() {
			want++
			rv.Field(i).Set(reflect.ValueOf([]Node{NewText("in-"+vt.Field(i).Name, Plain("x"))}))
		}
	}
	lists := v.NodeLists()
	if len(lists) != want {
		t.Fatalf("NodeLists has %d lists, View %d", len(lists), want)
	}
	var keys []string
	for _, l := range lists {
		for _, n := range l {
			keys = append(keys, n.Key)
		}
	}
	if strings.Join(keys, " ") != "in-Toolbar in-Nodes in-Footer" {
		t.Errorf("NodeLists order: %v", keys)
	}
	// The lists share v's arrays: a walk changes nodes in place.
	lists[0][0].Key = "changed"
	if v.Toolbar[0].Key != "changed" {
		t.Error("NodeLists copied the toolbar")
	}
}

func TestValidateStrips(t *testing.T) {
	text := func(k string) Node { return NewText(k, Plain("x")) }
	chips := NewChips("ch", Chip{Key: "c1", Label: "All", Selected: true, Action: EventAction("status", "all")})
	bar := Node{Key: "bar", Actions: &Actions{Align: AlignEnd, Buttons: []Button{EventButton("run", "Run", "run")}}}
	progress := Node{Key: "pr", Progress: &Progress{Label: "Syncing"}}
	search := func(fields ...Field) Node {
		submit := EventButton("go", "Filter", "filter").WithIcon("search").AsIconOnly()
		return NewForm("q", &submit, fields...)
	}
	query := TextField("qf", "q", "Filter").WithPlaceholder("Filter runs")
	dropdown := SelectField("sel", "s", "Status", Opt("o1", "a", "A"))
	multi := SelectField("multi", "m", "Tags", Opt("o2", "b", "B"))
	multi.Select.Multiple = true
	list := SelectField("list", "l", "Env", Opt("o3", "c", "C"))
	list.Select.Style = SelectList
	toggle := ToggleField("tg", "mine", "Mine", true)
	six := func(prefix string) []Node {
		out := make([]Node, MaxStripNodes)
		for i := range out {
			out[i] = text(prefix + strconv.Itoa(i))
		}
		return out
	}
	tests := []struct {
		name          string
		toolbar, foot []Node
		body          []Node
		want          string // "" = valid
	}{
		{name: "every strip kind in the toolbar", toolbar: []Node{search(query, dropdown, multi, toggle), chips, text("t"), progress, bar}},
		{name: "every strip kind in the footer", foot: []Node{text("t"), progress, bar, chips, search(query)}},
		{name: "both, beside a body", toolbar: []Node{search(query), chips}, body: []Node{text("b")}, foot: []Node{bar}},
		{name: "six in each", toolbar: six("t"), foot: six("f")},
		{name: "empty strips", toolbar: []Node{}, foot: []Node{}},
		{name: "seven in the toolbar", toolbar: append(six("t"), text("t6")), want: "toolbar: 7 nodes, at most 6"},
		{name: "seven in the footer", foot: append(six("f"), text("f6")), want: "footer: 7 nodes, at most 6"},
		{name: "a fieldset", toolbar: []Node{search(NewFieldset("fs", "Notify", toggle))}, want: "toolbar[0].form.fields[0]: a form in the toolbar has no fieldsets"},
		{name: "a list select", foot: []Node{search(list)}, want: "footer[0].form.fields[0].select.style: a select in the footer is a dropdown, not a list"},
		{name: "a node without a kind", foot: []Node{{Key: "x"}}, want: "footer[0]: a node has exactly one kind"},
		{name: "a node of two kinds", toolbar: []Node{{Key: "x", Text: &Text{Content: Plain("a")}, Markdown: &Markdown{}}}, want: "toolbar[0]: a node has exactly one kind"},
		{name: "a bad strip node", toolbar: []Node{{Key: "p", Progress: &Progress{Value: Fraction(2)}}}, want: "toolbar[0].progress.value: 2 is outside 0..1"},
		{name: "a bad button", foot: []Node{{Key: "a", Actions: &Actions{Buttons: []Button{{Key: "b", Label: "B"}}}}}, want: "footer[0].actions.buttons[0].action: required"},
		{name: "a key shared with the body", toolbar: []Node{text("same")}, body: []Node{text("same")}, want: `nodes[0].key: "same" is already used by toolbar[0]`},
		{name: "a key shared across strips", toolbar: []Node{text("same")}, foot: []Node{text("same")}, want: `footer[0].key: "same" is already used by toolbar[0]`},
		{name: "a form name in two strips", toolbar: []Node{search(query)}, foot: []Node{NewForm("f2", nil, TextField("qf2", "q", "Again"))}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := (View{Toolbar: tt.toolbar, Nodes: tt.body, Footer: tt.foot}).Validate()
			switch {
			case tt.want == "" && err != nil:
				t.Fatalf("Validate: %v", err)
			case tt.want != "" && (err == nil || !strings.Contains(err.Error(), tt.want)):
				t.Fatalf("Validate = %v, want %q", err, tt.want)
			}
		})
	}
}

// Every kind not in StripKinds is refused in either strip, by name.
func TestStripsRefuseOtherKinds(t *testing.T) {
	for _, k := range nodeKinds() {
		allowed := slices.Contains(StripKinds, k)
		for _, strip := range []string{"toolbar", "footer"} {
			v := View{}
			n := []Node{withKind("n", k)}
			if strip == "toolbar" {
				v.Toolbar = n
			} else {
				v.Footer = n
			}
			err := v.Validate()
			refused := err != nil && strings.Contains(err.Error(), strip+"[0]: a "+k+" node cannot be in the "+strip+" (text, chips, actions, progress, form)")
			if refused == allowed {
				t.Errorf("%s in the %s (allowed %v): %v", k, strip, allowed, err)
			}
		}
	}
	if len(StripKinds) != 5 {
		t.Errorf("strip kinds %v: the GUI's StripNodes and the skill's ui-layout.md list them", StripKinds)
	}
}

// Strip nodes and their elements count toward MaxElements like the body's.
func TestStripsCountAsElements(t *testing.T) {
	chips := func(prefix string, n int) Node {
		cs := make([]Chip, n)
		for i := range cs {
			cs[i] = Chip{Key: prefix + strconv.Itoa(i), Label: "c"}
		}
		return NewChips(prefix, cs...)
	}
	// 1 + 199 in the toolbar, 1 + 199 in the footer: 400.
	v := View{Toolbar: []Node{chips("t", 199)}, Footer: []Node{chips("f", 199)}}
	if err := v.Validate(); err != nil {
		t.Errorf("400 elements: %v", err)
	}
	v.Nodes = []Node{NewText("one-more", Plain("x"))}
	if err := v.Validate(); err == nil || !strings.Contains(err.Error(), "view: 401 elements, at most 400") {
		t.Errorf("401 elements: %v", err)
	}
}

func TestValidateContainer(t *testing.T) {
	text := func(k string) Node { return NewText(k, Plain("x")) }
	tests := []struct {
		name string
		node Node
		want string // "" = valid
	}{
		{"narrow", NewContainer("c", ContainerNarrow, text("t")), ""},
		{"wide", NewContainer("c", ContainerWide, text("t")), ""},
		{"full", NewContainer("c", ContainerFull, text("t")), ""},
		{"unset width", NewContainer("c", "", text("t")), ""},
		{"empty", NewContainer("c", ContainerNarrow), ""},
		{"columns in a wide container", NewContainer("c", ContainerWide, NewColumns("cols", NewColumn("a", text("t1")), NewColumn("b"))), ""},
		{"unknown width", NewContainer("c", "medium"), `nodes[0].container.width: unknown width "medium" (narrow, wide or full)`},
		{"px width", Node{Key: "c", Container: &Container{Width: "680"}}, `unknown width "680"`},
		{"bad child", NewContainer("c", ContainerNarrow, Node{Key: "x"}), "nodes[0].container.children[0]: a node has exactly one kind"},
		{"duplicate key in it", NewContainer("c", ContainerNarrow, text("c")), `nodes[0].container.children[0].key: "c" is already used by nodes[0]`},
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
	// A container is not allowed in a strip.
	if err := (View{Toolbar: []Node{NewContainer("c", ContainerNarrow)}}).Validate(); err == nil || !strings.Contains(err.Error(), "a container node cannot be in the toolbar") {
		t.Errorf("container in the toolbar: %v", err)
	}
}

func TestChromeJSON(t *testing.T) {
	submit := EventButton("go", "Filter", "filter")
	v := View{
		Toolbar: []Node{NewForm("q", &submit, TextField("qf", "q", "Filter"))},
		Nodes:   []Node{NewContainer("page", ContainerWide, NewText("t", Plain("x")))},
		Footer:  []Node{NewActions("bar", EventButton("run", "Run", "run"))},
	}
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"toolbar":[{"key":"q","form":{"fields":[{"key":"qf","name":"q","label":"Filter","input":{}}],"submit":{"key":"go","label":"Filter","action":{"event":"filter"}}}}],` +
		`"nodes":[{"key":"page","container":{"width":"wide","children":[{"key":"t","text":{"content":"x"}}]}}],` +
		`"footer":[{"key":"bar","actions":{"buttons":[{"key":"run","label":"Run","action":{"event":"run"}}]}}]}`
	if string(b) != want {
		t.Errorf("JSON\n got %s\nwant %s", b, want)
	}
	var back View
	if err := json.Unmarshal([]byte(want), &back); err != nil {
		t.Fatal(err)
	}
	if len(back.Toolbar) != 1 || back.Toolbar[0].Form == nil || len(back.Footer) != 1 || back.Nodes[0].Container.Width != ContainerWide {
		t.Errorf("decoded %+v", back)
	}
	// No strips: neither key is sent (an older GUI never sees them).
	if b, _ := json.Marshal(View{Nodes: []Node{}}); string(b) != `{"nodes":[]}` {
		t.Errorf("no strips: %s", b)
	}
	// An unset width is left out (full).
	if b, _ := json.Marshal(NewContainer("c", "")); string(b) != `{"key":"c","container":{"children":null}}` {
		t.Errorf("unset width: %s", b)
	}
	if ch := NewContainer("c", ContainerNarrow, NewText("a", Plain("x"))).Children(); len(ch) != 1 || ch[0][0].Key != "a" {
		t.Errorf("Children: %v", ch)
	}
}

// The GUI caps containers and strips with the SDK's numbers
// (gui/frontend/src/components/plugin/layout.ts, strip.ts).
func TestChromeNumbersMatchTheGUI(t *testing.T) {
	if _, err := os.Stat("../../gui/frontend/src/components/plugin"); os.IsNotExist(err) {
		t.Skip("no GUI in this tree")
	}
	read := func(name string) string {
		b, err := os.ReadFile("../../gui/frontend/src/components/plugin/" + name)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	layout, strip := read("layout.ts"), read("strip.ts")
	for _, c := range []struct {
		src, name string
		want      int
	}{
		{layout, "CONTAINER_NARROW_WIDTH", ContainerNarrowWidth},
		{layout, "CONTAINER_WIDE_WIDTH", ContainerWideWidth},
		{strip, "STRIP_MAX_NODES", MaxStripNodes},
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
	m := regexp.MustCompile(`export const STRIP_KINDS[^=]*= \[([^\]]*)\]`).FindStringSubmatch(strip)
	if m == nil || strings.ReplaceAll(strings.ReplaceAll(m[1], `"`, ""), " ", "") != strings.Join(StripKinds, ",") {
		t.Errorf("the GUI's STRIP_KINDS %v, the SDK's %v", m, StripKinds)
	}
}
