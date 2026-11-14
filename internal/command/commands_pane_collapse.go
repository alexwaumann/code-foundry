package command

import (
	"context"
	"fmt"

	"connectrpc.com/connect"

	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// paneCollapseCommand is pane.collapse: the user folds a pane to a rail on demand, or opens it
// again (docs/notes/shell-model.md, "Collapsing a pane"; docs/notes/shell-25d-collapse.md). The
// choice is kept with the pane in the layout, so it survives a restart. The last open pane of a
// space cannot be collapsed. Collapsing the focused pane hands the focus to the most recently
// focused open pane; opening a pane focuses it (from inside a thread, the user's focus stays).
func (l layout) paneCollapseCommand() Command {
	return Command{
		Name: "pane.collapse", Title: "Toggle Collapse Pane", Category: layoutCategory, Page: PageState,
		Description: "Collapse a pane to a rail, giving its room to the panes beside it, or open it again (default: the focused " +
			"pane, toggled). The choice is kept with the pane until it is opened: a click on one of its rail's icons, this verb " +
			"again, or giving one of its tabs the focus. The last open pane of a space cannot be collapsed.",
		Args: []ArgSpec{
			positional(paneIDArg("pane", "The pane (default: the focused one; from inside a thread, required)")),
			{Name: "on", Type: Bool, Description: "Collapse it (default: toggle)"},
			{Name: "off", Type: Bool, Description: "Open it again (default: toggle)"},
		},
		Keybindings: []string{"cmd+shift+m"},
		Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
			if a.Bool("on") && a.Bool("off") {
				return Result{}, InvalidArg("on", "--on and --off together")
			}
			snap, err := l.state()
			if err != nil {
				return Result{}, err
			}
			sp, p, err := l.pane(snap.State, uctx, a, "pane")
			if err != nil {
				return Result{}, err
			}
			collapse := !p.Collapsed
			switch {
			case a.Bool("on"):
				collapse = true
			case a.Bool("off"):
				collapse = false
			}
			if collapse && !p.Collapsed && core.LastOpen(sp, p.ID) {
				return Result{}, connect.NewError(connect.CodeFailedPrecondition,
					fmt.Errorf("pane %s is the last open pane of its space: it cannot be collapsed", p.ID))
			}
			c, err := l.apply(ctx, &core.SetCollapsed{Pane: p.ID, Collapsed: collapse}, !uctx.FromUser())
			if err != nil {
				return Result{}, err
			}
			word := "opened"
			if collapse {
				word = "collapsed"
			}
			return layoutResult(uctx, c, fmt.Sprintf("%s pane %s", word, p.ID)), nil
		},
	}
}
