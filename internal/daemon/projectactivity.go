package daemon

import (
	"context"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Thread activity drives the project store's git refreshes
// (docs/notes/git-activity-tiers.md). The project store does not know the thread store,
// so the daemon tells it which worktrees have a live thread (their projects are polled
// and fetched on the live tier) and when a thread changed files in one.

// projectActivity is the part of the project store thread activity drives.
// *project.Git implements it.
type projectActivity interface {
	SetLiveWorktrees(paths []string)
	Touch(path string)
	TouchNow(path string)
}

// editTools are the tools whose result means files in the worktree may have changed.
var editTools = []string{"Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"}

// liveResync is how often the live set is recomputed without a thread event, in case
// the event that changed it was dropped.
const liveResync = time.Minute

// startProjectActivity keeps projects' live worktrees in step with threads
// (thread.Event) and touches a thread's worktree when one of its tools may have edited
// files (debounced in the project store) or a turn ends (at once). The returned func
// stops it.
func startProjectActivity(ctx context.Context, log *slog.Logger, threads func() *thread.Snapshot, projects projectActivity, b *bus.Bus) func() {
	ctx, cancel := context.WithCancel(ctx)
	listEvents := bus.Subscribe[thread.Event](b, 256)
	// Every item event, deltas included: a large buffer, and the loop does little.
	itemEvents := bus.Subscribe[thread.ThreadEvent](b, 2048)
	var wg sync.WaitGroup
	wg.Go(func() {
		defer listEvents.Close()
		defer itemEvents.Close()
		var live []string
		resync := func() {
			next := liveWorktrees(threads(), time.Now())
			if live == nil || !slices.Equal(next, live) {
				live = next
				projects.SetLiveWorktrees(next)
			}
		}
		resync()
		t := time.NewTicker(liveResync)
		defer t.Stop()
		var dropped uint64
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				resync()
			case _, open := <-listEvents.C():
				if !open {
					return
				}
				resync()
			case ev, open := <-itemEvents.C():
				if !open {
					return
				}
				if d := itemEvents.Dropped(); d != dropped {
					dropped = d
					log.Debug("thread item events dropped; a worktree refresh may wait for the poll", "dropped", d)
				}
				now, ok := touchFor(ev)
				if !ok {
					continue
				}
				th, ok := threads().Thread(ev.Thread())
				if !ok || th.ProjectID == "" {
					continue // gone, or a thread without a project
				}
				if now {
					projects.TouchNow(th.WorktreePath)
				} else {
					projects.Touch(th.WorktreePath)
				}
			}
		}
	})
	return func() {
		cancel()
		wg.Wait()
	}
}

// liveWorktrees is the sorted, distinct worktrees of the project threads in snap that
// are live at now: not archived, and not snoozed (or past their snooze). Never nil.
func liveWorktrees(snap *thread.Snapshot, now time.Time) []string {
	out := []string{}
	if snap == nil {
		return out
	}
	for _, th := range snap.Threads {
		if th.ProjectID == "" || th.WorktreePath == "" || !th.ArchivedAt.IsZero() ||
			(!th.SnoozedUntil.IsZero() && th.SnoozedUntil.After(now)) {
			continue
		}
		out = append(out, th.WorktreePath)
	}
	slices.Sort(out)
	return slices.Compact(out)
}

// touchFor reports whether ev should touch its thread's worktree (ok) and whether at
// once (now: a turn ended) rather than debounced (an edit tool's result arrived).
func touchFor(ev thread.ThreadEvent) (now, ok bool) {
	var it thread.Item
	switch e := ev.(type) {
	case thread.ItemAppended:
		it = e.Item
	case thread.ItemUpdated:
		it = e.Item
	default:
		return false, false
	}
	switch it.Kind {
	case thread.KindTurnEnd:
		return true, true
	case thread.KindToolCall:
		tc := it.Tool
		return false, tc != nil && tc.Status != thread.ToolRunning && slices.Contains(editTools, tc.Name)
	}
	return false, false
}
