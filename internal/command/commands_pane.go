package command

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"connectrpc.com/connect"

	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// edgeArg is an edge of a pane or of the whole pane area.
func edgeArg(name, desc string) ArgSpec {
	return ArgSpec{Name: name, Type: Enum, Enum: []string{"left", "right", "top", "bottom"}, Description: desc}
}

// fracArg is the share of the room a new pane takes.
var fracArg = ArgSpec{Name: "frac", Type: String, Description: "The share of the room the new pane takes, between 0 and 1 (default: half)"}

func frac(a Args) (float64, error) {
	v := a.String("frac")
	if v == "" {
		return 0, nil
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil || !(f > 0 && f < 1) {
		return 0, InvalidArg("frac", "--frac %q: a number between 0 and 1", v)
	}
	return f, nil
}

// directions are the four direction verbs' names and the side each looks at.
var directions = []struct {
	name, title string
	side        core.Edge
	// letter and arrow are the direction's keys: ctrl+cmd+<key> focuses that way, with shift it
	// moves the pane (docs/notes/shell-model.md, "Keys").
	letter, arrow string
}{
	{"left", "Left", core.Left, "h", "arrowleft"}, {"down", "Down", core.Bottom, "j", "arrowdown"},
	{"up", "Up", core.Top, "k", "arrowup"}, {"right", "Right", core.Right, "l", "arrowright"},
}

func paneIDArg(name, desc string) ArgSpec {
	return ArgSpec{Name: name, Type: String, ID: PaneID, Description: desc + IDHelp}
}

// paneCommands are pane.focus, pane.focus.<direction>, pane.move, pane.move.<direction>,
// pane.split, pane.close and pane.resize.
func (l layout) paneCommands() []Command {
	cmds := []Command{
		{
			Name: "pane.focus", Title: "Focus Pane", Category: layoutCategory, Page: PageState,
			Description: "Give a pane the focus (its active tab takes the keyboard).",
			Args:        []ArgSpec{func() ArgSpec { s := paneIDArg("pane", "The pane"); s.Required = true; return s }(), focusArg},
			NoPalette:   true, NoKeybinding: true, NoIndex: true,
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				if err := onlyFocus(uctx, a, "pane.focus"); err != nil {
					return Result{}, err
				}
				c, err := l.apply(ctx, &core.FocusPane{Pane: a.String("pane")}, false)
				if err != nil {
					return Result{}, err
				}
				return layoutResult(uctx, c, "focused pane "+a.String("pane")), nil
			},
		},
		{
			Name: "pane.move", Title: "Move Pane", Category: layoutCategory, Page: PageState,
			Description: "Move a whole pane: beside another pane (--beside with --edge), into another pane's strip (--into, " +
				"its tabs join at --index), onto an edge of the whole pane area (--outer), or to another space (--space). " +
				"A pane moved to another space goes whole: each thread whose tab it holds moves there too, with its " +
				"linked tabs (as thread.space.move).",
			Args: []ArgSpec{
				func() ArgSpec {
					s := paneIDArg("pane", "The pane to move")
					s.Required, s.Positional = true, true
					return s
				}(),
				paneIDArg("beside", "Put it beside this pane, on --edge"),
				edgeArg("edge", "The edge of --beside it goes on"),
				paneIDArg("into", "Merge its tabs into this pane's strip"),
				{Name: "index", Type: Int, Description: "With --into: where its tabs join the strip, from 0 (default: the end)"},
				edgeArg("outer", "Put it on this edge of the whole pane area"),
				spaceArg("Move it to this space"),
				fracArg, focusArg,
			},
			NoPalette: true, NoKeybinding: true,
			Run: l.paneMove,
		},
		{
			Name: "pane.split", Title: "Split Pane", Category: layoutCategory, Page: PageState,
			Description: "Split a tab off a pane (default: the focused pane's active tab) into a new pane on an edge of it.",
			Args: []ArgSpec{
				paneIDArg("pane", "The pane (default: the focused one; from inside a thread, required)"),
				{Name: "tab", Type: String, ID: TabID, Description: "The tab to split off (default: the pane's active tab)" + IDHelp},
				func() ArgSpec { s := edgeArg("edge", "The edge the new pane goes on"); s.Default = "right"; return s }(),
				fracArg, focusArg,
			},
			NoIndex: true,
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				snap, err := l.state()
				if err != nil {
					return Result{}, err
				}
				_, p, err := l.pane(snap.State, uctx, a, "pane")
				if err != nil {
					return Result{}, err
				}
				tab := a.String("tab")
				if tab == "" {
					tab = p.Active
				} else if p.TabIndex(tab) < 0 {
					return Result{}, InvalidArg("tab", "tab %s is not in pane %s", tab, p.ID)
				}
				if len(p.Tabs) < 2 {
					return Result{}, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("pane %s has one tab: nothing to split off", p.ID))
				}
				f, err := frac(a)
				if err != nil {
					return Result{}, err
				}
				c, err := l.apply(ctx, &core.MoveTab{Tab: tab, Pane: p.ID, Edge: core.Edge(a.String("edge")), Frac: f}, !wantsFocus(uctx, a))
				if err != nil {
					return Result{}, err
				}
				return layoutResult(uctx, c, fmt.Sprintf("split tab %s off pane %s into pane %s", tab, p.ID, c.Result.Pane)), nil
			},
		},
		{
			Name: "pane.close", Title: "Close Pane", Category: layoutCategory, Page: PageState,
			Description: "Close a pane and its tabs (default: the focused pane). Each thread in it closes as thread.close closes " +
				"it: its linked tabs are remembered and come back when it opens again. Closed by the user, the pane goes in its " +
				"space's reopen history (tab.reopen).",
			Args:        []ArgSpec{positional(paneIDArg("pane", "The pane (default: the focused one; from inside a thread, required)"))},
			Keybindings: []string{"cmd+shift+w"},
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				snap, err := l.state()
				if err != nil {
					return Result{}, err
				}
				_, p, err := l.pane(snap.State, uctx, a, "pane")
				if err != nil {
					return Result{}, err
				}
				// A close by the user is recorded for tab.reopen; a model's is not.
				c, err := l.apply(ctx, &core.ClosePane{Pane: p.ID, Record: uctx.FromUser()}, !uctx.FromUser())
				if err != nil {
					return Result{}, err
				}
				return layoutResult(uctx, c, fmt.Sprintf("closed pane %s (%s)", p.ID, plural(len(c.Result.Closed), "tab"))), nil
			},
		},
		{
			Name: "pane.resize", Title: "Resize Panes", Category: layoutCategory, Page: PageState,
			Description: "Set the shares of a split's children (layout show prints split ids and their sizes), e.g. " +
				"--split s-3k2j --sizes 0.6,0.4. Each is positive; they are scaled to sum to 1.",
			Args: []ArgSpec{
				{Name: "split", Type: String, ID: SplitID, Required: true, Description: "The split" + IDHelp},
				{Name: "sizes", Type: String, Required: true, Description: "One share per child, comma separated"},
			},
			NoPalette: true, NoKeybinding: true,
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				var sizes []float64
				for _, part := range strings.Split(a.String("sizes"), ",") {
					f, err := strconv.ParseFloat(strings.TrimSpace(part), 64)
					if err != nil {
						return Result{}, InvalidArg("sizes", "--sizes %q: comma-separated numbers", a.String("sizes"))
					}
					sizes = append(sizes, f)
				}
				c, err := l.apply(ctx, &core.SetSizes{Split: a.String("split"), Sizes: sizes}, !uctx.FromUser())
				if err != nil {
					return Result{}, err
				}
				return layoutResult(uctx, c, "resized split "+a.String("split")), nil
			},
		},
	}
	for _, d := range directions {
		focus, move := l.paneFocusDir(d.name, d.title, d.side), l.paneMoveDir(d.name, d.title, d.side)
		focus.Keybindings = []string{"cmd+ctrl+" + d.letter, "cmd+ctrl+" + d.arrow}
		move.Keybindings = []string{"cmd+ctrl+shift+" + d.letter, "cmd+ctrl+shift+" + d.arrow}
		cmds = append(cmds, focus, move)
	}
	return cmds
}

// dirArgs are a direction verb's args: the pane it goes from and, when the caller resolved
// it from what it renders, the neighbour.
func dirArgs(what string) []ArgSpec {
	return []ArgSpec{
		paneIDArg("pane", "The pane to "+what+" from (default: the focused one; from inside a thread, required)"),
		paneIDArg("to", "The neighbour, when the caller has resolved it (the app, from the frame it draws); default: the neighbour in the stored layout"),
	}
}

// neighbour is the pane a direction verb goes to from the pane it names, or "" with none.
func (l layout) neighbour(st *core.State, uctx Context, a Args, side core.Edge) (*core.Space, *core.Node, string, error) {
	sp, p, err := l.pane(st, uctx, a, "pane")
	if err != nil {
		return nil, nil, "", err
	}
	if to := a.String("to"); to != "" {
		return sp, p, to, nil
	}
	vp := l.store.Viewport()
	return sp, p, core.Rects(sp.Root, vp.Width, vp.Height).Neighbour(sp.Root, p.ID, side, sp.MRU), nil
}

// sideWords name a side for messages.
var sideWords = map[core.Edge]string{core.Left: "left of", core.Right: "right of", core.Top: "above", core.Bottom: "below"}

func (l layout) paneFocusDir(name, title string, side core.Edge) Command {
	return Command{
		Name: "pane.focus." + name, Title: "Focus Pane " + title, Category: layoutCategory, Page: PageState,
		Description: "Give the focus to the pane " + sideWords[side] + " the focused pane (of several, the one focused last).",
		Args:        append(dirArgs("look"), focusArg),
		NoIndex:     true,
		Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
			if err := onlyFocus(uctx, a, "pane.focus."+name); err != nil {
				return Result{}, err
			}
			snap, err := l.state()
			if err != nil {
				return Result{}, err
			}
			_, p, to, err := l.neighbour(snap.State, uctx, a, side)
			if err != nil {
				return Result{}, err
			}
			if to == "" {
				return cliOnly(uctx, fmt.Sprintf("no pane %s pane %s", sideWords[side], p.ID)), nil
			}
			c, err := l.apply(ctx, &core.FocusPane{Pane: to}, false)
			if err != nil {
				return Result{}, err
			}
			return layoutResult(uctx, c, "focused pane "+to), nil
		},
	}
}

func (l layout) paneMoveDir(name, title string, side core.Edge) Command {
	return Command{
		Name: "pane.move." + name, Title: "Move Pane " + title, Category: layoutCategory, Page: PageState,
		Description: "Swap the focused pane with the pane " + sideWords[side] + " it: each takes the other's place and size.",
		Args:        dirArgs("move"),
		NoIndex:     true,
		Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
			snap, err := l.state()
			if err != nil {
				return Result{}, err
			}
			_, p, to, err := l.neighbour(snap.State, uctx, a, side)
			if err != nil {
				return Result{}, err
			}
			if to == "" {
				return cliOnly(uctx, fmt.Sprintf("no pane %s pane %s", sideWords[side], p.ID)), nil
			}
			c, err := l.apply(ctx, &core.SwapPane{Pane: p.ID, Target: to}, !uctx.FromUser())
			if err != nil {
				return Result{}, err
			}
			return layoutResult(uctx, c, fmt.Sprintf("swapped pane %s with %s", p.ID, to)), nil
		},
	}
}

// cliOnly is a result whose message only the CLI prints (a key that finds nothing to do
// says nothing in the app).
func cliOnly(uctx Context, msg string) Result {
	if uctx.ActiveView != "" {
		return Result{}
	}
	return Result{Message: msg}
}

func (l layout) paneMove(ctx context.Context, uctx Context, a Args) (Result, error) {
	f, err := frac(a)
	if err != nil {
		return Result{}, err
	}
	pane := a.String("pane")
	var op core.Op
	given := 0
	for _, n := range []string{"beside", "into", "outer", "space"} {
		if a.String(n) != "" {
			given++
		}
	}
	if given != 1 {
		return Result{}, InvalidArg("beside", "give one of --beside (with --edge), --into, --outer or --space")
	}
	switch {
	case a.String("beside") != "":
		if a.String("edge") == "" {
			return Result{}, InvalidArg("edge", "--beside needs --edge")
		}
		op = &core.MovePane{Pane: pane, Target: a.String("beside"), Edge: core.Edge(a.String("edge")), Frac: f}
	case a.String("into") != "":
		var idx *int
		if a.Has("index") {
			i := a.Int("index")
			idx = &i
		}
		op = &core.MergePane{Pane: pane, Target: a.String("into"), Index: idx}
	case a.String("outer") != "":
		op = &core.MovePane{Pane: pane, Edge: core.Edge(a.String("outer")), Frac: f}
	default:
		op = &core.MovePane{Pane: pane, Space: a.String("space")}
	}
	c, err := l.apply(ctx, op, !wantsFocus(uctx, a))
	if err != nil {
		return Result{}, err
	}
	return layoutResult(uctx, c, fmt.Sprintf("moved pane %s (now pane %s in space %s)", pane, c.Result.Pane, c.Result.Space)), nil
}
