package layout

import (
	"bytes"
	"crypto/rand"
	"encoding/base32"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
)

// Op is one operation on the layout. Each op is a struct in ops_*.go, registered by its JSON
// name; its JSON form is {"op": "<name>", ...its fields}.
type Op interface {
	// OpName is the op's JSON name ("add_tab").
	OpName() string
	apply(tx *tx) (Result, error)
}

// Result is what an op reports besides the new state.
type Result struct {
	Space string `json:"space,omitempty"`
	Pane  string `json:"pane,omitempty"`
	Tab   string `json:"tab,omitempty"`
	// Existing: the tab asked for was already open (same identity), and was used instead.
	Existing bool `json:"existing,omitempty"`
	// Closed lists the tabs the op took out of the layout, in layout order. The caller ends
	// what they hold (an unlinked terminal) or closes what they show (a thread).
	Closed []*Tab `json:"closed,omitempty"`
	// Rule says how placement chose where a tab went (place.go): "1" to "6", "pane" (the
	// caller's pane), "focused" (the focused pane), "compose" (it replaced a composer tab),
	// "edge" (a new pane on the edge the caller gave).
	Rule string `json:"rule,omitempty"`
	// Kept lists linked tabs taken out of the layout into their thread's remembered set
	// (thread.go). Their terminals keep running.
	Kept []*Tab `json:"kept,omitempty"`
	// Ended lists terminal tabs whose terminals the caller ends although the op did not close
	// them now: remembered terminals of a thread being snoozed or archived.
	Ended []*Tab `json:"ended,omitempty"`
	// Back and Placed list the remembered tabs a thread brought back when it opened: back in
	// their old panes, or placed fresh beside it. Fresh lists the terminal tabs among them that
	// come back as fresh shells (after a snooze): the caller starts one for each and sets its
	// terminal param.
	Back   []string `json:"back,omitempty"`
	Placed []string `json:"placed,omitempty"`
	Fresh  []string `json:"fresh,omitempty"`
	// FreshQuick is the thread whose quick terminal came back open when its tab opened, after
	// a snooze ended it (Quick.Fresh): the caller starts a fresh quick shell for it.
	FreshQuick string `json:"fresh_quick,omitempty"`
	// Swapped lists the panes smart swap switched (swap.go).
	Swapped []string `json:"swapped,omitempty"`
	// Draft is the composer draft the op started, opened or ended (drafts.go). After
	// clear_draft, discard_draft, or open_thread sending from a draft, the draft is gone and
	// the caller deletes its stored text.
	Draft string `json:"draft,omitempty"`
}

// Options are the user settings an op runs with.
type Options struct {
	// NoSmartSwap turns smart swap off (the setting layout.smart_swap, on by default).
	NoSmartSwap bool `json:"no_smart_swap,omitempty"`
	// KeepFocus puts the user's focus back as it was after the op (keep_focus.go): a call
	// from inside a thread, which never moves the user's focus.
	KeepFocus bool `json:"keep_focus,omitempty"`
}

var registry = map[string]func() Op{}

func register(name string, f func() Op) { registry[name] = f }

// OpNames lists every registered op name, sorted.
func OpNames() []string {
	out := make([]string, 0, len(registry))
	for n := range registry {
		out = append(out, n)
	}
	slices.Sort(out)
	return out
}

// NewOp is an empty op of that name.
func NewOp(name string) (Op, error) {
	f, ok := registry[name]
	if !ok {
		return nil, fmt.Errorf("unknown op %q: %w", name, ErrInvalidArgument)
	}
	return f(), nil
}

// DecodeOp reads an op from its JSON form. Unknown fields are refused.
func DecodeOp(data []byte) (Op, error) {
	var head struct {
		Op string `json:"op"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return nil, fmt.Errorf("decode op: %v: %w", err, ErrInvalidArgument)
	}
	op, err := NewOp(head.Op)
	if err != nil {
		return nil, err
	}
	// Decode the fields with "op" removed, so DisallowUnknownFields catches typos.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("decode op: %v: %w", err, ErrInvalidArgument)
	}
	delete(raw, "op")
	rest, err := json.Marshal(raw)
	if err != nil {
		return nil, fmt.Errorf("decode op: %v: %w", err, ErrInvalidArgument)
	}
	dec := json.NewDecoder(bytes.NewReader(rest))
	dec.DisallowUnknownFields()
	if err := dec.Decode(op); err != nil {
		return nil, fmt.Errorf("decode op %s: %v: %w", head.Op, err, ErrInvalidArgument)
	}
	return op, nil
}

// EncodeOp writes an op in its JSON form.
func EncodeOp(op Op) ([]byte, error) {
	body, err := json.Marshal(op)
	if err != nil {
		return nil, fmt.Errorf("encode op %s: %w", op.OpName(), err)
	}
	name, err := json.Marshal(op.OpName())
	if err != nil {
		return nil, fmt.Errorf("encode op %s: %w", op.OpName(), err)
	}
	out := []byte(`{"op":` + string(name))
	if len(body) > 2 {
		out = append(out, ',')
		out = append(out, body[1:]...)
	} else {
		out = append(out, '}')
	}
	return out, nil
}

// IDs makes new ids for panes ("p-"), splits ("s-"), tabs ("t-"), spaces ("sp-") and
// composer drafts ("d-").
// Apply retries an id already in use.
type IDs interface {
	NewID(prefix string) string
}

type randomIDs struct{}

var idEncoding = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)

func (randomIDs) NewID(prefix string) string {
	var b [5]byte
	_, _ = rand.Read(b[:]) // crypto/rand.Read never returns an error
	return prefix + idEncoding.EncodeToString(b[:])
}

// RandomIDs makes the ids the store uses: the prefix and 8 random base32 characters.
func RandomIDs() IDs { return randomIDs{} }

// SeqIDs makes ids "<prefix>n1", "<prefix>n2", ... with a counter per prefix: the ids the
// JSON test cases expect (docs/notes/shell-1-layout-model.md).
type SeqIDs struct{ next map[string]int }

// NewID returns the next id for prefix.
func (s *SeqIDs) NewID(prefix string) string {
	if s.next == nil {
		s.next = map[string]int{}
	}
	s.next[prefix]++
	return prefix + "n" + strconv.Itoa(s.next[prefix])
}

// Apply runs op on a copy of st with the default options. On success it returns the new
// state, in normal form; on an error it returns st itself, untouched.
func Apply(st *State, op Op, ids IDs) (*State, Result, error) {
	return ApplyWith(st, op, ids, Options{})
}

// ApplyWith is Apply with options. When the op leaves a thread tab newly focused (another tab,
// or another space, than before), smart swap runs for that thread unless it is turned off.
func ApplyWith(st *State, op Op, ids IDs, opts Options) (*State, Result, error) {
	t := &tx{st: st.Clone(), ids: ids}
	before := focusedThreadTab(t.st)
	res, err := op.apply(t)
	if err != nil {
		return st, Result{}, fmt.Errorf("layout %s: %w", op.OpName(), err)
	}
	t.finish()
	if opts.KeepFocus {
		keepFocus(st, t.st)
	}
	if after := focusedThreadTab(t.st); !opts.NoSmartSwap && after.thread != "" && after != before {
		res.Swapped = smartSwap(t.st, after.space, after.thread)
	}
	if err := Check(t.st); err != nil {
		return st, Result{}, fmt.Errorf("layout %s: %w: %w", op.OpName(), ErrBroken, err)
	}
	return t.st, res, nil
}

// tx is one op's working copy.
type tx struct {
	st   *State
	ids  IDs
	used map[string]bool
}

// newID is a fresh id with that prefix, unused anywhere in the state.
func (t *tx) newID(prefix string) string {
	if t.used == nil {
		t.used = usedIDs(t.st)
	}
	for {
		id := t.ids.NewID(prefix)
		if !t.used[id] {
			t.used[id] = true
			return id
		}
	}
}

// usedIDs is every space, node and tab id in the state, every pane id a thread remembers, and
// every pane and tab id of a reopen history (so a reopened tab or pane can take its own back).
// It reads states not yet sanitised too, so it skips nils.
func usedIDs(st *State) map[string]bool {
	used := map[string]bool{}
	for _, sp := range st.Spaces {
		if sp == nil {
			continue
		}
		used[sp.ID] = true
		for _, d := range sp.Drafts {
			if d != nil {
				used[d.ID] = true
			}
		}
		for _, e := range sp.Closed {
			if e == nil {
				continue
			}
			used[e.Pane] = true
			for _, tb := range e.Tabs {
				if tb != nil {
					used[tb.ID] = true
				}
			}
		}
		walk(sp.Root, func(n *Node) {
			used[n.ID] = true
			for _, tb := range n.Tabs {
				if tb != nil {
					used[tb.ID] = true
				}
			}
		})
	}
	for _, ts := range st.Threads {
		if ts == nil || ts.Remembered == nil {
			continue
		}
		used[ts.Remembered.Pane] = true
		for _, rt := range ts.Remembered.Tabs {
			used[rt.Pane] = true
			if rt.Tab != nil {
				used[rt.Tab.ID] = true
			}
		}
	}
	return used
}

// space is the space with that id; "" is the current space.
func (t *tx) space(id string) (*Space, error) {
	if id == "" {
		id = t.st.CurrentSpace
	}
	if sp := t.st.Space(id); sp != nil {
		return sp, nil
	}
	return nil, fmt.Errorf("space %q: %w", id, ErrNotFound)
}

func (t *tx) pane(id string) (*Space, *Node, error) {
	if id == "" {
		return nil, nil, fmt.Errorf("no pane given: %w", ErrInvalidArgument)
	}
	sp, p := t.st.FindPane(id)
	if p == nil {
		return nil, nil, fmt.Errorf("pane %q: %w", id, ErrNotFound)
	}
	return sp, p, nil
}

func (t *tx) tab(id string) (*Space, *Node, *Tab, error) {
	if id == "" {
		return nil, nil, nil, fmt.Errorf("no tab given: %w", ErrInvalidArgument)
	}
	sp, p, tb := t.st.FindTab(id)
	if tb == nil {
		return nil, nil, nil, fmt.Errorf("tab %q: %w", id, ErrNotFound)
	}
	return sp, p, tb, nil
}

// prepare checks a tab that is about to enter space sp and fills its key (and its id, when
// empty). It refuses a tab id in use and a thread tab outside its thread's space. When a tab
// of the same identity is already open where it would collide, it returns that one.
func (t *tx) prepare(sp *Space, tb *Tab) (*Tab, error) {
	if tb == nil {
		return nil, fmt.Errorf("no tab given: %w", ErrInvalidArgument)
	}
	k, key, err := Identify(tb)
	if err != nil {
		return nil, err
	}
	tb.Key = key
	if err := checkDraftTab(t.st, sp, tb); err != nil {
		return nil, err
	}
	if tb.Kind == "thread" && t.st.SpaceOf(tb.Thread) != sp.ID {
		return nil, fmt.Errorf("thread %s lives in space %s, not %s: %w", tb.Thread, t.st.SpaceOf(tb.Thread), sp.ID, ErrFailedPrecondition)
	}
	if !k.Renameable {
		tb.Name = ""
	}
	if same := t.sameTab(sp, k, key, ""); same != nil {
		return same, nil
	}
	if tb.ID == "" {
		tb.ID = t.newID("t-")
	} else if usedIDs(t.st)[tb.ID] {
		return nil, fmt.Errorf("tab id %q: %w", tb.ID, ErrAlreadyExists)
	}
	return nil, nil
}

// sameTab is an open tab with this identity in the scope of space sp, other than tab skip.
func (t *tx) sameTab(sp *Space, k *Kind, key, skip string) *Tab {
	spaces := []*Space{sp}
	if k.Scope == ScopeGlobal {
		spaces = t.st.Spaces
	}
	for _, s := range spaces {
		for _, p := range Panes(s.Root) {
			for _, tb := range p.Tabs {
				if tb.Key == key && tb.ID != skip {
					return tb
				}
			}
		}
	}
	return nil
}

// touch puts tab id first in the space's MRU.
func touch(sp *Space, id string) {
	sp.MRU = slices.Insert(slices.DeleteFunc(sp.MRU, func(m string) bool { return m == id }), 0, id)
	if len(sp.MRU) > MaxMRU {
		sp.MRU = sp.MRU[:MaxMRU]
	}
}

// focusTab makes a tab active in its pane, focuses that pane, and puts the tab first in MRU.
func focusTab(sp *Space, pane *Node, id string) {
	pane.Active = id
	sp.Focus = pane.ID
	touch(sp, id)
}

// show applies the focus rule to a tab just placed in pane: with focus, it takes the focus;
// without, it becomes active in its pane unless that pane is the focused one, where it waits
// behind the active tab (docs/notes/shell-1-layout-model.md, the focus rule).
func (t *tx) show(sp *Space, pane *Node, id string, focus bool) {
	switch {
	case focus:
		focusTab(sp, pane, id)
		t.st.CurrentSpace = sp.ID
	case sp.Focus != pane.ID:
		pane.Active = id
	}
	if sp.Focus == "" {
		sp.Focus = pane.ID
	}
}

// refocus gives the focus back to the newest MRU entry still open in the space; with none,
// it leaves the focus where detaching put it.
func refocus(sp *Space) {
	for _, id := range sp.MRU {
		for _, p := range Panes(sp.Root) {
			if p.TabIndex(id) >= 0 {
				focusTab(sp, p, id)
				return
			}
		}
	}
}

// focusedTab is the id of the focused pane's active tab, or "".
func focusedTab(sp *Space) string {
	for _, p := range Panes(sp.Root) {
		if p.ID == sp.Focus {
			return p.Active
		}
	}
	return ""
}

// forget drops tab ids from a space's MRU.
func forget(sp *Space, ids ...string) {
	sp.MRU = slices.DeleteFunc(sp.MRU, func(m string) bool { return slices.Contains(ids, m) })
}

// finish puts every space back into normal form after an op: the tree normalised, the focus
// on a pane that exists, MRU holding only this space's open tabs.
func (t *tx) finish() {
	for _, sp := range t.st.Spaces {
		sp.Root = norm(sp.Root)
		ids := PaneIDs(sp.Root)
		if !slices.Contains(ids, sp.Focus) {
			sp.Focus = ""
			if len(ids) > 0 {
				sp.Focus = ids[0]
			}
		}
		open := map[string]bool{}
		for _, p := range Panes(sp.Root) {
			for _, tb := range p.Tabs {
				open[tb.ID] = true
			}
		}
		seen := map[string]bool{}
		sp.MRU = slices.DeleteFunc(sp.MRU, func(m string) bool {
			drop := !open[m] || seen[m]
			seen[m] = true
			return drop
		})
		if len(sp.MRU) == 0 {
			sp.MRU = nil
		}
	}
	followDrafts(t.st)
}
