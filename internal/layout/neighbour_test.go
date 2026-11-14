package layout

import (
	"bytes"
	"encoding/json"
	"math/rand/v2"
	"os"
	"strconv"
	"strings"
	"testing"
)

func TestNeighbour(t *testing.T) {
	pane := func(id string, tabs ...string) *Node {
		n := &Node{T: NodePane, ID: id}
		for _, tb := range tabs {
			n.Tabs = append(n.Tabs, &Tab{ID: tb, Kind: "prs"})
		}
		n.Active = tabs[0]
		return n
	}
	// a | (b over c) | d
	root := &Node{T: NodeSplit, ID: "s-r", Dir: Row, Sizes: []float64{0.3, 0.4, 0.3}, Kids: []*Node{
		pane("p-a", "t-a"),
		{T: NodeSplit, ID: "s-c", Dir: Col, Sizes: []float64{0.6, 0.4}, Kids: []*Node{pane("p-b", "t-b"), pane("p-c", "t-c", "t-c2")}},
		pane("p-d", "t-d"),
	}}
	L := Rects(root, 1200, 800)
	tests := []struct {
		name, pane string
		side       Edge
		mru        []string
		want       string
	}{
		{"right of a, no history: the longest shared edge", "p-a", Right, nil, "p-b"},
		{"right of a, c focused last (by a tab that is not active)", "p-a", Right, []string{"t-c2", "t-b"}, "p-c"},
		{"right of a, b focused last", "p-a", Right, []string{"t-b", "t-c"}, "p-b"},
		{"below b", "p-b", Bottom, nil, "p-c"},
		{"above c", "p-c", Top, nil, "p-b"},
		{"left of d", "p-d", Left, []string{"t-c"}, "p-c"},
		{"nothing left of a", "p-a", Left, nil, ""},
		{"nothing above a", "p-a", Top, nil, ""},
		{"an unknown pane", "p-x", Right, nil, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := L.Neighbour(root, tt.pane, tt.side, tt.mru); got != tt.want {
				t.Errorf("Neighbour(%s, %s) = %q, want %q", tt.pane, tt.side, got, tt.want)
			}
		})
	}
}

func TestWithArea(t *testing.T) {
	for _, name := range OpNames() {
		op, _ := NewOp(name)
		WithArea(op, 900, 600)
		if !Measures(op) {
			continue
		}
		raw, err := EncodeOp(op)
		if err != nil {
			t.Fatal(err)
		}
		back, err := DecodeOp(raw)
		if err != nil {
			t.Fatal(err)
		}
		// A second area does not replace the one the op names.
		WithArea(back, 1, 1)
		again, _ := EncodeOp(back)
		if string(again) != string(raw) || !strings.Contains(string(raw), `"w":900,"h":600`) {
			t.Errorf("%s: %s then %s", name, raw, again)
		}
	}
	for _, name := range []string{"open_surface", "open_thread", "close_thread", "move_thread", "snooze_thread", "close_pane", "move_tab", "move_pane"} {
		op, _ := NewOp(name)
		if !Measures(op) {
			t.Errorf("%s does not take the pane area", name)
		}
	}
}

// TestNeighbourTies: of panes touching as much and none focused, the upper (left and right) or
// the left (top and bottom) wins, whatever their ids; the GUI's rule is the same.
func TestNeighbourTies(t *testing.T) {
	p := func(id string) *Node {
		return &Node{T: NodePane, ID: id, Tabs: []*Tab{{ID: "t" + id, Kind: "prs"}}, Active: "t" + id}
	}
	// (z over y) | x, and x over (w | v)
	tall := &Node{T: NodeSplit, ID: "s-r", Dir: Row, Sizes: []float64{0.5, 0.5}, Kids: []*Node{
		{T: NodeSplit, ID: "s-c", Dir: Col, Sizes: []float64{0.5, 0.5}, Kids: []*Node{p("p-z"), p("p-y")}},
		p("p-x"),
	}}
	if got := Rects(tall, 1000, 600).Neighbour(tall, "p-x", Left, nil); got != "p-z" {
		t.Errorf("left of x = %q, want the upper p-z", got)
	}
	wide := &Node{T: NodeSplit, ID: "s-c", Dir: Col, Sizes: []float64{0.5, 0.5}, Kids: []*Node{
		p("p-x"),
		{T: NodeSplit, ID: "s-r", Dir: Row, Sizes: []float64{0.5, 0.5}, Kids: []*Node{p("p-w"), p("p-v")}},
	}}
	if got := Rects(wide, 1000, 600).Neighbour(wide, "p-x", Bottom, nil); got != "p-w" {
		t.Errorf("below x = %q, want the left p-w", got)
	}
}

// neighbourCase is one entry of testdata/neighbour.json: a tree laid out plainly, a space's MRU,
// and every pane's Neighbour on each side. The GUI's neighbour reads the same file
// (gui/frontend/src/shell/geometry/neighbours.test.ts), so the two rules agree.
type neighbourCase struct {
	Root *Node                      `json:"root"`
	W    float64                    `json:"w"`
	H    float64                    `json:"h"`
	MRU  []string                   `json:"mru"`
	Want map[string]map[Edge]string `json:"want"`
}

// neighbourCases are random trees of 3 to 9 panes (several tabs a pane, so a pane's recency is its most
// recent tab's) with a random MRU, generated from a fixed seed. The last ten have panes the user
// collapsed (laid out as rails by Rects, docs/notes/shell-25d-collapse.md).
func neighbourCases() []*neighbourCase {
	r := rand.New(rand.NewPCG(13, 17))
	var out []*neighbourCase
	for len(out) < 40 {
		n := 0
		root := randomTree(r, 0, &n, Dir(""))
		if n < 3 || n > 9 {
			continue
		}
		var tabs []string
		for _, p := range Panes(root) {
			for k := range r.IntN(3) {
				p.Tabs = append(p.Tabs, &Tab{ID: p.ID + "-" + strconv.Itoa(k), Kind: "prs"})
			}
			for _, tb := range p.Tabs {
				tabs = append(tabs, tb.ID)
			}
		}
		r.Shuffle(len(tabs), func(i, j int) { tabs[i], tabs[j] = tabs[j], tabs[i] })
		c := &neighbourCase{Root: root, W: float64(n*60 + 400 + r.IntN(1600)), H: float64(n*60 + 300 + r.IntN(900)), MRU: tabs[:r.IntN(len(tabs)+1)]}
		if len(out) >= 30 {
			collapseSome(r, root)
		}
		l := Rects(root, c.W, c.H)
		c.Want = map[string]map[Edge]string{}
		for _, id := range PaneIDs(root) {
			for _, side := range sides {
				if got := l.Neighbour(root, id, side, c.MRU); got != "" {
					if c.Want[id] == nil {
						c.Want[id] = map[Edge]string{}
					}
					c.Want[id][side] = got
				}
			}
		}
		out = append(out, c)
	}
	return out
}

// collapseSome collapses one to all but one of the tree's panes, at random.
func collapseSome(r *rand.Rand, root *Node) {
	panes := Panes(root)
	r.Shuffle(len(panes), func(i, j int) { panes[i], panes[j] = panes[j], panes[i] })
	for _, p := range panes[:1+r.IntN(len(panes)-1)] {
		p.Collapsed = true
	}
}

func TestNeighbourCases(t *testing.T) {
	// One case a line: the file is generated, never edited by hand.
	got := []byte("[\n")
	for i, c := range neighbourCases() {
		b, err := json.Marshal(c)
		if err != nil {
			t.Fatal(err)
		}
		if i > 0 {
			got = append(got, ",\n"...)
		}
		got = append(got, b...)
	}
	got = append(got, "\n]\n"...)
	if *update {
		if err := os.WriteFile("testdata/neighbour.json", got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile("testdata/neighbour.json")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Error("testdata/neighbour.json is not what Neighbour gives: go test ./internal/layout -run TestNeighbourCases -update")
	}
}
