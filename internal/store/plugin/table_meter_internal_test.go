package plugin

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// The host takes a table's meter cells (canonical JSON keeps them, a 0 value included),
// refuses the ones ui's Validate refuses, and announces the capability
// (docs/notes/plugin-table-meter.md).
func TestTableMeterInTheHost(t *testing.T) {
	view := func(cell string) string {
		return `{"nodes": [{"key": "t", "table": {"columns": [{"key": "c", "label": "Pass rate"}], "rows": [{"key": "r", "cells": {"c": ` + cell + `}}]}}]}`
	}
	for _, tt := range []struct {
		name, cell, want, canon string
	}{
		{"a toned meter", `{"meter": {"value": 0.86, "label": "86%", "tone": "attention"}}`, "", `{"meter":{"value":0.86,"label":"86%","tone":"attention"}}`},
		{"an empty track", `{"meter": {"value": 0}}`, "", `{"meter":{"value":0}}`},
		{"no value is 0", `{"meter": {"label": "–"}}`, "", `{"meter":{"value":0,"label":"–"}}`},
		{"a full one", `{"meter": {"value": 1, "label": "100%", "tone": "ok"}}`, "", `{"meter":{"value":1,"label":"100%","tone":"ok"}}`},
		{"over one", `{"meter": {"value": 1.5}}`, "nodes[0].table.rows[0].cells.c.meter.value: 1.5 is outside 0..1", ""},
		{"a percent", `{"meter": {"value": 86, "label": "86%"}}`, "cells.c.meter.value: 86 is outside 0..1", ""},
		{"negative", `{"meter": {"value": -0.1}}`, "cells.c.meter.value: -0.1 is outside 0..1", ""},
		{"a long label", `{"meter": {"value": 0.5, "label": "` + strings.Repeat("x", ui.MaxMeterLabel+1) + `"}}`, "cells.c.meter.label: 17 characters, at most 16", ""},
		{"a label of two lines", `{"meter": {"value": 0.5, "label": "3 of\n8"}}`, "cells.c.meter.label: one line", ""},
		{"an unknown tone", `{"meter": {"value": 0.5, "tone": "green"}}`, `cells.c.meter.tone: unknown tone "green"`, ""},
		{"beside a value", `{"value": "86%", "meter": {"value": 0.86}}`, "cells.c: a meter is the cell's whole content", ""},
		{"beside a pill", `{"pill": {"label": "ok"}, "meter": {"value": 0.86}}`, "cells.c: a meter is the cell's whole content", ""},
		{"a string value", `{"meter": {"value": "86%"}}`, "view: ", ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			_, canon, errs := validateView(json.RawMessage(view(tt.cell)), "p", everyPerms)
			got := strings.Join(errs, "\n")
			if (tt.want == "") != (got == "") || !strings.Contains(got, tt.want) {
				t.Fatalf("errors %q, want %q", got, tt.want)
			}
			if tt.canon != "" && !strings.Contains(string(canon), `"cells":{"c":`+tt.canon+`}`) {
				t.Fatalf("canonical %s, want the cell %s", canon, tt.canon)
			}
		})
	}
	if !slices.Contains(hostCapabilities, "view.table.meter") {
		t.Errorf("view.table.meter is not announced: %v", hostCapabilities)
	}
}
