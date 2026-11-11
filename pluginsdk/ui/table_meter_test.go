package ui

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

// Every validation branch of a meter cell (docs/notes/plugin-table-meter.md).
func TestValidateMeterCell(t *testing.T) {
	cell := func(c Cell) View {
		return View{Nodes: []Node{NewTable("t", []TableColumn{TableCol("rate", "Pass rate")}, NewTableRow("r", map[string]Cell{"rate": c}))}}
	}
	meter := func(m Meter) Cell { return Cell{Meter: &m} }
	tests := []struct {
		name string
		cell Cell
		want string // "" = valid
	}{
		{"empty", MeterCell(0, ""), ""},
		{"full", MeterCell(1, "100%"), ""},
		{"a share with a label", MeterCell(0.86, "86%"), ""},
		{"label at the limit", MeterCell(0.5, strings.Repeat("x", MaxMeterLabel)), ""},
		{"label of non-ASCII at the limit", MeterCell(0.5, strings.Repeat("–", MaxMeterLabel)), ""},
		{"every tone", MeterCell(0.41, "41%").WithMeterTone(ToneError), ""},
		{"ok tone", MeterCell(0.99, "99%").WithMeterTone(ToneOK), ""},
		{"attention tone", MeterCell(0.86, "86%").WithMeterTone(ToneAttention), ""},
		{"muted tone", MeterCell(0.2, "1 of 5").WithMeterTone(ToneMuted), ""},
		{"neutral spelled out", meter(Meter{Value: 0.5, Tone: "neutral"}), ""},
		{"negative", MeterCell(-0.01, ""), "nodes[0].table.rows[0].cells.rate.meter.value: -0.01 is outside 0..1"},
		{"over one", MeterCell(1.0001, ""), "nodes[0].table.rows[0].cells.rate.meter.value: 1.0001 is outside 0..1 (a fraction: 0.86 for 86%)"},
		{"a percent, not a fraction", MeterCell(86, "86%"), "cells.rate.meter.value: 86 is outside 0..1"},
		{"NaN", MeterCell(math.NaN(), ""), "nodes[0].table.rows[0].cells.rate.meter.value: NaN is not a finite number"},
		{"infinity", MeterCell(math.Inf(1), ""), "cells.rate.meter.value: +Inf is not a finite number"},
		{"minus infinity", MeterCell(math.Inf(-1), ""), "cells.rate.meter.value: -Inf is not a finite number"},
		{"label too long", MeterCell(0.5, strings.Repeat("x", MaxMeterLabel+1)), "nodes[0].table.rows[0].cells.rate.meter.label: 17 characters, at most 16"},
		{"label of two lines", MeterCell(0.5, "3 of\n8"), "cells.rate.meter.label: one line"},
		{"label with a return", MeterCell(0.5, "3\r"), "cells.rate.meter.label: one line"},
		{"unknown tone", MeterCell(0.5, "").WithMeterTone("green"), `cells.rate.meter.tone: unknown tone "green"`},
		{"beside a value", Cell{Value: Plain("86%"), Meter: &Meter{Value: 0.86}}, "nodes[0].table.rows[0].cells.rate: a meter is the cell's whole content: no value, glyph or pill beside it"},
		{"beside a glyph", Cell{Glyph: &Glyph{Status: StatusOK}, Meter: &Meter{Value: 0.86}}, "cells.rate: a meter is the cell's whole content"},
		{"beside a pill", Cell{Pill: NewPill("ok", ToneOK), Meter: &Meter{Value: 0.86}}, "cells.rate: a meter is the cell's whole content"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := cell(tt.cell).Validate()
			switch {
			case tt.want == "" && err != nil:
				t.Fatalf("Validate: %v", err)
			case tt.want != "" && (err == nil || !strings.Contains(err.Error(), tt.want)):
				t.Fatalf("Validate = %v, want %q", err, tt.want)
			}
		})
	}
}

// A meter cell is {"meter": …} in JSON (a value of 0 is kept), and decodes back to the
// same cell; the plain-value cell still encodes as its Inline.
func TestMeterCellJSON(t *testing.T) {
	for _, tt := range []struct {
		name string
		cell Cell
		want string
	}{
		{"empty track", MeterCell(0, ""), `{"meter":{"value":0}}`},
		{"full, labelled", MeterCell(1, "100%"), `{"meter":{"value":1,"label":"100%"}}`},
		{"toned", MeterCell(0.86, "86%").WithMeterTone(ToneAttention), `{"meter":{"value":0.86,"label":"86%","tone":"attention"}}`},
		{"a value alone is still its Inline", TextCell("main"), `"main"`},
	} {
		t.Run(tt.name, func(t *testing.T) {
			b, err := json.Marshal(tt.cell)
			if err != nil || string(b) != tt.want {
				t.Fatalf("Marshal = %s, %v; want %s", b, err, tt.want)
			}
			var back Cell
			if err := json.Unmarshal(b, &back); err != nil {
				t.Fatal(err)
			}
			if b2, _ := json.Marshal(back); string(b2) != tt.want {
				t.Fatalf("round trip %s, want %s", b2, tt.want)
			}
		})
	}
	var c Cell
	if err := json.Unmarshal([]byte(`{"meter":{"value":"86%"}}`), &c); err == nil {
		t.Errorf("a string value decoded: %+v", c.Meter)
	}
}

// The builders: MeterCell is a neutral meter alone; WithMeterTone sets the tone on a copy
// and leaves a cell without a meter as it is.
func TestMeterBuilders(t *testing.T) {
	base := MeterCell(0.41, "41%")
	toned := base.WithMeterTone(ToneError)
	if base.Meter.Tone != ToneNeutral || toned.Meter.Tone != ToneError || toned.Meter.Value != 0.41 || toned.Meter.Label != "41%" {
		t.Fatalf("base %+v, toned %+v", base.Meter, toned.Meter)
	}
	if base.Value != nil || base.Glyph != nil || base.Pill != nil {
		t.Fatalf("MeterCell is a meter alone: %+v", base)
	}
	if got := TextCell("x").WithMeterTone(ToneOK); got.Meter != nil {
		t.Fatalf("WithMeterTone on a text cell made a meter: %+v", got.Meter)
	}
	if TableMeterCapability != "view.table.meter" {
		t.Fatalf("capability %q", TableMeterCapability)
	}
}
