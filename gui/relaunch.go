package main

import (
	"context"
	"log/slog"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/awaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/awaumann/code-foundry/internal/client"
	"github.com/awaumann/code-foundry/internal/paths"
)

// relaunchRetry is how long the watcher waits before reconnecting to the daemon (it may
// be restarting, or not started yet).
const relaunchRetry = 2 * time.Second

// watchRelaunch follows UpdateService.Watch over the daemon's Unix socket and calls
// relaunch when the daemon asks GUIs to relaunch (`app.relaunch`). The host does this
// itself rather than the frontend, so relaunching does not depend on the webview. It
// never starts the daemon (GetDaemonEndpoint does) and reconnects until ctx ends.
func watchRelaunch(ctx context.Context, p paths.Paths, log *slog.Logger, relaunch func()) {
	for ctx.Err() == nil {
		err := watchRelaunchOnce(ctx, client.New(p), relaunch)
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
