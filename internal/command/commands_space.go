package command

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// spaceCommands are space.new, space.rename, space.remove, space.switch and space.move.
func (l layout) spaceCommands() []Command {
	return []Command{
		{
			Name: "space.new", Title: "New Space", Category: layoutCategory, Page: PageState,
			Description: "Make a new, empty space after the others. Without a name it is called \"Space <n>\".",
			Args:        []ArgSpec{{Name: "name", Type: String, Description: "Its name"}, focusArg},
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				c, err := l.apply(ctx, &core.NewSpace{Name: a.String("name"), Switch: wantsFocus(uctx, a)}, false)
				if err != nil {
					return Result{}, err
				}
				return layoutResult(uctx, c, fmt.Sprintf("new space %s %q", c.Result.Space, spaceName(l, c.Result.Space))), nil
			},
		},
		{
			Name: "space.rename", Title: "Rename Space", Category: layoutCategory, Page: PageState,
			Description: "Rename a space (default: the current one).",
			Args: []ArgSpec{
				positional(ArgSpec{Name: "name", Type: String, Required: true, Rest: true, Description: "The new name"}),
				spaceArg("The space to rename (default: the current one; from inside a thread, required)"),
			},
			NoKeybinding: true,
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				snap, err := l.state()
				if err != nil {
					return Result{}, err
				}
				sp, err := l.space(snap.State, uctx, a, "space")
				if err != nil {
					return Result{}, err
				}
				c, err := l.apply(ctx, &core.RenameSpace{Space: sp.ID, Name: a.String("name")}, false)
				if err != nil {
					return Result{}, err
				}
				return layoutResult(uctx, c, fmt.Sprintf("space %s is %q", sp.ID, a.String("name"))), nil
			},
		},
		l.spaceRemove(),
		{
			Name: "space.switch", Title: "Switch Space", Category: layoutCategory, Page: PageState,
			Description: "Show another space: by its id or name, or by its place in the top bar (--index, from 1).",
			Args: []ArgSpec{
				positional(ArgSpec{Name: "space", Type: String, ID: SpaceID, Description: "The space (an id, a unique id suffix, or its name)"}),
				{Name: "index", Type: Int, Description: "The space's place in the top bar, from 1"},
				focusArg,
			},
			NoKeybinding: true,
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				if err := onlyFocus(uctx, a, "space.switch"); err != nil {
					return Result{}, err
				}
				snap, err := l.state()
				if err != nil {
					return Result{}, err
				}
				id, err := spaceByIndex(snap.State, a)
				if err != nil {
					return Result{}, err
				}
				c, err := l.apply(ctx, &core.SwitchSpace{Space: id}, false)
				if err != nil {
					return Result{}, err
				}
				return layoutResult(uctx, c, fmt.Sprintf("switched to space %s %q", id, spaceName(l, id))), nil
			},
		},
		{
			Name: "space.move", Title: "Move Space", Category: layoutCategory, Page: PageState,
			Description: "Move a space to another place in the top bar (--index, from 1).",
			Args: []ArgSpec{
				positional(ArgSpec{Name: "space", Type: String, ID: SpaceID, Required: true, Description: "The space (an id, a unique id suffix, or its name)"}),
				{Name: "index", Type: Int, Required: true, Description: "Its new place, from 1"},
			},
			NoPalette: true, NoKeybinding: true, NoIndex: true,
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				snap, err := l.state()
				if err != nil {
					return Result{}, err
				}
				st := snap.State
				id := a.String("space")
				order := make([]string, 0, len(st.Spaces))
				for _, sp := range st.Spaces {
					if sp.ID != id {
						order = append(order, sp.ID)
					}
				}
				if len(order) == len(st.Spaces) {
					return Result{}, connect.NewError(connect.CodeNotFound, fmt.Errorf("no space %s", id))
				}
				i := a.Int("index")
				if i < 1 || i > len(st.Spaces) {
					return Result{}, InvalidArg("index", "index %d: there are %d spaces", i, len(st.Spaces))
				}
				order = slices.Insert(order, i-1, id)
				c, err := l.apply(ctx, &core.ReorderSpaces{Order: order}, false)
				if err != nil {
					return Result{}, err
				}
				return layoutResult(uctx, c, fmt.Sprintf("space %s is now %d of %d", id, i, len(order))), nil
			},
		},
	}
}

// spaceByIndex is the space a switch names: --index (from 1) or the space arg.
func spaceByIndex(st *core.State, a Args) (string, error) {
	switch {
	case a.Has("index") && a.String("space") != "":
		return "", InvalidArg("index", "give a space or --index, not both")
	case a.Has("index"):
		i := a.Int("index")
		if i < 1 || i > len(st.Spaces) {
			return "", InvalidArg("index", "index %d: there are %d spaces", i, len(st.Spaces))
		}
		return st.Spaces[i-1].ID, nil
	case a.String("space") != "":
		return a.String("space"), nil
	}
	return "", InvalidArg("space", "name a space, or its place with --index")
}

// spaceName is the name of space id now, or "".
func spaceName(l layout, id string) string {
	snap, err := l.state()
	if err != nil {
		return ""
	}
	if sp := snap.State.Space(id); sp != nil {
		return sp.Name
	}
	return ""
}

// spaceRemoval is what removing a space does, worked out before it runs (for the question
// and for Run).
type spaceRemoval struct {
	space   *core.Space
	to      *core.Space // the space its threads move to; nil when they are archived
	tabs    int
	threads []string // the threads its sidebar lists (the user's, and children whose creator is gone), not archived
}

func (l layout) removal(ctx context.Context, uctx Context, a Args) (spaceRemoval, error) {
	snap, err := l.state()
	if err != nil {
		return spaceRemoval{}, err
	}
	st := snap.State
	sp, err := l.space(st, uctx, a, "space")
	if err != nil {
		return spaceRemoval{}, err
	}
	if len(st.Spaces) == 1 {
		return spaceRemoval{}, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("space %s is the last space", sp.ID))
	}
	rm := spaceRemoval{space: sp}
	for _, p := range core.Panes(sp.Root) {
		rm.tabs += len(p.Tabs)
	}
	archive := a.Bool("archive")
	if archive && a.String("to") != "" {
		return spaceRemoval{}, InvalidArg("archive", "move its threads (--to) or archive them (--archive), not both")
	}
	if !archive {
		to := a.String("to")
		if to == "" {
			// internal/layout's default: the space on the left, else on the right.
			i := slices.IndexFunc(st.Spaces, func(s *core.Space) bool { return s.ID == sp.ID })
			to = st.Spaces[max(i-1, 0)].ID
			if i == 0 {
				to = st.Spaces[1].ID
			}
		}
		if rm.to = st.Space(to); rm.to == nil || to == sp.ID {
			return spaceRemoval{}, InvalidArg("to", "--to must name another space")
		}
	}
	if l.thread != nil {
		// The space's threads as its sidebar lists them (thread.Thread.InSidebar): the user's,
		// and a thread's child once its creator no longer exists (an archived creator does).
		res, err := l.thread.List(ctx, connect.NewRequest(&v1.ListThreadsRequest{Filter: &v1.ThreadFilter{IncludeArchived: true}}))
		if err != nil && connect.CodeOf(err) != connect.CodeUnimplemented {
			return spaceRemoval{}, err
		}
		if err == nil {
			exists := map[string]bool{}
			for _, t := range res.Msg.GetThreads() {
				exists[t.GetId()] = true
			}
			for _, t := range res.Msg.GetThreads() {
				inSidebar := t.GetCreatedBy() == "" || !exists[t.GetCreatedBy()]
				if t.GetArchivedAt() == nil && inSidebar && st.SpaceOf(t.GetId()) == sp.ID {
					rm.threads = append(rm.threads, t.GetId())
				}
			}
		}
	}
	return rm, nil
}

// question is the confirmation's text.
func (rm spaceRemoval) question() string {
	// its, plus "its tab closes" or "its 2 tabs close".
	its := func(n int, noun, one, many string) string {
		if n == 1 {
			return "its " + noun + " " + one
		}
		return fmt.Sprintf("its %d %ss %s", n, noun, many)
	}
	var parts []string
	if rm.tabs > 0 {
		parts = append(parts, its(rm.tabs, "tab", "closes", "close"))
	}
	if n := len(rm.threads); n > 0 {
		if rm.to == nil {
			parts = append(parts, its(n, "thread", "is archived", "are archived"))
		} else {
			parts = append(parts, its(n, "thread", fmt.Sprintf("moves to %q", rm.to.Name), fmt.Sprintf("move to %q", rm.to.Name)))
		}
	}
	q := fmt.Sprintf("Remove space %q?", rm.space.Name)
	if len(parts) > 0 {
		q += " " + strings.ToUpper(parts[0][:1]) + parts[0][1:]
		if len(parts) > 1 {
			q += ", and " + parts[1]
		}
		q += "."
	}
	return q
}

// spaceRemove is space.remove (shell-model.md: removing a space drops its tabs and panes,
// and its threads move to another space or are all archived; the last space stays).
func (l layout) spaceRemove() Command {
	return Command{
		Name: "space.remove", Title: "Remove Space", Category: layoutCategory, Page: PageState,
		Description: "Remove a space (default: the current one): its tabs and panes close, and its threads move to another " +
			"space (--to; default the space on its left) or, with --archive, are all archived. The last space cannot be removed.",
		Args: []ArgSpec{
			positional(ArgSpec{Name: "space", Type: String, ID: SpaceID,
				Description: "The space (an id, a unique id suffix, or its name; default: the current one; from inside a thread, required)"}),
			{Name: "to", Type: String, ID: SpaceID, Description: "The space its threads move to (default: the one on its left)"},
			{Name: "archive", Type: Bool, Description: "Archive its threads instead of moving them"},
		},
		Confirm: "Remove space {space}?",
		DynamicConfirm: func(ctx context.Context, uctx Context, a Args) string {
			rm, err := l.removal(ctx, uctx, a)
			if err != nil {
				return ""
			}
			return rm.question()
		},
		ConfirmIf: func(ctx context.Context, uctx Context, a Args) bool {
			rm, err := l.removal(ctx, uctx, a)
			return err != nil || rm.tabs > 0 || len(rm.threads) > 0
		},
		ConfirmLabel: "Remove",
		Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
			rm, err := l.removal(ctx, uctx, a)
			if err != nil {
				return Result{}, err
			}
			if rm.to == nil {
				for _, id := range rm.threads {
					if _, err := l.thread.Archive(ctx, connect.NewRequest(&v1.ArchiveThreadRequest{Id: id, Archived: true, ByThreadId: askingThread(uctx)})); err != nil {
						return Result{}, fmt.Errorf("archive thread %s: %w", id, err)
					}
				}
			}
			op := &core.RemoveSpace{Space: rm.space.ID}
			if rm.to != nil {
				op.To = rm.to.ID
			}
			c, err := l.apply(ctx, op, !uctx.FromUser())
			if err != nil {
				return Result{}, err
			}
			msg := fmt.Sprintf("removed space %s %q", rm.space.ID, rm.space.Name)
			switch {
			case len(rm.threads) > 0 && rm.to == nil:
				msg += fmt.Sprintf("; archived %s", plural(len(rm.threads), "thread"))
			case len(rm.threads) > 0:
				msg += fmt.Sprintf("; %s moved to %q", plural(len(rm.threads), "thread"), rm.to.Name)
			}
			return layoutResult(uctx, c, msg), nil
		},
	}
}
