package layout

import (
	"errors"
	"fmt"
	"maps"
	"math"
	"slices"
	"strings"
)

// sizeTolerance is how far a split's sizes may sum from 1.
const sizeTolerance = 1e-9

// Check reports every way st is not in normal form, or nil. Normal form:
//   - at least one space; space ids unique, names not blank; the current and default spaces exist;
//   - every space, pane, split and tab id non-empty and unique in the whole state;
//   - no pane without tabs; each pane's active tab is one of its tabs;
//   - no split with fewer than two children, none directly in a split of the same direction,
//     one size per child, each positive, summing to 1;
//   - every tab valid for its kind (identity.go), its key the computed one, no manual name
//     unless the kind is renameable, and no two tabs with one key in the key's scope;
//   - a thread tab is in its thread's space;
//   - a space's focus names one of its panes ("" only when it has none); its MRU holds only
//     its open tabs, each once, at most MaxMRU; its reopen history at most MaxClosed entries,
//     each with a tab;
//   - every thread state names an existing space;
//   - draft ids non-empty and listed once in the whole state, labels as draftLabel leaves
//     them, no "draft" key in a draft's params; a composer that is a draft is listed by its
//     own space, is the only tab of that draft anywhere, and has its entry's params.
func Check(st *State) error {
	c := &checker{st: st, ids: map[string]bool{}, global: map[string]string{}, drafts: map[string]*Space{}, draftTabs: map[string]string{}}
	c.run()
	return errors.Join(c.errs...)
}

type checker struct {
	st        *State
	ids       map[string]bool
	global    map[string]string // key -> tab id, for global-scope kinds
	drafts    map[string]*Space // draft id -> the space listing it
	draftTabs map[string]string // draft id -> its open tab
	errs      []error
}

func (c *checker) fail(format string, a ...any) {
	c.errs = append(c.errs, fmt.Errorf(format, a...))
}

func (c *checker) id(id, what string) {
	switch {
	case id == "":
		c.fail("%s without an id", what)
	case c.ids[id]:
		c.fail("%s id %q used twice", what, id)
	}
	c.ids[id] = true
}

func (c *checker) run() {
	st := c.st
	if st.V != Version {
		c.fail("version %d, want %d", st.V, Version)
	}
	if len(st.Spaces) == 0 {
		c.fail("no space")
	}
	for _, sp := range st.Spaces {
		if sp == nil {
			continue
		}
		for _, d := range sp.Drafts {
			switch {
			case d == nil:
				c.fail("space %s: nil draft", sp.ID)
			case d.ID == "":
				c.fail("space %s: draft without an id", sp.ID)
			case c.drafts[d.ID] != nil:
				c.fail("draft %s listed twice", d.ID)
			default:
				c.drafts[d.ID] = sp
				if d.Label != draftLabel(d.Label) {
					c.fail("draft %s: label %q is not one short line", d.ID, d.Label)
				}
				if _, ok := d.Params[DraftParam]; ok {
					c.fail("draft %s: params hold a draft id", d.ID)
				}
			}
		}
	}
	for _, sp := range st.Spaces {
		if sp == nil {
			c.fail("nil space")
			continue
		}
		c.space(sp)
	}
	if st.Space(st.CurrentSpace) == nil {
		c.fail("current space %q does not exist", st.CurrentSpace)
	}
	if st.Space(st.DefaultSpace) == nil {
		c.fail("default space %q does not exist", st.DefaultSpace)
	}
	for id, ts := range st.Threads {
		switch {
		case ts == nil:
			c.fail("thread %s: nil state", id)
		case st.Space(ts.Space) == nil:
			c.fail("thread %s: space %q does not exist", id, ts.Space)
		case ts.Remembered != nil:
			for _, rt := range ts.Remembered.Tabs {
				if rt.Tab == nil {
					c.fail("thread %s: remembered nil tab", id)
				} else if _, _, err := Identify(rt.Tab); err != nil {
					c.fail("thread %s: remembered tab %s: %v", id, rt.Tab.ID, err)
				}
			}
		}
	}
}

func (c *checker) space(sp *Space) {
	c.id(sp.ID, "space")
	if strings.TrimSpace(sp.Name) == "" {
		c.fail("space %s: blank name", sp.ID)
	}
	keys := map[string]string{}
	open := map[string]bool{}
	c.node(sp, sp.Root, "", keys, open)
	panes := PaneIDs(sp.Root)
	switch {
	case sp.Root == nil && sp.Focus != "":
		c.fail("space %s: focus %q with no panes", sp.ID, sp.Focus)
	case sp.Root != nil && !slices.Contains(panes, sp.Focus):
		c.fail("space %s: focus %q is not one of its panes", sp.ID, sp.Focus)
	}
	if len(sp.MRU) > MaxMRU {
		c.fail("space %s: MRU holds %d entries", sp.ID, len(sp.MRU))
	}
	if len(sp.Closed) > MaxClosed {
		c.fail("space %s: reopen history holds %d entries", sp.ID, len(sp.Closed))
	}
	for i, e := range sp.Closed {
		if e == nil || len(e.Tabs) == 0 || slices.Contains(e.Tabs, nil) {
			c.fail("space %s: reopen history entry %d holds no tab, or a nil one", sp.ID, i)
		}
	}
	seen := map[string]bool{}
	for _, id := range sp.MRU {
		if !open[id] || seen[id] {
			c.fail("space %s: MRU entry %q is not an open tab of the space, or repeats", sp.ID, id)
		}
		seen[id] = true
	}
}

func (c *checker) node(sp *Space, n *Node, parent Dir, keys map[string]string, open map[string]bool) {
	if n == nil {
		return
	}
	switch n.T {
	case NodePane:
		c.id(n.ID, "pane")
		if len(n.Kids) > 0 || len(n.Sizes) > 0 || n.Dir != "" {
			c.fail("pane %s has split fields", n.ID)
		}
		if len(n.Tabs) == 0 {
			c.fail("pane %s has no tabs", n.ID)
		}
		for _, tb := range n.Tabs {
			if tb == nil {
				c.fail("pane %s: nil tab", n.ID)
				continue
			}
			c.tab(sp, tb, keys)
			open[tb.ID] = true
		}
		if n.TabIndex(n.Active) < 0 {
			c.fail("pane %s: active tab %q is not one of its tabs", n.ID, n.Active)
		}
	case NodeSplit:
		c.id(n.ID, "split")
		if len(n.Tabs) > 0 || n.Active != "" {
			c.fail("split %s has pane fields", n.ID)
		}
		if n.Dir != Row && n.Dir != Col {
			c.fail("split %s: direction %q", n.ID, n.Dir)
		}
		if n.Dir == parent {
			c.fail("split %s repeats its parent's direction", n.ID)
		}
		if len(n.Kids) < 2 {
			c.fail("split %s has %d children", n.ID, len(n.Kids))
		}
		if len(n.Sizes) != len(n.Kids) {
			c.fail("split %s: %d sizes for %d children", n.ID, len(n.Sizes), len(n.Kids))
		}
		for _, s := range n.Sizes {
			if !(s > 0) || math.IsInf(s, 0) {
				c.fail("split %s: size %v", n.ID, s)
			}
		}
		if tot := sum(n.Sizes); math.Abs(tot-1) > sizeTolerance {
			c.fail("split %s: sizes sum to %v", n.ID, tot)
		}
		for _, k := range n.Kids {
			if k == nil {
				c.fail("split %s: nil child", n.ID)
				continue
			}
			c.node(sp, k, n.Dir, keys, open)
		}
	default:
		c.fail("node %q: type %q", n.ID, n.T)
	}
}

func (c *checker) tab(sp *Space, tb *Tab, keys map[string]string) {
	c.id(tb.ID, "tab")
	k, key, err := Identify(tb)
	if err != nil {
		c.fail("tab %s: %v", tb.ID, err)
		return
	}
	if tb.Key != key {
		c.fail("tab %s: key %q, want %q", tb.ID, tb.Key, key)
	}
	if tb.Name != "" && !k.Renameable {
		c.fail("tab %s: a %s tab takes no name", tb.ID, tb.Kind)
	}
	scope := keys
	if k.Scope == ScopeGlobal {
		scope = c.global
	}
	if other, ok := scope[key]; ok {
		c.fail("tabs %s and %s are both %s", other, tb.ID, key)
	}
	scope[key] = tb.ID
	if tb.Kind == "thread" && c.st.SpaceOf(tb.Thread) != sp.ID {
		c.fail("thread tab %s is in space %s, its thread lives in %s", tb.ID, sp.ID, c.st.SpaceOf(tb.Thread))
	}
	if id := draftOf(tb); id != "" {
		if other, ok := c.draftTabs[id]; ok {
			c.fail("tabs %s and %s are both draft %s", other, tb.ID, id)
		}
		c.draftTabs[id] = tb.ID
		if c.drafts[id] != sp {
			c.fail("draft tab %s: space %s does not list draft %s", tb.ID, sp.ID, id)
		} else if _, d := findDraft(c.st, id); !maps.Equal(d.Params, draftParams(tb.Params)) {
			c.fail("draft %s: params %v, its tab has %v", id, d.Params, draftParams(tb.Params))
		}
	}
}
