package daemon

import (
	"context"
	"log/slog"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// A workspace's instructions file and skills (Workspace.Instructions and .Skills) are
// read from its managed dir by the workspace store, which does not watch the disk: it
// reads them again at every EnsureDirs. A thread writes them with its file tools, so
// when a thread that references a workspace ends a turn the daemon asks the store to
// look again (docs/notes/workspaces-v2-4-projects-page.md). The store publishes an
// update only when something changed.

// workspaceDirs is the part of the workspace store this needs. *workspace.Manager
// implements it.
type workspaceDirs interface {
	EnsureDirs(ctx context.Context, id string) error
}

// startWorkspaceContents re-reads a workspace's managed dir when one of its threads ends
// a turn. The returned func stops it.
func startWorkspaceContents(ctx context.Context, log *slog.Logger, threads func() *thread.Snapshot, ws workspaceDirs, b *bus.Bus) func() {
	ctx, cancel := context.WithCancel(ctx)
	events := bus.Subscribe[thread.ThreadEvent](b, 2048)
	var wg sync.WaitGroup
	wg.Go(func() {
		defer events.Close()
		for {
			select {
			case <-ctx.Done():
				return
			case ev, open := <-events.C():
				if !open {
					return
				}
				id := turnEndWorkspace(ev, threads())
				if id == "" {
					continue
				}
				if err := ws.EnsureDirs(ctx, id); err != nil {
					log.Warn("workspace managed dir after a turn", "workspace", id, "err", err)
				}
			}
		}
	})
	return func() {
		cancel()
		wg.Wait()
	}
}

// turnEndWorkspace is the workspace whose managed dir ev's thread may have written: the
// thread's workspace reference when ev ends a turn, else "".
func turnEndWorkspace(ev thread.ThreadEvent, snap *thread.Snapshot) string {
	e, ok := ev.(thread.ItemAppended)
	if !ok || e.Item.Kind != thread.KindTurnEnd || snap == nil {
		return ""
	}
	th, ok := snap.Thread(ev.Thread())
	if !ok {
		return ""
	}
	return th.WorkspaceID
}
