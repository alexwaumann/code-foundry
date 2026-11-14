package layout

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"os"
	"testing"
)

func TestPaneMinimum(t *testing.T) {
	term := &Tab{ID: "t-t", Kind: "terminal"}
	tests := []struct {
		name string
		tabs []*Tab
		want Size
	}{
		{"a thread", []*Tab{{ID: "t-a", Kind: "thread", Thread: "th-a"}}, Size{480, 400}},
		{"a diff", []*Tab{{ID: "t-d", Kind: "diff"}}, Size{480, 400}},
		{"a page", []*Tab{{ID: "t-p", Kind: "prs"}}, Size{480, 400}},
		{"one terminal", []*Tab{term}, Size{300, 220}},
		{"two terminals", []*Tab{term, {ID: "t-u", Kind: "terminal"}}, Size{300, 220}},
		{"a terminal and a file: the file decides, active or not", []*Tab{term, {ID: "t-f", Kind: "file"}}, Size{480, 400}},
		{"no tabs", nil, Size{480, 400}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := &Node{T: NodePane, ID: "p-a", Tabs: tc.tabs}
			if len(tc.tabs) > 0 {
				p.Active = tc.tabs[0].ID
			}
			if got := PaneMinimum(p); got != tc.want {
				t.Errorf("PaneMinimum = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestFits(t *testing.T) {
	pane := func(id, kind string) *Node {
		return &Node{T: NodePane, ID: id, Tabs: []*Tab{{ID: "t" + id, Kind: kind}}, Active: "t" + id}
	}
	collapsed := func(n *Node) *Node { n.Collapsed = true; return n }
	split := func(dir Dir, kids ...*Node) *Node {
		sizes := make([]float64, len(kids))
		for i := range sizes {
			sizes[i] = 1 / float64(len(kids))
		}
		return &Node{T: NodeSplit, ID: "s-" + string(dir), Dir: dir, Kids: kids, Sizes: sizes}
	}
	tests := []struct {
		name string
		root *Node
		w, h float64
		min  Size
		fits bool
	}{
		{"nothing", nil, 10, 10, Size{}, true},
		{"one pane always fits, however small the area", pane("p-a", "thread"), 100, 100, Size{480, 400}, true},
		{"two in a row, exactly", split(Row, pane("p-a", "thread"), pane("p-b", "diff")), 972, 400, Size{972, 400}, true},
		{"two in a row, a px short", split(Row, pane("p-a", "thread"), pane("p-b", "diff")), 971, 400, Size{972, 400}, false},
		{"two in a row, too short", split(Row, pane("p-a", "thread"), pane("p-b", "diff")), 2000, 399, Size{972, 400}, false},
		{"a terminal beside a thread", split(Row, pane("p-a", "thread"), pane("p-b", "terminal")), 792, 400, Size{792, 400}, true},
		{"a column of a thread and a terminal", split(Col, pane("p-a", "thread"), pane("p-b", "terminal")), 480, 632, Size{480, 632}, true},
		{"a collapsed pane is a 36px rail", split(Row, pane("p-a", "thread"), collapsed(pane("p-b", "diff")), pane("p-c", "diff")), 1020, 400, Size{1020, 400}, true},
		{"three open in a row do not fit 1440 less the sidebar", split(Row, pane("p-a", "thread"), pane("p-b", "diff"), pane("p-c", "prs")), 1440 - 233 - 24, 832, Size{1464, 400}, false},
		{"nested: a row beside a column", split(Row, pane("p-a", "thread"), split(Col, pane("p-b", "diff"), pane("p-c", "terminal"))), 972, 632, Size{972, 632}, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := MinimumOf(tc.root); got != tc.min {
				t.Errorf("MinimumOf = %v, want %v", got, tc.min)
			}
			if got := Fits(tc.root, tc.w, tc.h); got != tc.fits {
				t.Errorf("Fits(%v x %v) = %v, want %v", tc.w, tc.h, got, tc.fits)
			}
		})
	}
}

func TestCanTake(t *testing.T) {
	thread := &Node{T: NodePane, ID: "p-a", Tabs: []*Tab{{ID: "t-a", Kind: "thread", Thread: "th-a"}}, Active: "t-a"}
	terms := &Node{T: NodePane, ID: "p-b", Tabs: []*Tab{{ID: "t-t", Kind: "terminal"}}, Active: "t-t"}
	sp := &Space{ID: "sp-a", Root: &Node{T: NodeSplit, ID: "s-r", Dir: Row, Kids: []*Node{thread, terms}, Sizes: []float64{0.6, 0.4}}}
	file := &Tab{ID: "t-f", Kind: "file"}
	term := &Tab{ID: "t-u", Kind: "terminal"}
	tests := []struct {
		name      string
		pane      *Node
		w         float64
		tab       *Tab
		collapsed bool
		want      bool
	}{
		{"a terminal joins terminals: the minimum stays", terms, 792, term, false, true},
		{"a file joins terminals with room", terms, 972, file, false, true},
		{"a file joins terminals without room", terms, 971, file, false, false},
		{"a collapsed pane of terminals takes anything", terms, 700, file, true, true},
		{"a pane that is not all terminals takes anything", thread, 700, file, false, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			tc.pane.Collapsed = tc.collapsed
			defer func() { tc.pane.Collapsed = false }()
			before := len(tc.pane.Tabs)
			if got := canTake(sp, tc.pane, tc.w, 900, tc.tab); got != tc.want {
				t.Errorf("canTake = %v, want %v", got, tc.want)
			}
			if len(tc.pane.Tabs) != before {
				t.Error("canTake changed the pane")
			}
		})
	}
}

// fitCase is one entry of testdata/fits.json: a tree with tabs of every kind the minimum tells
// apart and some panes collapsed, an area, the tree's minimum and whether it fits. The GUI's
// geometry reads it (gui/frontend/src/shell/geometry/fit.test.ts): its minimumOf and treeFits
// must give the same answers (docs/notes/shell-25f-sizes.md).
type fitCase struct {
	Root *Node   `json:"root"`
	W    float64 `json:"w"`
	H    float64 `json:"h"`
	Min  Size    `json:"min"`
	Fits bool    `json:"fits"`
}

func fitCases() []*fitCase {
	r := rand.New(rand.NewPCG(25, 6))
	var out []*fitCase
	for len(out) < 60 {
		n := 0
		root := randomTree(r, 0, &n, Dir(""))
		tabs := 0
		for _, p := range Panes(root) {
			p.Tabs = nil
			for range 1 + r.IntN(3) {
				tabs++
				kind := []string{"terminal", "terminal", "thread", "diff", "file", "prs"}[r.IntN(6)]
				p.Tabs = append(p.Tabs, &Tab{ID: fmt.Sprintf("t-%d", tabs), Kind: kind})
			}
			p.Active = p.Tabs[r.IntN(len(p.Tabs))].ID
		}
		if n > 1 && r.IntN(3) == 0 {
			collapseSome(r, root)
		}
		m := MinimumOf(root)
		// Areas around the minimum, so both answers come up.
		w := float64(int(m.W) - 200 + r.IntN(400))
		h := float64(int(m.H) - 150 + r.IntN(300))
		out = append(out, &fitCase{Root: slim(root), W: w, H: h, Min: m, Fits: Fits(root, w, h)})
	}
	return out
}

// TestFitCases keeps testdata/fits.json what Fits gives (-update writes it).
func TestFitCases(t *testing.T) {
	got := []byte("[\n")
	fits := 0
	for i, c := range fitCases() {
		b, err := json.Marshal(c)
		if err != nil {
			t.Fatal(err)
		}
		if i > 0 {
			got = append(got, ",\n"...)
		}
		got = append(got, b...)
		if c.Fits {
			fits++
		}
	}
	got = append(got, "\n]\n"...)
	if fits < 10 || fits > 50 {
		t.Fatalf("%d of 60 fit: the fixture should hold both answers", fits)
	}
	if *update {
		if err := os.WriteFile("testdata/fits.json", got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile("testdata/fits.json")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Error("testdata/fits.json is not what Fits gives: go test ./internal/layout -run TestFitCases -update")
	}
}
