package ui

import (
	"strings"
	"testing"
)

func TestHintsAndInputKinds(t *testing.T) {
	long := strings.Repeat("x", MaxLabel+1)
	live := TextField("f-q", "q", "Filter").WithChange("filter").AsLive()
	form := func(f Field) Node { return Node{Key: "form", Form: &Form{Fields: []Field{f}}} }
	row := func(g *Glyph) Node {
		return Node{Key: "list", List: &List{Rows: []Row{{Key: "r", Title: "t", Glyph: g}}}}
	}
	tests := []struct {
		name string
		view View
		want string // a problem Validate must name; "" when the view is fine
	}{
		{name: "a hint on every carrier", view: View{Nodes: []Node{
			NewActions("bar", EventButton("b", "Go", "go").WithHint("why")),
			{Key: "chips", Chips: &Chips{Chips: []Chip{{Key: "c", Label: "Build", Hint: "why"}}}},
			row(&Glyph{Status: StatusOK, Hint: "why"}),
			NewText("t", Spans(T("x").WithHint("why"))),
			{Key: "pairs", Pairs: &Pairs{Items: []Pair{{Key: "p", Label: "L", Pill: &Pill{Label: "ok", Hint: "why"}}}}},
		}}},
		{name: "a button's hint too long", view: View{Nodes: []Node{NewActions("bar", EventButton("b", "Go", "go").WithHint(long))}}, want: "buttons[0].hint"},
		{name: "a chip's hint too long", view: View{Nodes: []Node{{Key: "chips", Chips: &Chips{Chips: []Chip{{Key: "c", Label: "Build", Hint: long}}}}}}, want: "chips[0].hint"},
		{name: "a glyph's hint too long", view: View{Nodes: []Node{row(&Glyph{Status: StatusOK, Hint: long})}}, want: "glyph.hint"},
		{name: "a span's hint too long", view: View{Nodes: []Node{NewText("t", Spans(T("x").WithHint(long)))}}, want: "spans[0].hint"},
		{name: "a pill's hint too long", view: View{Header: &Header{Pill: &Pill{Label: "ok", Hint: long}}}, want: "pill.hint"},
		{name: "multiline with rows", view: View{Nodes: []Node{form(MultilineField("f", "n", "Notes", MaxInputRows))}}},
		{name: "multiline without rows", view: View{Nodes: []Node{form(MultilineField("f", "n", "Notes", 0))}}},
		{name: "too few rows", view: View{Nodes: []Node{form(MultilineField("f", "n", "Notes", MinInputRows-1))}}, want: ".rows"},
		{name: "too many rows", view: View{Nodes: []Node{form(MultilineField("f", "n", "Notes", MaxInputRows+1))}}, want: ".rows"},
		{name: "rows on a text input", view: View{Nodes: []Node{form(Field{Key: "f", Name: "n", Input: &Input{Rows: 4}})}}, want: "rows are for multiline"},
		{name: "a number", view: View{Nodes: []Node{form(NumberField("f", "n", "Port").WithValue("8080"))}}},
		{name: "an unknown kind", view: View{Nodes: []Node{form(Field{Key: "f", Name: "n", Input: &Input{Kind: "date"}})}}, want: "unknown kind"},
		{name: "live with a change event", view: View{Toolbar: []Node{form(live)}, Nodes: []Node{}}},
		{name: "live without one", view: View{Nodes: []Node{form(TextField("f", "n", "Q").AsLive())}}, want: "needs a change event"},
		{name: "multiline in a toolbar", view: View{Toolbar: []Node{form(MultilineField("f", "n", "Notes", 0))}, Nodes: []Node{}}, want: "one line, not multiline"},
		{name: "a number in a toolbar", view: View{Toolbar: []Node{form(NumberField("f", "n", "Port"))}, Nodes: []Node{}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.view.Nodes == nil {
				tt.view.Nodes = []Node{}
			}
			err := tt.view.Validate()
			switch {
			case tt.want == "" && err != nil:
				t.Fatalf("Validate() = %v, want nil", err)
			case tt.want != "" && (err == nil || !strings.Contains(err.Error(), tt.want)):
				t.Fatalf("Validate() = %v, want it to name %q", err, tt.want)
			}
		})
	}
}

func TestAsLiveLeavesOtherControlsAlone(t *testing.T) {
	if f := ToggleField("f", "n", "On", true).AsLive(); f.Input != nil {
		t.Errorf("AsLive on a toggle gave it an input: %+v", f)
	}
	base := TextField("f", "n", "Q")
	if live := base.AsLive(); !live.Input.Live || base.Input.Live {
		t.Errorf("AsLive must set the copy only: %+v, %+v", live.Input, base.Input)
	}
}
