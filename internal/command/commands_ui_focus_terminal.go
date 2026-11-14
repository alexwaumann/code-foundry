package command

import (
	"context"
	"fmt"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	layoutstore "github.com/alexwaumann/code-foundry/internal/store/layout"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// ui.focus.terminal in the shell window's layout (docs/notes/shell-7-view-open.md): the
// terminal's tab takes the user's focus, opened by the placement rules when it has none (linked
// to the terminal's thread, else unlinked in the focused pane); a thread's quick terminal opens
// under its thread, whose tab takes the focus.

// UIOption configures RegisterUI.
type UIOption func(*uiOptions)

type uiOptions struct {
	layout    layoutstore.Store
	terminals TerminalBackend
}

// WithTerminalTabs gives ui.focus.terminal the layout and the terminals it reads the labels of.
// Without them it only sends FocusTerminal, which moves the keyboard to a terminal tab that is open.
func WithTerminalTabs(l layoutstore.Store, terms TerminalBackend) UIOption {
	return func(o *uiOptions) { o.layout, o.terminals = l, terms }
}

// focusTerminalTab focuses terminal id's tab, or its quick terminal's thread. A terminal with no
// tab gets one in pane when it is given (a pane's "+" menu), else by the placement rules. It
// returns a phrase for the message.
func (o uiOptions) focusTerminalTab(ctx context.Context, id, pane string) (string, error) {
	if o.layout == nil || o.terminals == nil {
		return "", nil
	}
	t, err := findTerminal(ctx, o.terminals, id)
	if err != nil {
		return "", err
	}
	l := layout{store: o.layout}
	labels := t.GetLabels()
	thread := labels[termlabel.Thread]
	if termlabel.IsQuick(labels) && thread != "" {
		if _, err := l.apply(ctx, &core.OpenThread{Thread: thread, Focus: true}, false); err != nil {
			return "", err
		}
		if _, err := l.apply(ctx, &core.SetQuick{Thread: thread, Open: true}, false); err != nil {
			return "", err
		}
		return fmt.Sprintf("opened thread %s's quick terminal %s; ", thread, id), nil
	}
	tb := &core.Tab{Kind: "terminal", Thread: thread, Params: map[string]string{core.TerminalParam: id}}
	c, err := l.apply(ctx, &core.OpenSurface{Pane: pane, Tab: tb, Focus: true}, false)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("terminal %s has the focus as tab %s in pane %s; ", id, c.Result.Tab, c.Result.Pane), nil
}

// findTerminal returns terminal id (a whole id: the registry resolves a suffix first).
func findTerminal(ctx context.Context, terms TerminalBackend, id string) (*v1.Terminal, error) {
	res, err := terms.List(ctx, connect.NewRequest(&v1.ListTerminalsRequest{}))
	if err != nil {
		return nil, err
	}
	for _, t := range res.Msg.GetTerminals() {
		if t.GetId() == id {
			return t, nil
		}
	}
	return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no terminal %s", id))
}
