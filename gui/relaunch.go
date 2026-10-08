package main

import (
	"context"
	"log/slog"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/awaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/awaumann/code-foundry/internal/client"
)

// relaunchRetry is how long the watcher waits before reconnecting to the daemon (it may
// be restarting, or not started yet).
const relaunchRetry = 2 * time.Second

// watchRelaunch follows UpdateService.Watch over the daemon's Unix socket and calls
// relaunch when the daemon asks GUIs to relaunch (`app.relaunch`). The host does this
// itself rather than the frontend, so it does not depend on the webview. connect may
// auto-start the daemon: after `daemon.restart` the host brings up the installed
// version, like the frontend's next request would. Reconnects until ctx ends.
func watchRelaunch(ctx context.Context, connect func(context.Context) (*client.Client, error), log *slog.Logger, relaunch func()) {
	for ctx.Err() == nil {
		c, err := connect(ctx)
		if err == nil {
			err = watchRelaunchOnce(ctx, c, relaunch)
		}
		if ctx.Err() != nil {
			return
		}
		log.Debug("relaunch watch ended; reconnecting", "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(relaunchRetry):
		}
	}
}

func watchRelaunchOnce(ctx context.Context, c *client.Client, relaunch func()) error {
	stream, err := c.Update.Watch(ctx, connect.NewRequest(&v1.WatchUpdateRequest{}))
	if err != nil {
		return err
	}
	defer func() { _ = stream.Close() }()
	for stream.Receive() {
		if stream.Msg().GetRelaunchRequested() != nil {
			relaunch()
		}
	}
	return stream.Err()
}
