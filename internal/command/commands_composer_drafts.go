package command

import (
	"context"
	"fmt"
	"strconv"

	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// The composer as a tab and its drafts (docs/notes/shell-model.md, "The composer";
// docs/notes/shell-2b-drafts.md). composer.new is the shell's New thread: it focuses the
// space's empty composer or opens one. The draft verbs are the composer's and the sidebar
// row's: the composer starts, relabels and clears its draft as the user types; the row opens
// or discards it. None is in the palette or the agents' index: a model starts threads with
// thread.new. thread.new itself is unchanged until the shell is the window.

func draftArg() ArgSpec {
	return positional(ArgSpec{Name: "draft", Type: String, ID: DraftID, Required: true, Description: "The draft" + IDHelp})
}

func (l layout) composerCommands() []Command {
	return []Command{
		{
			Name: "composer.new", Title: "New Thread in a Tab", Category: layoutCategory, Page: PageState,
			Description: "Focus the space's empty composer, or open one in the focused pane (--pane: that pane, which an " +
				"empty composer open elsewhere in the space moves to). --project, --workspace or --like say what the " +
				"thread will start from.",
			Args: []ArgSpec{
				spaceArg("The space (default: the pane's, else the current one)"),
				paneIDArg("pane", "The pane it opens in"),
				{Name: "project", Type: String, Description: "The project the thread starts in"},
				{Name: "workspace", Type: String, Description: "The workspace the thread starts in"},
				{Name: "like", Type: String, ID: ThreadID, Description: "A thread the new one starts like" + IDHelp},
				focusArg,
			},
			NoPalette: true, NoIndex: true,
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				params := map[string]string{}
				for _, k := range []string{"project", "workspace", "like"} {
					if v := a.String(k); v != "" {
						params[k] = v
					}
				}
				if len(params) == 0 {
					params = nil
				}
				focus := wantsFocus(uctx, a)
				c, err := l.apply(ctx, &core.NewThread{Space: a.String("space"), Pane: a.String("pane"), Params: params, Focus: focus}, !focus)
				if err != nil {
					return Result{}, err
				}
				return layoutResult(uctx, c, fmt.Sprintf("composer tab %s in pane %s of space %s", c.Result.Tab, c.Result.Pane, c.Result.Space)), nil
			},
		},
		{
			Name: "composer.draft.start", Title: "Start Draft", Category: layoutCategory, Page: PageState,
			Description: "Turn an empty composer tab into a draft (its first text was typed). Prints the draft's id.",
			Args: []ArgSpec{
				{Name: "tab", Type: String, ID: TabID, Required: true, Description: "The empty composer's tab" + IDHelp},
				{Name: "id", Type: String, Description: "The draft's id, when the caller chose one (unused anywhere in the layout)"},
				{Name: "label", Type: String, Description: "Its label: the text's first line"},
			},
			NoPalette: true, NoIndex: true, NoKeybinding: true,
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				c, err := l.apply(ctx, &core.StartDraft{Tab: a.String("tab"), Draft: a.String("id"), Label: a.String("label")}, !uctx.FromUser())
				if err != nil {
					return Result{}, err
				}
				return layoutResult(uctx, c, "draft "+c.Result.Draft), nil
			},
		},
		{
			Name: "composer.draft.label", Title: "Label Draft", Category: layoutCategory, Page: PageState,
			Description: "Set a draft's label (one line, at most 80 characters).",
			Args:        []ArgSpec{draftArg(), positional(ArgSpec{Name: "label", Type: String, Rest: true, Description: "The label"})},
			NoPalette:   true, NoIndex: true, NoKeybinding: true,
			Run: l.draftOp("labelled draft", func(a Args) core.Op { return &core.LabelDraft{Draft: a.String("draft"), Label: a.String("label")} }),
		},
		{
			Name: "composer.draft.clear", Title: "Clear Draft", Category: layoutCategory, Page: PageState,
			Description: "End a draft whose text was deleted: its tab is the space's empty composer again, or closes when " +
				"the space has one already. A draft is the user's: a thread cannot clear one, and a page asks the user first.",
			Args:      []ArgSpec{draftArg()},
			NoPalette: true, NoIndex: true, NoKeybinding: true,
			Run: l.usersDraftOp("composer.draft.clear", "Clear Draft", "Clear", "cleared draft", func(a Args) core.Op { return &core.ClearDraft{Draft: a.String("draft")} }),
		},
		{
			Name: "composer.draft.discard", Title: "Discard Draft", Category: layoutCategory, Page: PageState,
			Description: "End a draft and close its tab when it is open; its text is gone. A draft is the user's: a thread " +
				"cannot discard one, and a page asks the user first.",
			Args:      []ArgSpec{draftArg()},
			NoPalette: true, NoIndex: true, NoKeybinding: true,
			Run: l.usersDraftOp("composer.draft.discard", "Discard Draft", "Discard", "discarded draft", func(a Args) core.Op { return &core.DiscardDraft{Draft: a.String("draft")} }),
		},
		{
			Name: "composer.draft.open", Title: "Open Draft", Category: layoutCategory, Page: PageState,
			Description: "Focus a draft's tab, or open it in its space's focused pane.",
			Args:        []ArgSpec{draftArg(), focusArg},
			NoPalette:   true, NoIndex: true, NoKeybinding: true,
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				focus := wantsFocus(uctx, a)
				c, err := l.apply(ctx, &core.OpenDraft{Draft: a.String("draft"), Focus: focus}, !focus)
				if err != nil {
					return Result{}, err
				}
				return layoutResult(uctx, c, fmt.Sprintf("draft %s is tab %s in pane %s", c.Result.Draft, c.Result.Tab, c.Result.Pane)), nil
			},
		},
	}
}

// draftOp runs the op build makes, saying what it did.
func (l layout) draftOp(did string, build func(Args) core.Op) func(context.Context, Context, Args) (Result, error) {
	return func(ctx context.Context, uctx Context, a Args) (Result, error) {
		c, err := l.apply(ctx, build(a), !uctx.FromUser())
		if err != nil {
			return Result{}, err
		}
		return layoutResult(uctx, c, did+" "+a.String("draft")), nil
	}
}

// usersDraftOp is draftOp for a verb that ends a draft and loses its text. A draft is what the
// user typed: a thread's model may read draft ids (layout show) but never ends one, and a
// page's call asks the user first, showing the draft. The window's composer and sidebar row,
// the CLI outside a thread and a plugin run it as before.
func (l layout) usersDraftOp(name, title, label, did string, build func(Args) core.Op) func(context.Context, Context, Args) (Result, error) {
	run := l.draftOp(did, build)
	return func(ctx context.Context, uctx Context, a Args) (Result, error) {
		id := a.String("draft")
		switch {
		case uctx.Untrusted():
			ask := fmt.Sprintf("%s the draft %s? Its text is lost.", label, strconv.Quote(l.draftLabel(id)))
			if err := pageAsks(ctx, uctx, name, title, label, ask); err != nil {
				return Result{}, err
			}
		case !uctx.FromUser() && uctx.Origin != OriginPlugin:
			return Result{}, Failed(fmt.Errorf("%s: draft %s is the user's: a thread does not end it (the user can, from its row in the sidebar)", name, id))
		}
		return run(ctx, uctx, a)
	}
}

// draftLabel is draft id's label, else its id.
func (l layout) draftLabel(id string) string {
	if snap, err := l.state(); err == nil {
		for _, sp := range snap.State.Spaces {
			for _, d := range sp.Drafts {
				if d.ID == id && d.Label != "" {
					return d.Label
				}
			}
		}
	}
	return id
}
