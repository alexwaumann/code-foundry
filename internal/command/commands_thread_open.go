package command

import (
	"context"
	"fmt"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	layoutstore "github.com/alexwaumann/code-foundry/internal/store/layout"
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

// isChild reports whether another thread created th and that creator still exists (an archived
// one does): the sidebar rule's hidden child, which its lead manages, so the user's open of it
// may be a preview (docs/notes/shell-model.md, "Preview tabs"). A creator that is gone makes it
// a thread of the sidebar again.
func (l layout) isChild(ctx context.Context, th *v1.Thread) (bool, error) {
	by := th.GetCreatedBy()
	if by == "" || l.thread == nil {
		return false, nil
	}
	_, err := l.thread.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: by}))
	switch {
	case err == nil:
		return true, nil
	case connect.CodeOf(err) == connect.CodeNotFound:
		return false, nil
	default:
		return false, err
	}
}

// parentOf is from when from created th, directly or further up its creator chain (the user
// opened a child from its lead), else "".
func (l layout) parentOf(ctx context.Context, th *v1.Thread, from string) (string, error) {
	if l.thread == nil {
		return "", nil
	}
	seen := map[string]bool{}
	for by := th.GetCreatedBy(); by != "" && !seen[by]; {
		if by == from {
			return from, nil
		}
		seen[by] = true
		res, err := l.thread.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: by}))
		switch {
		case connect.CodeOf(err) == connect.CodeNotFound:
			return "", nil
		case err != nil:
			return "", err
		}
		by = res.Msg.GetThread().GetCreatedBy()
	}
	return "", nil
}

func (l layout) threadCommands() []Command {
	return []Command{
		{
			Name: "thread.open", Title: "Open Thread", Category: layoutCategory, Page: PageState,
			Description: "Open a thread's tab, or focus it when it is open: in the thread's space, in the focused pane when it has a thread " +
				"open, else in the nearest pane that has one, else in the focused pane (setting layout.smart_placement) (--pane: " +
				"that pane, at --index from 0; --split with --edge: a new pane on that edge of a pane; --outer: a new pane on " +
				"that edge of the whole pane area), in place of the space's composer when that is all the space shows. An " +
				"archived thread lives in no space: it opens in the current space (or --pane's). The linked tabs it had open " +
				"when it closed come back (a snoozed thread's when it wakes). From inside a thread it opens without taking the " +
				"user's focus unless --focus. --preview (the user only, without a place) opens an archived or snoozed thread, " +
				"or a child (a thread another thread created, while that creator exists), as the space's preview tab, replacing the last one, until tab.keep or a move, a send or its surfaces keep it. " +
				"The setting layout.threads_open_as changes where it opens: under panes a pane shows one thread, and the thread " +
				"replaces the one in the focused thread pane (else the pane focused last that shows a thread; else it opens in a new " +
				"pane on the left), which closes as thread.close closes it, its linked tabs switching with it; it opens in a pane of its " +
				"own only with --split, --outer, --beside, or --pane naming a pane without a thread (a new pane on that pane's left). " +
				"Under single every open replaces the space's one thread pane, and --beside is refused. Under tabs (the default) it opens as a tab as above.",
			Args: []ArgSpec{
				layoutThreadArg(true),
				paneIDArg("pane", "The pane its tab opens in (a pane of the thread's space)"),
				{Name: "index", Type: Int, Description: "With --pane: its place in the strip, from 0 (default: after the active tab)"},
				paneIDArg("split", "In a new pane on --edge of this pane (a pane of the thread's space)"),
				edgeArg("edge", "With --split: the edge of that pane"),
				edgeArg("outer", "In a new pane on this edge of the whole pane area of the thread's space"),
				focusArg,
				{Name: "preview", Type: Bool, Description: "As the space's preview tab when the thread is archived, snoozed or a child (otherwise a kept tab)"},
				{Name: "beside", Type: String, Description: "In a new pane on the right of this pane, or of this thread's pane (a pane id or a thread id, " +
					"in the thread's space); refused when layout.threads_open_as is single"},
				{Name: "from", Type: String, ID: ThreadID, Description: "The thread the user opened it from: when that thread created it, under " +
					"layout.threads_open_as panes it opens beside that thread's pane instead of replacing a thread" + IDHelp},
			},
			NoPalette: true, NoKeybinding: true,
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				id, th, err := l.namedThread(ctx, uctx, a)
				if err != nil {
					return Result{}, err
				}
				op := &core.OpenThread{
					Thread: id, Pane: a.String("pane"), Archived: th.GetArchivedAt() != nil,
					Snoozed: th.GetSnoozedUntil() != nil || th.GetSavedAt() != nil, Preview: a.Bool("preview"),
				}
				if op.Preview {
					if op.Child, err = l.isChild(ctx, th); err != nil {
						return Result{}, err
					}
				}
				switch {
				case op.Preview && !uctx.FromUser():
					return Result{}, InvalidArg("preview", "only the user opens a preview; a thread or a page opens a kept tab")
				case op.Preview && (a.String("pane") != "" || a.String("split") != "" || a.String("outer") != "" || a.String("beside") != ""):
					return Result{}, InvalidArg("preview", "a preview opens where a thread's tab opens: no --pane, --split, --outer or --beside")
				case a.String("beside") != "" && (a.String("pane") != "" || a.String("split") != "" || a.String("outer") != "" || a.Has("index")):
					return Result{}, InvalidArg("beside", "--beside is a place of its own: no --pane, --split, --outer or --index")
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
				op.Beside = a.String("beside")
				if from := a.String("from"); from != "" && from != id {
					if op.Parent, err = l.parentOf(ctx, th, from); err != nil {
						return Result{}, err
					}
				}
				focus := wantsFocus(uctx, a)
				op.Focus = focus
				c, err := l.apply(ctx, op, !focus)
				if err != nil {
					return Result{}, err
				}
				what := "tab"
				if snap, err := l.state(); err == nil {
					if _, _, tb := snap.State.FindTab(c.Result.Tab); tb != nil && tb.Preview {
						what = "preview tab"
					}
				}
				msg := fmt.Sprintf("opened thread %s as %s %s in pane %s of space %s", id, what, c.Result.Tab, c.Result.Pane, c.Result.Space)
				if c.Result.Existing {
					msg = fmt.Sprintf("thread %s is open as %s %s in pane %s of space %s", id, what, c.Result.Tab, c.Result.Pane, c.Result.Space)
				}
				for _, tb := range c.Result.Closed {
					if tb.Kind == "thread" && !c.Result.Existing {
						msg += fmt.Sprintf("; thread %s's tab closed", tb.Thread)
					}
				}
				if c.Result.Collapsed {
					msg += " (folded: no room for another open pane)"
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
				// A close by the user is recorded for tab.reopen; a model's is not.
				c, err := l.apply(ctx, &core.CloseThread{Thread: id, Record: uctx.FromUser()}, !uctx.FromUser())
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
				threadIDsArg,
				{Name: "space", Type: String, ID: SpaceID, Required: true, Description: "The space (an id, a unique id suffix, or its name)"},
			},
			NoKeybinding: true,
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				if a.Has("ids") {
					return l.moveThreadsToSpace(ctx, uctx, splitList(a.String("ids")), a.String("space"))
				}
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

// SpaceMoveResult is thread.space.move's answer given ids: the threads moved and those
// that failed (ThreadsResult), and the layout's rev after the last move, which the window
// waits for (LayoutResult's rev).
type SpaceMoveResult struct {
	ThreadsResult
	Rev     uint64 `json:"rev"`
	Changed bool   `json:"changed"`
}

// moveThreadsToSpace is thread.space.move given ids (the sidebar's bulk Move to space ▸ and
// a selection dropped on a space tab, docs/notes/sidebar-bulk-select.md): one
// MoveThreadToSpace per thread, in order, past one that fails (eachThread); a thread that
// already lives there fails as it does alone. The ids are resolved by Invoke (an IDList arg),
// so a typo moves none.
func (l layout) moveThreadsToSpace(ctx context.Context, uctx Context, ids []string, space string) (Result, error) {
	if len(ids) == 0 {
		return Result{}, InvalidArg("ids", "name at least one thread")
	}
	var last layoutstore.Commit
	res := eachThread(ctx, ids, "moved", func(ctx context.Context, id string) error {
		c, err := l.apply(ctx, &core.MoveThreadToSpace{Thread: id, Space: space}, !uctx.FromUser())
		if err == nil {
			last = c
		}
		return err
	})
	res = afterCount(res, "moved", fmt.Sprintf(" to space %s %q", space, spaceName(l, space)))
	out, _ := res.JSON.(ThreadsResult)
	res.JSON = SpaceMoveResult{ThreadsResult: out, Rev: last.Rev, Changed: last.Changed}
	return res, nil
}
