package command

import (
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// Terminal command lines and who reads them (docs/notes/shell-24a-import-moves.md, item 7).
//
// A terminal's foreground and last command lines (Terminal.foreground, last_command) and the
// line a snoozed terminal's tab keeps for "Run again" (the "ran" param, a remembered tab's
// Fresh.Ran, a quick terminal's Ran) are what the user typed, arguments and all. The app, the CLI, a thread's model
// through its CLI and a plugin run as the user and could read the process table themselves.
// A page cannot: its read-only verbs run without asking, so they leave the lines out for an
// untrusted caller (a page, or a call that does not say who it is).

// hidesCommandLines reports whether uctx's caller does not get terminal command lines.
func hidesCommandLines(uctx Context) bool { return uctx.Untrusted() }

// terminalsFor is terms as uctx's caller may read them: copies without the command lines when
// it may not, terms itself otherwise.
func terminalsFor(uctx Context, terms []*v1.Terminal) []*v1.Terminal {
	if !hidesCommandLines(uctx) {
		return terms
	}
	out := make([]*v1.Terminal, len(terms))
	for i, t := range terms {
		c := proto.Clone(t).(*v1.Terminal)
		c.Foreground, c.LastCommand = "", ""
		out[i] = c
	}
	return out
}

// layoutFor is st as uctx's caller may read it: a copy without the command lines snoozed
// terminals keep (a tab's "ran" param, a remembered tab's Fresh.Ran, a quick terminal's Ran)
// when it may not.
func layoutFor(uctx Context, st *core.State) *core.State {
	if !hidesCommandLines(uctx) {
		return st
	}
	c := st.Clone()
	for _, sp := range c.Spaces {
		for _, p := range core.Panes(sp.Root) {
			for _, tb := range p.Tabs {
				withoutRan(tb)
			}
		}
	}
	for _, ts := range c.Threads {
		if ts.Quick != nil {
			ts.Quick.Ran = ""
		}
		if ts.Remembered == nil {
			continue
		}
		for i := range ts.Remembered.Tabs {
			rt := &ts.Remembered.Tabs[i]
			withoutRan(rt.Tab)
			if rt.Fresh != nil {
				rt.Fresh.Ran = ""
			}
		}
	}
	return c
}

// withoutRan drops tab tb's "ran" param (its copy's: tb belongs to a cloned state).
func withoutRan(tb *core.Tab) {
	if tb == nil || tb.Params[core.RanParam] == "" {
		return
	}
	delete(tb.Params, core.RanParam)
	if len(tb.Params) == 0 {
		tb.Params = nil
	}
}
