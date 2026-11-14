package layout

import "fmt"

// A pane the user collapsed (docs/notes/shell-model.md, "Collapsing a pane";
// docs/notes/shell-25d-collapse.md). The window draws it folded to a rail, always; the choice is
// the pane's (Node.Collapsed), stored with it, and goes where the pane goes. The rules kept here:
//   - a space with panes keeps at least one open (keepOneOpen, run by every op's finish);
//   - collapsing the focused pane hands the focus on as closing it would (refocus: the most
//     recently focused open pane);
//   - the focus may rest on a collapsed pane (FocusPane: the direction keys) and the pane stays
//     collapsed; an op that gives one of its tabs the focus opens it (tx.focusTab), unless the op
//     keeps the user's focus (Options.KeepFocus, keepCollapsed).

func init() {
	register("set_collapsed", func() Op { return &SetCollapsed{} })
}

// SetCollapsed collapses a pane to a rail or opens it again. Collapsing the last open pane of
// a space is refused. Collapsing the focused pane hands the focus to the most recently focused
// open pane; opening a pane gives it the focus (a call from a thread keeps the user's focus).
type SetCollapsed struct {
	Pane      string `json:"pane"`
	Collapsed bool   `json:"collapsed"`
}

// OpName implements Op.
func (*SetCollapsed) OpName() string { return "set_collapsed" }

func (o *SetCollapsed) apply(t *tx) (Result, error) {
	sp, p, err := t.pane(o.Pane)
	if err != nil {
		return Result{}, err
	}
	if !o.Collapsed {
		p.Collapsed = false
		focusTab(sp, p, p.Active)
		t.st.CurrentSpace = sp.ID
		return Result{Space: sp.ID, Pane: p.ID, Tab: p.Active}, nil
	}
	if p.Collapsed {
		return Result{Space: sp.ID, Pane: p.ID}, nil
	}
	if LastOpen(sp, p.ID) {
		return Result{}, fmt.Errorf("pane %s is the last open pane of its space: %w", p.ID, ErrFailedPrecondition)
	}
	p.Collapsed = true
	if sp.Focus == p.ID {
		refocus(sp)
	}
	return Result{Space: sp.ID, Pane: p.ID}, nil
}

// LastOpen reports whether pane id is the only pane of sp that is not collapsed.
func LastOpen(sp *Space, id string) bool {
	for _, p := range Panes(sp.Root) {
		if p.ID != id && !p.Collapsed {
			return false
		}
	}
	return true
}

// focusTab is the package's focusTab for an op that gives the tab the user's focus: a
// collapsed pane opens (and is remembered in t.revealed, so KeepFocus can collapse it again).
func (t *tx) focusTab(sp *Space, pane *Node, id string) {
	if pane.Collapsed {
		pane.Collapsed = false
		t.revealed = append(t.revealed, pane.ID)
	}
	focusTab(sp, pane, id)
}

// paneByID is the pane of sp with that id, or nil.
func paneByID(sp *Space, id string) *Node {
	for _, p := range Panes(sp.Root) {
		if p.ID == id {
			return p
		}
	}
	return nil
}

// firstOpen is the first pane of sp in layout order that is not collapsed, or nil.
func firstOpen(sp *Space) *Node {
	for _, p := range Panes(sp.Root) {
		if !p.Collapsed {
			return p
		}
	}
	return nil
}

// nearestOpen is the pane of panes nearest index at that is not collapsed (the earlier of two
// as near), else panes[at].
func nearestOpen(panes []*Node, at int) *Node {
	for d := 0; d < len(panes); d++ {
		for _, i := range []int{at - d, at + d} {
			if i >= 0 && i < len(panes) && !panes[i].Collapsed {
				return panes[i]
			}
		}
	}
	return panes[at]
}

// keepOneOpen opens the focused pane of sp when every pane of it is collapsed (the last open
// pane was closed or moved away).
func keepOneOpen(sp *Space) {
	if sp.Root == nil || firstOpen(sp) != nil {
		return
	}
	if p := paneByID(sp, sp.Focus); p != nil {
		p.Collapsed = false
		return
	}
	Panes(sp.Root)[0].Collapsed = false
}
