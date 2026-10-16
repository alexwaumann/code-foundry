package daemon

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/action"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// actionRuns is the part of the action store the cleanup drives. *action.Manager
// implements it.
type actionRuns interface {
	RepoRemoved(ctx context.Context, repoID string)
	KillRuns(match func(action.Run) bool) int
}

// startActionCleanup keeps actions in step with their owners, like the shell reaper
// does for terminals (which also covers action runs in a terminal, kind=action):
//
//   - a project is unregistered (repo.RepoRemoved): its actions are forgotten (the
//     database cascades) and its runs killed and forgotten;
//   - a thread is removed (thread.Removed), archived or snoozed (thread.Updated with
//     ArchivedAt or SnoozedUntil set): its background runs are killed, as its action
//     terminals are by the session store;
//   - a worktree's directory is removed (repo.WorktreeRemoved, directory gone): the
//     background runs in it are killed.
//
// The returned func stops it.
func startActionCleanup(ctx context.Context, log *slog.Logger, runs actionRuns, b *bus.Bus) func() {
	return startActionCleanupWith(ctx, log, runs, b, func(path string) bool {
		_, err := os.Stat(path)
		return errors.Is(err, fs.ErrNotExist)
	})
}

func startActionCleanupWith(ctx context.Context, log *slog.Logger, runs actionRuns, b *bus.Bus, dirGone func(string) bool) func() {
	ctx, cancel := context.WithCancel(ctx)
	repoEvents := bus.Subscribe[repo.Event](b, 256)
	sessionEvents := bus.Subscribe[thread.Event](b, 256)
	var wg sync.WaitGroup
	wg.Go(func() {
		defer repoEvents.Close()
		defer sessionEvents.Close()
		kill := func(why string, match func(action.Run) bool) {
			if n := runs.KillRuns(match); n > 0 {
				log.Info("killed background action runs", "why", why, "count", n)
			}
		}
		for {
			select {
			case <-ctx.Done():
				return
			case ev := <-repoEvents.C():
				switch e := ev.(type) {
				case repo.RepoRemoved:
					runs.RepoRemoved(ctx, e.ID)
				case repo.WorktreeRemoved:
					if dirGone(e.Path) {
						kill("worktree removed", func(r action.Run) bool { return r.Worktree == e.Path })
					}
				}
			case ev := <-sessionEvents.C():
				switch e := ev.(type) {
				case thread.Removed:
					kill("thread removed", func(r action.Run) bool { return r.SessionID == e.ID })
				case thread.Updated:
					id := e.Session.ID
					switch {
					case !e.Session.ArchivedAt.IsZero():
						kill("thread archived", func(r action.Run) bool { return r.SessionID == id })
					case !e.Session.SnoozedUntil.IsZero():
						kill("thread snoozed", func(r action.Run) bool { return r.SessionID == id })
					}
				}
			}
		}
	})
	return func() {
		cancel()
		wg.Wait()
	}
}
