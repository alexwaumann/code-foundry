package layout

import (
	"fmt"
	"reflect"
	"testing"
)

// A stored reopen history is read back as it was; one written by hand or by a newer build
// keeps only what can be reopened, at most MaxClosed entries.
func TestReopenHistoryStoredAndSanitised(t *testing.T) {
	sp := &Space{ID: "sp-a", Name: "Main", Closed: []*Closed{
		{Pane: "p-a", Whole: true, Tabs: []*Tab{{ID: "t-f", Kind: "file", Params: map[string]string{"path": "/x"}}}, Active: "t-f",
			Beside: &Beside{Neighbours: []string{"p-b"}, Edge: Left, Frac: 0.3}},
	}}
	doc, err := EncodeSpaceDoc(sp)
	if err != nil {
		t.Fatal(err)
	}
	back, err := DecodeSpaceDoc("sp-a", "Main", doc)
	if err != nil || !reflect.DeepEqual(back.Closed, sp.Closed) {
		t.Fatalf("round trip %+v (%v)", back.Closed, err)
	}

	var many []*Closed
	for i := range MaxClosed + 3 {
		many = append(many, &Closed{Pane: "p-z", Tabs: []*Tab{{ID: fmt.Sprintf("t-%d", i), Kind: "prs"}}})
	}
	many = append([]*Closed{nil, {Pane: "p-y", Tabs: []*Tab{nil, {ID: "t-new", Kind: "newer.kind"}}}}, many...)
	st := &State{V: Version, Spaces: []*Space{{ID: "sp-a", Name: "Main", Closed: many}}, CurrentSpace: "sp-a", DefaultSpace: "sp-a"}
	if repairs := Sanitize(st, &SeqIDs{}); len(repairs) == 0 {
		t.Error("no repair noted")
	}
	h := st.Spaces[0].Closed
	if len(h) != MaxClosed || h[0].Tabs[0].ID != "t-0" {
		t.Errorf("history kept %d entries, first %v", len(h), h[0].Tabs[0])
	}
	if err := Check(st); err != nil {
		t.Error(err)
	}
}

// Entries come back newest first, and one names the pane another brings back: a tab closed
// from a pane, then that pane closed, reopen as the pane (with its other tab) and then the
// tab into it at its old place.
func TestReopenInTurn(t *testing.T) {
	file := func(id, path string) *Tab { return &Tab{ID: id, Kind: "file", Params: map[string]string{"path": path}} }
	st := &State{V: Version, CurrentSpace: "sp-a", DefaultSpace: "sp-a", Spaces: []*Space{{
		ID: "sp-a", Name: "Main", Focus: "p-b",
		Root: &Node{T: NodeSplit, ID: "s-r", Dir: Row, Sizes: []float64{0.6, 0.4}, Kids: []*Node{
			{T: NodePane, ID: "p-a", Tabs: []*Tab{{ID: "t-a", Kind: "prs"}}, Active: "t-a"},
			{T: NodePane, ID: "p-b", Tabs: []*Tab{file("t-f", "/x"), file("t-g", "/y")}, Active: "t-f"},
		}},
	}}}
	if repairs := Sanitize(st, &SeqIDs{}); len(repairs) > 0 {
		t.Fatal(repairs)
	}
	ids := &SeqIDs{}
	run := func(op Op) Result {
		t.Helper()
		next, res, err := Apply(st, op, ids)
		if err != nil {
			t.Fatal(err)
		}
		st = next
		return res
	}
	run(&CloseTab{Tab: "t-f", Record: true})
	run(&ClosePane{Pane: "p-b", Record: true})
	if got := PaneIDs(st.Spaces[0].Root); !reflect.DeepEqual(got, []string{"p-a"}) {
		t.Fatalf("panes %v", got)
	}
	if res := run(&ReopenClosed{}); res.Pane != "p-b" || res.Tab != "t-g" {
		t.Fatalf("first reopen %+v", res)
	}
	if res := run(&ReopenClosed{}); res.Pane != "p-b" || res.Tab != "t-f" {
		t.Fatalf("second reopen %+v", res)
	}
	_, p := st.FindPane("p-b")
	if p.Tabs[0].ID != "t-f" || p.Tabs[1].ID != "t-g" || st.Spaces[0].Root.Sizes[1] < 0.39 || st.Spaces[0].Root.Sizes[1] > 0.41 {
		t.Errorf("pane %+v, sizes %v", p.Tabs, st.Spaces[0].Root.Sizes)
	}
	if res := run(&ReopenClosed{}); res.Tab != "" || st.Spaces[0].Closed != nil {
		t.Errorf("nothing left: %+v, history %v", res, st.Spaces[0].Closed)
	}
}
