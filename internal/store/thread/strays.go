package thread

import (
	"context"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/procscan"
)

// Stray processes (docs/notes/ember-fixes-2-small.md). Claude runs in a process group
// of its own, and once it exits the daemon signals that group (killGroup, stream.go),
// but Claude Code starts every Bash call in a new process group: a server a Bash call
// put in the background (`pnpm dev &`) is outside Claude's group, re-parented to
// launchd once its shell ends, and would outlive the thread, its archive and its
// worktree. Archive and Remove therefore stop, once Claude is gone, what the thread
// left running in its worktree: the process groups of the orphans (parent launchd)
// whose working directory is in the thread's cwd and that started after the thread
// was made. App bundles there (an editor, a browser the user opened in the worktree)
// are left alone and logged. Nothing is stopped when the cwd is the home directory or
// above it (a thread without a project), or when another thread that is not archived
// works there (its processes cannot be told apart).

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

// strayDir is the directory whose orphans thread id's archive or removal stops, "" when
// none: its cwd, unless that is home or above it, or another live thread works there.
func strayDir(threads []Thread, id, home string) string {
	var cwd string
	for _, t := range threads {
		if t.ID == id {
			cwd = t.WorktreePath
		}
	}
	if cwd == "" || !filepath.IsAbs(cwd) {
		return ""
	}
	cwd = filepath.Clean(cwd)
	if home != "" && procscan.Inside(filepath.Clean(home), cwd) {
		return "" // the home directory, or a directory above it
	}
	for _, t := range threads {
		if t.ID == id || !t.ArchivedAt.IsZero() || t.Removing || t.WorktreePath == "" {
			continue
		}
		if procscan.Inside(t.WorktreePath, cwd) || procscan.Inside(cwd, t.WorktreePath) {
			return ""
		}
	}
	return cwd
}

// stopStrays stops what thread id left running in its cwd once its Claude is gone
// (Archive, Remove): it finds the strays and sends SIGTERM now, SIGKILL StrayGrace
// later in the background. A failure to look is logged, never an error.
func (m *Manager) stopStrays(ctx context.Context, id string) {
	snap := m.Snapshot()
	var since time.Time
	if t, ok := snap.Thread(id); ok {
		since = t.CreatedAt.Add(-time.Second) // stored at ms; a process start is µs
	}
	dir := strayDir(snap.Threads, id, m.opts.Home)
	if dir == "" {
		return
	}
	procs, err := procscan.In(ctx, dir, strayCandidate(since))
	if err != nil {
		m.log.Warn("look for processes the thread left running", "thread", id, "dir", dir, "err", err)
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
