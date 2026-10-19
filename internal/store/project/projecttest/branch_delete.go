package projecttest

import (
	"context"
	"fmt"
	"slices"

	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// DeleteBranch implements project.Store: it records the call and deletes nothing (the
// fake keeps no branches). The default branch and a branch a worktree has checked out
// are refused like the real store; otherwise it answers Local, and Remote when asked.
func (f *Fake) DeleteBranch(_ context.Context, o project.DeleteBranchOptions) (project.DeleteBranchResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, fmt.Sprintf("DeleteBranch %s %s force=%t remote=%t", o.ProjectID, o.Branch, o.Force, o.Remote))
	if f.Err != nil {
		return project.DeleteBranchResult{}, f.Err
	}
	r, ok := f.projects[o.ProjectID]
	if !ok {
		return project.DeleteBranchResult{}, fmt.Errorf("%w: project %q", project.ErrNotFound, o.ProjectID)
	}
	if err := notGit(r); err != nil {
		return project.DeleteBranchResult{}, err
	}
	if o.Branch == r.DefaultBranch {
		return project.DeleteBranchResult{}, fmt.Errorf("%w: %s is the default branch of %s", project.ErrInvalidArgument, o.Branch, r.Name)
	}
	if slices.ContainsFunc(r.Worktrees, func(w project.Worktree) bool { return w.Branch == o.Branch }) {
		return project.DeleteBranchResult{}, fmt.Errorf("%w: branch %s is checked out", project.ErrFailedPrecondition, o.Branch)
	}
	return project.DeleteBranchResult{Local: true, Remote: o.Remote}, nil
}
