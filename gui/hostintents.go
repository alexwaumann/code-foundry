package main

import (
	"context"
	"log/slog"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/client"
)

// viewDictationAllow is command.ViewDictationAllow.
const viewDictationAllow = "dictation.allow"

// intentRetry is how long the watcher waits before reconnecting to the daemon.
const intentRetry = 2 * time.Second

// intentStream is the client side of UiService.WatchIntents.
type intentStream interface {
	Receive() bool
	Msg() *v1.UiIntent
	Err() error
	Close() error
}

// hostIntentWatcher follows UiService.WatchIntents for the intents only the host can act
// on: AXIsProcessTrustedWithOptions has to run in the process that needs the grant, and the
// page talks only to the daemon. It runs with the window hidden too. Windows get their
// intents on the shared events stream, so this one does not count as a window.
type hostIntentWatcher struct {
	// open starts a stream; ending ctx must end it.
	open  func(ctx context.Context) (intentStream, error)
	log   *slog.Logger
	retry time.Duration
	allow func()
}

// watchHostIntents runs the watcher until ctx ends, reconnecting when the daemon restarts.
func watchHostIntents(ctx context.Context, connectDaemon func(context.Context) (*client.Client, error), allow func(), log *slog.Logger) {
	w := hostIntentWatcher{
		open: func(ctx context.Context) (intentStream, error) {
			c, err := connectDaemon(ctx)
			if err != nil {
				return nil, err
			}
			return c.UI.WatchIntents(ctx, connect.NewRequest(&v1.WatchIntentsRequest{}))
		},
		log:   log,
		retry: intentRetry,
		allow: allow,
	}
	w.run(ctx)
}

func (w *hostIntentWatcher) run(ctx context.Context) {
	for ctx.Err() == nil {
		err := w.once(ctx)
		if ctx.Err() != nil {
			return
		}
		w.log.Debug("intent watch ended; reconnecting", "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(w.retry):
		}
	}
}

func (w *hostIntentWatcher) once(ctx context.Context) error {
	stream, err := w.open(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = stream.Close() }()
	for stream.Receive() {
		if stream.Msg().GetShowView().GetName() == viewDictationAllow {
			w.log.Info("dictation: asking for Accessibility")
			w.allow()
		}
	}
	return stream.Err()
}
