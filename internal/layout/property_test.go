package layout

import (
	"errors"
	"maps"
	"math/rand/v2"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// seedState is the state every random op sequence starts from: two spaces, nested splits,
// threads, linked and unlinked tabs.
const seedState = `{"v":1,"spaces":[
 {"id":"sp-a","name":"Main","root":{"t":"split","id":"s-r","dir":"row","sizes":[0.55,0.45],"kids":[
   {"t":"split","id":"s-c","dir":"col","sizes":[0.62,0.38],"kids":[
     {"t":"pane","id":"p-a","tabs":[{"id":"t-a","kind":"thread","thread":"th-1"},{"id":"t-a2","kind":"thread","thread":"th-2"}],"active":"t-a"},
     {"t":"pane","id":"p-t","tabs":[{"id":"t-t","kind":"terminal","thread":"th-1","params":{"terminal":"term-1"}}],"active":"t-t"}]},
   {"t":"pane","id":"p-b","tabs":[{"id":"t-d","kind":"diff","thread":"th-1","params":{"project":"pj","worktree":"w"}},{"id":"t-f","kind":"file","thread":"th-1","params":{"path":"/a"}}],"active":"t-d"}]},
  "focus":"p-a","mru":["t-a","t-d"]},
 {"id":"sp-b","name":"Second","root":{"t":"pane","id":"p-c","tabs":[{"id":"t-b","kind":"thread","thread":"th-3"},{"id":"t-prs","kind":"prs"}],"active":"t-b"},"focus":"p-c"}],
 "current_space":"sp-a","default_space":"sp-a","threads":{"th-3":{"space":"sp-b"}}}`

// bytesrc turns fuzz input into choices; past its end every choice is 0.
type bytesrc struct {
	b []byte
	i int
}

func (s *bytesrc) n(k int) int {
	if k <= 0 || s.i >= len(s.b) {
		return 0
	}
	v := int(s.b[s.i])
	s.i++
	return v % k
}

func pick[T any](s *bytesrc, xs ...T) T { return xs[s.n(len(xs))] }

func (s *bytesrc) done() bool { return s.i >= len(s.b) }

// ids lists what an op could name in st, plus a few that name nothing.
func stateIDs(st *State) (spaces, panes, splits, tabs []string) {
	spaces, panes, splits, tabs = []string{"", "sp-zz"}, []string{"", "p-zz"}, []string{"s-zz"}, []string{"", "t-zz"}
	for _, sp := range st.Spaces {
		spaces = append(spaces, sp.ID)
		walk(sp.Root, func(n *Node) {
			if n.IsPane() {
				panes = append(panes, n.ID)
				for _, tb := range n.Tabs {
					tabs = append(tabs, tb.ID)
				}
			} else {
				splits = append(splits, n.ID)
			}
		})
	}
	return
}

func randomTab(s *bytesrc) *Tab {
	thread := pick(s, "", "th-1", "th-2", "th-3", "th-4")
	switch s.n(12) {
	case 11:
		return &Tab{Kind: "terminal", Thread: thread, Params: map[string]string{"terminal": pick(s, "term-1", "term-4", "term-5")}}
	case 0:
		return &Tab{Kind: "thread", Thread: pick(s, "th-1", "th-2", "th-3", "th-4", "")}
	case 1:
		return &Tab{Kind: "diff", Thread: thread, Params: map[string]string{"project": pick(s, "pj", "pk"), "worktree": "w"}}
	case 2:
		return &Tab{Kind: "file", Thread: thread, Params: map[string]string{"path": pick(s, "/a", "/b", "/c")}}
	case 3:
		return &Tab{Kind: "pullrequest", Thread: thread, Params: map[string]string{"slug": pick(s, "A/b", "a/B"), "number": pick(s, "1", "2", "x")}}
	case 4:
		return &Tab{Kind: "terminal", Thread: thread, Params: map[string]string{"terminal": pick(s, "term-1", "term-2", "term-3")}, Name: pick(s, "", "dev")}
	case 5:
		return &Tab{Kind: pick(s, "prs", "projects"), Thread: pick(s, "", "", "th-1")}
	case 6:
		return &Tab{Kind: "compose", Params: map[string]string{"project": pick(s, "", "pj")}}
	case 7:
		return &Tab{Kind: pick(s, "mcp", "ember.board"), Thread: thread}
	case 8:
		return &Tab{Kind: "gallery", Thread: thread, Params: map[string]string{"title": "Shots"}}
	case 9:
		return &Tab{Kind: "plugin.notes.board", Thread: thread, Params: map[string]string{"scope": thread}}
	default:
		return &Tab{ID: pick(s, "t-a", "p-a", "t-new"), Kind: pick(s, "prs", "nope")}
	}
}

// randomOp makes one op of any registered kind, naming mostly things that exist in st.
func randomOp(s *bytesrc, st *State) Op {
	spaces, panes, splits, tabs := stateIDs(st)
	edge := func() Edge { return pick(s, Left, Right, Top, Bottom, Right, Edge(""), Edge("middle")) }
	frac := func() float64 { return pick(s, 0, 0.05, 0.3, 0.5, 0.95, 1.5, -1) }
	index := func() *int {
		if s.n(2) == 0 {
			return nil
		}
		i := pick(s, -1, 0, 1, 2, 9)
		return &i
	}
	op, _ := NewOp(pick(s, OpNames()...))
	switch o := op.(type) {
	case *AddTab:
		o.Space, o.Pane, o.Tab, o.Index, o.Focus = pick(s, spaces...), pick(s, panes...), randomTab(s), index(), s.n(2) == 0
	case *SplitPane:
		o.Pane, o.Edge, o.Tab, o.Frac, o.Focus = pick(s, panes...), edge(), randomTab(s), frac(), s.n(2) == 0
	case *MoveTab:
		o.Tab, o.Space, o.Pane, o.Index, o.Edge, o.Frac = pick(s, tabs...), pick(s, spaces...), pick(s, panes...), index(), edge(), frac()
	case *MovePane:
		o.Pane, o.Target, o.Edge, o.Frac = pick(s, panes...), pick(s, panes...), edge(), frac()
		if s.n(3) == 0 {
			o.Target, o.Edge, o.Space = "", "", pick(s, spaces...)
		}
	case *MergePane:
		o.Pane, o.Target, o.Index = pick(s, panes...), pick(s, panes...), index()
	case *SwapPane:
		o.Pane, o.Target = pick(s, panes...), pick(s, panes...)
	case *CloseTab:
		o.Tab = pick(s, tabs...)
	case *ClosePane:
		o.Pane = pick(s, panes...)
	case *SetSizes:
		o.Split = pick(s, splits...)
		_, split := st.FindSplit(o.Split)
		k := 2 + s.n(2)
		if split != nil && s.n(4) != 0 {
			k = len(split.Kids)
		}
		for range k {
			o.Sizes = append(o.Sizes, pick(s, 1, 2, 0.5, 0.01, 0, -1))
		}
	case *FocusTab:
		o.Tab = pick(s, tabs...)
	case *FocusPane:
		o.Pane = pick(s, panes...)
	case *SetTabParams:
		o.Tab = pick(s, tabs...)
		o.Params = randomTab(s).Params
		if s.n(2) == 0 {
			title := "T"
			o.Title = &title
		}
	case *RenameTab:
		o.Tab, o.Name = pick(s, tabs...), pick(s, "", " x ", "dev")
	case *NewSpace:
		o.Name, o.Switch = pick(s, "", "Two", "  "), s.n(2) == 0
	case *RenameSpace:
		o.Space, o.Name = pick(s, spaces...), pick(s, "", "R", " ")
	case *RemoveSpace:
		o.Space, o.To = pick(s, spaces...), pick(s, spaces...)
	case *ReorderSpaces:
		for _, sp := range st.Spaces {
			o.Order = append(o.Order, sp.ID)
		}
		if s.n(4) == 0 {
			o.Order = append(o.Order, "sp-zz")
		}
		for i := range o.Order {
			j := s.n(len(o.Order))
			o.Order[i], o.Order[j] = o.Order[j], o.Order[i]
		}
	case *SwitchSpace:
		o.Space = pick(s, spaces...)
	case *OpenSurface:
		o.Space, o.Tab, o.Focus = pick(s, "", "", "", spaces[len(spaces)-1]), randomTab(s), s.n(2) == 0
		if s.n(4) == 0 {
			o.Pane = pick(s, panes...)
		}
		o.W, o.H = viewportOf(s)
	case *OpenThread:
		o.Thread, o.Focus = pick(s, threads...), s.n(3) != 0
		switch s.n(5) {
		case 0:
			o.Pane = pick(s, panes...)
		case 1:
			o.Compose = pick(s, tabs...)
		}
		o.W, o.H = viewportOf(s)
	case *CloseThread:
		o.Thread = pick(s, threads...)
		o.W, o.H = viewportOf(s)
	case *MoveThreadToSpace:
		o.Thread, o.Space = pick(s, threads...), pick(s, spaces...)
		o.W, o.H = viewportOf(s)
	case *ArchiveThread:
		o.Thread = pick(s, threads...)
	case *SnoozeThread:
		o.Thread = pick(s, threads...)
		o.Ran = map[string]string{"term-1": "make dev"}
		o.W, o.H = viewportOf(s)
	}
	return op
}

// threads are the thread ids random ops name, "" among them.
var threads = []string{"th-1", "th-2", "th-3", "th-4", ""}

// viewportOf is a pane area for placement: wide, narrow, odd, or the default.
func viewportOf(s *bytesrc) (float64, float64) {
	return pick(s, 0, 1180, 700, 2400, 333.5, -1), pick[float64](s, 0, 820, 400)
}

// runOps applies ops drawn from data to the seed state and checks every step: no op leaves
// the state out of normal form, a failed op changes nothing, the input state is never
// mutated, closed tabs are gone, and the result survives an encode and decode unchanged.
func runOps(t *testing.T, data []byte, maxSteps int) {
	st, _, err := Decode([]byte(seedState), &SeqIDs{})
	if err != nil {
		t.Fatal(err)
	}
	ids := &SeqIDs{}
	s := &bytesrc{b: data}
	for step := 0; step < maxSteps && !s.done(); step++ {
		op := randomOp(s, st)
		before, err := Encode(st)
		if err != nil {
			t.Fatal(err)
		}
		opts := Options{NoSmartSwap: s.n(4) == 0}
		next, res, err := ApplyWith(st, op, ids, opts)
		opJSON, _ := EncodeOp(op)
		if after, _ := Encode(st); string(after) != string(before) {
			t.Fatalf("step %d %s mutated its input", step, opJSON)
		}
		if err != nil {
			if errors.Is(err, ErrBroken) {
				t.Fatalf("step %d %s: %v", step, opJSON, err)
			}
			if next != st {
				t.Fatalf("step %d %s failed but returned a new state", step, opJSON)
			}
			continue
		}
		if err := Check(next); err != nil {
			t.Fatalf("step %d %s: %v", step, opJSON, err)
		}
		for _, tb := range append(slices.Clone(res.Closed), res.Kept...) {
			if _, _, still := next.FindTab(tb.ID); still != nil {
				t.Fatalf("step %d %s: closed tab %s is still open", step, opJSON, tb.ID)
			}
		}
		checkPlacement(t, step, string(opJSON), st, next, res)
		enc, err := Encode(next)
		if err != nil {
			t.Fatal(err)
		}
		back, repairs, err := Decode(enc, &SeqIDs{})
		if err != nil || len(repairs) > 0 {
			t.Fatalf("step %d %s: decode of the result: %v %q", step, opJSON, err, repairs)
		}
		if again, _ := Encode(back); string(again) != string(enc) {
			t.Fatalf("step %d %s: the result does not read back as written", step, opJSON)
		}
		st = next
	}
}

// checkPlacement pins what placement and the thread ops promise on any state: a pane that is
// joined is never resized (rules 2, 3, 4, 6 and the caller's or focused pane change no split),
// a kept tab is in its thread's remembered set, and the tabs a thread brought back are open.
func checkPlacement(t *testing.T, step int, opJSON string, before, after *State, res Result) {
	t.Helper()
	if _, ok := map[string]bool{"2": true, "3": true, "4": true, "6": true, "pane": true, "focused": true}[res.Rule]; ok && len(res.Back)+len(res.Placed) == 0 {
		if b, a := splitSizes(before), splitSizes(after); !maps.EqualFunc(b, a, slices.Equal[[]float64]) {
			t.Fatalf("step %d %s: rule %s resized a split:\n%v\n%v", step, opJSON, res.Rule, b, a)
		}
	}
	for _, tb := range res.Kept {
		ts := after.Threads[tb.Thread]
		if ts == nil || ts.Remembered == nil || !slices.ContainsFunc(ts.Remembered.Tabs, func(rt RememberedTab) bool { return rt.Tab.ID == tb.ID }) {
			t.Fatalf("step %d %s: kept tab %s is not remembered", step, opJSON, tb.ID)
		}
	}
	for _, id := range append(slices.Clone(res.Back), res.Placed...) {
		if _, _, tb := after.FindTab(id); tb == nil {
			t.Fatalf("step %d %s: restored tab %s is not open", step, opJSON, id)
		}
	}
}

// splitSizes is every split's sizes by id, in all spaces.
func splitSizes(st *State) map[string][]float64 {
	out := map[string][]float64{}
	for _, sp := range st.Spaces {
		walk(sp.Root, func(n *Node) {
			if n.T == NodeSplit {
				out[n.ID] = n.Sizes
			}
		})
	}
	return out
}

// TestOpSequencesKeepNormalForm is the property test: many random op sequences.
func TestOpSequencesKeepNormalForm(t *testing.T) {
	r := rand.New(rand.NewPCG(7, 11))
	for range 400 {
		data := make([]byte, 240)
		for i := range data {
			data[i] = byte(r.UintN(256))
		}
		runOps(t, data, 60)
	}
}

// FuzzOps runs op sequences drawn from fuzz input. Run it bounded:
// go test ./internal/layout -run '^$' -fuzz '^FuzzOps$' -fuzztime 60s
func FuzzOps(f *testing.F) {
	f.Add([]byte{})
	f.Add([]byte("move every pane and tab around, then close them all"))
	f.Add([]byte{3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9, 3, 2, 3, 8, 4, 6, 2, 6, 4, 3, 3, 8, 3, 2, 7, 9, 5})
	f.Fuzz(func(t *testing.T, data []byte) {
		runOps(t, data, 80)
	})
}

// FuzzDecode feeds any bytes to Decode: it never panics, and what it accepts is in normal
// form and reads back as written. Run it bounded:
// go test ./internal/layout -run '^$' -fuzz '^FuzzDecode$' -fuzztime 60s
func FuzzDecode(f *testing.F) {
	f.Add([]byte(seedState))
	f.Add([]byte(`{}`))
	f.Add([]byte(`{"v":1,"spaces":[{"id":"sp-a","root":{"t":"split","dir":"col","kids":[{"t":"pane","tabs":[{"kind":"prs"},{"kind":"prs"}]},null]}}],"threads":{"x":null}}`))
	files, _ := filepath.Glob("testdata/ops/*.json")
	for _, file := range files[:min(len(files), 8)] {
		if b, err := os.ReadFile(file); err == nil {
			f.Add(b)
		}
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		st, _, err := Decode(data, &SeqIDs{})
		if err != nil {
			if errors.Is(err, ErrBroken) {
				t.Fatal(err)
			}
			return
		}
		if err := Check(st); err != nil {
			t.Fatal(err)
		}
		enc, err := Encode(st)
		if err != nil {
			t.Fatal(err)
		}
		back, repairs, err := Decode(enc, &SeqIDs{})
		if err != nil || len(repairs) > 0 {
			t.Fatalf("re-decode: %v %q", err, repairs)
		}
		if again, _ := Encode(back); string(again) != string(enc) {
			t.Fatalf("does not read back as written:\n%s\n%s", enc, again)
		}
		if !slices.Equal(PaneIDs(back.Spaces[0].Root), PaneIDs(st.Spaces[0].Root)) {
			t.Fatal("panes changed on re-decode")
		}
	})
}
