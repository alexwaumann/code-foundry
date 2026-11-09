package plugintest_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/plugintest"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// Check, Move, AddRow and EditRow shape a list's row acts as the host does (kind and
// action the act's kind, node the list, the value typed) and refuse what the host refuses.
func TestListRowHelpers(t *testing.T) {
	rec := recorder{got: make(chan pluginsdk.SurfaceAct, 1)}
	p := pluginsdk.Plugin{Surfaces: map[string]pluginsdk.SurfaceFactory{
		"s": func(_ context.Context, h *pluginsdk.Host, open pluginsdk.SurfaceOpen) (pluginsdk.Surface, error) {
			todo := ui.NewList("todo", ui.NewRow("a", "A").AsEditable(), ui.NewRow("b", "B").AsChecked(true)).
				AsCheckable().AsReorderable().WithAddRow("Add", false)
			plain := ui.NewList("plain", ui.NewRow("p", "P"))
			box := ui.NewSection("sec", "Inside", todo)
			return rec, h.UpdateView(open.Instance, ui.View{Nodes: []ui.Node{box, plain}})
		},
	}}
	h := plugintest.Start(t, p, plugintest.Options{})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := h.OpenSurface(ctx, "i", "s", pluginsdk.UiContext{}); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(2*time.Second, func(h *plugintest.Host) bool { _, ok := h.View("i"); return ok })

	sent := []struct {
		name string
		do   func() error
		want pluginsdk.SurfaceAct
	}{
		{"check", func() error { return h.Check(ctx, "i", "b", false) }, pluginsdk.SurfaceAct{Kind: "check", Key: "b", Value: false}},
		{"move first", func() error { return h.Move(ctx, "i", "b", "") }, pluginsdk.SurfaceAct{Kind: "move", Key: "b", Value: ""}},
		{"move after", func() error { return h.Move(ctx, "i", "a", "b") }, pluginsdk.SurfaceAct{Kind: "move", Key: "a", Value: "b"}},
		{"add", func() error { return h.AddRow(ctx, "i", "todo", "  Buy milk ") }, pluginsdk.SurfaceAct{Kind: "add", Key: "todo", Value: "Buy milk"}},
		{"edit", func() error { return h.EditRow(ctx, "i", "a", "Renamed") }, pluginsdk.SurfaceAct{Kind: "edit", Key: "a", Value: "Renamed"}},
	}
	for _, c := range sent {
		if err := c.do(); err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		got := <-rec.got
		if got.Kind != c.want.Kind || got.Action != c.want.Kind || got.Key != c.want.Key || got.Node != "todo" || got.Value != c.want.Value {
			t.Errorf("%s: the plugin got %+v", c.name, got)
		}
		switch c.want.Kind {
		case pluginsdk.ActCheck:
			if got.Checked() {
				t.Errorf("%s: Checked() is true", c.name)
			}
		case pluginsdk.ActMove:
			if got.After() != c.want.Value {
				t.Errorf("%s: After() = %q", c.name, got.After())
			}
		default:
			if got.Text() != c.want.Value {
				t.Errorf("%s: Text() = %q", c.name, got.Text())
			}
		}
	}

	refused := []struct {
		name string
		err  error
		want string
	}{
		{"check a plain row", h.Check(ctx, "i", "p", true), `row "p" has no check act`},
		{"move a plain row", h.Move(ctx, "i", "p", ""), `row "p" has no move act`},
		{"edit a row that is not editable", h.EditRow(ctx, "i", "b", "x"), `row "b" has no edit act`},
		{"a missing row", h.Check(ctx, "i", "zz", true), `no row "zz"`},
		{"move after itself", h.Move(ctx, "i", "a", "a"), `not "a"`},
		{"move after another list's row", h.Move(ctx, "i", "a", "p"), `not "p"`},
		{"add to a list without an input", h.AddRow(ctx, "i", "plain", "x"), `"plain" is not a list with an add input`},
		{"add nothing", h.AddRow(ctx, "i", "todo", "  "), "the text is empty"},
		{"edit to two lines", h.EditRow(ctx, "i", "a", "a\nb"), "one line"},
	}
	for _, c := range refused {
		if c.err == nil || !strings.Contains(c.err.Error(), c.want) {
			t.Errorf("%s: %v, want %q", c.name, c.err, c.want)
		}
	}
	select {
	case got := <-rec.got:
		t.Errorf("a refused act reached the plugin: %+v", got)
	default:
	}
}
