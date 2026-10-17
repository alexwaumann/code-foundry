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
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// actionRuns is the part of the action store the cleanup drives. *action.Manager
// implements it.
type actionRuns interface {
	ProjectRemoved(ctx context.Context, projectID string)
	KillRuns(match func(action.Run) bool) int
}

// startActionCleanup keeps actions in step with their owners, like the shell reaper
// does for terminals (which also covers action runs in a terminal, kind=action):
//
//   - a project is unregistered (repo.RepoRemoved): its actions are forgotten (the
//     database cascades) and its runs killed and forgotten;
//   - a thread is removed (thread.Removed), archived or snoozed (thread.Updated with
//     ArchivedAt or SnoozedUntil set): its background runs are killed, as its action
//     terminals are by the thread store;
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
	projectEvents := bus.Subscribe[project.Event](b, 256)
	threadListEvents := bus.Subscribe[thread.Event](b, 256)
	var wg sync.WaitGroup
	wg.Go(func() {
		defer projectEvents.Close()
		defer threadListEvents.Close()
		kill := func(why string, match func(action.Run) bool) {
			if n := runs.KillRuns(match); n > 0 {
				log.Info("killed background action runs", "why", why, "count", n)
			}
		}
		for {
			select {
			case <-ctx.Done():
				return
			case ev := <-projectEvents.C():
				switch e := ev.(type) {
				case project.ProjectRemoved:
					runs.ProjectRemoved(ctx, e.ID)
				case project.WorktreeRemoved:
					if dirGone(e.Path) {
						kill("worktree removed", func(r action.Run) bool { return r.Worktree == e.Path })
					}
				}
			case ev := <-threadListEvents.C():
				switch e := ev.(type) {
				case thread.Removed:
					kill("thread removed", func(r action.Run) bool { return r.ThreadID == e.ID })
				case thread.Updated:
					id := e.Thread.ID
					switch {
					case !e.Thread.ArchivedAt.IsZero():
						kill("thread archived", func(r action.Run) bool { return r.ThreadID == id })
					case !e.Thread.SnoozedUntil.IsZero():
						kill("thread snoozed", func(r action.Run) bool { return r.ThreadID == id })
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
