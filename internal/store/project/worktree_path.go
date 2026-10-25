package project

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Where a new worktree goes, and what may stand in its way (fuzz findings git 3, 4).

// worktreeKey is a project's directory under the worktree root: its GitHub slug, else
// _local/<name> (defaultWorktreePath).
func worktreeKey(slug, name string) string {
	if slug == "" {
		return localOwner + "/" + name
	}
	return slug
}

// worktreeDirKey is m's directory under the worktree root: worktreeKey, unless another
// git project registered before m has the same one (case-insensitively, as APFS
// compares: two folders named app, or two checkouts of one GitHub repository); then
// it ends in "-<the first 8 characters of m's id>". The first project keeps the plain
// directory, so its paths (a thread's recreate compares with them) never change.
// slug is m's, read by the caller (m.GitHubSlug is empty until its first reconcile).
func (g *Git) worktreeDirKey(m *projectMeta, slug string) string {
	key := worktreeKey(slug, m.Name)
	g.mu.RLock()
	defer g.mu.RUnlock()
	for _, st := range g.projects {
		o := st.meta.Load()
		if o.ID == m.ID || !o.Git || !strings.EqualFold(worktreeKey(o.GitHubSlug, o.Name), key) {
			continue
		}
		if o.RegisteredAt.Before(m.RegisteredAt) || (o.RegisteredAt.Equal(m.RegisteredAt) && o.ID < m.ID) {
			return key + "-" + m.ID[:min(8, len(m.ID))]
		}
	}
	return key
}

// dropStaleWorktrees removes git's entries for worktrees whose directory is gone
// ("prunable": deleted by hand) that sit at path or have branch checked out, each with
// `git worktree remove <its path>`. git otherwise refuses `worktree add` there ("missing
// but already registered worktree") and deleting the branch ("used by worktree at"),
// for three months, while the snapshot hides such entries. Only the matching entries
// go: `git worktree prune` would also drop a worktree on a volume that is not mounted.
// Either of path and branch may be empty. Failures are logged; git reports the
// conflict itself afterwards.
func (g *Git) dropStaleWorktrees(ctx context.Context, m *projectMeta, path, branch string) {
	out, err := g.runner.Run(ctx, m.Path, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return
	}
	all, err := parseWorktreeList(out)
	if err != nil {
		return
	}
	for _, l := range all {
		if !l.Prunable || !(path != "" && samePath(l.Path, path) || branch != "" && l.Branch == branch) {
			continue
		}
		if _, err := g.runner.Run(ctx, m.Path, "worktree", "remove", l.Path); err != nil {
			g.log.Warn("dropping a stale worktree entry failed", "project", m.ID, "path", l.Path, "err", err)
			continue
		}
		g.log.Info("stale worktree entry dropped (its directory is gone)", "project", m.ID, "path", l.Path, "branch", l.Branch)
	}
}

// samePath compares two paths cleaned, then with their parent directories' symlinks
// resolved (the leaf may not exist).
func samePath(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if a == b {
		return true
	}
	res := func(p string) string { return filepath.Join(resolved(filepath.Dir(p)), filepath.Base(p)) }
	return res(a) == res(b)
}

// DefaultWorktreePath is where CreateWorktree puts project id's worktree for branch: the
// same path every caller computes, so threads on one branch share one worktree (a
// thread's derived checkouts, docs/notes/workspaces-v2-1-threads.md). It reads the
// GitHub slug of the project's last reconcile (CreateWorktree reads origin afresh, so
// before the first reconcile of a project with a GitHub origin the two can differ;
// callers look for an existing worktree on the branch first). "" for an unknown project
// or one without git.
func (g *Git) DefaultWorktreePath(projectID, branch string) string {
	st := g.project(projectID)
	if st == nil || branch == "" {
		return ""
	}
	m := st.meta.Load()
	if !m.Git {
		return ""
	}
	return filepath.Clean(defaultWorktreePath(g.wtRoot, g.worktreeDirKey(m, m.GitHubSlug), branch))
}

// requireFree refuses a worktree path something already occupies, before `git
// worktree add -b` would create the branch and then fail on it (leaving the branch).
func requireFree(path string) error {
	_, err := os.Lstat(path)
	switch {
	case err == nil:
		return fmt.Errorf("%w: %s already exists", ErrFailedPrecondition, path)
	case !errors.Is(err, os.ErrNotExist):
		return fmt.Errorf("%w: check %s: %w", ErrFailedPrecondition, path, err)
	}
	return nil
}
