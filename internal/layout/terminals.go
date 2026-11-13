package layout

import (
	"fmt"
	"maps"
	"math"
	"slices"
)

// What the window's terminals need of the layout (docs/notes/shell-model.md, "Terminals";
// docs/notes/shell-6-lifecycle.md): a thread's quick terminal drawn open or closed, a tab
// that follows its terminal to the fresh shell that replaced it, a terminal that went away,
// and the ring of a thread's terminal tabs.

func init() {
	register("set_quick", func() Op { return &SetQuick{} })
	register("replace_terminal", func() Op { return &ReplaceTerminal{} })
	register("drop_terminal", func() Op { return &DropTerminal{} })
}

// TerminalParam is the param of a terminal tab that names its terminal.
const TerminalParam = "terminal"

// RanParam is the param of a terminal tab restored as a fresh shell after a snooze: the
// command its old shell was running, for its "Run again" line.
const RanParam = "ran"

// SetQuick opens or closes a thread's quick terminal (ThreadState.Quick), which is not a tab:
// it is drawn under the thread's conversation in the thread's pane. Height, when above
// zero, is its height in layout pixels; zero keeps the height it has. Either way it is no
// longer one a snooze ended (Quick.Fresh): it is as this op says. Its "Run again" line
// (Quick.Ran) stays unless ForgetRan.
type SetQuick struct {
	Thread    string  `json:"thread"`
	Open      bool    `json:"open"`
	Height    float64 `json:"height,omitempty"`
	ForgetRan bool    `json:"forget_ran,omitempty"`
}

// OpName implements Op.
func (*SetQuick) OpName() string { return "set_quick" }

func (o *SetQuick) apply(t *tx) (Result, error) {
	if o.Thread == "" {
		return Result{}, fmt.Errorf("no thread given: %w", ErrInvalidArgument)
	}
	if o.Height < 0 || math.IsNaN(o.Height) || math.IsInf(o.Height, 0) || o.Height > 1e6 {
		return Result{}, fmt.Errorf("quick terminal height %v: %w", o.Height, ErrInvalidArgument)
	}
	ts := t.st.Threads[o.Thread]
	if ts == nil && !o.Open && o.Height == 0 {
		return Result{}, nil // closed already: no record to write
	}
	ts = threadState(t.st, o.Thread)
	q := Quick{Open: o.Open}
	if ts.Quick != nil {
		q.Height = ts.Quick.Height
		if !o.ForgetRan {
			q.Ran = ts.Quick.Ran
		}
	}
	if o.Height > 0 {
		q.Height = o.Height
	}
	ts.Quick = &q
	if q == (Quick{}) {
		ts.Quick = nil
	}
	prune(t.st, o.Thread)
	return Result{}, nil
}

// prune drops thread's record when it stores nothing the default would not give.
func prune(st *State, thread string) {
	ts := st.Threads[thread]
	if ts != nil && ts.Quick == nil && ts.Remembered == nil && len(ts.Last) == 0 && ts.Space == st.DefaultSpace {
		delete(st.Threads, thread)
	}
}

// ReplaceTerminal points every tab of terminal Old at terminal New: the open tab (it stays
// where it is, with its name and its other params) and the remembered tabs that still run.
// terminal.reset starts a fresh shell for an old one, and the daemon restores a snoozed
// thread's terminals as fresh shells; the tab follows. Result.Tab is the open tab, if any.
type ReplaceTerminal struct {
	Old string `json:"old"`
	New string `json:"new"`
}

// OpName implements Op.
func (*ReplaceTerminal) OpName() string { return "replace_terminal" }

func (o *ReplaceTerminal) apply(t *tx) (Result, error) {
	if o.Old == "" || o.New == "" {
		return Result{}, fmt.Errorf("replace_terminal needs old and new: %w", ErrInvalidArgument)
	}
	if o.Old == o.New {
		return Result{}, nil
	}
	if tb := terminalTab(t.st, o.New); tb != nil {
		return Result{}, fmt.Errorf("terminal %s already has tab %s: %w", o.New, tb.ID, ErrAlreadyExists)
	}
	retarget := func(tb *Tab) {
		tb.Params = maps.Clone(tb.Params)
		tb.Params[TerminalParam] = o.New
		_, tb.Key, _ = Identify(tb)
	}
	var res Result
	if sp, p, tb := findTerminalTab(t.st, o.Old); tb != nil {
		retarget(tb)
		res = Result{Space: sp.ID, Pane: p.ID, Tab: tb.ID}
	}
	for _, ts := range t.st.Threads {
		if ts.Remembered == nil {
			continue
		}
		for i, rt := range ts.Remembered.Tabs {
			if rt.Fresh == nil && isTerminalOf(rt.Tab, o.Old) {
				ts.Remembered.Tabs[i].Tab = rt.Tab.Clone()
				retarget(ts.Remembered.Tabs[i].Tab)
			}
		}
	}
	return res, nil
}

// DropTerminal is a terminal that went away (it exited, or was removed): its open tab
// closes (Result.Closed; the focus returns as close_tab's), and a remembered tab of it that
// was still running is forgotten, so its thread does not bring back a dead terminal. A tab
// remembered as a fresh shell (a snoozed thread's) stays: its terminal ended on purpose.
type DropTerminal struct {
	Terminal string `json:"terminal"`
}

// OpName implements Op.
func (*DropTerminal) OpName() string { return "drop_terminal" }

func (o *DropTerminal) apply(t *tx) (Result, error) {
	if o.Terminal == "" {
		return Result{}, fmt.Errorf("no terminal given: %w", ErrInvalidArgument)
	}
	var res Result
	if sp, p, tb := findTerminalTab(t.st, o.Terminal); tb != nil {
		wasFocused := focusedTab(sp) == tb.ID
		detach(sp, p, tb.ID)
		forget(sp, tb.ID)
		if wasFocused {
			refocus(sp)
		}
		res = Result{Space: sp.ID, Closed: []*Tab{tb}}
	}
	for id, ts := range t.st.Threads {
		if ts.Remembered == nil {
			continue
		}
		ts.Remembered.Tabs = slices.DeleteFunc(ts.Remembered.Tabs, func(rt RememberedTab) bool {
			return rt.Fresh == nil && isTerminalOf(rt.Tab, o.Terminal)
		})
		if len(ts.Remembered.Tabs) == 0 {
			ts.Remembered = nil
			prune(t.st, id)
		}
	}
	return res, nil
}

// isTerminalOf reports whether tb is a terminal tab of terminal id.
func isTerminalOf(tb *Tab, id string) bool {
	return tb != nil && tb.Kind == "terminal" && tb.Params[TerminalParam] == id
}

// findTerminalTab is terminal id's open tab (a terminal is in one tab at most), its pane and
// its space, or nils.
func findTerminalTab(st *State, id string) (*Space, *Node, *Tab) {
	for _, sp := range st.Spaces {
		for _, p := range Panes(sp.Root) {
			for _, tb := range p.Tabs {
				if isTerminalOf(tb, id) {
					return sp, p, tb
				}
			}
		}
	}
	return nil, nil, nil
}

// terminalTab is terminal id's open tab, or nil.
func terminalTab(st *State, id string) *Tab {
	_, _, tb := findTerminalTab(st, id)
	return tb
}

// Holds reports whether the layout holds terminal id: an open tab shows it, or a thread
// remembers it running (closed with its thread, to come back when the thread opens).
// A terminal the layout does not hold is not the layout's to end.
func Holds(st *State, id string) bool {
	if terminalTab(st, id) != nil {
		return true
	}
	for _, ts := range st.Threads {
		if ts.Remembered == nil {
			continue
		}
		for _, rt := range ts.Remembered.Tabs {
			if rt.Fresh == nil && isTerminalOf(rt.Tab, id) {
				return true
			}
		}
	}
	return false
}

// HeldTerminals lists the terminal ids the layout holds (Holds), sorted.
func HeldTerminals(st *State) []string {
	set := map[string]bool{}
	for _, sp := range st.Spaces {
		for _, p := range Panes(sp.Root) {
			for _, tb := range p.Tabs {
				if tb.Kind == "terminal" && tb.Params[TerminalParam] != "" {
					set[tb.Params[TerminalParam]] = true
				}
			}
		}
	}
	for _, ts := range st.Threads {
		if ts.Remembered == nil {
			continue
		}
		for _, rt := range ts.Remembered.Tabs {
			if rt.Fresh == nil && rt.Tab != nil && rt.Tab.Kind == "terminal" && rt.Tab.Params[TerminalParam] != "" {
				set[rt.Tab.Params[TerminalParam]] = true
			}
		}
	}
	return slices.Sorted(maps.Keys(set))
}

// RingStep is where terminal.cycle goes from a tab (docs/notes/shell-model.md, cmd+shift+j:
// "the thread, each of its terminal tabs, the thread; from a view it starts at the first
// terminal"). Tab is the tab to focus; when it is "", the thread's own tab is next and it
// is not open (the caller opens the thread).
type RingStep struct {
	Thread string
	Tab    string
}

// NextInRing is the step after tab from in its thread's ring: the thread's tab, then each of
// the thread's linked terminal tabs in its space, in layout order, then the thread's tab
// again. From the thread's tab it goes to the first terminal; from a terminal to the next,
// and from the last back to the thread; from any other of the thread's linked tabs (a view)
// to the first terminal. A thread with no terminal tab has a ring of one: the thread.
// A tab that belongs to no thread is refused (ErrFailedPrecondition).
func NextInRing(st *State, from string) (RingStep, error) {
	_, _, tb := st.FindTab(from)
	if tb == nil {
		return RingStep{}, fmt.Errorf("tab %q: %w", from, ErrNotFound)
	}
	if tb.Thread == "" {
		return RingStep{}, fmt.Errorf("tab %s belongs to no thread: %w", from, ErrFailedPrecondition)
	}
	thread := tb.Thread
	var ring []string
	if sp := st.Space(st.SpaceOf(thread)); sp != nil {
		for _, p := range Panes(sp.Root) {
			for _, x := range p.Tabs {
				if x.Kind == "terminal" && x.Thread == thread {
					ring = append(ring, x.ID)
				}
			}
		}
	}
	threadTab := threadTabID(st, thread)
	next := threadTab
	switch i := slices.Index(ring, from); {
	case tb.Kind == "terminal" && i >= 0 && i+1 < len(ring):
		next = ring[i+1]
	case tb.Kind == "terminal" && i >= 0:
		// the last terminal: back to the thread
	case len(ring) > 0:
		next = ring[0] // the thread itself, a view, or a terminal of it in another space
	}
	if next == from {
		return RingStep{Thread: thread, Tab: from}, nil
	}
	return RingStep{Thread: thread, Tab: next}, nil
}
