package daemon

import (
	"context"
	"log/slog"
	"strconv"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/procscan"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// abandonedBy is project.CleanupOptions.Abandoned over the thread store's threads,
// archived ones included, and its tombstones (cleanupAbandoned).
func abandonedBy(threads *thread.Manager) func(project.Worktree) bool {
	return func(w project.Worktree) bool {
		removed, _ := threads.ListRemoved(context.Background(), thread.ListOptions{})
		return cleanupAbandoned(w.Path, threads.Snapshot(), removed)
	}
}

// logLeftovers is project.CleanupOptions.Removing: it logs the processes still
// running in a worktree cleanup is about to remove (archive and remove stop what a
// thread left; anything else, a user's own server, is only named).
func logLeftovers(log *slog.Logger) func(context.Context, project.Worktree) {
	return func(ctx context.Context, w project.Worktree) {
		procs, err := procscan.In(ctx, w.Path, nil)
		if err != nil {
			log.Debug("look for processes in a worktree cleanup removes", "path", w.Path, "err", err)
			return
		}
		if len(procs) == 0 {
			return
		}
		names := make([]string, len(procs))
		for i, p := range procs {
			names[i] = p.Name() + " (" + strconv.Itoa(p.PID) + ")"
		}
		log.Warn("processes still run in a worktree cleanup removes", "path", w.Path, "processes", names)
	}
}

// cleanupAbandoned reports whether the worktree at path is abandoned: no thread that is
// not archived is on it (its cwd is the worktree or inside it), and an archived one or
// a removed one (its tombstone, kept for thread.RemovedTTL) was. Cleanup then removes it
// although it was made less than project.FreshFor ago. Pure.
func cleanupAbandoned(path string, snap *thread.Snapshot, removed []thread.RemovedThread) bool {
	was := false
	if snap != nil {
		for _, t := range snap.Threads {
			if !inside(t.WorktreePath, path) {
				continue
			}
			if t.ArchivedAt.IsZero() {
				return false
			}
			was = true
		}
	}
	for _, r := range removed {
		if inside(r.WorktreePath, path) {
			was = true
		}
	}
	return was
}

// cleanupHold is the non-git half of the worktree cleanup rule (project.CleanupVerdict
// is the git half): why something keeps the worktree at path, or "". A thread is on it
// (its cwd is the worktree or inside it; any state, archived ones excluded by the caller), a terminal that has not exited
// belongs to it (worktree label) or runs inside it. Pure; the daemon passes the thread and
// terminal stores' current state (workspaces have no worktrees).
func cleanupHold(path string, threads []holder, terminals []terminal.Terminal) string {
	for _, t := range threads {
		if inside(t.Cwd, path) {
			if t.Name != "" {
				return "thread " + t.Name + " is on it"
			}
			return "a thread is on it"
		}
	}
	for _, t := range terminals {
		if t.State != terminal.StateExited && (t.Labels[termlabel.Worktree] == path || inside(t.Cwd, path)) {
			return "a terminal is open in it"
		}
	}
	return ""
}

// holder is a thread that holds a path for the cleanup rule: its cwd, or one of its
// checkouts (checkoutThreads).
type holder struct {
	ID, Name string
	Cwd      string
}

// inside reports whether p is root or below it. Both are snapshot paths (cleaned,
// symlinks resolved).
func inside(p, root string) bool {
	if p == "" || root == "" {
		return false
	}
	return p == root || strings.HasPrefix(p, strings.TrimSuffix(root, "/")+"/")
}
