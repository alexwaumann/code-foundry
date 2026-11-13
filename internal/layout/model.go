// Package layout is the pure core of the window shell: spaces, the pane tree of each space,
// tabs, and what is stored per thread. It holds the model, the JSON form the store persists,
// every operation on it, the plain proportional rectangles, and the surface identity table.
//
// It does no I/O and imports no store. Operations are values (Op) applied by Apply to a copy
// of a State; the result is always in normal form (Check), or the operation fails and the
// State it was given is untouched. The specification is docs/notes/shell-model.md; the build is
// summed up in docs/notes/shell-build.md; this package's decisions and its JSON test case format are
// in docs/notes/shell-1-layout-model.md.
package layout

import (
	"errors"
	"maps"
	"slices"
)

// Version is the version of the JSON documents this package writes and reads.
const Version = 1

// MaxMRU is how many recently focused tab ids a space keeps.
const MaxMRU = 64

// Errors returned by operations and decoding, wrapped with detail; test with errors.Is.
// They line up with Connect codes so a handler maps them one to one.
var (
	ErrNotFound           = errors.New("not found")
	ErrInvalidArgument    = errors.New("invalid argument")
	ErrAlreadyExists      = errors.New("already exists")
	ErrFailedPrecondition = errors.New("failed precondition")
	// ErrNewerVersion is a document written by a newer build.
	ErrNewerVersion = errors.New("newer layout version")
	// ErrBroken is an operation that would have left the state out of normal form: a bug in
	// this package, reported instead of stored.
	ErrBroken = errors.New("layout broken")
)

// NodeType tells a pane from a split.
type NodeType string

// Node types.
const (
	NodePane  NodeType = "pane"
	NodeSplit NodeType = "split"
)

// Dir is a split's direction: a row lays its children left to right, a column top to bottom.
type Dir string

// Split directions.
const (
	Row Dir = "row"
	Col Dir = "col"
)

// Edge is a side of a pane, or of the whole pane area.
type Edge string

// Edges.
const (
	Left   Edge = "left"
	Right  Edge = "right"
	Top    Edge = "top"
	Bottom Edge = "bottom"
)

// Valid reports whether e is one of the four edges.
func (e Edge) Valid() bool { return e == Left || e == Right || e == Top || e == Bottom }

func (e Edge) dir() Dir {
	if e == Left || e == Right {
		return Row
	}
	return Col
}

func (e Edge) before() bool { return e == Left || e == Top }

// Tab is one surface in a pane.
type Tab struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	// Thread is the link: "" for an unlinked tab, the thread itself for a thread tab.
	Thread string `json:"thread,omitempty"`
	// Key is the identity key from the kind table (identity.go), computed from Kind, Thread
	// and Params. Two tabs with one key in one scope are the same tab.
	Key    string            `json:"key,omitempty"`
	Params map[string]string `json:"params,omitempty"`
	// Title is the last automatic title, for strips and the CLI.
	Title string `json:"title,omitempty"`
	// Name is a manual name (renameable kinds); "" means automatic.
	Name string `json:"name,omitempty"`
}

// Node is a pane (T == NodePane: Tabs, Active) or a split (T == NodeSplit: Dir, Kids, Sizes).
// Sizes are the children's shares of the split, positive and summing to 1.
type Node struct {
	T      NodeType  `json:"t"`
	ID     string    `json:"id"`
	Tabs   []*Tab    `json:"tabs,omitempty"`
	Active string    `json:"active,omitempty"`
	Dir    Dir       `json:"dir,omitempty"`
	Kids   []*Node   `json:"kids,omitempty"`
	Sizes  []float64 `json:"sizes,omitempty"`
}

// IsPane reports whether n is a pane.
func (n *Node) IsPane() bool { return n != nil && n.T == NodePane }

// TabIndex is the index of tab id in pane n, or -1.
func (n *Node) TabIndex(id string) int {
	return slices.IndexFunc(n.Tabs, func(t *Tab) bool { return t.ID == id })
}

// ActiveTab is the pane's active tab, or nil.
func (n *Node) ActiveTab() *Tab {
	if i := n.TabIndex(n.Active); i >= 0 {
		return n.Tabs[i]
	}
	return nil
}

// Space is a named layout: one tree of panes, the focused pane, and the tabs most recently
// focused in it.
type Space struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Root *Node  `json:"root"`
	// Focus is the focused pane's id; "" only when Root is nil.
	Focus string `json:"focus,omitempty"`
	// MRU holds tab ids of this space, most recently focused first, at most MaxMRU.
	MRU []string `json:"mru,omitempty"`
	// Drafts are the space's composer drafts, newest first, whether or not each has a tab
	// open (drafts.go). The space's empty composer is never one of them.
	Drafts []*Draft `json:"drafts,omitempty"`
}

// Draft is a composer with something typed in it: its id (the "draft" param of its compose
// tab), a short label for lists, and the params its tab carries besides the id (what the next
// thread starts from), so a closed draft reopens as it was. The text itself is not here.
type Draft struct {
	ID     string            `json:"id"`
	Label  string            `json:"label,omitempty"`
	Params map[string]string `json:"params,omitempty"`
}

// ThreadState is what the layout stores for one thread.
type ThreadState struct {
	// Space is the space the thread lives in.
	Space      string            `json:"space"`
	Quick      *Quick            `json:"quick,omitempty"`
	Remembered *Remembered       `json:"remembered,omitempty"`
	Last       map[string]string `json:"last,omitempty"` // kind -> this thread's tab last active (smart swap)
	// Info is whether the thread shows its info card, as the user last toggled it (info.go);
	// nil: never toggled, so the setting layout.thread_info decides.
	Info *bool `json:"info,omitempty"`
}

// Quick is the thread's quick terminal slot.
type Quick struct {
	Open   bool    `json:"open"`
	Height float64 `json:"height,omitempty"`
	// Fresh: a snooze ended it while it was open (Open is then false). It comes back open, as
	// a fresh shell the caller starts (Result.FreshQuick), when the thread's tab opens.
	Fresh bool `json:"fresh,omitempty"`
	// Ran is the command its shell was running when a snooze ended it, for its "Run again"
	// line, until that runs or is dismissed (SetQuick.ForgetRan).
	Ran string `json:"ran,omitempty"`
}

// Remembered is the set of linked tabs a thread had open when its tab closed.
type Remembered struct {
	Pane string          `json:"pane,omitempty"` // the pane the thread's tab was in
	Tabs []RememberedTab `json:"tabs"`
}

// RememberedTab is one remembered linked tab and where it was.
type RememberedTab struct {
	Tab *Tab `json:"tab"`
	// Space is the space it was in when that is not its thread's (a snooze takes the thread's
	// terminal tabs from every space): it goes back there. Empty: the thread's space.
	Space    string  `json:"space,omitempty"`
	Pane     string  `json:"pane"`
	Index    int     `json:"index"`
	Active   bool    `json:"active,omitempty"`
	Adjacent bool    `json:"adjacent,omitempty"`
	Beside   *Beside `json:"beside,omitempty"`
	Fresh    *Fresh  `json:"fresh,omitempty"`
}

// Beside says where a pane sat: next to which panes, on which of their edges, at what share
// of the room the two had together. BesideInfo computes it.
type Beside struct {
	Neighbours []string `json:"neighbours"`
	Edge       Edge     `json:"edge"`
	Frac       float64  `json:"frac"`
}

// Fresh is a terminal that comes back as a fresh shell (after a snooze).
type Fresh struct {
	Name string `json:"name,omitempty"`
	Ran  string `json:"ran,omitempty"`
}

// State is the whole layout: every space, the current one, and per-thread state.
type State struct {
	V      int      `json:"v"`
	Spaces []*Space `json:"spaces"`
	// CurrentSpace is the space the window shows.
	CurrentSpace string `json:"current_space"`
	// DefaultSpace is the space of every thread without a ThreadState.
	DefaultSpace string `json:"default_space"`
	// Threads holds only threads with something stored.
	Threads map[string]*ThreadState `json:"threads,omitempty"`
}

// NewState is a state with one empty space.
func NewState(spaceID, name string) *State {
	return &State{
		V:            Version,
		Spaces:       []*Space{{ID: spaceID, Name: name}},
		CurrentSpace: spaceID,
		DefaultSpace: spaceID,
	}
}

// Space is the space with that id, or nil.
func (st *State) Space(id string) *Space {
	for _, sp := range st.Spaces {
		if sp.ID == id {
			return sp
		}
	}
	return nil
}

// SpaceOf is the id of the space thread lives in.
func (st *State) SpaceOf(thread string) string {
	if ts := st.Threads[thread]; ts != nil {
		return ts.Space
	}
	return st.DefaultSpace
}

// FindPane is the pane with that id and its space, or nils.
func (st *State) FindPane(id string) (*Space, *Node) {
	for _, sp := range st.Spaces {
		for _, p := range Panes(sp.Root) {
			if p.ID == id {
				return sp, p
			}
		}
	}
	return nil, nil
}

// FindTab is the tab with that id, its pane and its space, or nils.
func (st *State) FindTab(id string) (*Space, *Node, *Tab) {
	for _, sp := range st.Spaces {
		for _, p := range Panes(sp.Root) {
			if i := p.TabIndex(id); i >= 0 {
				return sp, p, p.Tabs[i]
			}
		}
	}
	return nil, nil, nil
}

// FindSplit is the split with that id and its space, or nils.
func (st *State) FindSplit(id string) (*Space, *Node) {
	for _, sp := range st.Spaces {
		var found *Node
		walk(sp.Root, func(n *Node) {
			if n.T == NodeSplit && n.ID == id {
				found = n
			}
		})
		if found != nil {
			return sp, found
		}
	}
	return nil, nil
}

// Panes lists the panes under n in layout order: left to right, top to bottom.
func Panes(n *Node) []*Node {
	var out []*Node
	walk(n, func(m *Node) {
		if m.IsPane() {
			out = append(out, m)
		}
	})
	return out
}

// PaneIDs lists the ids of Panes(n).
func PaneIDs(n *Node) []string {
	ps := Panes(n)
	out := make([]string, len(ps))
	for i, p := range ps {
		out[i] = p.ID
	}
	return out
}

// walk visits n and every node under it, parents first.
func walk(n *Node, f func(*Node)) {
	if n == nil {
		return
	}
	f(n)
	for _, k := range n.Kids {
		walk(k, f)
	}
}

// Clone is a deep copy of st.
func (st *State) Clone() *State {
	c := &State{V: st.V, CurrentSpace: st.CurrentSpace, DefaultSpace: st.DefaultSpace}
	c.Spaces = make([]*Space, len(st.Spaces))
	for i, sp := range st.Spaces {
		c.Spaces[i] = sp.clone()
	}
	if st.Threads != nil {
		c.Threads = make(map[string]*ThreadState, len(st.Threads))
		for id, ts := range st.Threads {
			c.Threads[id] = ts.clone()
		}
	}
	return c
}

func (sp *Space) clone() *Space {
	if sp == nil {
		return nil
	}
	c := &Space{ID: sp.ID, Name: sp.Name, Root: sp.Root.clone(), Focus: sp.Focus, MRU: slices.Clone(sp.MRU)}
	if sp.Drafts != nil {
		c.Drafts = make([]*Draft, len(sp.Drafts))
		for i, d := range sp.Drafts {
			if d != nil {
				c.Drafts[i] = &Draft{ID: d.ID, Label: d.Label, Params: maps.Clone(d.Params)}
			}
		}
	}
	return c
}

func (n *Node) clone() *Node {
	if n == nil {
		return nil
	}
	c := &Node{T: n.T, ID: n.ID, Active: n.Active, Dir: n.Dir, Sizes: slices.Clone(n.Sizes)}
	if n.Tabs != nil {
		c.Tabs = make([]*Tab, len(n.Tabs))
		for i, t := range n.Tabs {
			c.Tabs[i] = t.Clone()
		}
	}
	if n.Kids != nil {
		c.Kids = make([]*Node, len(n.Kids))
		for i, k := range n.Kids {
			c.Kids[i] = k.clone()
		}
	}
	return c
}

// Clone is a deep copy of t.
func (t *Tab) Clone() *Tab {
	if t == nil {
		return nil
	}
	c := *t
	c.Params = maps.Clone(t.Params)
	return &c
}

func (ts *ThreadState) clone() *ThreadState {
	if ts == nil {
		return nil
	}
	c := &ThreadState{Space: ts.Space, Last: maps.Clone(ts.Last)}
	if ts.Info != nil {
		v := *ts.Info
		c.Info = &v
	}
	if ts.Quick != nil {
		q := *ts.Quick
		c.Quick = &q
	}
	if ts.Remembered != nil {
		r := &Remembered{Pane: ts.Remembered.Pane, Tabs: make([]RememberedTab, len(ts.Remembered.Tabs))}
		for i, rt := range ts.Remembered.Tabs {
			rt.Tab = rt.Tab.Clone()
			if rt.Beside != nil {
				b := *rt.Beside
				b.Neighbours = slices.Clone(b.Neighbours)
				rt.Beside = &b
			}
			if rt.Fresh != nil {
				f := *rt.Fresh
				rt.Fresh = &f
			}
			r.Tabs[i] = rt
		}
		c.Remembered = r
	}
	return c
}
