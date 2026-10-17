package daemon

import (
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// cleanupHold is the non-git half of the worktree cleanup rule (repo.MergedCleanReason
// is the git half): why something keeps the worktree at path, or "". A thread is on it
// (its cwd is the worktree or inside it; any state, archived ones excluded by the caller), a terminal that has not exited
// belongs to it (worktree label) or runs inside it, or it is a workspace member. Pure;
// the daemon passes the thread, terminal and workspace stores' current state.
func cleanupHold(path string, threads []workspace.Thread, terminals []terminal.Terminal, workspaces *workspace.Snapshot) string {
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
	if w, _, ok := workspace.MemberAt(workspaces, path); ok {
		return "member of workspace " + w.Name
	}
	return ""
}

// inside reports whether p is root or below it. Both are snapshot paths (cleaned,
// symlinks resolved).
func inside(p, root string) bool {
	if p == "" || root == "" {
		return false
	}
	return p == root || strings.HasPrefix(p, strings.TrimSuffix(root, "/")+"/")
}
