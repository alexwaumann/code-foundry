package command

import (
	"context"

	core "github.com/alexwaumann/code-foundry/internal/layout"
	layoutstore "github.com/alexwaumann/code-foundry/internal/store/layout"
)

// Sending from the shell window's composer (docs/notes/shell-model.md, "The composer"):
// thread.new --compose <tab> creates the thread, then its tab takes the place of the composer
// tab it was sent from (open_thread with compose): the thread lives in that composer's space,
// and a draft sent ends (docs/notes/shell-2b-drafts.md, shell-6-lifecycle.md).

// ThreadLifecycleOption configures RegisterThreadLifecycle.
type ThreadLifecycleOption func(*threadLifecycleOptions)

type threadLifecycleOptions struct {
	layout layoutstore.Store
}

// WithLayout gives thread.new the layout store, for --compose. Without it --compose is
// refused.
func WithLayout(l layoutstore.Store) ThreadLifecycleOption {
	return func(o *threadLifecycleOptions) { o.layout = l }
}

// composeArg is thread.new's --compose.
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
// inside a thread it does not move the user's focus.
func (o threadLifecycleOptions) sentFrom(ctx context.Context, uctx Context, compose, id string) error {
	if compose == "" {
		return nil
	}
	focus := uctx.FromUser()
	_, err := layout{store: o.layout}.apply(ctx, &core.OpenThread{Thread: id, Compose: compose, Focus: focus}, !focus)
	return err
}
