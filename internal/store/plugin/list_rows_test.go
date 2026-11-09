package plugin_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// rowsSurface is the test plugin's "rows" surface: a checkable, reorderable list with an
// add input, an editable row and a row with its own action, beside a plain list. It shows
// the last act it got; it refuses an add or an edit of "no".
type rowsSurface struct {
	h    *pluginsdk.Host
	inst string
	mu   sync.Mutex
	got  string
}

func newRowsSurface(_ context.Context, h *pluginsdk.Host, open pluginsdk.SurfaceOpen) (pluginsdk.Surface, error) {
	r := &rowsSurface{h: h, inst: open.Instance, got: "nothing"}
	return r, h.UpdateView(open.Instance, r.view())
}

func (r *rowsSurface) view() ui.View {
	r.mu.Lock()
	defer r.mu.Unlock()
	return ui.View{Nodes: []ui.Node{
		ui.NewText("rgot", ui.Plain("got "+r.got)),
		ui.NewList("rl", ui.NewRow("ra", "Alpha").AsChecked(true).AsEditable(),
			ui.Row{Key: "rb", Title: "Beta", Action: ui.EventAction("open", "b")}, ui.NewRow("rc", "Gamma")).
			AsCheckable().AsReorderable().WithAddRow("Add a task", false),
		ui.NewList("plain", ui.NewRow("pa", "Plain")),
	}}
}

func (r *rowsSurface) Act(_ context.Context, act pluginsdk.SurfaceAct) error {
	if (act.Kind == pluginsdk.ActAdd || act.Kind == pluginsdk.ActEdit) && act.Text() == "no" {
		return errors.New("not that one")
	}
	r.mu.Lock()
	r.got = fmt.Sprintf("%s:%s key=%s node=%s value=%#v data=%q values=%v", act.Kind, act.Action, act.Key, act.Node, act.Value, act.Data, act.Values)
	r.mu.Unlock()
	return r.h.UpdateView(r.inst, r.view())
}

func (*rowsSurface) Visibility(bool)             {}
func (*rowsSurface) Close(pluginsdk.CloseReason) {}

// A list's row acts reach the plugin shaped by the host (kind and action the act's kind,
// node the list, the value typed and checked, no data and no form values); a bad value,
// an act the row does not have or a row of a plain list is refused before the plugin.
func TestListRowActs(t *testing.T) {
	e := newSurfEnv(t, nil)
	w := e.watch("rows", s1)
	w.view("first view", contains("got nothing"))
	deadline := time.Now().Add(10 * time.Second)
	for {
		_, err := e.act(w.key, plugin.ActRequest{Key: "rb"})
		if err == nil {
			break
		}
		if !strings.Contains(err.Error(), "is not open") || time.Now().After(deadline) {
			t.Fatalf("waiting for the open: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	w.view("the row's own click", contains(`got click:open key=rb node= value=`+"\\u003cnil\\u003e"+` data=\"b\"`))

	ok := []struct {
		name string
		req  plugin.ActRequest
		want string
	}{
		{"check", plugin.ActRequest{Key: "rb", Action: "check", Value: new("true")}, `got check:check key=rb node=rl value=true data=\"\" values=map[]`},
		{"uncheck", plugin.ActRequest{Key: "ra", Action: "check", Value: new("false")}, `got check:check key=ra node=rl value=false`},
		{"values dropped", plugin.ActRequest{Key: "rc", Action: "check", Value: new("1"), Values: map[string]any{"name": "Ada"}}, `got check:check key=rc node=rl value=true data=\"\" values=map[]`},
		{"move first", plugin.ActRequest{Key: "rc", Action: "move", Value: new("")}, `got move:move key=rc node=rl value=\"\"`},
		{"move after", plugin.ActRequest{Key: "ra", Action: "move", Value: new("rc")}, `got move:move key=ra node=rl value=\"rc\"`},
		{"add trimmed", plugin.ActRequest{Key: "rl", Action: "add", Value: new("  New task ")}, `got add:add key=rl node=rl value=\"New task\"`},
		{"edit", plugin.ActRequest{Key: "ra", Action: "edit", Value: new("Renamed")}, `got edit:edit key=ra node=rl value=\"Renamed\"`},
	}
	for _, c := range ok {
		if _, err := e.act(w.key, c.req); err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		w.view(c.name, contains(c.want))
	}

	refused := []struct {
		name string
		req  plugin.ActRequest
		want string
	}{
		{"check without a value", plugin.ActRequest{Key: "ra", Action: "check"}, "a check act needs a value"},
		{"check of yes", plugin.ActRequest{Key: "ra", Action: "check", Value: new("yes")}, `a check's value is true or false, not "yes"`},
		{"move after itself", plugin.ActRequest{Key: "ra", Action: "move", Value: new("ra")}, `another row of list "rl", not "ra"`},
		{"move after another list's row", plugin.ActRequest{Key: "ra", Action: "move", Value: new("pa")}, `not "pa"`},
		{"add of nothing", plugin.ActRequest{Key: "rl", Action: "add", Value: new("   ")}, "the text is empty"},
		{"add of two lines", plugin.ActRequest{Key: "rl", Action: "add", Value: new("a\nb")}, "the text is one line"},
		{"add too long", plugin.ActRequest{Key: "rl", Action: "add", Value: new(strings.Repeat("é", ui.MaxRowText+1))}, "over 200 characters"},
		{"edit of a row that is not editable", plugin.ActRequest{Key: "rb", Action: "edit", Value: new("x")}, `element "rb"'s action is "open", not "edit"`},
		{"check on a plain list", plugin.ActRequest{Key: "pa", Action: "check", Value: new("true")}, `no acting element "pa"`},
		{"add on a plain list", plugin.ActRequest{Key: "plain", Action: "add", Value: new("x")}, `no acting element "plain"`},
		{"a check without a key", plugin.ActRequest{Action: "check", Value: new("true")}, `no element acts "check"`},
	}
	for _, c := range refused {
		if _, err := e.act(w.key, c.req); !errors.Is(err, plugin.ErrInvalidArgument) || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v, want %q", c.name, err, c.want)
		}
	}
	// The plugin's refusal comes back as one.
	if _, err := e.act(w.key, plugin.ActRequest{Key: "rl", Action: "add", Value: new("no")}); !errors.Is(err, plugin.ErrPluginRefused) || !strings.Contains(err.Error(), "not that one") {
		t.Errorf("a refused add: %v", err)
	}

	// The row acts are listed after the view's elements, with their list.
	var got []string
	for _, el := range e.m.SurfaceElements(w.key, 0) {
		got = append(got, fmt.Sprintf("%s %s %s %s %q", el.Key, el.Kind, el.Action, el.Node, el.Label))
	}
	want := []string{`rb click open  "Beta"`, `rl add add rl "Add a task"`,
		`ra check check rl "Alpha"`, `ra move move rl "Alpha"`, `ra edit edit rl "Alpha"`,
		`rb check check rl "Beta"`, `rb move move rl "Beta"`, `rc check check rl "Gamma"`, `rc move move rl "Gamma"`}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("elements\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}
