package command

import (
	"context"
	"fmt"

	core "github.com/alexwaumann/code-foundry/internal/layout"
	layoutstore "github.com/alexwaumann/code-foundry/internal/store/layout"
)

// Sending from the shell window's composer (docs/notes/shell-model.md, "The composer"):
// thread.new --compose <tab> (and thread.new-like's) creates the thread, then its tab takes the
// place of the composer tab it was sent from (open_thread with compose): the thread lives in that composer's space,
// and a draft sent ends (docs/notes/shell-2b-drafts.md, shell-6-lifecycle.md).

// ThreadLifecycleOption configures RegisterThreadLifecycle.
type ThreadLifecycleOption func(*threadLifecycleOptions)

type threadLifecycleOptions struct {
	layout layoutstore.Store
}

// WithLayout gives thread.new the layout store, for --compose (without it --compose is
// refused), and thread.focus, which also focuses the thread's tab there.
func WithLayout(l layoutstore.Store) ThreadLifecycleOption {
	return func(o *threadLifecycleOptions) { o.layout = l }
}

// composeArg is thread.new's and thread.new-like's --compose.
var composeArg = ArgSpec{
	Name: "compose", Type: String, ID: TabID,
	Description: "The composer tab it is sent from (the shell window sets it): the thread's tab takes its place, in its space" + IDHelp,
}

// checkComposer refuses --compose naming no composer tab, before the thread is made.
func (o threadLifecycleOptions) checkComposer(compose string) error {
	if compose == "" {
		return nil
	}
	snap, err := layout{store: o.layout}.state()
	if err != nil {
		return err
	}
	if _, _, tb := snap.State.FindTab(compose); tb == nil || tb.Kind != "compose" {
		return InvalidArg("compose", "tab %s is not a composer tab", compose)
	}
	return nil
}

// sentFrom opens new thread id in place of composer tab compose, when one is given. From
// inside a thread it does not move the user's focus. It never fails the send: the thread
// exists, and an error would have its caller send again and start a second one. A composer tab
// that went while the thread was made (closed, or its draft discarded) has no place to give:
// the thread's tab opens where a new thread's does. What still goes wrong comes back as a
// warning for the result.
func (o threadLifecycleOptions) sentFrom(ctx context.Context, uctx Context, compose, id string) string {
	if compose == "" {
		return ""
	}
	focus := uctx.FromUser()
	l := layout{store: o.layout}
	_, err := l.apply(ctx, &core.OpenThread{Thread: id, Compose: compose, Focus: focus}, !focus)
	if err == nil {
		return ""
	}
	if _, again := l.apply(ctx, &core.OpenThread{Thread: id, Focus: focus}, !focus); again == nil {
		return ""
	}
	return fmt.Sprintf("its tab could not take the composer's place: %v", err)
}

// focusThreadTab is thread.focus's half in the shell window's layout: thread.open --focus, which
// switches to the thread's space and focuses its tab, opening it (and its remembered tabs) when
// it is closed. It works with no window open: the layout shows it when one opens. It returns a
// phrase for the message; without a layout it does nothing.
func (o threadLifecycleOptions) focusThreadTab(ctx context.Context, id string) (string, error) {
	if o.layout == nil {
		return "", nil
	}
	c, err := layout{store: o.layout}.apply(ctx, &core.OpenThread{Thread: id, Focus: true}, false)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("thread %s has the focus as tab %s in pane %s of space %s; ", id, c.Result.Tab, c.Result.Pane, c.Result.Space), nil
}
