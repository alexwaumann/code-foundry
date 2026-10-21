package thread

import (
	"context"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/procscan"
	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// Stray processes (docs/notes/ember-fixes-2-small.md). Claude runs in a process group
// of its own, and once it exits the daemon signals that group (killGroup, stream.go),
// but Claude Code starts every Bash call in a new process group: a server a Bash call
// put in the background (`pnpm dev &`) is outside Claude's group, re-parented to
// launchd once its shell ends, and would outlive the thread, its archive and its
// worktree. Archive and Remove therefore look, once Claude is gone, for what the
// thread left running in its cwd: the orphans (parent launchd) whose working directory
// is in it and that started after the thread was made.
//
// They are stopped (their process groups) only in a worktree Code Foundry made, under
// Options.WorktreeRoot. In any other cwd, a project's own checkout above all, they are
// only logged: the user runs their own dev servers there, and a lead started without a
// new worktree lives there; killing a user's server is worse than a stray one. App
// bundles (an editor, a browser opened in the worktree) are never stopped, only
// logged. Nothing is looked at when the cwd is the home directory or above it (a
// thread without a project), or when another thread that is not archived works there
// (its processes cannot be told apart).

// StrayGrace is how long a stray process group gets between SIGTERM and SIGKILL.
const StrayGrace = 2 * time.Second

// pickStrays chooses among the processes in a thread's cwd (procscan.In, already
// limited to orphans started after the thread was made) the process groups to stop:
// those of the processes that are not app bundles. spared are the app bundles.
func pickStrays(procs []procscan.Proc) (pgids []int, stop, spared []procscan.Proc) {
	for _, p := range procs {
		if isAppBundle(p.Exe) {
			spared = append(spared, p)
			continue
		}
		stop = append(stop, p)
		if !slices.Contains(pgids, p.PGID) {
			pgids = append(pgids, p.PGID)
		}
	}
	return pgids, stop, spared
}

// isAppBundle reports whether exe is inside a macOS app bundle.
func isAppBundle(exe string) bool { return strings.Contains(exe, ".app/Contents/") }

// strayCandidate is procscan.In's first filter: an orphan that started after since.
func strayCandidate(since time.Time) func(procscan.Proc) bool {
	return func(p procscan.Proc) bool { return p.PPID == 1 && !p.Start.Before(since) }
}

// strayDir is the directory thread id's archive or removal looks in for orphans, ""
// when none: its cwd, unless that is home or above it, or another live thread works
// there. stop is whether they are stopped there, not only logged: the cwd is inside
// worktreeRoot, a worktree Code Foundry made (never a project's own checkout).
func strayDir(threads []Thread, id, home, worktreeRoot string) (dir string, stop bool) {
	var cwd string
	for _, t := range threads {
		if t.ID == id {
			cwd = t.WorktreePath
		}
	}
	if cwd == "" || !filepath.IsAbs(cwd) {
		return "", false
	}
	cwd = filepath.Clean(cwd)
	if home != "" && procscan.Inside(filepath.Clean(home), cwd) {
		return "", false // the home directory, or a directory above it
	}
	for _, t := range threads {
		if t.ID == id || !t.ArchivedAt.IsZero() || t.Removing || t.WorktreePath == "" {
			continue
		}
		if procscan.Inside(t.WorktreePath, cwd) || procscan.Inside(cwd, t.WorktreePath) {
			return "", false
		}
	}
	return cwd, project.InsideRoot(cwd, worktreeRoot)
}

// stopStrays stops what thread id left running in its cwd once its Claude is gone
// (Archive, Remove): in a worktree Code Foundry made it finds the strays and sends
// SIGTERM now, SIGKILL StrayGrace later in the background; elsewhere it only logs
// them. A failure to look is logged, never an error.
func (m *Manager) stopStrays(ctx context.Context, id string) {
	snap := m.Snapshot()
	var since time.Time
	if t, ok := snap.Thread(id); ok {
		since = t.CreatedAt.Add(-time.Second) // stored at ms; a process start is µs
	}
	dir, stopHere := strayDir(snap.Threads, id, m.opts.Home, m.opts.WorktreeRoot)
	if dir == "" {
		return
	}
	procs, err := procscan.In(ctx, dir, strayCandidate(since))
	if err != nil {
		m.log.Warn("look for processes the thread left running", "thread", id, "dir", dir, "err", err)
		return
	}
	if !stopHere {
		if len(procs) > 0 {
			m.log.Warn("left running in the thread's checkout (not a worktree Code Foundry made, so not stopped)",
				"thread", id, "dir", dir, "processes", procList(procs))
		}
		return
	}
	pgids, stop, spared := pickStrays(procs)
	if len(spared) > 0 {
		m.log.Warn("left running in the thread's worktree: app bundles", "thread", id, "dir", dir, "processes", procList(spared))
	}
	if len(pgids) == 0 {
		return
	}
	m.log.Info("stopping processes the thread left running", "thread", id, "dir", dir, "processes", procList(stop), "groups", pgids)
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		procscan.StopGroups(m.ctx, pgids, StrayGrace)
	}()
}

// procList names procs for a log line: "vite (7938)".
func procList(procs []procscan.Proc) []string {
	out := make([]string, len(procs))
	for i, p := range procs {
		out[i] = p.Name() + " (" + strconv.Itoa(p.PID) + ")"
	}
	return out
}
