package ui

import (
	"fmt"
	"math"
	"strings"
)

// Stats is a row of figure cards, drawn like the app's own Pull Requests counts: each card
// a label, a figure (Value, a string the plugin formats: "86%", "4m 12s", "1,288") in the
// card's tone, and a subtitle. MinStatCards..MaxStatCards cards share the row equally; when
// they do not fit at StatCardMinWidth px each (a narrow pane, about 360 px, fits three)
// they wrap onto balanced rows (four cards: two by two) rather than shrink, and the figures
// step down a type size so a value never wraps. A card with an Action is a toggle (a
// filter): Pressed draws it pressed and dims the others, as the Pull Requests page's cards
// do. In JSON: {"key": "k", "stats": {"cards": [{"key": "c", "label": "Pass rate",
// "value": "86%", "tone": "ok"}]}}.
type Stats struct {
	Cards []StatCard `json:"cards"`
}

// StatCard is one figure card. Label (required, at most MaxStatLabel characters) and
// Subtitle (one line, at most MaxLabel) are cut with "…" when longer than the card; Value
// (required, at most MaxStatValue characters) is never cut unless no type size fits it.
// Tone colours the figure: ToneOK emerald, ToneAttention amber, ToneError red, ToneMuted
// muted, ToneNeutral the text colour. Action (any kind) makes the card a button; Pressed
// (only with an Action) shows it pressed.
type StatCard struct {
	Key      string  `json:"key"`
	Label    string  `json:"label"`
	Value    string  `json:"value"`
	Tone     Tone    `json:"tone,omitempty"`
	Subtitle *Inline `json:"subtitle,omitempty"`
	Action   *Action `json:"action,omitempty"`
	Pressed  bool    `json:"pressed,omitempty"`
}

// Stats' numbers, which the GUI uses too.
const (
	MinStatCards     = 1
	MaxStatCards     = 6
	MaxStatLabel     = 40
	MaxStatValue     = 24
	StatCardMinWidth = 100 // px: narrower, the cards wrap to more rows
)

// Bars is a small bar chart in a card, drawn like the app's own Pull Requests charts: a
// title and subtitle, an optional reference line (a dashed line at Reference.Value, its
// label in the card's top right: "median 4m 12s"), up to MaxBars bars from left to right
// and the axis' first and last labels under them (StartLabel, EndLabel: "#1259", "#1288").
// Bars share the width (a bar is at most BarMaxWidth px; 120 bars in a narrow pane are a
// few px each) and the height scales to the largest value or the reference, whichever is
// higher. Pointing at a bar (or the arrow keys, once the chart has focus) shows one
// tooltip with its Title and Meta and dims the other bars; a bar with an Action acts on a
// click or Enter. In JSON: {"key": "k", "bars": {"title": "Build time", "bars":
// [{"key": "b1", "value": 252, "status": "ok", "title": "#1288 · 4m 12s"}]}}.
type Bars struct {
	Title      string         `json:"title,omitempty"`
	Subtitle   *Inline        `json:"subtitle,omitempty"`
	Bars       []Bar          `json:"bars"`
	Reference  *BarsReference `json:"reference,omitempty"`
	StartLabel string         `json:"startLabel,omitempty"`
	EndLabel   string         `json:"endLabel,omitempty"`
}

// Bar is one bar: its Value (finite, at least 0, in any unit: only the ratios show), its
// colour, and its tooltip, Title (required: the tooltip's first line, "#1280 · 6m 01s")
// over Meta (one line: "main · 18h ago"). The colour is its Status's (StatusOK emerald,
// StatusFailed red, StatusAttention amber, StatusRunning blue and hollow, so a bar still
// growing reads apart; pending, skipped and off muted) or, without a status, its Series's
// (1..MaxBarSeries, the app's chart palette: blue, orange, aqua, yellow, grey; 0 is 1).
// Set one, not both. Action (any kind) acts on a click or Enter.
type Bar struct {
	Key    string  `json:"key"`
	Value  float64 `json:"value"`
	Status Status  `json:"status,omitempty"`
	Series int     `json:"series,omitempty"`
	Title  string  `json:"title"`
	Meta   *Inline `json:"meta,omitempty"`
	Action *Action `json:"action,omitempty"`
}

// BarsReference is a bar chart's reference line: a value on the bars' scale (finite, at
// least 0) and its label, shown in the card's top right.
type BarsReference struct {
	Value float64 `json:"value"`
	Label string  `json:"label,omitempty"`
}

// Bars' numbers, which the GUI uses too.
const (
	MaxBars      = 120
	MaxBarSeries = 5
	MaxAxisLabel = 40
	BarMaxWidth  = 40 // px
)

// NewStats returns a row of figure cards.
func NewStats(key string, cards ...StatCard) Node {
	return Node{Key: key, Stats: &Stats{Cards: cards}}
}

// NewStat returns a figure card: a label over a value the plugin formats ("4m 12s").
func NewStat(key, label, value string) StatCard {
	return StatCard{Key: key, Label: label, Value: value}
}

// WithTone returns c with its figure in a tone.
func (c StatCard) WithTone(t Tone) StatCard { c.Tone = t; return c }

// WithSubtitle returns c with a line under its figure.
func (c StatCard) WithSubtitle(in *Inline) StatCard { c.Subtitle = in; return c }

// WithAction returns c as a toggle doing a (a filter: send an event and render the view
// again with the card pressed).
func (c StatCard) WithAction(a *Action) StatCard { c.Action = a; return c }

// AsPressed returns c pressed (a card with an action: the filter it toggles is on).
func (c StatCard) AsPressed() StatCard { c.Pressed = true; return c }

// NewBars returns a bar chart with a title.
func NewBars(key, title string, bars ...Bar) Node {
	return Node{Key: key, Bars: &Bars{Title: title, Bars: bars}}
}

// NewBar returns a bar: its value and its tooltip's first line.
func NewBar(key, title string, value float64) Bar {
	return Bar{Key: key, Title: title, Value: value}
}

// WithStatus returns b coloured by a status.
func (b Bar) WithStatus(s Status) Bar { b.Status, b.Series = s, 0; return b }

// WithSeries returns b in the chart palette's colour n (1..MaxBarSeries).
func (b Bar) WithSeries(n int) Bar { b.Series, b.Status = n, StatusNone; return b }

// WithMeta returns b with its tooltip's second line.
func (b Bar) WithMeta(in *Inline) Bar { b.Meta = in; return b }

// WithAction returns b acting on a click or Enter.
func (b Bar) WithAction(a *Action) Bar { b.Action = a; return b }

// stats checks a stats node: MinStatCards..MaxStatCards cards, each with a key, a label,
// a value, a tone, a subtitle and an action, pressed only with an action.
func (c *checker) stats(path string, s *Stats) {
	if n := len(s.Cards); n < MinStatCards || n > MaxStatCards {
		c.bad(path+".cards", "%d cards, want %d to %d", n, MinStatCards, MaxStatCards)
	}
	for i, card := range s.Cards {
		p := fmt.Sprintf("%s.cards[%d]", path, i)
		c.key(p, card.Key)
		c.required(p+".label", card.Label)
		c.str(p+".label", card.Label, MaxStatLabel)
		c.required(p+".value", card.Value)
		c.str(p+".value", card.Value, MaxStatValue)
		if strings.ContainsAny(card.Value, "\n\r") {
			c.bad(p+".value", "one line")
		}
		c.tone(p+".tone", card.Tone)
		c.inline(p+".subtitle", card.Subtitle, MaxLabel)
		c.action(p+".action", card.Action)
		if card.Pressed && card.Action == nil {
			c.bad(p+".pressed", "a card is pressed only when it has an action (it is a toggle)")
		}
	}
}

// bars checks a bar chart: its title, subtitle and axis labels, its reference, and at most
// MaxBars bars, each with a key, a finite value of at least 0, a status or a series, a
// title, a meta line and an action.
func (c *checker) bars(path string, b *Bars) {
	c.str(path+".title", b.Title, MaxSectionTitle)
	c.inline(path+".subtitle", b.Subtitle, MaxLabel)
	c.str(path+".startLabel", b.StartLabel, MaxAxisLabel)
	c.str(path+".endLabel", b.EndLabel, MaxAxisLabel)
	if r := b.Reference; r != nil {
		c.barValue(path+".reference.value", r.Value)
		c.str(path+".reference.label", r.Label, MaxAxisLabel)
	}
	if n := len(b.Bars); n > MaxBars {
		c.bad(path+".bars", "%d bars, at most %d", n, MaxBars)
	}
	for i, bar := range b.Bars {
		p := fmt.Sprintf("%s.bars[%d]", path, i)
		c.key(p, bar.Key)
		c.barValue(p+".value", bar.Value)
		c.status(p+".status", bar.Status)
		if bar.Series < 0 || bar.Series > MaxBarSeries {
			c.bad(p+".series", "%d is outside 1..%d (0 is 1)", bar.Series, MaxBarSeries)
		}
		if bar.Status != StatusNone && bar.Series != 0 {
			c.bad(p, "a bar is coloured by a status or a series, not both")
		}
		c.required(p+".title", bar.Title)
		c.str(p+".title", bar.Title, MaxLabel)
		c.inline(p+".meta", bar.Meta, MaxLabel)
		c.action(p+".action", bar.Action)
	}
}

// barValue checks a bar's or a reference's value: finite and at least 0.
func (c *checker) barValue(path string, v float64) {
	switch {
	case math.IsNaN(v) || math.IsInf(v, 0):
		c.bad(path, "%g is not a finite number", v)
	case v < 0:
		c.bad(path, "%g is negative", v)
	}
}
