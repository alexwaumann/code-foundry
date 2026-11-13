package layout

import (
	"bytes"
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"
)

// Encode writes the whole state as JSON (the form of the test cases; the store writes one
// document per space and per thread instead).
func Encode(st *State) ([]byte, error) {
	b, err := json.Marshal(st)
	if err != nil {
		return nil, fmt.Errorf("encode layout: %w", err)
	}
	return b, nil
}

// Decode reads a whole state from JSON and repairs it into normal form (Sanitize). It returns
// what it repaired, for the log. A document from a newer version is refused with
// ErrNewerVersion, JSON that does not fit the model with ErrInvalidArgument.
func Decode(data []byte, ids IDs) (*State, []string, error) {
	var st State
	if err := json.Unmarshal(data, &st); err != nil {
		return nil, nil, fmt.Errorf("decode layout: %v: %w", err, ErrInvalidArgument)
	}
	if st.V > Version {
		return nil, nil, fmt.Errorf("decode layout: version %d: %w", st.V, ErrNewerVersion)
	}
	repairs := Sanitize(&st, ids)
	if err := Check(&st); err != nil {
		return nil, nil, fmt.Errorf("decode layout: %w: %w", ErrBroken, err)
	}
	return &st, repairs, nil
}

// SpaceDoc is one space's stored document (the row holds its id, name and position).
type SpaceDoc struct {
	V      int      `json:"v"`
	Root   *Node    `json:"root"`
	Focus  string   `json:"focus,omitempty"`
	MRU    []string `json:"mru,omitempty"`
	Drafts []*Draft `json:"drafts,omitempty"`
}

// EncodeSpaceDoc writes a space's document.
func EncodeSpaceDoc(sp *Space) ([]byte, error) {
	b, err := json.Marshal(SpaceDoc{V: Version, Root: sp.Root, Focus: sp.Focus, MRU: sp.MRU, Drafts: sp.Drafts})
	if err != nil {
		return nil, fmt.Errorf("encode space %s: %w", sp.ID, err)
	}
	return b, nil
}

// DecodeSpaceDoc reads a space's document. It checks only the version and the JSON: run
// Sanitize on the assembled State.
func DecodeSpaceDoc(id, name string, data []byte) (*Space, error) {
	var d SpaceDoc
	if err := json.Unmarshal(data, &d); err != nil {
		return nil, fmt.Errorf("decode space %s: %v: %w", id, err, ErrInvalidArgument)
	}
	if d.V > Version {
		return nil, fmt.Errorf("decode space %s: version %d: %w", id, d.V, ErrNewerVersion)
	}
	return &Space{ID: id, Name: name, Root: d.Root, Focus: d.Focus, MRU: d.MRU, Drafts: d.Drafts}, nil
}

// ThreadDoc is one thread's stored document (the row holds its id and space).
type ThreadDoc struct {
	V          int               `json:"v"`
	Quick      *Quick            `json:"quick,omitempty"`
	Remembered *Remembered       `json:"remembered,omitempty"`
	Last       map[string]string `json:"last,omitempty"`
	Info       *bool             `json:"info,omitempty"`
}

// EncodeThreadDoc writes a thread's document.
func EncodeThreadDoc(ts *ThreadState) ([]byte, error) {
	b, err := json.Marshal(ThreadDoc{V: Version, Quick: ts.Quick, Remembered: ts.Remembered, Last: ts.Last, Info: ts.Info})
	if err != nil {
		return nil, fmt.Errorf("encode thread state: %w", err)
	}
	return b, nil
}

// DecodeThreadDoc reads a thread's document. It checks only the version and the JSON.
func DecodeThreadDoc(space string, data []byte) (*ThreadState, error) {
	var d ThreadDoc
	if err := json.Unmarshal(data, &d); err != nil {
		return nil, fmt.Errorf("decode thread state: %v: %w", err, ErrInvalidArgument)
	}
	if d.V > Version {
		return nil, fmt.Errorf("decode thread state: version %d: %w", d.V, ErrNewerVersion)
	}
	return &ThreadState{Space: space, Quick: d.Quick, Remembered: d.Remembered, Last: d.Last, Info: d.Info}, nil
}

// FromNewerBuild lists what in st only a newer build writes: a node of a type this build
// does not know, and a tab of a kind it does not know, open or remembered. Sanitize drops
// them, since they cannot be shown; a store that finds any keeps the stored documents as they
// are (a kind is never removed from the identity table for that reason).
func FromNewerBuild(st *State) []string {
	var out []string
	var node func(sp string, n *Node)
	node = func(sp string, n *Node) {
		switch {
		case n == nil:
		case n.T == NodeSplit:
			for _, k := range n.Kids {
				node(sp, k)
			}
		case n.T == NodePane:
			for _, tb := range n.Tabs {
				if tb != nil {
					if _, ok := KindOf(tb.Kind); !ok {
						out = append(out, fmt.Sprintf("space %s: tab %s of kind %q", sp, tb.ID, tb.Kind))
					}
				}
			}
		default:
			out = append(out, fmt.Sprintf("space %s: node %s of type %q", sp, n.ID, n.T))
		}
	}
	for _, sp := range st.Spaces {
		if sp != nil {
			node(sp.ID, sp.Root)
		}
	}
	for _, id := range slices.Sorted(maps.Keys(st.Threads)) {
		ts := st.Threads[id]
		if ts == nil || ts.Remembered == nil {
			continue
		}
		for _, rt := range ts.Remembered.Tabs {
			if rt.Tab != nil {
				if _, ok := KindOf(rt.Tab.Kind); !ok {
					out = append(out, fmt.Sprintf("thread %s: remembered tab %s of kind %q", id, rt.Tab.ID, rt.Tab.Kind))
				}
			}
		}
	}
	return out
}

// Sanitize repairs any state into normal form (Check) in place and returns what it changed.
// It never fails: what cannot be repaired is dropped (a tab of an unknown kind, a duplicate
// of an open surface, a node of an unknown type), a missing or repeated id is replaced, and
// a state with no space gets one called "Main". A version 0 document (no "v") is read as
// version 1.
func Sanitize(st *State, ids IDs) []string {
	s := &sanitizer{t: &tx{st: st, ids: ids}, seen: map[string]bool{}, global: map[string]bool{}, draftTabs: map[string]bool{}}
	s.run()
	return s.repairs
}

type sanitizer struct {
	t         *tx
	seen      map[string]bool // ids claimed so far
	global    map[string]bool // global-scope keys open so far
	draftTabs map[string]bool // drafts with a tab open so far
	repairs   []string
}

func (s *sanitizer) note(format string, a ...any) {
	s.repairs = append(s.repairs, fmt.Sprintf(format, a...))
}

// claim keeps id when it is set and not yet seen; otherwise it replaces it with a new one.
func (s *sanitizer) claim(id, prefix, what string) string {
	if id == "" || s.seen[id] {
		nid := s.t.newID(prefix)
		s.note("%s %q: new id %s", what, id, nid)
		id = nid
	}
	s.seen[id] = true
	return id
}

func (s *sanitizer) run() {
	st := s.t.st
	if st.V < Version {
		st.V = Version
	}
	st.Spaces = slices.DeleteFunc(st.Spaces, func(sp *Space) bool { return sp == nil })
	for i, sp := range st.Spaces {
		sp.ID = s.claim(sp.ID, "sp-", "space")
		if strings.TrimSpace(sp.Name) == "" {
			sp.Name = "Space " + strconv.Itoa(i+1)
			s.note("space %s: named %q", sp.ID, sp.Name)
		}
	}
	if len(st.Spaces) == 0 {
		sp := &Space{ID: s.t.newID("sp-"), Name: "Main"}
		s.seen[sp.ID] = true
		st.Spaces = []*Space{sp}
		st.CurrentSpace, st.DefaultSpace = sp.ID, sp.ID
		s.note("no space: added %s", sp.ID)
	}
	if st.Space(st.CurrentSpace) == nil {
		s.note("current space %q: now %s", st.CurrentSpace, st.Spaces[0].ID)
		st.CurrentSpace = st.Spaces[0].ID
	}
	if st.Space(st.DefaultSpace) == nil {
		s.note("default space %q: now %s", st.DefaultSpace, st.Spaces[0].ID)
		st.DefaultSpace = st.Spaces[0].ID
	}
	for _, sp := range st.Spaces {
		s.space(sp)
	}
	s.threads()
	s.drafts()
}

func (s *sanitizer) space(sp *Space) {
	keys := map[string]bool{}
	sp.Root = s.node(sp, sp.Root, keys)
	before, _ := json.Marshal(sp.Root)
	sp.Root = norm(sp.Root)
	if after, _ := json.Marshal(sp.Root); !bytes.Equal(before, after) {
		s.note("space %s: tree put into normal form", sp.ID)
	}
	ids := PaneIDs(sp.Root)
	if want := focusOr(ids, sp.Focus); want != sp.Focus {
		s.note("space %s: focus %q is now %q", sp.ID, sp.Focus, want)
		sp.Focus = want
	}
	open := map[string]bool{}
	for _, p := range Panes(sp.Root) {
		for _, tb := range p.Tabs {
			open[tb.ID] = true
		}
	}
	seen := map[string]bool{}
	mru := slices.DeleteFunc(slices.Clone(sp.MRU), func(m string) bool {
		drop := !open[m] || seen[m]
		seen[m] = true
		return drop
	})
	if len(mru) > MaxMRU {
		mru = mru[:MaxMRU]
	}
	if len(mru) == 0 {
		mru = nil
	}
	if !slices.Equal(mru, sp.MRU) {
		s.note("space %s: MRU repaired", sp.ID)
	}
	sp.MRU = mru
}

// focusOr is focus when it is one of ids, else the first of ids, else "".
func focusOr(ids []string, focus string) string {
	if slices.Contains(ids, focus) {
		return focus
	}
	if len(ids) > 0 {
		return ids[0]
	}
	return ""
}

func (s *sanitizer) node(sp *Space, n *Node, keys map[string]bool) *Node {
	if n == nil {
		return nil
	}
	switch n.T {
	case NodePane:
		n.ID = s.claim(n.ID, "p-", "pane")
		n.Dir, n.Kids, n.Sizes = "", nil, nil
		n.Tabs = slices.DeleteFunc(n.Tabs, func(tb *Tab) bool { return !s.tab(sp, n, tb, keys) })
		return n
	case NodeSplit:
		n.ID = s.claim(n.ID, "s-", "split")
		n.Tabs, n.Active = nil, ""
		if n.Dir != Row && n.Dir != Col {
			s.note("split %s: direction %q is now row", n.ID, n.Dir)
			n.Dir = Row
		}
		if len(n.Sizes) != len(n.Kids) {
			s.note("split %s: %d sizes for %d children, now equal", n.ID, len(n.Sizes), len(n.Kids))
			n.Sizes = nil
		}
		for i, k := range n.Kids {
			n.Kids[i] = s.node(sp, k, keys)
		}
		return n
	default:
		s.note("space %s: dropped node %q of type %q", sp.ID, n.ID, n.T)
		return nil
	}
}

// tab repairs a tab in place and reports whether to keep it.
func (s *sanitizer) tab(sp *Space, p *Node, tb *Tab, keys map[string]bool) bool {
	if tb == nil {
		return false
	}
	k, key, err := Identify(tb)
	if err != nil {
		s.note("pane %s: dropped tab %q: %v", p.ID, tb.ID, err)
		return false
	}
	if tb.Key != "" && tb.Key != key {
		s.note("tab %s: key %q is now %q", tb.ID, tb.Key, key)
	}
	tb.Key = key
	scope := keys
	if k.Scope == ScopeGlobal {
		scope = s.global
	}
	if scope[key] {
		s.note("pane %s: dropped tab %q, a second %s", p.ID, tb.ID, key)
		return false
	}
	if id := draftOf(tb); id != "" {
		if s.draftTabs[id] {
			s.note("pane %s: dropped tab %q, a second tab of draft %s", p.ID, tb.ID, id)
			return false
		}
		s.draftTabs[id] = true
	}
	scope[key] = true
	if tb.Name != "" && !k.Renameable {
		s.note("tab %s: dropped the name of a %s tab", tb.ID, tb.Kind)
		tb.Name = ""
	}
	tb.ID = s.claim(tb.ID, "t-", "tab")
	return true
}

func (s *sanitizer) threads() {
	st := s.t.st
	for id, ts := range st.Threads {
		if ts == nil {
			s.note("thread %s: dropped nil state", id)
			delete(st.Threads, id)
			continue
		}
		if st.Space(ts.Space) == nil {
			s.note("thread %s: space %q is now %s", id, ts.Space, st.DefaultSpace)
			ts.Space = st.DefaultSpace
		}
		if r := ts.Remembered; r != nil {
			r.Tabs = slices.DeleteFunc(r.Tabs, func(rt RememberedTab) bool {
				if rt.Tab == nil {
					s.note("thread %s: dropped a remembered nil tab", id)
					return true
				}
				_, key, err := Identify(rt.Tab)
				if err != nil {
					s.note("thread %s: dropped remembered tab %q: %v", id, rt.Tab.ID, err)
					return true
				}
				rt.Tab.Key = key
				return false
			})
		}
	}
	// A thread tab is the stronger fact: the thread lives where its tab is.
	for _, sp := range st.Spaces {
		for _, p := range Panes(sp.Root) {
			for _, tb := range p.Tabs {
				if tb.Kind != "thread" || st.SpaceOf(tb.Thread) == sp.ID {
					continue
				}
				s.note("thread %s: its tab is in space %s, so it lives there", tb.Thread, sp.ID)
				if st.Threads == nil {
					st.Threads = map[string]*ThreadState{}
				}
				if ts := st.Threads[tb.Thread]; ts != nil {
					ts.Space = sp.ID
				} else {
					st.Threads[tb.Thread] = &ThreadState{Space: sp.ID}
				}
			}
		}
	}
}

// drafts repairs the draft lists: an entry that is nil, has no id, or repeats one listed
// before is dropped; a label is made one short line; a draft whose tab is open in another
// space moves there, and one no space lists is listed by its tab's space (label empty); each
// entry takes its open tab's params.
func (s *sanitizer) drafts() {
	st := s.t.st
	listed := map[string]bool{}
	for _, sp := range st.Spaces {
		sp.Drafts = slices.DeleteFunc(sp.Drafts, func(d *Draft) bool {
			switch {
			case d == nil || d.ID == "":
				s.note("space %s: dropped a draft without an id", sp.ID)
				return true
			case listed[d.ID]:
				s.note("space %s: dropped draft %s, listed before", sp.ID, d.ID)
				return true
			}
			listed[d.ID] = true
			if l := draftLabel(d.Label); l != d.Label {
				s.note("draft %s: label %q is now %q", d.ID, d.Label, l)
				d.Label = l
			}
			if _, ok := d.Params[DraftParam]; ok {
				s.note("draft %s: dropped the draft id from its params", d.ID)
				d.Params = draftParams(d.Params)
			}
			return false
		})
		if len(sp.Drafts) == 0 {
			sp.Drafts = nil
		}
	}
	for _, sp := range st.Spaces {
		for _, p := range Panes(sp.Root) {
			for _, tb := range p.Tabs {
				id := draftOf(tb)
				if id == "" {
					continue
				}
				dsp, d := findDraft(st, id)
				switch {
				case d == nil:
					s.note("draft %s: open in space %s but listed nowhere, now listed there", id, sp.ID)
					d = &Draft{ID: id}
					sp.Drafts = append(sp.Drafts, d)
				case dsp != sp:
					s.note("draft %s: open in space %s, listed by %s, moved", id, sp.ID, dsp.ID)
					unlistDraft(st, id)
					sp.Drafts = append(sp.Drafts, d)
				}
				if want := draftParams(tb.Params); !maps.Equal(d.Params, want) {
					s.note("draft %s: params are now its tab's", id)
					d.Params = want
				}
			}
		}
	}
}
