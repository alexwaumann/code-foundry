package ui

import (
	"math"
	"strings"
)

// Meter is a thin horizontal bar in a table cell: a track the cell's width with a fill of
// Value (a fraction from 0 to 1), and Label after it, which the plugin formats ("52%",
// "3 of 8", "–"; at most MaxMeterLabel characters, one line): the host never formats a
// number. Tone colours the fill as stat figures and bars are coloured: ToneOK emerald,
// ToneAttention amber, ToneError red, ToneMuted muted; neutral by default. A value of 0
// draws the empty track; any value above 0 at least a sliver. In a narrow column the label
// goes (into a tooltip) and the track stays. Use it for a share or a rate in a row (a
// suite's pass rate, a branch's share of the builds), not for running work (the progress
// node). In JSON: {"meter": {"value": 0.86, "label": "86%", "tone": "attention"}}.
type Meter struct {
	Value float64 `json:"value"`
	Label string  `json:"label,omitempty"`
	Tone  Tone    `json:"tone,omitempty"`
}

// TableMeterCapability is announced by a host that draws a table cell's Meter.
const TableMeterCapability = "view.table.meter"

// MaxMeterLabel is a meter's label's most characters.
const MaxMeterLabel = 16

// MeterCell returns a cell of a meter alone: value a fraction from 0 to 1, label what
// shows after the bar ("52%", "3 of 8"; "" for none), neutral (WithMeterTone colours it).
func MeterCell(value float64, label string) Cell {
	return Cell{Meter: &Meter{Value: value, Label: label}}
}

// WithMeterTone returns c with its meter's fill in tone t (a cell without a meter is
// returned as it is).
func (c Cell) WithMeterTone(t Tone) Cell {
	if c.Meter != nil {
		m := *c.Meter
		m.Tone = t
		c.Meter = &m
	}
	return c
}

// meter checks a cell's meter: the cell's whole content, a finite value in [0, 1] (never
// clamped), a short one-line label and a known tone.
func (c *checker) meter(path string, cell Cell) {
	m := cell.Meter
	if m == nil {
		return
	}
	if cell.Value != nil || cell.Glyph != nil || cell.Pill != nil {
		c.bad(path, "a meter is the cell's whole content: no value, glyph or pill beside it")
	}
	p := path + ".meter"
	switch v := m.Value; {
	case math.IsNaN(v) || math.IsInf(v, 0):
		c.bad(p+".value", "%g is not a finite number", v)
	case v < 0 || v > 1:
		c.bad(p+".value", "%g is outside 0..1 (a fraction: 0.86 for 86%%)", v)
	}
	c.str(p+".label", m.Label, MaxMeterLabel)
	if strings.ContainsAny(m.Label, "\n\r") {
		c.bad(p+".label", "one line")
	}
	c.tone(p+".tone", m.Tone)
}
