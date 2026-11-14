package command

import (
	"context"
	"errors"
	"fmt"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	core "github.com/alexwaumann/code-foundry/internal/layout"
)

func tabIDArg(desc string) ArgSpec {
	return ArgSpec{Name: "tab", Type: String, ID: TabID, Description: desc + IDHelp}
}

// tabCommands are tab.focus, tab.move, tab.close, tab.reopen, tab.rename, tab.auto-name, tab.next and tab.previous.
func (l layout) tabCommands() []Command {
	return []Command{
		{
			Name: "tab.focus", Title: "Focus Tab", Category: layoutCategory, Page: PageState,
			Description: "Make a tab active in its pane and give it the focus (switching to its space). From inside a thread " +
				"without --focus it only becomes active in its pane, unless that pane has the user's focus.",
			Args:      []ArgSpec{func() ArgSpec { s := positional(tabIDArg("The tab")); s.Required = true; return s }(), focusArg},
			NoPalette: true, NoKeybinding: true,
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				c, err := l.apply(ctx, &core.FocusTab{Tab: a.String("tab")}, !wantsFocus(uctx, a))
				if err != nil {
					return Result{}, err
				}
				return layoutResult(uctx, c, "focused tab "+a.String("tab")), nil
			},
		},
		{
			Name: "tab.move", Title: "Move Tab", Category: layoutCategory, Page: PageState,
			Description: "Move a tab: into another pane's strip (--pane, at --index from 0), into a new pane on an edge of a " +
				"pane (--split with --edge), onto an edge of the whole pane area (--outer), or to another space's focused pane " +
				"(--space). A thread's own tab does not change space: move the thread (thread.space.move).",
			Args: []ArgSpec{
				func() ArgSpec { s := positional(tabIDArg("The tab to move")); s.Required = true; return s }(),
				paneIDArg("pane", "Into this pane's strip"),
				{Name: "index", Type: Int, Description: "With --pane: its place in the strip, from 0 (default: the end)"},
				paneIDArg("split", "Into a new pane on --edge of this pane"),
				edgeArg("edge", "With --split: the edge of that pane"),
				edgeArg("outer", "Into a new pane on this edge of the whole pane area (of --space, default the tab's own)"),
				spaceArg("To this space: its focused pane, or with --outer its pane area"),
				fracArg, focusArg,
			},
			NoPalette: true, NoKeybinding: true,
			Run: l.tabMove,
		},
		{
			Name: "tab.close", Title: "Close Tab", Category: layoutCategory, Page: PageState,
			Description: "Close a tab (default: the focused tab); the focus returns to what had it before. A thread's tab closes " +
				"the thread from its space as thread.close does (it is never archived). Closed by the user (the app, or the CLI " +
				"outside a thread), it goes in its space's reopen history (tab.reopen).",
			Args:        []ArgSpec{positional(tabIDArg("The tab (default: the focused one; from inside a thread, required)"))},
			Keybindings: []string{"cmd+w"},
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				snap, err := l.state()
				if err != nil {
					return Result{}, err
				}
				_, _, tb, err := l.tab(snap.State, uctx, a, "tab")
				if err != nil {
					return Result{}, err
				}
				// A close by the user is recorded for tab.reopen; a model's is not.
				var op core.Op = &core.CloseTab{Tab: tb.ID, Record: uctx.FromUser()}
				if tb.Kind == "thread" {
					op = &core.CloseThread{Thread: tb.Thread, Record: uctx.FromUser()}
				}
				c, err := l.apply(ctx, op, !uctx.FromUser())
				if err != nil {
					return Result{}, err
				}
				msg := "closed tab " + tb.ID
				if n := len(c.Result.Kept); n > 0 {
					msg += fmt.Sprintf("; %s of its thread remembered", plural(n, "linked tab"))
				}
				return layoutResult(uctx, c, msg), nil
			},
		},
		l.reopenCommand(),
		{
			Name: "tab.rename", Title: "Rename Tab", Category: layoutCategory, Page: PageState,
			Description: "Rename a tab (default: the focused tab). A thread's tab renames the thread (as thread.rename; in the app, " +
				"inline in the sidebar); a terminal's tab takes a name of its own, kept until --auto (or tab.auto-name) gives it back " +
				"its automatic name. Other tabs are named by what they show.",
			Args: []ArgSpec{
				positional(tabIDArg("The tab (default: the focused one; from inside a thread, required)")),
				{Name: "name", Type: String, Description: "The name; for a terminal, empty or --auto goes back to the automatic name"},
				{Name: "auto", Type: Bool, Description: "Go back to the automatic name: a thread's is generated again, a terminal's is what runs in it"},
			},
			Keybindings: []string{"cmd+r"},
			NoIndex:     true,
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				if a.Bool("auto") && a.String("name") != "" {
					return Result{}, InvalidArg("auto", "--auto and --name together")
				}
				return l.renameTab(ctx, uctx, a, a.String("name"), a.Bool("auto"))
			},
		},
		{
			Name: "tab.auto-name", Title: "Name Tab Automatically", Category: layoutCategory, Page: PageState,
			Description: "Give a tab its automatic name again (default: the focused tab): a thread's name is generated again from " +
				"its recent turns (thread.regenerate-name), a terminal's tab drops its own name for what runs in it.",
			Args:        []ArgSpec{positional(tabIDArg("The tab (default: the focused one; from inside a thread, required)"))},
			Keybindings: []string{"cmd+shift+r"},
			NoIndex:     true,
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				return l.renameTab(ctx, uctx, a, "", true)
			},
		},
		l.tabStep("tab.next", "Next Tab", "the next tab", 1, "cmd+shift+]"),
		l.tabStep("tab.previous", "Previous Tab", "the previous tab", -1, "cmd+shift+["),
	}
}

// tabStep is tab.next or tab.previous: the tab after (or before) the active one in a pane,
// round the strip.
func (l layout) tabStep(name, title, what string, step int, chord string) Command {
	return Command{
		Name: name, Title: title, Category: layoutCategory, Page: PageState,
		Description: "Focus " + what + " in the pane (default: the focused pane), going round the strip.",
		Args:        []ArgSpec{paneIDArg("pane", "The pane (default: the focused one; from inside a thread, required)"), focusArg},
		Keybindings: []string{chord},
		NoIndex:     true,
		Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
			snap, err := l.state()
			if err != nil {
				return Result{}, err
			}
			_, p, err := l.pane(snap.State, uctx, a, "pane")
			if err != nil {
				return Result{}, err
			}
			n := len(p.Tabs)
			i := p.TabIndex(p.Active)
			next := p.Tabs[((i+step)%n+n)%n].ID
			c, err := l.apply(ctx, &core.FocusTab{Tab: next}, !wantsFocus(uctx, a))
			if err != nil {
				return Result{}, err
			}
			return layoutResult(uctx, c, "focused tab "+next), nil
		},
	}
}

func (l layout) tabMove(ctx context.Context, uctx Context, a Args) (Result, error) {
	f, err := frac(a)
	if err != nil {
		return Result{}, err
	}
	op := &core.MoveTab{Tab: a.String("tab"), Space: a.String("space"), Frac: f}
	switch {
	case a.String("pane") != "" && (a.String("split") != "" || a.String("outer") != ""),
		a.String("split") != "" && a.String("outer") != "":
		return Result{}, InvalidArg("pane", "give one of --pane, --split (with --edge), --outer or --space")
	case a.String("pane") != "":
		op.Pane = a.String("pane")
		if a.Has("index") {
			i := a.Int("index")
			op.Index = &i
		}
	case a.String("split") != "":
		if a.String("edge") == "" {
			return Result{}, InvalidArg("edge", "--split needs --edge")
		}
		op.Pane, op.Edge = a.String("split"), core.Edge(a.String("edge"))
	case a.String("outer") != "":
		op.Edge = core.Edge(a.String("outer"))
	case a.String("space") == "":
		return Result{}, InvalidArg("pane", "give one of --pane, --split (with --edge), --outer or --space")
	}
	if a.String("edge") != "" && a.String("split") == "" {
		return Result{}, InvalidArg("edge", "--edge goes with --split; an edge of the whole area is --outer")
	}
	c, err := l.apply(ctx, op, !wantsFocus(uctx, a))
	if err != nil {
		return Result{}, err
	}
	return layoutResult(uctx, c, fmt.Sprintf("moved tab %s to pane %s in space %s", op.Tab, c.Result.Pane, c.Result.Space)), nil
}

// renameTab is tab.rename and tab.auto-name. A thread's tab is the thread: its name is the
// thread's (thread.rename, thread.regenerate-name). A terminal's tab takes a manual name, and
// "" goes back to the automatic one. Any other kind is refused by the op.
func (l layout) renameTab(ctx context.Context, uctx Context, a Args, name string, auto bool) (Result, error) {
	snap, err := l.state()
	if err != nil {
		return Result{}, err
	}
	_, _, tb, err := l.tab(snap.State, uctx, a, "tab")
	if err != nil {
		return Result{}, err
	}
	if tb.Kind == "thread" {
		return l.renameThread(ctx, tb.Thread, name, auto)
	}
	c, err := l.apply(ctx, &core.RenameTab{Tab: tb.ID, Name: name}, !uctx.FromUser())
	if err != nil {
		return Result{}, err
	}
	msg := "tab " + tb.ID + " goes by its automatic name"
	if name != "" {
		msg = fmt.Sprintf("renamed tab %s to %q", tb.ID, name)
	}
	return layoutResult(uctx, c, msg), nil
}

// renameThread names a thread from its tab: name, or with auto a generated one.
func (l layout) renameThread(ctx context.Context, thread, name string, auto bool) (Result, error) {
	if l.thread == nil {
		return Result{}, connect.NewError(connect.CodeUnimplemented, errors.New("this daemon cannot rename threads"))
	}
	if auto {
		res, err := l.thread.RegenerateName(ctx, connect.NewRequest(&v1.RegenerateNameRequest{Id: thread}))
		if err != nil {
			return Result{}, err
		}
		return Result{Message: "renamed thread " + threadLabel(res.Msg.GetThread()), JSON: res.Msg.GetThread()}, nil
	}
	if name == "" {
		return Result{}, InvalidArg("name", "a thread's tab is the thread: give --name, or --auto to generate one")
	}
	res, err := l.thread.Rename(ctx, connect.NewRequest(&v1.RenameThreadRequest{Id: thread, Name: name}))
	if err != nil {
		return Result{}, err
	}
	return Result{Message: "renamed thread " + threadLabel(res.Msg.GetThread()), JSON: res.Msg.GetThread()}, nil
}
