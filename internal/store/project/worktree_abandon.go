package project

import (
	"context"
	"fmt"
	"os"
	"slices"
)

// A `git worktree add` that was killed (a cancelled setup) or lost with the daemon does
// not clean up after itself: git does that only when it dies by itself or takes a
// signal it can catch. It can leave the directory, half checked out, its entry in
// `git worktree list`, locked "initializing", and the new branch. So CreateWorktree undoes
// an add its ctx killed, and a caller that lost one says so with AbandonWorktree.

// AbandonWorktree implements Store. A path outside the worktree root is refused: it
// cannot have come from CreateWorktree's default.
func (g *Git) AbandonWorktree(ctx context.Context, opts AbandonWorktreeOptions) error {
	st := g.project(opts.ProjectID)
	if st == nil {
		return fmt.Errorf("%w: project %q", ErrNotFound, opts.ProjectID)
	}
	m := st.meta.Load()
	if err := requireGit(m); err != nil {
		return err
	}
	if !InsideRoot(opts.Path, g.wtRoot) {
		return fmt.Errorf("%w: worktree path %s is outside %s", ErrInvalidArgument, opts.Path, g.wtRoot)
	}
	ctx, cancel := context.WithTimeout(ctx, worktreeTimeout)
	defer cancel()
	g.undoAdd(ctx, m, opts)
	g.forgetMade(ctx, g.now(), opts.Path)
	return g.sched.wait(ctx, jobKey{kind: jobReconcile, projectID: m.ID})
}

// undoAdd takes away what the add of o.Path left. git locks a worktree until its checkout
// is done, so one it lists unlocked is whole and may have been worked in (an add that
// finished as the daemon died, a worktree made there since): that goes as any worktree
// does, only when git finds nothing to lose, and its branch stays with it when it does
// not. Anything else is only half there: the worktree (the second --force is for the
// lock), the directory should git not take it for one, its entry, then the branch while it
// is where the add put it.
func (g *Git) undoAdd(ctx context.Context, m *projectMeta, o AbandonWorktreeOptions) {
	if entry, ok := g.worktreeEntry(ctx, m, o.Path); ok && !entry.Locked {
		if _, err := g.runner.Run(ctx, m.Path, "worktree", "remove", o.Path); err != nil {
			g.log.Info("worktree kept: git would lose something in it", "project", m.ID, "path", o.Path, "err", err)
			return
		}
		g.deleteUntouchedBranch(ctx, m, o.Branch, o.Head)
		return
	}
	if _, err := g.runner.Run(ctx, m.Path, "worktree", "remove", "--force", "--force", o.Path); err != nil {
		g.log.Debug("a half-made worktree is not one to git", "project", m.ID, "path", o.Path, "err", err)
	}
	if err := os.RemoveAll(o.Path); err != nil {
		g.log.Warn("removing a half-made worktree failed", "project", m.ID, "path", o.Path, "err", err)
	}
	if _, err := g.runner.Run(ctx, m.Path, "worktree", "unlock", o.Path); err != nil {
		g.log.Debug("no lock on a half-made worktree", "project", m.ID, "path", o.Path, "err", err)
	}
	if _, err := g.runner.Run(ctx, m.Path, "worktree", "prune"); err != nil {
		g.log.Warn("pruning a half-made worktree failed", "project", m.ID, "path", o.Path, "err", err)
	}
	g.deleteUntouchedBranch(ctx, m, o.Branch, o.Head)
	g.log.Info("half-made worktree removed", "project", m.ID, "path", o.Path, "branch", o.Branch)
}

// worktreeEntry is path's entry in `git worktree list`, read now.
func (g *Git) worktreeEntry(ctx context.Context, m *projectMeta, path string) (listedWorktree, bool) {
	out, err := g.runner.Run(ctx, m.Path, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return listedWorktree{}, false
	}
	all, err := parseWorktreeList(out)
	if err != nil {
		return listedWorktree{}, false
	}
	i := slices.IndexFunc(all, func(e listedWorktree) bool { return samePath(e.Path, path) })
	if i < 0 {
		return listedWorktree{}, false
	}
	return all[i], true
}

// deleteUntouchedBranch deletes branch while its tip is still head: made for a worktree
// that is gone, and nobody has committed to it. Anything else stays, logged; a branch
// that does not exist is nothing to do, and so is a head of "": the branch was not made.
func (g *Git) deleteUntouchedBranch(ctx context.Context, m *projectMeta, branch, head string) {
	if branch == "" || head == "" {
		return
	}
	tip := g.revParse(ctx, m.Path, "refs/heads/"+branch)
	switch {
	case tip == "":
		return
	case tip != head:
		g.log.Info("branch kept: it moved since it was made", "project", m.ID, "branch", branch, "made_at", head, "tip", tip)
		return
	}
	if _, err := g.runner.Run(ctx, m.Path, "branch", "-D", branch); err != nil {
		g.log.Warn("deleting a branch made for a worktree failed", "project", m.ID, "branch", branch, "err", err)
		return
	}
	g.log.Info("branch deleted", "project", m.ID, "branch", branch, "made_at", head)
}
