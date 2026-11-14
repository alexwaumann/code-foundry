package layout

import (
	"fmt"
	"slices"
	"strconv"
	"strings"
)

func init() {
	register("new_space", func() Op { return &NewSpace{} })
	register("rename_space", func() Op { return &RenameSpace{} })
	register("remove_space", func() Op { return &RemoveSpace{} })
	register("reorder_spaces", func() Op { return &ReorderSpaces{} })
	register("switch_space", func() Op { return &SwitchSpace{} })
}

// NewSpace adds an empty space after the others ("Space <n>" when Name is blank) and, with
// Switch, makes it the current space.
type NewSpace struct {
	Name   string `json:"name,omitempty"`
	Switch bool   `json:"switch,omitempty"`
}

// OpName implements Op.
func (*NewSpace) OpName() string { return "new_space" }

func (o *NewSpace) apply(t *tx) (Result, error) {
	name := strings.TrimSpace(o.Name)
	if name == "" {
		name = freeSpaceName(t.st)
	}
	sp := &Space{ID: t.newID("sp-"), Name: name}
	t.st.Spaces = append(t.st.Spaces, sp)
	if o.Switch {
		t.st.CurrentSpace = sp.ID
	}
	return Result{Space: sp.ID}, nil
}

// freeSpaceName is "Space <n>" for the least n from the number of spaces + 1 that no space
// is called.
func freeSpaceName(st *State) string {
	for n := len(st.Spaces) + 1; ; n++ {
		name := "Space " + strconv.Itoa(n)
		if !slices.ContainsFunc(st.Spaces, func(sp *Space) bool { return sp.Name == name }) {
			return name
		}
	}
}

// RenameSpace renames a space; the name may not be blank.
type RenameSpace struct {
	Space string `json:"space"`
	Name  string `json:"name"`
}

// OpName implements Op.
func (*RenameSpace) OpName() string { return "rename_space" }

func (o *RenameSpace) apply(t *tx) (Result, error) {
	sp, err := t.spaceByID(o.Space)
	if err != nil {
		return Result{}, err
	}
	name := strings.TrimSpace(o.Name)
	if name == "" {
		return Result{}, fmt.Errorf("a space needs a name: %w", ErrInvalidArgument)
	}
	sp.Name = name
	return Result{Space: sp.ID}, nil
}

// RemoveSpace removes a space with all its panes and tabs. Its threads move to To (default:
// the space on its left, else on its right), closed, as do the threads of the default space
// when it is the one removed: each is closed as close_thread closes it, so the linked tabs it
// had open in the space join its remembered set (Result.Kept; their terminals keep running)
// and come back, placed fresh, when it opens in its new space. A linked tab of a thread that
// lives in another space (one dragged here by itself) joins that thread's set the same way.
// Every other tab is in Result.Closed, so the caller ends the unlinked terminals. Its drafts
// move to the top of To's list, closed. Archiving its threads instead is the caller's,
// through the thread store, before this. The last space cannot be removed.
type RemoveSpace struct {
	Space string  `json:"space"`
	To    string  `json:"to,omitempty"`
	W     float64 `json:"w,omitempty"`
	H     float64 `json:"h,omitempty"`
}

// OpName implements Op.
func (*RemoveSpace) OpName() string { return "remove_space" }

func (o *RemoveSpace) apply(t *tx) (Result, error) {
	sp, err := t.spaceByID(o.Space)
	if err != nil {
		return Result{}, err
	}
	if len(t.st.Spaces) < 2 {
		return Result{}, fmt.Errorf("the last space cannot be removed: %w", ErrFailedPrecondition)
	}
	i := slices.Index(t.st.Spaces, sp)
	to := o.To
	if to == "" {
		to = t.st.Spaces[1].ID
		if i > 0 {
			to = t.st.Spaces[i-1].ID
		}
	}
	if to == sp.ID {
		return Result{}, fmt.Errorf("space %s cannot move its threads to itself: %w", sp.ID, ErrInvalidArgument)
	}
	if _, err := t.spaceByID(to); err != nil {
		return Result{}, err
	}
	// Every tab, in layout order, and the threads whose tabs are here, in order of first sight.
	var all []*Tab
	var threads []string
	for _, p := range Panes(sp.Root) {
		for _, tb := range p.Tabs {
			all = append(all, tb)
			if (tb.Kind == "thread" || tb.IsLinked()) && !slices.Contains(threads, tb.Thread) {
				threads = append(threads, tb.Thread)
			}
		}
	}
	w, h := viewport(o.W, o.H)
	kept := map[*Tab]bool{}
	var res Result
	for _, th := range threads {
		var k []*Tab
		if id := threadTabID(t.st, th); id != "" {
			if tsp, _, _ := t.st.FindTab(id); tsp == sp {
				k = t.closeThread(th, id, w, h, false).Kept
			}
		}
		k = append(k, t.putAway(sp, th, "", w, h)...)
		for _, tb := range k {
			kept[tb] = true
		}
	}
	for _, tb := range all {
		if kept[tb] {
			res.Kept = append(res.Kept, tb)
		} else {
			res.Closed = append(res.Closed, tb)
		}
	}
	if len(sp.Drafts) > 0 {
		target := t.st.Space(to)
		target.Drafts = append(slices.Clone(sp.Drafts), target.Drafts...)
	}
	for _, ts := range t.st.Threads {
		if ts.Space == sp.ID {
			ts.Space, ts.Last = to, nil
		}
	}
	if t.st.DefaultSpace == sp.ID {
		t.st.DefaultSpace = to
	}
	if t.st.CurrentSpace == sp.ID {
		t.st.CurrentSpace = to
	}
	t.st.Spaces = slices.Delete(t.st.Spaces, i, i+1)
	res.Space = to
	return res, nil
}

// ReorderSpaces puts the spaces in this order, which must name each space once.
type ReorderSpaces struct {
	Order []string `json:"order"`
}

// OpName implements Op.
func (*ReorderSpaces) OpName() string { return "reorder_spaces" }

func (o *ReorderSpaces) apply(t *tx) (Result, error) {
	if len(o.Order) != len(t.st.Spaces) {
		return Result{}, fmt.Errorf("order names %d spaces of %d: %w", len(o.Order), len(t.st.Spaces), ErrInvalidArgument)
	}
	next := make([]*Space, 0, len(o.Order))
	for _, id := range o.Order {
		sp := t.st.Space(id)
		if sp == nil || slices.Contains(next, sp) {
			return Result{}, fmt.Errorf("order names %q twice or not at all: %w", id, ErrInvalidArgument)
		}
		next = append(next, sp)
	}
	t.st.Spaces = next
	return Result{}, nil
}

// SwitchSpace makes a space the current one.
type SwitchSpace struct {
	Space string `json:"space"`
}

// OpName implements Op.
func (*SwitchSpace) OpName() string { return "switch_space" }

func (o *SwitchSpace) apply(t *tx) (Result, error) {
	sp, err := t.spaceByID(o.Space)
	if err != nil {
		return Result{}, err
	}
	t.st.CurrentSpace = sp.ID
	return Result{Space: sp.ID}, nil
}

// spaceByID is the space with that id; unlike space, "" is refused.
func (t *tx) spaceByID(id string) (*Space, error) {
	if id == "" {
		return nil, fmt.Errorf("no space given: %w", ErrInvalidArgument)
	}
	return t.space(id)
}
