package project

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// Deleting a branch whose worktree is gone (docs/notes/orch-cli-batch.md, W4 finding 3):
// once `project worktree remove` ran, --delete-branch had nothing to point at, and an
// orchestrator told to discard a child's work deleted the branch (and origin's) with raw
// git behind the daemon's back.

// DeleteBranchOptions configures Store.DeleteBranch.
type DeleteBranchOptions struct {
	ProjectID string
	Branch    string
	// Force runs `git branch -D` (unmerged commits are lost); else `git branch -d`,
	// which refuses a branch not merged into its upstream or HEAD.
	Force bool
	// Remote also runs `git push origin --delete <branch>`; a branch origin does not
	// have is not an error.
	Remote bool
}

// DeleteBranchResult says what DeleteBranch deleted.
type DeleteBranchResult struct {
	Local, Remote bool
}

// DeleteBranch implements Store. The default branch is refused, and so (by git) is a
// branch a worktree has checked out. Neither a local nor (with Remote) an origin branch
// of that name is ErrNotFound.
func (g *Git) DeleteBranch(ctx context.Context, o DeleteBranchOptions) (DeleteBranchResult, error) {
	var res DeleteBranchResult
	st := g.project(o.ProjectID)
	if st == nil {
		return res, fmt.Errorf("%w: project %q", ErrNotFound, o.ProjectID)
	}
	m := st.meta.Load()
	if err := requireGit(m); err != nil {
		return res, err
	}
	if o.Branch == "" || strings.HasPrefix(o.Branch, "-") {
		return res, fmt.Errorf("%w: invalid branch name %q", ErrInvalidArgument, o.Branch)
	}
	if _, err := g.runner.Run(ctx, m.Path, "check-ref-format", "--branch", o.Branch); err != nil {
		return res, fmt.Errorf("%w: invalid branch name %q", ErrInvalidArgument, o.Branch)
	}
	if o.Branch == m.DefaultBranch {
		return res, fmt.Errorf("%w: %s is the default branch of %s", ErrInvalidArgument, o.Branch, m.Name)
	}
	if g.refExists(ctx, m.Path, "refs/heads/"+o.Branch) {
		flag := "-d"
		if o.Force {
			flag = "-D"
		}
		if _, err := g.runner.Run(ctx, m.Path, "branch", flag, o.Branch); err != nil {
			return res, fmt.Errorf("%w: %w", ErrFailedPrecondition, err)
		}
		res.Local = true
		g.log.Info("branch deleted", "project", m.ID, "branch", o.Branch, "force", o.Force)
	}
	if o.Remote {
		if _, err := g.runner.Run(ctx, m.Path, "remote", "get-url", "origin"); err != nil {
			return res, fmt.Errorf("%w: %s has no origin remote", ErrFailedPrecondition, m.Name)
		}
		pctx, cancel := context.WithTimeout(ctx, fetchTimeout)
		defer cancel()
		_, err := g.runner.Run(pctx, m.Path, "push", "origin", "--delete", o.Branch)
		var ge *GitError
		switch {
		case err == nil:
			res.Remote = true
			g.log.Info("branch deleted on origin", "project", m.ID, "branch", o.Branch)
		case errors.As(err, &ge) && strings.Contains(ge.Stderr, "remote ref does not exist"):
		default:
			return res, fmt.Errorf("%w: %w", ErrFailedPrecondition, err)
		}
	}
	if !res.Local && !res.Remote {
		where := "locally"
		if o.Remote {
			where = "locally or on origin"
		}
		return res, fmt.Errorf("%w: no branch %s in %s %s", ErrNotFound, o.Branch, m.Name, where)
	}
	return res, nil
}
