package command

import (
	"context"
	"fmt"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// A thread's own tab: opening it (a sidebar click, the CLI), closing it from its space (its
// linked tabs are remembered and come back when it opens again) and moving it to another
// space with its linked tabs (docs/notes/shell-model.md, "Linked surfaces").

// layoutThreadArg is the thread a verb acts on; context-bound, so the app's active thread is
// its default there. From inside a thread it must be given (thread verbs default to the
// caller's own thread through $CODE_FOUNDRY_THREAD, which is not a layout default).
func layoutThreadArg(required bool) ArgSpec {
	s := ArgSpec{Name: "id", Type: String, ID: ThreadID, Positional: true, Description: "The thread" + IDHelp}
	if required {
		s.Required = true
	} else {
		s.Context = ContextThread
		s.Description = "The thread (default: the active one; from inside a thread, required)" + IDHelp
	}
	return s
}

// threadID is the thread a verb names, checked to exist.
func (l layout) threadID(ctx context.Context, uctx Context, a Args) (string, error) {
	id, _, err := l.namedThread(ctx, uctx, a)
	return id, err
}

// namedThread is the thread a verb names, checked to exist, and the thread itself (nil when
// there is no thread service to ask).
func (l layout) namedThread(ctx context.Context, uctx Context, a Args) (string, *v1.Thread, error) {
	id := a.String("id")
	if id == "" || !a.Given("id") {
		if err := implicit(uctx, "id", "thread"); err != nil {
			return "", nil, err
		}
	}
	if id == "" {
		return "", nil, InvalidArg("id", "name a thread")
	}
	if l.thread != nil {
		res, err := l.thread.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: id}))
		switch {
		case err == nil:
			return id, res.Msg.GetThread(), nil
		case connect.CodeOf(err) != connect.CodeUnimplemented:
			return "", nil, err
		}
	}
	return id, nil, nil
}

func (l layout) threadCommands() []Command {
	return []Command{
		{
			Name: "thread.open", Title: "Open Thread", Category: layoutCategory, Page: PageState,
			Description: "Open a thread's tab, or focus it when it is open: in the focused pane of the thread's space (--pane: " +
				"that pane, at --index from 0; --split with --edge: a new pane on that edge of a pane; --outer: a new pane on " +
				"that edge of the whole pane area), in place of the space's composer when that is all the space shows. An " +
				"archived thread lives in no space: it opens in the current space (or --pane's). The linked tabs it had open " +
				"when it closed come back. From inside a thread it opens without taking the user's focus unless --focus.",
			Args: []ArgSpec{
				layoutThreadArg(true),
				paneIDArg("pane", "The pane its tab opens in (a pane of the thread's space)"),
				{Name: "index", Type: Int, Description: "With --pane: its place in the strip, from 0 (default: after the active tab)"},
				paneIDArg("split", "In a new pane on --edge of this pane (a pane of the thread's space)"),
				edgeArg("edge", "With --split: the edge of that pane"),
				edgeArg("outer", "In a new pane on this edge of the whole pane area of the thread's space"),
				focusArg,
			},
			NoPalette: true, NoKeybinding: true,
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				id, th, err := l.namedThread(ctx, uctx, a)
				if err != nil {
					return Result{}, err
				}
				op := &core.OpenThread{Thread: id, Pane: a.String("pane"), Archived: th.GetArchivedAt() != nil}
				switch {
				case a.String("pane") != "" && (a.String("split") != "" || a.String("outer") != ""),
					a.String("split") != "" && a.String("outer") != "":
					return Result{}, InvalidArg("pane", "give one of --pane, --split (with --edge) or --outer")
				case a.String("edge") != "" && a.String("split") == "":
					return Result{}, InvalidArg("edge", "--edge goes with --split; an edge of the whole area is --outer")
				case a.Has("index") && a.String("pane") == "":
					return Result{}, InvalidArg("index", "--index is a place in --pane's strip")
				case a.String("split") != "":
					if a.String("edge") == "" {
						return Result{}, InvalidArg("edge", "--split needs --edge")
					}
					op.Pane, op.Edge = a.String("split"), core.Edge(a.String("edge"))
				case a.String("outer") != "":
					op.Edge = core.Edge(a.String("outer"))
				}
				if a.Has("index") {
					i := a.Int("index")
					op.Index = &i
				}
				focus := wantsFocus(uctx, a)
				op.Focus = focus
				c, err := l.apply(ctx, op, !focus)
				if err != nil {
					return Result{}, err
				}
				msg := fmt.Sprintf("opened thread %s as tab %s in pane %s of space %s", id, c.Result.Tab, c.Result.Pane, c.Result.Space)
				if c.Result.Existing {
					msg = fmt.Sprintf("thread %s is open as tab %s in pane %s of space %s", id, c.Result.Tab, c.Result.Pane, c.Result.Space)
				}
				if n := len(c.Result.Back) + len(c.Result.Placed); n > 0 {
					msg += fmt.Sprintf("; %s came back", plural(n, "linked tab"))
				}
				return layoutResult(uctx, c, msg), nil
			},
		},
		{
			Name: "thread.close", Title: "Close Thread Tab", Category: layoutCategory, Page: PageState,
			Description: "Close a thread's tab from its space, with its linked tabs there; they are remembered and come back " +
				"when the thread opens again. The thread itself goes on (it is not archived); its terminals keep running.",
			Args: []ArgSpec{layoutThreadArg(false)},
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				id, err := l.threadID(ctx, uctx, a)
				if err != nil {
					return Result{}, err
				}
				c, err := l.apply(ctx, &core.CloseThread{Thread: id}, !uctx.FromUser())
				if err != nil {
					return Result{}, err
				}
				msg := fmt.Sprintf("closed thread %s's tab", id)
				if n := len(c.Result.Kept); n > 0 {
					msg += fmt.Sprintf("; %s remembered", plural(n, "linked tab"))
				}
				return layoutResult(uctx, c, msg), nil
			},
		},
		{
			Name: "thread.space.move", Title: "Move Thread to Space", Category: layoutCategory, Page: PageState,
			Description: "Move a thread to another space with its linked tabs in its space. An open thread's tab opens in that " +
				"space's focused pane; nothing switches spaces.",
			Args: []ArgSpec{
				layoutThreadArg(false),
				{Name: "space", Type: String, ID: SpaceID, Required: true, Description: "The space (an id, a unique id suffix, or its name)"},
			},
			NoKeybinding: true,
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				id, err := l.threadID(ctx, uctx, a)
				if err != nil {
					return Result{}, err
				}
				c, err := l.apply(ctx, &core.MoveThreadToSpace{Thread: id, Space: a.String("space")}, !uctx.FromUser())
				if err != nil {
					return Result{}, err
				}
				return layoutResult(uctx, c, fmt.Sprintf("thread %s is in space %s %q", id, a.String("space"), spaceName(l, a.String("space")))), nil
			},
		},
	}
}
