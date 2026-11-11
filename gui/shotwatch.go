package main

import (
	"context"
	"log/slog"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/client"
)

// shotRetry is how long the watcher waits before reconnecting to the daemon.
const shotRetry = 2 * time.Second

// shotStream is the client side of UiService.WatchShots.
type shotStream interface {
	Receive() bool
	Msg() *v1.ShotRequest
	Err() error
	Close() error
}

// shotWatcher holds UiService.WatchShots, which makes the host the daemon's one capturer
// of plugin surface shots, and hands each request to the ShotService's queue with the
// stream's context: a request whose stream dropped is not drawn (the daemon has failed it).
type shotWatcher struct {
	// open starts a stream; ending ctx must end it.
	open  func(ctx context.Context) (shotStream, error)
	log   *slog.Logger
	retry time.Duration
	take  func(ctx context.Context, r *v1.ShotRequest)
}

// watchShots runs the watcher until ctx ends, reconnecting when the daemon restarts.
func watchShots(ctx context.Context, connectDaemon func(context.Context) (*client.Client, error), shots *ShotService, log *slog.Logger) {
	w := shotWatcher{
		open: func(ctx context.Context) (shotStream, error) {
			c, err := connectDaemon(ctx)
			if err != nil {
				return nil, err
			}
			return c.UI.WatchShots(ctx, connect.NewRequest(&v1.WatchShotsRequest{}))
		},
		log:   log,
		retry: shotRetry,
		take:  shots.take,
	}
	w.run(ctx)
}

// publishShot is ShotService.publish: UiService.PublishShot on the daemon.
func publishShot(connectDaemon func(context.Context) (*client.Client, error)) func(context.Context, *v1.PublishShotRequest) error {
	return func(ctx context.Context, r *v1.PublishShotRequest) error {
		c, err := connectDaemon(ctx)
		if err != nil {
			return err
		}
		_, err = c.UI.PublishShot(ctx, connect.NewRequest(r))
		return err
	}
}

func (w *shotWatcher) run(ctx context.Context) {
	for ctx.Err() == nil {
		err := w.once(ctx)
		if ctx.Err() != nil {
			return
		}
		w.log.Debug("shot watch ended; reconnecting", "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(w.retry):
		}
	}
}

// once holds one stream until it ends; the requests it delivered end with it.
func (w *shotWatcher) once(ctx context.Context) error {
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stream, err := w.open(sctx)
	if err != nil {
		return err
	}
	defer func() { _ = stream.Close() }()
	for stream.Receive() {
		if r := stream.Msg(); r.GetId() != "" {
			w.take(sctx, r)
		}
	}
	return stream.Err()
}
