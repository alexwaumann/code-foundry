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

// PickDate sends a date field's change act as the host does and refuses what the host
// refuses.
func TestPickDate(t *testing.T) {
	rec := recorder{got: make(chan pluginsdk.SurfaceAct, 1)}
	p := pluginsdk.Plugin{Surfaces: map[string]pluginsdk.SurfaceFactory{
		"s": func(_ context.Context, h *pluginsdk.Host, open pluginsdk.SurfaceOpen) (pluginsdk.Surface, error) {
			due := ui.DateField("f-due", "due", "Due").WithValue("2026-11-14").WithDateRange("2026-11-01", "2026-12-31").WithChange("due")
			due.Change.Data = "task-1"
			form := ui.NewForm("f", nil,
				ui.TextField("f-title", "title", "Title").WithValue("Ship it"),
				ui.NewFieldset("f-when", "When", due, ui.DateField("f-plain", "plain", "Plain")),
				ui.ToggleField("f-done", "done", "Done", false),
				ui.SecretField("f-token", "token", "Token", ""),
			)
			v := ui.View{Toolbar: []ui.Node{ui.NewForm("tb", nil, ui.DateField("tb-since", "since", "Since").WithChange("since"))}, Nodes: []ui.Node{form}}
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

	if err := h.PickDate(ctx, "i", "f-due", "2026-11-20"); err != nil {
		t.Fatal(err)
	}
	got := <-rec.got
	if got.Kind != pluginsdk.ActChange || got.Action != "due" || got.Data != "task-1" || got.Key != "f-due" || got.Field != "due" || got.Value != "2026-11-20" {
		t.Errorf("act = %+v", got)
	}
	if got.Values["due"] != "2026-11-20" || got.Values["title"] != "Ship it" || got.Values["done"] != false || got.Values["plain"] != "" {
		t.Errorf("values = %v", got.Values)
	}
	if _, ok := got.Values["token"]; ok {
		t.Errorf("a secret in a change: %v", got.Values)
	}
	if err := h.PickDate(ctx, "i", "tb-since", ""); err != nil {
		t.Fatal(err)
	}
	if got := <-rec.got; got.Key != "tb-since" || got.Value != nil && got.Value != "" {
		t.Errorf("clear in the toolbar: %+v", got)
	}

	for _, c := range []struct{ key, day, want string }{
		{"f-nope", "2026-11-20", "no date field"},
		{"f-title", "2026-11-20", "no date field"},
		{"f-plain", "2026-11-20", "no change event"},
		{"f-due", "next week", "not an ISO date"},
		{"f-due", "2026-02-30", "not an ISO date"},
		{"f-due", "2026-10-31", "outside"},
		{"f-due", "2027-01-01", "outside"},
	} {
		if err := h.PickDate(ctx, "i", c.key, c.day); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("PickDate(%s, %s) = %v, want %q", c.key, c.day, err, c.want)
		}
	}
	if err := h.PickDate(ctx, "nope", "f-due", ""); err == nil {
		t.Error("an instance without a view")
	}
}
