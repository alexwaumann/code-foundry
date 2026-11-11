package plugintest_test

import (
	"context"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/plugintest"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// meterPlugin shows one table of suites' pass rates: meters where the host draws them,
// else their labels as text.
func meterPlugin() pluginsdk.Plugin {
	return pluginsdk.Plugin{Surfaces: map[string]pluginsdk.SurfaceFactory{
		"s": func(_ context.Context, h *pluginsdk.Host, open pluginsdk.SurfaceOpen) (pluginsdk.Surface, error) {
			rate := func(v float64, label string, tone ui.Tone) ui.Cell {
				if !h.HasCapability(ui.TableMeterCapability) {
					return ui.TextCell(label)
				}
				return ui.MeterCell(v, label).WithMeterTone(tone)
			}
			t := ui.NewTable("suites", []ui.TableColumn{ui.TableCol("s-name", "Suite"), ui.TableCol("s-rate", "Pass rate")},
				ui.NewTableRow("s-unit", map[string]ui.Cell{"s-name": ui.TextCell("unit"), "s-rate": rate(1, "100%", ui.ToneOK)}),
				ui.NewTableRow("s-lint", map[string]ui.Cell{"s-name": ui.TextCell("lint")}))
			return surface{}, h.UpdateView(open.Instance, ui.View{Nodes: []ui.Node{t}})
		},
	}}
}

// The real host announces meters and TableCell reads one back; a test of an older host
// (no capability) sees the plugin's text instead. A missing table, row or cell is not ok.
func TestTableCellMeter(t *testing.T) {
	for _, tt := range []struct {
		name string
		caps []string
		want ui.Cell
	}{
		{"the real host", nil, ui.MeterCell(1, "100%").WithMeterTone(ui.ToneOK)},
		{"an older host", []string{"surfaces", "view.node.table"}, ui.TextCell("100%")},
	} {
		t.Run(tt.name, func(t *testing.T) {
			h := plugintest.Start(t, meterPlugin(), plugintest.Options{Capabilities: tt.caps})
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := h.OpenSurface(ctx, "i", "s", pluginsdk.UiContext{}); err != nil {
				t.Fatal(err)
			}
			h.WaitFor(2*time.Second, func(h *plugintest.Host) bool { _, ok := h.View("i"); return ok })
			got, ok := h.TableCell("i", "suites", "s-unit", "s-rate")
			if !ok {
				t.Fatal("no cell")
			}
			if g, w := enc(t, got), enc(t, tt.want); g != w {
				t.Errorf("cell %s, want %s", g, w)
			}
			for _, c := range [][3]string{{"nope", "s-unit", "s-rate"}, {"suites", "s-nope", "s-rate"}, {"suites", "s-lint", "s-rate"}} {
				if _, ok := h.TableCell("i", c[0], c[1], c[2]); ok {
					t.Errorf("TableCell(%v) is ok", c)
				}
			}
		})
	}
}

func enc(t *testing.T, c ui.Cell) string {
	t.Helper()
	b, err := c.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
