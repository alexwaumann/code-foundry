package main

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/client"
)

// relaunchRetry is how long the watcher waits before reconnecting to the daemon (it may
// be restarting, or not started yet).
const relaunchRetry = 2 * time.Second

// restartWait bounds how long the watcher waits, after restart_requested, for the
// daemon to end the stream (it exits shortly after asking) before relaunching anyway.
const restartWait = 15 * time.Second

// updateStream is the client side of UpdateService.Watch
// (*connect.ServerStreamForClient[v1.UpdateEvent]).
type updateStream interface {
	Receive() bool
	Msg() *v1.UpdateEvent
	Err() error
	Close() error
}

// relaunchWatcher follows UpdateService.Watch and relaunches the GUI when the daemon
// asks. Fields are injectable for tests; watchRelaunch fills them for the app.
type relaunchWatcher struct {
	// open starts a Watch stream; ending ctx must end the stream.
	open        func(ctx context.Context) (updateStream, error)
	log         *slog.Logger
	relaunch    func()
	retry       time.Duration
	restartWait time.Duration
}

// watchRelaunch follows UpdateService.Watch over the daemon's Unix socket and relaunches
// the GUI when the daemon asks. The host does this itself rather than the frontend, so
// it does not depend on the webview.
//
//   - relaunch_requested (`app.relaunch`): relaunch at once; the daemon keeps running.
//   - restart_requested (`app.restart`): the daemon is about to exit. Relaunch once the
//     stream ends, so the new window's connect auto-starts the installed daemon instead
//     of reaching the dying one; after restartWait relaunch anyway. Watching stops there.
//
// connectDaemon may auto-start the daemon: after `daemon.restart` the host brings up the
// installed version, like the frontend's next request would. Reconnects until ctx ends.
func watchRelaunch(ctx context.Context, connectDaemon func(context.Context) (*client.Client, error), log *slog.Logger, relaunch func()) {
	w := relaunchWatcher{
		open: func(ctx context.Context) (updateStream, error) {
			c, err := connectDaemon(ctx)
			if err != nil {
				return nil, err
			}
			return c.Update.Watch(ctx, connect.NewRequest(&v1.WatchUpdateRequest{}))
		},
		log:         log,
		relaunch:    relaunch,
		retry:       relaunchRetry,
		restartWait: restartWait,
	}
	w.run(ctx)
}

// run watches until ctx ends or a restart relaunched the GUI.
func (w *relaunchWatcher) run(ctx context.Context) {
	for ctx.Err() == nil {
		restarted, err := w.once(ctx)
		if restarted || ctx.Err() != nil {
			return
		}
		w.log.Debug("relaunch watch ended; reconnecting", "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(w.retry):
		}
	}
}

// once follows one Watch stream until it ends. restarted reports that the stream carried
// restart_requested and the GUI was relaunched for it.
func (w *relaunchWatcher) once(parent context.Context) (restarted bool, err error) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	stream, err := w.open(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = stream.Close() }()
	var (
		timer    *time.Timer
		timedOut atomic.Bool
	)
	for stream.Receive() {
		ev := stream.Msg()
		switch {
		case ev.GetRelaunchRequested() != nil:
			w.relaunch()
		case ev.GetRestartRequested() != nil && timer == nil:
			w.log.Info("daemon restart requested; relaunching once it has stopped")
			timer = time.AfterFunc(w.restartWait, func() {
				timedOut.Store(true)
				cancel()
			})
		}
	}
	if timer == nil {
		return false, stream.Err()
	}
	timer.Stop()
	if parent.Err() != nil && !timedOut.Load() {
		return false, nil // the app is quitting anyway
	}
	if timedOut.Load() {
		w.log.Warn("daemon still connected after a restart request; relaunching anyway", "waited", w.restartWait)
	}
	w.relaunch()
	return true, nil
}
