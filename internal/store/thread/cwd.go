package thread

import (
	"context"
	"fmt"
)

// A spawn's working directory (docs/notes/workspaces-v2-fix-1-workspace.md). Claude is
// exec'd with the thread's cwd as its directory, and a missing one fails as ENOENT,
// which reads as a missing claude binary. Every spawn checks it first: a derived
// worktree a cleanup removed was made again before (ensureWorktree at a start); a
// workspace's managed dir is made again here (EnsureDirs, empty: a synthetic
// workspace's files went with it); anything else, a workspace's moved root included, is
// an error that names the folder.

// ensureCwd makes sure s's cwd is a directory, making a workspace's managed dir again
// when that is the cwd.
func (m *Manager) ensureCwd(ctx context.Context, s Thread) error {
	if s.WorktreePath == "" || isDir(s.WorktreePath) {
		return nil
	}
	if w, ok := m.workspaceOf(s); ok && samePath(s.WorktreePath, w.ManagedDir) {
		if err := m.opts.Workspaces.EnsureDirs(ctx, w.ID); err != nil {
			m.log.Warn("workspace managed dir", "thread", s.ID, "workspace", w.ID, "err", err)
		}
		if isDir(s.WorktreePath) {
			m.log.Info("thread's workspace folder was gone; made it again (empty)", "thread", s.ID, "workspace", w.ID, "dir", s.WorktreePath)
			return nil
		}
	}
	err := missingCwd(s.WorktreePath)
	m.log.Warn("thread's working directory is missing", "thread", s.ID, "cwd", s.WorktreePath)
	return err
}

// missingCwd is the error for a spawn whose cwd is gone.
func missingCwd(path string) error {
	return fmt.Errorf("%w: working directory %s is missing", ErrFailedPrecondition, path)
}
