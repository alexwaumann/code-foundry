package layout

import (
	"fmt"
	"maps"
	"slices"
	"strings"
	"unicode/utf8"
)

// Composer drafts (docs/notes/shell-model.md, "The composer"; decisions in
// docs/notes/shell-2b-drafts.md). A compose tab is either the space's EMPTY composer (no
// "draft" param, keyed "compose": at most one per space) or a DRAFT (param "draft" = its id,
// keyed "compose:draft:<id>"). Each space lists its drafts, newest first, whether or not each
// has a tab open; the empty composer is never listed. A draft's tab is open in at most one
// place, in the space that lists it: a draft dragged to another space takes its entry along.
// The draft's text is not in the layout; only its id, label and the tab's other params are.

// DraftParam is the compose tab param that holds its draft's id.
const DraftParam = "draft"

// MaxDraftLabel is the most runes a draft's label keeps.
const MaxDraftLabel = 80

func init() {
	register("new_thread", func() Op { return &NewThread{} })
	register("start_draft", func() Op { return &StartDraft{} })
	register("label_draft", func() Op { return &LabelDraft{} })
	register("clear_draft", func() Op { return &ClearDraft{} })
	register("discard_draft", func() Op { return &DiscardDraft{} })
	register("open_draft", func() Op { return &OpenDraft{} })
}

// draftLabel is a label as the layout stores it: one line, spaces collapsed, at most
// MaxDraftLabel runes.
func draftLabel(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= MaxDraftLabel {
		return s
	}
	return strings.TrimSpace(string([]rune(s)[:MaxDraftLabel]))
}

// draftOf is the id of the draft a tab is, or "" for any other tab (the empty composer too).
func draftOf(tb *Tab) string {
	if tb == nil || tb.Kind != "compose" {
		return ""
	}
	return tb.Params[DraftParam]
}

// draftParams is a draft tab's params without its id: what its Draft entry keeps.
func draftParams(p map[string]string) map[string]string {
	out := maps.Clone(p)
	delete(out, DraftParam)
	if len(out) == 0 {
		return nil
	}
	return out
}

// findDraft is the draft with that id and the space that lists it, or nils.
func findDraft(st *State, id string) (*Space, *Draft) {
	if id == "" {
		return nil, nil
	}
	for _, sp := range st.Spaces {
		for _, d := range sp.Drafts {
			if d != nil && d.ID == id {
				return sp, d
			}
		}
	}
	return nil, nil
}

// draftTab is the open tab of draft id, its pane and its space, or nils.
func draftTab(st *State, id string) (*Space, *Node, *Tab) {
	for _, sp := range st.Spaces {
		for _, p := range Panes(sp.Root) {
			for _, tb := range p.Tabs {
				if draftOf(tb) == id {
					return sp, p, tb
				}
			}
		}
	}
	return nil, nil, nil
}

// emptyComposer is the space's empty composer tab and its pane, or nils.
func emptyComposer(sp *Space) (*Node, *Tab) {
	for _, p := range Panes(sp.Root) {
		for _, tb := range p.Tabs {
			if tb.Kind == "compose" && draftOf(tb) == "" {
				return p, tb
			}
		}
	}
	return nil, nil
}

// unlistDraft drops draft id from the space that lists it.
func unlistDraft(st *State, id string) {
	if sp, _ := findDraft(st, id); sp != nil {
		sp.Drafts = slices.DeleteFunc(sp.Drafts, func(d *Draft) bool { return d.ID == id })
		if len(sp.Drafts) == 0 {
			sp.Drafts = nil
		}
	}
}

// checkDraftTab refuses a compose tab about to enter space sp whose draft that space does
// not list: not_found when no space lists it, failed_precondition when another does (the
// draft is open or kept there; move its tab instead).
func checkDraftTab(st *State, sp *Space, tb *Tab) error {
	id := draftOf(tb)
	if id == "" {
		return nil
	}
	dsp, _ := findDraft(st, id)
	switch {
	case dsp == nil:
		return fmt.Errorf("draft %q: %w", id, ErrNotFound)
	case dsp != sp:
		return fmt.Errorf("draft %s belongs to space %s, not %s: %w", id, dsp.ID, sp.ID, ErrFailedPrecondition)
	}
	return nil
}

// followDrafts runs after every op (finish): a draft whose tab is open in another space than
// the one listing it moves to the top of the tab's space's list (its tab was dragged there),
// and each entry takes the params of its open tab, so a closed draft reopens as it was.
func followDrafts(st *State) {
	for _, sp := range st.Spaces {
		for _, p := range Panes(sp.Root) {
			for _, tb := range p.Tabs {
				id := draftOf(tb)
				if id == "" {
					continue
				}
				dsp, d := findDraft(st, id)
				if d == nil {
					continue // Check reports it: every op lists a draft before opening its tab
				}
				if dsp != sp {
					unlistDraft(st, id)
					sp.Drafts = slices.Insert(sp.Drafts, 0, d)
				}
				d.Params = draftParams(tb.Params)
			}
		}
	}
}

// NewThread is the New thread action: it focuses the space's empty composer when the space
// has one (giving it Params when given), and otherwise opens one in the focused pane, or in
// Pane (a pane's "+": an empty composer open elsewhere in the space moves there). Space is
// the space ("" is the current one, or Pane's). It is open_surface with a compose tab, in the
// W x H pane area.
type NewThread struct {
	Space  string            `json:"space,omitempty"`
	Pane   string            `json:"pane,omitempty"`
	Params map[string]string `json:"params,omitempty"`
	Focus  bool              `json:"focus,omitempty"`
	W      float64           `json:"w,omitempty"`
	H      float64           `json:"h,omitempty"`
}

// OpName implements Op.
func (*NewThread) OpName() string { return "new_thread" }

func (o *NewThread) apply(t *tx) (Result, error) {
	if o.Params[DraftParam] != "" {
		return Result{}, fmt.Errorf("new_thread opens the empty composer; a draft opens with open_draft: %w", ErrInvalidArgument)
	}
	op := &OpenSurface{Space: o.Space, Pane: o.Pane, Tab: &Tab{Kind: "compose", Params: maps.Clone(o.Params)}, Focus: o.Focus, W: o.W, H: o.H}
	return op.apply(t)
}

// StartDraft makes a space's empty composer a draft: the user typed its first text. The
// draft takes Draft as its id (refused when in use) or a new "d-" id, and Label (one line,
// at most MaxDraftLabel runes) for lists; it goes to the top of its space's drafts. The space
// then has no empty composer, so New thread opens a new one. Result.Draft is the id.
type StartDraft struct {
	Tab   string `json:"tab"`
	Draft string `json:"draft,omitempty"`
	Label string `json:"label,omitempty"`
}

// OpName implements Op.
func (*StartDraft) OpName() string { return "start_draft" }

func (o *StartDraft) apply(t *tx) (Result, error) {
	sp, pane, tb, err := t.tab(o.Tab)
	if err != nil {
		return Result{}, err
	}
	if tb.Kind != "compose" {
		return Result{}, fmt.Errorf("tab %s is a %s tab, not a composer: %w", tb.ID, tb.Kind, ErrInvalidArgument)
	}
	if id := draftOf(tb); id != "" {
		return Result{}, fmt.Errorf("composer %s is already draft %s: %w", tb.ID, id, ErrFailedPrecondition)
	}
	id := strings.TrimSpace(o.Draft)
	switch {
	case o.Draft == "":
		id = t.newID("d-")
	case id != o.Draft:
		return Result{}, fmt.Errorf("draft id %q has spaces around it: %w", o.Draft, ErrInvalidArgument)
	case usedIDs(t.st)[id]:
		return Result{}, fmt.Errorf("draft id %q: %w", id, ErrAlreadyExists)
	}
	params := maps.Clone(tb.Params)
	if params == nil {
		params = map[string]string{}
	}
	params[DraftParam] = id
	tb.Params = params
	_, key, err := Identify(tb)
	if err != nil {
		return Result{}, err
	}
	tb.Key = key
	sp.Drafts = slices.Insert(sp.Drafts, 0, &Draft{ID: id, Label: draftLabel(o.Label), Params: draftParams(params)})
	return Result{Space: sp.ID, Pane: pane.ID, Tab: tb.ID, Draft: id}, nil
}

// LabelDraft sets a draft's label (one line, at most MaxDraftLabel runes).
type LabelDraft struct {
	Draft string `json:"draft"`
	Label string `json:"label"`
}

// OpName implements Op.
func (*LabelDraft) OpName() string { return "label_draft" }

func (o *LabelDraft) apply(t *tx) (Result, error) {
	sp, d, err := t.draft(o.Draft)
	if err != nil {
		return Result{}, err
	}
	d.Label = draftLabel(o.Label)
	res := Result{Space: sp.ID, Draft: d.ID}
	if _, p, tb := draftTab(t.st, d.ID); tb != nil {
		res.Pane, res.Tab = p.ID, tb.ID
	}
	return res, nil
}

// draft is the draft with that id and the space that lists it.
func (t *tx) draft(id string) (*Space, *Draft, error) {
	if id == "" {
		return nil, nil, fmt.Errorf("no draft given: %w", ErrInvalidArgument)
	}
	sp, d := findDraft(t.st, id)
	if d == nil {
		return nil, nil, fmt.Errorf("draft %q: %w", id, ErrNotFound)
	}
	return sp, d, nil
}

// ClearDraft makes a draft empty again: the user deleted all its text. The draft leaves its
// space's list and its tab is the space's empty composer again. When the space already has
// an empty composer, the one of the two without the focus closes (the draft's tab when
// neither has it). A draft whose tab is closed is just dropped.
type ClearDraft struct {
	Draft string `json:"draft"`
}

// OpName implements Op.
func (*ClearDraft) OpName() string { return "clear_draft" }

func (o *ClearDraft) apply(t *tx) (Result, error) {
	sp, d, err := t.draft(o.Draft)
	if err != nil {
		return Result{}, err
	}
	unlistDraft(t.st, d.ID)
	res := Result{Space: sp.ID, Draft: d.ID}
	_, p, tb := draftTab(t.st, d.ID)
	if tb == nil {
		return res, nil
	}
	if ep, empty := emptyComposer(sp); empty != nil {
		if focusedTab(sp) != tb.ID {
			detach(sp, p, tb.ID)
			forget(sp, tb.ID)
			res.Closed = []*Tab{tb}
			res.Pane, res.Tab = ep.ID, empty.ID
			return res, nil
		}
		detach(sp, ep, empty.ID)
		forget(sp, empty.ID)
		res.Closed = []*Tab{empty}
		_, p, _ = t.st.FindTab(tb.ID)
	}
	tb.Params = draftParams(tb.Params)
	tb.Key = "compose"
	res.Pane, res.Tab = p.ID, tb.ID
	return res, nil
}

// DiscardDraft throws a draft away (its sidebar row's discard): it leaves its space's list
// and its tab, when open, closes (Result.Closed); the focus returns as close_tab's.
type DiscardDraft struct {
	Draft string `json:"draft"`
}

// OpName implements Op.
func (*DiscardDraft) OpName() string { return "discard_draft" }

func (o *DiscardDraft) apply(t *tx) (Result, error) {
	sp, d, err := t.draft(o.Draft)
	if err != nil {
		return Result{}, err
	}
	unlistDraft(t.st, d.ID)
	res := Result{Space: sp.ID, Draft: d.ID}
	if _, p, tb := draftTab(t.st, d.ID); tb != nil {
		wasFocused := focusedTab(sp) == tb.ID
		detach(sp, p, tb.ID)
		forget(sp, tb.ID)
		if wasFocused {
			refocus(sp)
		}
		res.Closed = []*Tab{tb}
	}
	return res, nil
}

// OpenDraft opens a draft (its sidebar row): its tab is focused where it is when open, and
// otherwise opens in its space's focused pane after the active tab, with the params it had.
type OpenDraft struct {
	Draft string `json:"draft"`
	Focus bool   `json:"focus,omitempty"`
	// W and H are the pane area (default DefaultW x DefaultH).
	W float64 `json:"w,omitempty"`
	H float64 `json:"h,omitempty"`
}

// OpName implements Op.
func (*OpenDraft) OpName() string { return "open_draft" }

func (o *OpenDraft) apply(t *tx) (Result, error) {
	sp, d, err := t.draft(o.Draft)
	if err != nil {
		return Result{}, err
	}
	params := maps.Clone(d.Params)
	if params == nil {
		params = map[string]string{}
	}
	params[DraftParam] = d.ID
	w, h := viewport(o.W, o.H)
	res, err := t.place(sp, nil, &Tab{Kind: "compose", Params: params}, o.Focus, w, h)
	if err != nil {
		return Result{}, err
	}
	res.Draft = d.ID
	return res, nil
}
