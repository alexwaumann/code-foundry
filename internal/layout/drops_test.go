package layout

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"os"
	"testing"
)

// dropCase is one entry of testdata/drops.json: a space's tree in a w x h pane area with its
// focus and MRU, and drags dropped on it, each with the state the daemon's op leaves. The GUI's
// drop preview reads the same file (gui/frontend/src/shell/drag/drop.test.ts): the rectangle it
// highlights must be the one the dropped tab's or pane's pane is drawn at after the op, rails and
// minimums included (docs/notes/shell-25b-audits.md).
type dropCase struct {
	Root  *Node      `json:"root"`
	W     float64    `json:"w"`
	H     float64    `json:"h"`
	Focus string     `json:"focus"`
	MRU   []string   `json:"mru"`
	Drops []dropTest `json:"drops"`
}

// dropTest is one drag: what is dragged and where it lands, in the GUI's terms (shell/drag
// targets.ts DragSource and DropTarget), and the space after the op the drop runs; or Refused
// when the op refuses it for want of room (fit.go): the GUI must not offer that target
// (docs/notes/shell-25f-sizes.md).
type dropTest struct {
	Source  dropSource `json:"source"`
	Target  dropTarget `json:"target"`
	After   *dropAfter `json:"after,omitempty"`
	Refused bool       `json:"refused,omitempty"`
}

type dropSource struct {
	Kind   string `json:"kind"`
	Tab    string `json:"tab,omitempty"`
	Pane   string `json:"pane,omitempty"`
	Thread string `json:"thread,omitempty"`
}

type dropTarget struct {
	Kind string `json:"kind"`
	Pane string `json:"pane,omitempty"`
	Edge Edge   `json:"edge,omitempty"`
}

type dropAfter struct {
	Root  *Node    `json:"root"`
	Focus string   `json:"focus"`
	MRU   []string `json:"mru"`
	// Pane is the pane that holds what was dropped (Result.Pane).
	Pane string `json:"pane"`
}

// dropTree is a random tree of 2 to 7 panes whose tabs are of every kind the minimums and the
// fold order tell apart: threads, their linked surfaces, free terminals and the two pages.
func dropTree(r *rand.Rand) *Node {
	for {
		n, tabs := 0, 0
		root := randomTree(r, 0, &n, Dir(""))
		if n < 2 || n > 7 {
			continue
		}
		pages := []string{"prs", "projects"}
		for _, p := range Panes(root) {
			p.Tabs = nil
			for range 1 + r.IntN(3) {
				tabs++
				id := fmt.Sprintf("t-%d", tabs)
				th := fmt.Sprintf("th-%d", r.IntN(4))
				var tb *Tab
				switch k := r.IntN(6); {
				case k == 0:
					tb = &Tab{ID: id, Kind: "thread", Thread: "th-" + id}
				case k == 1:
					tb = &Tab{ID: id, Kind: "terminal", Thread: th, Params: map[string]string{"terminal": "term-" + id}}
				case k == 2:
					tb = &Tab{ID: id, Kind: "file", Thread: th, Params: map[string]string{"path": id + ".go"}}
				case k == 3:
					tb = &Tab{ID: id, Kind: "terminal", Params: map[string]string{"terminal": "term-" + id}}
				case k == 4 && len(pages) > 0:
					tb = &Tab{ID: id, Kind: pages[0]}
					pages = pages[1:]
				default:
					tb = &Tab{ID: id, Kind: "file", Params: map[string]string{"path": id + ".md"}}
				}
				p.Tabs = append(p.Tabs, tb)
			}
			p.Active = p.Tabs[r.IntN(len(p.Tabs))].ID
		}
		return root
	}
}

// dropState is the one-space state of a case, decoded so its tabs have their keys.
func dropState(t *testing.T, c *dropCase) *State {
	t.Helper()
	b, err := json.Marshal(&State{V: Version, Spaces: []*Space{{ID: "sp-a", Name: "A", Root: c.Root, Focus: c.Focus, MRU: c.MRU}}, CurrentSpace: "sp-a", DefaultSpace: "sp-a"})
	if err != nil {
		t.Fatal(err)
	}
	st, repairs, err := Decode(b, &SeqIDs{})
	if err != nil || len(repairs) > 0 {
		t.Fatalf("case state: %v %v", err, repairs)
	}
	return st
}

// dropOp is the op the GUI's drop runs (shell/drag/drop.ts dropCommand, through tab.move and
// pane.move), or nil for a drop the GUI does not offer (targets.ts allowed).
func dropOp(c *dropCase, s dropSource, tg dropTarget, panes int, tabsIn func(string) int) Op {
	if s.Kind == "thread" {
		// A sidebar row's thread, not open in the space: one open_thread with the place
		// (shell/drag/threadDrop.ts).
		switch tg.Kind {
		case "outer":
			return &OpenThread{Thread: s.Thread, Edge: tg.Edge, Focus: true, W: c.W, H: c.H}
		case "edge":
			return &OpenThread{Thread: s.Thread, Pane: tg.Pane, Edge: tg.Edge, Focus: true, W: c.W, H: c.H}
		default:
			return &OpenThread{Thread: s.Thread, Pane: tg.Pane, Focus: true, W: c.W, H: c.H}
		}
	}
	if s.Kind == "pane" {
		switch {
		case tg.Kind == "outer" && panes > 1:
			return &MovePane{Pane: s.Pane, Edge: tg.Edge, W: c.W, H: c.H}
		case tg.Kind == "outer" || tg.Pane == s.Pane:
			return nil
		case tg.Kind == "edge":
			return &MovePane{Pane: s.Pane, Target: tg.Pane, Edge: tg.Edge, W: c.W, H: c.H}
		default:
			return &MergePane{Pane: s.Pane, Target: tg.Pane, W: c.W, H: c.H}
		}
	}
	own := tabsIn(s.Pane)
	switch {
	case tg.Kind == "outer":
		if panes == 1 && own == 1 {
			return nil
		}
		return &MoveTab{Tab: s.Tab, Edge: tg.Edge, W: c.W, H: c.H}
	case tg.Pane == s.Pane && (tg.Kind == "pane" || own == 1):
		return nil
	case tg.Kind == "edge":
		return &MoveTab{Tab: s.Tab, Pane: tg.Pane, Edge: tg.Edge, W: c.W, H: c.H}
	default:
		return &MoveTab{Tab: s.Tab, Pane: tg.Pane, W: c.W, H: c.H}
	}
}

// dropCases are random trees in areas from roomy to small enough to fold panes to rails, each
// with drags of every kind (a tab, a pane or a sidebar row's thread, onto a pane's middle, an edge or the outer edge),
// generated from a fixed seed. The last eight have panes the user collapsed, which the GUI
// offers only as a whole (a rail's middle) and whose rails are not dragged as panes.
func dropCases(t *testing.T) []*dropCase {
	r := rand.New(rand.NewPCG(21, 34))
	edges := []Edge{Left, Right, Top, Bottom}
	var out []*dropCase
	for len(out) < 26 {
		root := dropTree(r)
		if len(out) >= 18 {
			collapseSome(r, root)
		}
		ids := PaneIDs(root)
		var tabs []string
		for _, p := range Panes(root) {
			for _, tb := range p.Tabs {
				tabs = append(tabs, tb.ID)
			}
		}
		r.Shuffle(len(tabs), func(i, j int) { tabs[i], tabs[j] = tabs[j], tabs[i] })
		// Every third roomy, the rest small: rails fold in most, and many drops find no room.
		w, h := float64(700+r.IntN(900)), float64(450+r.IntN(600))
		if len(out)%3 == 0 {
			w, h = float64(1800+r.IntN(1200)), float64(1000+r.IntN(600))
		}
		c := &dropCase{Root: root, W: w, H: h, Focus: ids[r.IntN(len(ids))], MRU: tabs[:r.IntN(len(tabs)+1)]}
		st := dropState(t, c)
		c.Root = st.Spaces[0].Root
		tabsIn := func(id string) int {
			for _, p := range Panes(c.Root) {
				if p.ID == id {
					return len(p.Tabs)
				}
			}
			return 0
		}
		for len(c.Drops) < 6 {
			var s dropSource
			switch k := r.IntN(6); {
			case k == 0:
				s = dropSource{Kind: "thread", Thread: fmt.Sprintf("th-new-%d", len(c.Drops))}
			case k <= 2:
				s = dropSource{Kind: "pane", Pane: ids[r.IntN(len(ids))]}
			default:
				p := Panes(c.Root)[r.IntN(len(ids))]
				s = dropSource{Kind: "tab", Tab: p.Tabs[r.IntN(len(p.Tabs))].ID, Pane: p.ID}
			}
			var tg dropTarget
			switch r.IntN(3) {
			case 0:
				tg = dropTarget{Kind: "pane", Pane: ids[r.IntN(len(ids))]}
			case 1:
				tg = dropTarget{Kind: "edge", Pane: ids[r.IntN(len(ids))], Edge: edges[r.IntN(4)]}
			default:
				tg = dropTarget{Kind: "outer", Edge: edges[r.IntN(4)]}
			}
			if collapsedPane(c.Root, s.Pane) && s.Kind == "pane" || tg.Kind == "edge" && collapsedPane(c.Root, tg.Pane) {
				continue
			}
			op := dropOp(c, s, tg, len(ids), tabsIn)
			if op == nil {
				continue
			}
			next, res, err := Apply(st, op, &SeqIDs{})
			if IsNoRoom(err) {
				c.Drops = append(c.Drops, dropTest{Source: s, Target: tg, Refused: true})
				continue
			}
			if err != nil {
				t.Fatalf("%s %+v: %v", op.OpName(), op, err)
			}
			sp := next.Spaces[0]
			c.Drops = append(c.Drops, dropTest{Source: s, Target: tg, After: &dropAfter{Root: slim(sp.Root), Focus: sp.Focus, MRU: sp.MRU, Pane: res.Pane}})
		}
		c.Root = slim(c.Root)
		out = append(out, c)
	}
	return out
}

// collapsedPane reports whether the pane with that id under root is collapsed.
func collapsedPane(root *Node, id string) bool {
	for _, p := range Panes(root) {
		if p.ID == id {
			return p.Collapsed
		}
	}
	return false
}

// slim is a tree with only what the preview reads: tabs' ids, kinds and threads, and the
// collapsed mark.
func slim(n *Node) *Node {
	if n == nil {
		return nil
	}
	c := &Node{T: n.T, ID: n.ID, Dir: n.Dir, Sizes: n.Sizes, Active: n.Active, Collapsed: n.Collapsed}
	for _, tb := range n.Tabs {
		c.Tabs = append(c.Tabs, &Tab{ID: tb.ID, Kind: tb.Kind, Thread: tb.Thread})
	}
	for _, k := range n.Kids {
		c.Kids = append(c.Kids, slim(k))
	}
	return c
}

// TestDropCases keeps testdata/drops.json what the ops give (-update writes it).
func TestDropCases(t *testing.T) {
	got := []byte("[\n")
	for i, c := range dropCases(t) {
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
		if err := os.WriteFile("testdata/drops.json", got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile("testdata/drops.json")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Error("testdata/drops.json is not what the ops give: go test ./internal/layout -run TestDropCases -update")
	}
}
