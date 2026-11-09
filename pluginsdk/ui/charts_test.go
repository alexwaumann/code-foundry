package ui

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"testing"
)

// chartsSeed has a stats row of every tone (a pressed toggle, a command card, a subtitle
// with a duration) and a bar chart with every status, a series, a reference and axis
// labels, one inside a card section and one in a grid item.
const chartsSeed = `{"nodes":[
  {"key":"st","stats":{"cards":[
    {"key":"st-pass","label":"Pass rate","value":"86%","tone":"ok","subtitle":"last 30"},
    {"key":"st-med","label":"Median","value":"4m 12s","subtitle":{"spans":[{"text":"p90 "},{"duration":{"ms":361000}}]}},
    {"key":"st-fail","label":"Failing","value":"2","tone":"error","subtitle":"integration","pressed":true,"action":{"event":"filter","data":"failed"}},
    {"key":"st-q","label":"Queue","value":"1","tone":"attention","action":{"command":{"name":"thread.send","args":{"text":"hi"}}}},
    {"key":"st-m","label":"Skipped","value":"0","tone":"muted"}]}},
  {"key":"sec","section":{"card":true,"title":"Builds","children":[
    {"key":"bt","bars":{"title":"Build time","subtitle":"last 6 builds","startLabel":"#1","endLabel":"#6",
      "reference":{"value":252,"label":"median 4m 12s"},
      "bars":[
        {"key":"b1","value":240,"status":"ok","title":"#1 · 4m 00s","meta":"main"},
        {"key":"b2","value":361,"status":"failed","title":"#2 · 6m 01s","meta":{"spans":[{"text":"main · "},{"time":{"at":"2026-11-08T09:00:00Z"}}]},"action":{"event":"open","data":"2"}},
        {"key":"b3","value":0,"status":"off","title":"#3 · aborted"},
        {"key":"b4","value":250.5,"series":3,"title":"#4"},
        {"key":"b5","value":12,"status":"attention","title":"#5","action":{"openUrl":"https://example.com/5"}},
        {"key":"b6","value":130,"status":"running","title":"#6 · running"}]}}]}},
  {"key":"g","grid":{"items":[{"key":"g1","children":[{"key":"bt2","bars":{"bars":[]}}]}]}}]}`

// Every validation branch of stats and bars (docs/notes/plugin-stats-bars.md).
func TestValidateStatsAndBars(t *testing.T) {
	cards := func(n int) []StatCard {
		out := make([]StatCard, n)
		for i := range out {
			out[i] = NewStat("c"+strconv.Itoa(i), "Label", "1")
		}
		return out
	}
	bars := func(n int) []Bar {
		out := make([]Bar, n)
		for i := range out {
			out[i] = NewBar("b"+strconv.Itoa(i), "#"+strconv.Itoa(i), float64(i))
		}
		return out
	}
	stats := func(cs ...StatCard) Node { return NewStats("st", cs...) }
	chart := func(b Bars) Node { return Node{Key: "ch", Bars: &b} }
	one := func(b Bar) Node { return NewBars("ch", "Build time", b) }
	ev := EventAction("filter", "failed")
	tests := []struct {
		name string
		node Node
		want string // "" = valid
	}{
		// stats
		{"one card", stats(NewStat("a", "Pass rate", "86%")), ""},
		{"most cards", stats(cards(MaxStatCards)...), ""},
		{"no cards", stats(), "nodes[0].stats.cards: 0 cards, want 1 to 6"},
		{"too many cards", stats(cards(MaxStatCards + 1)...), "nodes[0].stats.cards: 7 cards, want 1 to 6"},
		{"every tone", stats(NewStat("a", "A", "1").WithTone(ToneOK), NewStat("b", "B", "1").WithTone(ToneAttention),
			NewStat("c", "C", "1").WithTone(ToneError), NewStat("d", "D", "1").WithTone(ToneMuted), NewStat("e", "E", "1").WithTone("neutral")), ""},
		{"unknown tone", stats(NewStat("a", "A", "1").WithTone("warning")), `nodes[0].stats.cards[0].tone: unknown tone "warning"`},
		{"no label", stats(NewStat("a", " ", "1")), "nodes[0].stats.cards[0].label: required"},
		{"label at the limit", stats(NewStat("a", strings.Repeat("x", MaxStatLabel), "1")), ""},
		{"label too long", stats(NewStat("a", strings.Repeat("x", MaxStatLabel+1), "1")), "nodes[0].stats.cards[0].label: 41 characters, at most 40"},
		{"no value", stats(NewStat("a", "A", "")), "nodes[0].stats.cards[0].value: required"},
		{"value at the limit", stats(NewStat("a", "A", strings.Repeat("9", MaxStatValue))), ""},
		{"value too long", stats(NewStat("a", "A", strings.Repeat("9", MaxStatValue+1))), "nodes[0].stats.cards[0].value: 25 characters, at most 24"},
		{"value of two lines", stats(NewStat("a", "A", "4m\n12s")), "nodes[0].stats.cards[0].value: one line"},
		{"subtitle", stats(NewStat("a", "A", "1").WithSubtitle(Spans(T("p90 "), T("6m").AsMono()))), ""},
		{"subtitle too long", stats(NewStat("a", "A", "1").WithSubtitle(Plain(strings.Repeat("x", MaxLabel+1)))), "nodes[0].stats.cards[0].subtitle.text: 201 characters"},
		{"a toggle", stats(NewStat("a", "A", "1").WithAction(ev).AsPressed(), NewStat("b", "B", "2").WithAction(EventAction("filter", "ok"))), ""},
		{"a link card", stats(NewStat("a", "A", "1").WithAction(URLAction("https://example.com"))), ""},
		{"pressed without an action", stats(NewStat("a", "A", "1").AsPressed()), "nodes[0].stats.cards[0].pressed: a card is pressed only when it has an action"},
		{"bad action", stats(NewStat("a", "A", "1").WithAction(&Action{})), "nodes[0].stats.cards[0].action: an action is exactly one of"},
		{"bad card key", stats(NewStat("a b", "A", "1")), `nodes[0].stats.cards[0].key: "a b" must match`},
		{"card key used by the node", stats(NewStat("st", "A", "1")), `nodes[0].stats.cards[0].key: "st" is already used by nodes[0]`},
		{"duplicate card keys", stats(NewStat("a", "A", "1"), NewStat("a", "B", "1")), `nodes[0].stats.cards[1].key: "a" is already used by nodes[0].stats.cards[0]`},
		{"stats in a section", NewSection("s", "S", stats(cards(3)...)), ""},
		// bars
		{"no bars", NewBars("ch", "Build time"), ""},
		{"bare chart", chart(Bars{Bars: bars(3)}), ""},
		{"most bars", chart(Bars{Bars: bars(MaxBars)}), ""},
		{"too many bars", chart(Bars{Bars: bars(MaxBars + 1)}), "nodes[0].bars.bars: 121 bars, at most 120"},
		{"title too long", chart(Bars{Title: strings.Repeat("x", MaxSectionTitle+1)}), "nodes[0].bars.title: 61 characters, at most 60"},
		{"subtitle too long", chart(Bars{Subtitle: Plain(strings.Repeat("x", MaxLabel+1))}), "nodes[0].bars.subtitle.text: 201 characters"},
		{"axis labels", chart(Bars{StartLabel: "#1259", EndLabel: "#1288", Bars: bars(2)}), ""},
		{"start label too long", chart(Bars{StartLabel: strings.Repeat("x", MaxAxisLabel+1)}), "nodes[0].bars.startLabel: 41 characters, at most 40"},
		{"end label too long", chart(Bars{EndLabel: strings.Repeat("x", MaxAxisLabel+1)}), "nodes[0].bars.endLabel: 41 characters, at most 40"},
		{"reference", chart(Bars{Reference: &BarsReference{Value: 252, Label: "median 4m 12s"}, Bars: bars(2)}), ""},
		{"reference at zero", chart(Bars{Reference: &BarsReference{}}), ""},
		{"negative reference", chart(Bars{Reference: &BarsReference{Value: -1}}), "nodes[0].bars.reference.value: -1 is negative"},
		{"infinite reference", chart(Bars{Reference: &BarsReference{Value: math.Inf(1)}}), "nodes[0].bars.reference.value: +Inf is not a finite number"},
		{"reference label too long", chart(Bars{Reference: &BarsReference{Label: strings.Repeat("x", MaxAxisLabel+1)}}), "nodes[0].bars.reference.label: 41 characters"},
		{"zero value", one(NewBar("b", "#1", 0)), ""},
		{"fractional value", one(NewBar("b", "#1", 0.25)), ""},
		{"negative value", one(NewBar("b", "#1", -0.5)), "nodes[0].bars.bars[0].value: -0.5 is negative"},
		{"NaN value", one(NewBar("b", "#1", math.NaN())), "nodes[0].bars.bars[0].value: NaN is not a finite number"},
		{"infinite value", one(NewBar("b", "#1", math.Inf(-1))), "nodes[0].bars.bars[0].value: -Inf is not a finite number"},
		{"every status", chart(Bars{Bars: []Bar{NewBar("a", "a", 1).WithStatus(StatusOK), NewBar("b", "b", 1).WithStatus(StatusFailed),
			NewBar("c", "c", 1).WithStatus(StatusAttention), NewBar("d", "d", 1).WithStatus(StatusRunning), NewBar("e", "e", 1).WithStatus(StatusPending),
			NewBar("f", "f", 1).WithStatus(StatusSkipped), NewBar("g", "g", 1).WithStatus(StatusOff)}}), ""},
		{"unknown status", one(NewBar("b", "#1", 1).WithStatus("passed")), `nodes[0].bars.bars[0].status: unknown status "passed"`},
		{"every series", chart(Bars{Bars: []Bar{NewBar("a", "a", 1).WithSeries(1), NewBar("b", "b", 1).WithSeries(MaxBarSeries)}}), ""},
		{"series too big", one(NewBar("b", "#1", 1).WithSeries(MaxBarSeries + 1)), "nodes[0].bars.bars[0].series: 6 is outside 1..5 (0 is 1)"},
		{"negative series", one(NewBar("b", "#1", 1).WithSeries(-1)), "nodes[0].bars.bars[0].series: -1 is outside 1..5"},
		{"status and series", one(Bar{Key: "b", Title: "#1", Status: StatusOK, Series: 2}), "nodes[0].bars.bars[0]: a bar is coloured by a status or a series, not both"},
		{"no title", one(NewBar("b", "", 1)), "nodes[0].bars.bars[0].title: required"},
		{"title too long", one(NewBar("b", strings.Repeat("x", MaxLabel+1), 1)), "nodes[0].bars.bars[0].title: 201 characters"},
		{"meta", one(NewBar("b", "#1", 1).WithMeta(Spans(T("main · "), For(90e9)))), ""},
		{"meta too long", one(NewBar("b", "#1", 1).WithMeta(Plain(strings.Repeat("x", MaxLabel+1)))), "nodes[0].bars.bars[0].meta.text: 201 characters"},
		{"actions", chart(Bars{Bars: []Bar{NewBar("a", "a", 1).WithAction(EventAction("open", "1")), NewBar("b", "b", 1).WithAction(CopyAction("x"))}}), ""},
		{"bad action", one(NewBar("b", "#1", 1).WithAction(&Action{Data: "x"})), "nodes[0].bars.bars[0].action: an action is exactly one of"},
		{"bad bar key", one(NewBar("", "#1", 1)), `nodes[0].bars.bars[0].key: "" must match`},
		{"duplicate bar keys", chart(Bars{Bars: []Bar{NewBar("a", "a", 1), NewBar("a", "b", 1)}}), `nodes[0].bars.bars[1].key: "a" is already used by nodes[0].bars.bars[0]`},
		{"bars in a grid item", NewGrid("grid", NewGridItem("gi", NewBars("ch", "T", bars(4)...))), ""},
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
}

// Stats and bars are body nodes: not in a toolbar, a footer or a group.
func TestStatsAndBarsStayInTheBody(t *testing.T) {
	st := NewStats("st", NewStat("a", "A", "1"))
	ch := NewBars("ch", "T", NewBar("b", "#1", 1))
	for _, tt := range []struct {
		name string
		v    View
		want string
	}{
		{"stats in the toolbar", View{Toolbar: []Node{st}}, "toolbar[0]: a stats node cannot be in the toolbar"},
		{"bars in the footer", View{Footer: []Node{ch}}, "footer[0]: a bars node cannot be in the footer"},
		{"stats in a group", View{Nodes: []Node{NewGroup("g", AlignStart, st)}}, "a group holds text, chips, actions, progress nodes, not stats"},
		{"bars in a group", View{Nodes: []Node{NewGroup("g", AlignStart, ch)}}, "a group holds text, chips, actions, progress nodes, not bars"},
	} {
		if err := tt.v.Validate(); err == nil || !strings.Contains(err.Error(), tt.want) {
			t.Errorf("%s: %v, want %q", tt.name, err, tt.want)
		}
	}
}

// Cards and bars count as elements: 120 bars and 6 cards are 128 with their nodes.
func TestStatsAndBarsCountAsElements(t *testing.T) {
	b := make([]Bar, MaxBars)
	for i := range b {
		b[i] = NewBar("b"+strconv.Itoa(i), "x", 1)
	}
	c := make([]StatCard, MaxStatCards)
	for i := range c {
		c[i] = NewStat("c"+strconv.Itoa(i), "x", "1")
	}
	chips := func(n int) []Node {
		out := make([]Node, n)
		for i := range out {
			out[i] = NewChips("ch" + strconv.Itoa(i))
		}
		return out
	}
	base := []Node{NewBars("bars", "T", b...), NewStats("stats", c...)}
	if err := (View{Nodes: append(base, chips(MaxElements-128)...)}).Validate(); err != nil {
		t.Fatalf("at the limit: %v", err)
	}
	err := (View{Nodes: append(base, chips(MaxElements-127)...)}).Validate()
	if err == nil || !strings.Contains(err.Error(), "view: 401 elements, at most 400") {
		t.Fatalf("over the limit: %v", err)
	}
}

// The builders make what the JSON says, and the JSON round-trips.
func TestStatsAndBarsBuilders(t *testing.T) {
	v := View{Nodes: []Node{
		NewStats("st",
			NewStat("pass", "Pass rate", "86%").WithTone(ToneOK).WithSubtitle(Plain("last 30")),
			NewStat("fail", "Failing", "2").WithTone(ToneError).WithAction(EventAction("filter", "failed")).AsPressed()),
		func() Node {
			n := NewBars("bt", "Build time",
				NewBar("b1", "#1 · 4m 00s", 240).WithStatus(StatusOK).WithMeta(Plain("main")),
				NewBar("b2", "#2", 130).WithSeries(2).WithStatus(StatusRunning).WithAction(EventAction("open", "2")))
			n.Bars.Reference = &BarsReference{Value: 252, Label: "median 4m 12s"}
			n.Bars.StartLabel, n.Bars.EndLabel = "#1", "#2"
			return n
		}(),
	}}
	if err := v.Validate(); err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"nodes":[{"key":"st","stats":{"cards":[` +
		`{"key":"pass","label":"Pass rate","value":"86%","tone":"ok","subtitle":"last 30"},` +
		`{"key":"fail","label":"Failing","value":"2","tone":"error","action":{"event":"filter","data":"failed"},"pressed":true}]}},` +
		`{"key":"bt","bars":{"title":"Build time","bars":[` +
		`{"key":"b1","value":240,"status":"ok","title":"#1 · 4m 00s","meta":"main"},` +
		`{"key":"b2","value":130,"status":"running","title":"#2","action":{"event":"open","data":"2"}}],` +
		`"reference":{"value":252,"label":"median 4m 12s"},"startLabel":"#1","endLabel":"#2"}}]}`
	if string(b) != want {
		t.Fatalf("JSON\n got %s\nwant %s", b, want)
	}
	var back View
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	if b2, _ := json.Marshal(back); string(b2) != want {
		t.Fatalf("round trip\n got %s\nwant %s", b2, want)
	}
}
