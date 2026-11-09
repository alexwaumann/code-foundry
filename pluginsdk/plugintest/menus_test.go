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

// PickItem sends a menu item's click (its event, key and data) from a row's, the header's or a
// menu button's menu, a submenu's too, and refuses what the GUI would not send.
func TestPickItem(t *testing.T) {
	rec := recorder{got: make(chan pluginsdk.SurfaceAct, 1)}
	p := pluginsdk.Plugin{Surfaces: map[string]pluginsdk.SurfaceFactory{
		"s": func(_ context.Context, h *pluginsdk.Host, open pluginsdk.SurfaceOpen) (pluginsdk.Surface, error) {
			row := ui.NewRow("CF-407", "Plugin menus")
			row.Menu = ui.NewMenu(
				ui.EventItem("send", "Send to this thread", "send", "CF-407"),
				ui.Submenu("move", "Move to", ui.PickGroup("status", "todo",
					ui.EventItem("todo", "To do", "move", "todo"), ui.EventItem("done", "Done", "move", "done"))...),
				ui.Submenu("later", "Later", ui.EventItem("later-1", "Tomorrow", "later", "1")).AsDisabled(),
				ui.URLItem("open", "Open in Jira", "https://jira.example.com/CF-407"),
				ui.EventItem("del", "Delete", "delete", "CF-407").AsDisabled().AsDanger(),
			)
			v := ui.View{
				Header: &ui.Header{Title: "Jira", Menu: ui.NewMenu(ui.EventItem("refresh", "Refresh", "refresh", ""))},
				Nodes: []ui.Node{ui.NewList("l", row), ui.NewActions("bar",
					ui.Button{Key: "rebuild", Label: "Rebuild"}.WithMenu(ui.NewMenu(ui.EventItem("rebuild-1", "Rebuild", "rebuild", "1287"))))},
			}
			return rec, h.UpdateView(open.Instance, v)
		},
	}}
	h := plugintest.Start(t, p, plugintest.Options{})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := h.OpenSurface(ctx, "i", "s", pluginsdk.UiContext{}); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(2*time.Second, func(h *plugintest.Host) bool { _, ok := h.View("i"); return ok })
	for _, c := range []struct{ key, action, data string }{
		{"send", "send", "CF-407"}, {"done", "move", "done"}, {"refresh", "refresh", ""}, {"rebuild-1", "rebuild", "1287"},
	} {
		if err := h.PickItem(ctx, "i", c.key); err != nil {
			t.Fatalf("%s: %v", c.key, err)
		}
		got := <-rec.got
		if got.Kind != pluginsdk.ActClick || got.Action != c.action || got.Key != c.key || got.Data != c.data {
			t.Errorf("%s: %+v", c.key, got)
		}
	}
	for key, want := range map[string]string{
		"nope": "no menu item", "move": "is a submenu", "del": "is disabled", "later-1": "is disabled",
		"open": "the host's", "CF-407": "no menu item",
	} {
		if err := h.PickItem(ctx, "i", key); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v, want %q", key, err, want)
		}
	}
	if err := h.PickItem(ctx, "other", "send"); err == nil {
		t.Error("an instance without a view")
	}
}
