package daemon

import (
	"context"
	"log/slog"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/action"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Wake subscriptions to action runs (docs/notes/agents-4-wake.md): the thread store
// does not know the action store, so the daemon looks runs up for it
// (thread.Options.ActionRun) and tells it about every run's end (startWakeRuns).

// runGetter is the part of the action store wake subscriptions read. *action.Manager
// implements it.
type runGetter interface {
	GetRun(ctx context.Context, id string) (action.Run, error)
}

// actionRunForWake is thread.Options.ActionRun over the action store: the run with its
// output, false when the store does not remember it.
func actionRunForWake(runs runGetter) func(ctx context.Context, id string) (thread.ActionRun, bool) {
	return func(ctx context.Context, id string) (thread.ActionRun, bool) {
		r, err := runs.GetRun(ctx, id)
		if err != nil {
			return thread.ActionRun{}, false
		}
		return thread.ActionRun{
			ID: r.ID, ActionID: r.ActionID, ActionName: r.ActionName, RepoID: r.RepoID, Finished: r.Finished(),
			ExitCode: r.ExitCode, StartedAt: r.StartedAt, FinishedAt: r.FinishedAt, Output: r.Output,
		}, true
	}
}

// runWaker is the part of the thread store a run's end goes to. *thread.Manager
// implements it.
type runWaker interface {
	ActionRunFinished(ctx context.Context, id string)
}

// startWakeRuns forwards every run_finished of the action store to the thread store's
// wake subscriptions. The returned func stops it.
func startWakeRuns(ctx context.Context, log *slog.Logger, threads runWaker, b *bus.Bus) func() {
	ctx, cancel := context.WithCancel(ctx)
	events := bus.Subscribe[action.Event](b, 256)
	var wg sync.WaitGroup
	wg.Go(func() {
		defer events.Close()
		var dropped uint64
		for {
			select {
			case <-ctx.Done():
				return
			case ev, open := <-events.C():
				if !open {
					return
				}
				if d := events.Dropped(); d != dropped {
					dropped = d
					log.Warn("action events dropped; a run's end may not wake its subscribers", "dropped", d)
				}
				if e, ok := ev.(action.RunFinished); ok {
					threads.ActionRunFinished(ctx, e.RunID)
				}
			}
		}
	})
	return func() {
		cancel()
		wg.Wait()
	}
}
