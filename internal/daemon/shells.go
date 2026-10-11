package daemon

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// reapTimeout bounds one removal: a shell that ignores SIGHUP gets SIGKILL after the
// terminal store's grace period (3s), well inside it.
const reapTimeout = 15 * time.Second

// startShellReaper removes the shells terminal.new starts (termlabel.KindShell) once
// nothing shows them: a shell is removed as soon as it exits, and killed and removed when
// its worktree goes away (repo.WorktreeRemoved, whether from repo.worktree.remove, a
// workspace removal, or `git worktree remove` outside the app). Other terminals (a
// session's Claude terminal) are left alone. A thread's shells go with the thread in
// session.Manager.Remove. The returned func stops the reaper and waits for removals in
// flight.
func startShellReaper(ctx context.Context, log *slog.Logger, terms terminal.Store, b *bus.Bus) (func(), error) {
	runCtx, cancel := context.WithCancel(ctx)
	// Subscribe before sweeping, so an exit between the two is not missed.
	events, err := terms.Watch(runCtx)
	if err != nil {
		cancel()
		return nil, err
	}
	repoEvents := bus.Subscribe[repo.Event](b, 256)
	var wg sync.WaitGroup

	remove := func(id string) {
		rctx, rcancel := context.WithTimeout(runCtx, reapTimeout)
		defer rcancel()
		if err := terms.Remove(rctx, id); err != nil && !errors.Is(err, terminal.ErrNotFound) && runCtx.Err() == nil {
			log.Warn("remove exited shell", "terminal", id, "err", err)
		}
	}
	for _, t := range terms.List(runCtx) {
		if termlabel.IsShell(t.Labels) && t.State == terminal.StateExited {
			remove(t.ID)
		}
	}

	wg.Go(func() {
		defer repoEvents.Close()
		for {
			select {
			case <-runCtx.Done():
				return
			case ev, ok := <-events:
				if !ok {
					return
				}
				if t := ev.Updated; t != nil && t.State == terminal.StateExited && termlabel.IsShell(t.Labels) {
					remove(t.ID)
				}
			case ev := <-repoEvents.C():
				if wr, ok := ev.(repo.WorktreeRemoved); ok {
					wg.Go(func() { reapWorktree(runCtx, log, terms, wr.Path) })
				}
			}
		}
	})
	return func() {
		cancel()
		wg.Wait()
	}, nil
}

// reapWorktree kills and removes the shells that belong to worktree path.
func reapWorktree(ctx context.Context, log *slog.Logger, terms terminal.Store, path string) {
	ctx, cancel := context.WithTimeout(ctx, reapTimeout)
	defer cancel()
	n, err := terminal.KillAndRemoveWhere(ctx, terms, func(t terminal.Terminal) bool {
		return termlabel.IsShell(t.Labels) && t.Labels[termlabel.Worktree] == path
	})
	if err != nil && ctx.Err() == nil {
		log.Warn("remove the shells of a removed worktree", "worktree", path, "err", err)
	}
	if n > 0 {
		log.Info("removed the shells of a removed worktree", "worktree", path, "count", n)
	}
}
