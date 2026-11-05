package project

import (
	"context"
	"errors"
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
	if err := g.undoAdd(ctx, m, opts); err != nil {
		return err
	}
	g.forgetMade(ctx, g.now(), opts.Path)
	return g.sched.wait(ctx, jobKey{kind: jobReconcile, projectID: m.ID})
}

// undoAdd takes away what the add of o.Path left, and only what it can tell the add left,
// so anything else is an error and stays. What git lists says which it is, and when it
// cannot be read nothing is touched: a worktree that merely went unlisted would lose
// its work.
//
//   - Listed, locked "initializing": half checked out, and nothing was ever worked on. The
//     worktree goes (the second --force is for the lock), the directory should git not take
//     it for one, its entry, then the branch while it is where the add put it.
//   - Listed otherwise: whole (an add that finished as the daemon died, a worktree made
//     there since), or locked by someone. It goes as any worktree does, only when git finds
//     nothing to lose, and its branch stays with it when it does not.
//   - Not listed: an add killed before its entry leaves an empty directory, so only that
//     goes.
func (g *Git) undoAdd(ctx context.Context, m *projectMeta, o AbandonWorktreeOptions) error {
	entry, listed, err := g.worktreeEntry(ctx, m, o.Path)
	switch {
	case err != nil:
		return fmt.Errorf("%w: %s stays: %w", ErrFailedPrecondition, o.Path, err)
	case !listed:
		if err := os.Remove(o.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("%w: %s stays: git does not list it, and it is not empty: %w", ErrFailedPrecondition, o.Path, err)
		}
	case entry.LockReason != lockInitializing:
		if _, err := g.runner.Run(ctx, m.Path, "worktree", "remove", o.Path); err != nil {
			return fmt.Errorf("%w: %s stays: %w", ErrFailedPrecondition, o.Path, err)
		}
	default:
		g.removeHalfMade(ctx, m, o.Path)
	}
	g.deleteUntouchedBranch(ctx, m, o.Branch, o.Head)
	g.log.Info("what a worktree add left is gone", "project", m.ID, "path", o.Path, "branch", o.Branch)
	return nil
}

// lockInitializing is the reason git locks a worktree for while an add checks it out. Its
// messages are C locale's here (gitEnv).
const lockInitializing = "initializing"

// removeHalfMade removes a worktree git listed as being added.
func (g *Git) removeHalfMade(ctx context.Context, m *projectMeta, path string) {
	if _, err := g.runner.Run(ctx, m.Path, "worktree", "remove", "--force", "--force", path); err != nil {
		g.log.Debug("a half-made worktree is not one to git", "project", m.ID, "path", path, "err", err)
	}
	if err := os.RemoveAll(path); err != nil {
		g.log.Warn("removing a half-made worktree failed", "project", m.ID, "path", path, "err", err)
	}
	if _, err := g.runner.Run(ctx, m.Path, "worktree", "unlock", path); err != nil {
		g.log.Debug("no lock on a half-made worktree", "project", m.ID, "path", path, "err", err)
	}
	if _, err := g.runner.Run(ctx, m.Path, "worktree", "prune"); err != nil {
		g.log.Warn("pruning a half-made worktree failed", "project", m.ID, "path", path, "err", err)
	}
}

// worktreeEntry is path's entry in `git worktree list`, read now. An error says the list
// could not be read, which says nothing about path.
func (g *Git) worktreeEntry(ctx context.Context, m *projectMeta, path string) (listedWorktree, bool, error) {
	out, err := g.runner.Run(ctx, m.Path, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return listedWorktree{}, false, err
	}
	all, err := parseWorktreeList(out)
	if err != nil {
		return listedWorktree{}, false, err
	}
	i := slices.IndexFunc(all, func(e listedWorktree) bool { return samePath(e.Path, path) })
	if i < 0 {
		return listedWorktree{}, false, nil
	}
	return all[i], true, nil
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
